export * as SchedulerCore from "./scheduler-core"

import * as Core from "./types"
import { eligible, dims, pick, type Candidate, type Pick } from "./scoring"

/**
 * `ResourceResolver`, the P1 mount contract from docs 02 §4:
 *
 *   resolve(req, ctx) → ResourceBinding
 *
 * Pure over its inputs: the candidate pool, each candidate's state and
 * metrics, the session's current binding, and the weights. The
 * persistence (state.json), the probes' network I/O, and the timers all
 * live outside this function — resolve() itself is the deterministic
 * core that the audit log replays.
 *
 * Docs 02 §4 semantics, in order:
 *   1) modelOverride, when it names a candidate the pool knows, wins —
 *      still checked for account availability, and reported via
 *      "override" so the audit log says who really decided. An override
 *      naming something the pool does not know is NoResourceError,
 *      not a silent drop to the scored path.
 *   2) Otherwise the six-dimension score picks, with the EPS jitter and
 *      the STICKY_DELTA session stickiness on top.
 *   3) When nothing is eligible at all, NoResourceError — the SUSPENDED
 *      path (ADR-004), never a silent fallback to a hardcoded model.
 */

export interface ResolveContext {
  /** The session's current binding, "model@account"; undefined for a new session. */
  currentBinding?: string
  /** Set when `currentBinding` is a manual override: sticky is off for it. */
  override?: boolean
  /** User-supplied weights; the defaults when absent. */
  weights?: Core.SchedulerWeights
  eps?: number
  stickyDelta?: number
  /**
   * A deterministic jitter seed. Replay passes the seed recorded in the
   * audit row; live picks pass a monotonically increasing one.
   */
  jitterSeed?: number
  now?: number
}

/**
 * The audit log row, docs 03 §4.3: what was asked, what was seen, what
 * was picked and how. The log is what `/scheduler explain` replays.
 */
export interface DecisionLogEntry {
  ts: string
  task: string
  req: string
  candidates: Array<{ m: string; a: string; score: number }>
  pick: string
  path: string
  reason: string
}

/**
 * A `state.json` snapshot: candidate states plus the rolling decision log.
 * The scheduler is replayable from exactly this — the acceptance
 * criterion: the same snapshot plus the same request gives the same pick.
 */
export interface StateSnapshot {
  version: 1
  candidates: Record<string, { health: import("./state-machine").CandidateHealth; metrics: import("./metrics").CandidateMetrics; quotaRemaining?: number }>
  sessions: Record<string, { binding?: string; override?: boolean }>
  suspended: Record<string, import("./suspend").SuspendedSnapshot>
  /** The rolling decision log, capped at 500 entries. */
  decisions: DecisionLogEntry[]
}

/** A decision plus the audit row that records it. */
export interface ResolveOutcome {
  binding: Core.ResourceBinding
  pick: Pick
  /** The audit row to append to `state.json`; the scheduler keeps the last 500. */
  audit: DecisionLogEntry
}

/**
 * The resolver itself.
 *
 * Returns the binding plus the audit row, or throws NoResourceError — a
 * first-class outcome in this design, because it is the only shape that
 * cannot be mistaken for "picking a model no one asked for". The caller
 * converts the exception into the SUSPENDED snapshot (suspend.park).
 */
export function resolve(
  candidates: readonly Candidate[],
  req: Core.ResolveRequest,
  ctx: ResolveContext = {},
): ResolveOutcome {
  const now = ctx.now ?? Date.now()
  const bindingOf = (c: Candidate, via: NonNullable<Core.ResourceBinding["via"]>): Core.ResourceBinding => ({
    model: c.spec.model,
    account: c.spec.account,
    endpoint: (c.spec.provider?.baseUrlOverride ?? c.spec.provider?.endpoint ?? ""),
    effectiveCapabilities: c.spec.model.capabilities,
    via,
  })
  const label = (c: Candidate) => `${c.spec.model.id}@${c.spec.account.id}`

  // 1) The manual override, docs 02 §4.
  if (req.modelOverride) {
    const target = candidates.find((c) => label(c) === req.modelOverride)
    if (!target) {
      throw new Core.NoResourceError({ capability: req.capability, features: req.requiredFeatures ?? [] })
    }
    // The override still checks account availability: a manually picked
    // candidate whose account is invalid, disabled, or out of quota is
    // reported rather than served.
    const hardExcluded = eligible(target, req, now, { relaxed: false }).filter((reason) => reason !== "capability" && reason !== "feature")
    if (hardExcluded.length > 0) {
      throw new Core.NoResourceError({ capability: req.capability, features: req.requiredFeatures ?? [] })
    }
    const picked: Pick = {
      candidate: target,
      terms: dims(target, req, []),
      score: 1,
      path: "score",
      excluded: [],
    }
    const binding = bindingOf(target, "override")
    return { binding, pick: picked, audit: auditRow(label(target), req, picked, "override", "manual model override", now) }
  }

  // 2) The scored pick, with jitter and stickiness.
  const picked = pick(candidates, req, {
    weights: ctx.weights,
    current: ctx.currentBinding,
    override: ctx.override,
    eps: ctx.eps,
    stickyDelta: ctx.stickyDelta,
    now,
    jitterSeed: ctx.jitterSeed,
  })
  if (!picked) {
    // 3) Nothing eligible: the SUSPENDED path.
    throw new Core.NoResourceError({ capability: req.capability, features: req.requiredFeatures ?? [] })
  }

  const binding = bindingOf(picked.candidate, picked.path === "sticky" ? "sticky" : "score")
  if (picked.degradedPath) binding.degradedPath = true
  return {
    binding,
    pick: picked,
    audit: auditRow(label(picked.candidate), req, picked, picked.path, picked.degradedPath ? "relaxed pool (required feature dropped)" : "scored", now),
  }
}

function auditRow(pickID: string, req: Core.ResolveRequest, picked: Pick, path: string, reason: string, now: number): DecisionLogEntry {
  return {
    ts: new Date(now).toISOString(),
    task: req.task ?? "",
    req: req.capability + (req.requiredFeatures?.length ? `+${req.requiredFeatures.join(",")}` : ""),
    candidates: [
      {
        m: picked.candidate.spec.model.id,
        a: picked.candidate.spec.account.id,
        score: Number(picked.score.toFixed(4)),
      },
    ],
    pick: pickID,
    path,
    reason,
  }
}
