export * as Suspend from "./suspend"

import * as Core from "./types"
import { onProbe, onQuotaReset, probeOptions } from "./state-machine"
import { pool, type Candidate } from "./scoring"

/**
 * The SUSPENDED path, docs 03 §5 and ADR-004: when the pool is empty — no
 * provider, every account invalid, every quota spent — the task is not
 * dropped and not silently downgraded. It is parked with its context
 * intact, the user gets an actionable checklist rather than a crash, and
 * a background re-probe every 5 minutes brings it back on its own when a
 * resource recovers.
 *
 * This module owns the *snapshot* (what to resume, and with what) and the
 * re-probe decision. The timers, the TUI, and the session storage live in
 * the harness; everything this module does is pure and returns data.
 */

export interface SuspendedSnapshot {
  /** When the task was parked. */
  at: number
  /** What the task was waiting for, replayable as a request. */
  request: Core.ResolveRequest
  /**
   * The actionable checklist from docs 03 §5 row 1, rendered for the TUI.
   * Not "check the network" but real commands.
   */
  checklist: string[]
  /** The next time a re-probe should run; 5-minute cadence by default. */
  nextProbeAt: number
  /** Set when autoResume is on and the user has not opted out. */
  autoResume: boolean
}

export const DEFAULT_AUTO_RESUME = true

/**
 * Park a task that found no resource. Pure; the caller persists the
 * snapshot under the session key.
 */
export function park(req: Core.ResolveRequest, now = Date.now(), autoResume: boolean = DEFAULT_AUTO_RESUME): SuspendedSnapshot {
  return {
    at: now,
    request: req,
    checklist: [
      "① 配置 API key: freecode account add <provider>",
      "② 检查本地模型: freecode provider test ollama （未运行时: ollama serve）",
      "③ 网络/代理: 检查 endpoint 可达性（freecode doctor）",
    ],
    nextProbeAt: now + Core.SUSPENDED_REPROBE_MS,
    autoResume,
  }
}

/**
 * The result of one re-probe pass over the suspended task. Pure: given the
 * fresh candidate states, decide whether the task may resume and, if so,
 * on which resource.
 */
export interface ReProbeResult {
  resume: boolean
  binding?: string
  reason?: string
  /** When resume is false, the next pass runs at this time. */
  nextProbeAt: number
}

/**
 * One pass of the 5-minute background probe, docs 03 §5 and ADR-004.
 *
 * A probe pass applies the just-recorded probe outcomes to the candidates
 * (the state machine has already done that — the states passed in are the
 * post-probe ones) and then asks the picker whether anything is in. When
 * nothing is, the next pass is 5 minutes out. When something is, the task
 * resumes on the pick — and only automatically when `autoResume` is on;
 * otherwise the TUI asks "continue?".
 */
export function reProbe(
  snapshot: SuspendedSnapshot,
  candidates: readonly Candidate[],
  probeOutcomes: ReadonlyMap<string, { ok: boolean; kind?: "connection" | "http" }>,
  now = Date.now(),
): ReProbeResult {
  const req = snapshot.request
  const advanced = candidates.map((c) => {
    const outcome = probeOutcomes.get(`${c.spec.model.id}@${c.spec.account.id}`)
    if (!outcome) return c
    const health = onProbe(
      c.health,
      { ok: outcome.ok, kind: outcome.kind, at: now },
      probeOptions(c.spec.provider?.health),
      now,
    )
    return { ...c, health }
  })

  const inPool = pool(advanced, req, now, false)
  const anyUsable = inPool.length > 0 || pool(advanced, req, now, true).length > 0
  if (!anyUsable) {
    return {
      resume: false,
      reason: "still no eligible resource",
      nextProbeAt: now + Core.SUSPENDED_REPROBE_MS,
    }
  }

  // The first pick is scored against the plain pool; the caller (the
  // harness) records it as the resumed binding. Auto-resume is the
  // default; when it is off the harness asks the user first.
  const binding = inPool[0]
  return {
    resume: snapshot.autoResume,
    binding: binding ? `${binding.spec.model.id}@${binding.spec.account.id}` : undefined,
    reason: snapshot.autoResume ? "resource recovered, auto-resuming" : "resource recovered, confirm to resume",
    nextProbeAt: now + Core.SUSPENDED_REPROBE_MS,
  }
}

/**
 * A scheduled task (the harness runs it on the provider's probe interval):
 * a candidate in EXHAUSTED whose quota window has just reset gets its
 * re-probe fired here, back into the pool via DEGRADED.
 */
export function sweepQuotaWindows(candidates: readonly Candidate[], now: number): { next: Candidate[]; reAdmitted: string[] } {
  const reAdmitted: string[] = []
  const next = candidates.map((c) => {
    if (c.health.state !== "EXHAUSTED") return c
    const reset = c.health.quotaResetAt ?? (c.spec.account.quota ? Core.quotaWindowReset(c.spec.account.quota, now) : undefined)
    if (reset !== undefined && reset <= now) {
      const health = onQuotaReset(c.health, now)
      reAdmitted.push(`${c.spec.model.id}@${c.spec.account.id}`)
      return { ...c, health }
    }
    return c
  })
  return { next, reAdmitted }
}

