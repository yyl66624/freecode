export * as Scoring from "./scoring"

import * as Core from "./types"
import { IN_POOL, onQuotaReset, type CandidateState, type CandidateHealth } from "./state-machine"
import { Metrics, latencyMs, reliabilityOf } from "./metrics"

/**
 * The six-dimension scorer, docs 03 §3.
 *
 * A candidate is a (model, account) binding with a state-machine block, a
 * metrics block, and the static facts from the four-layer specs. Scoring is
 * deliberately transparent arithmetic — when a task lands on an unexpected
 * resource the explanation has to be readable off the numbers, and `dims`
 * exists for exactly that. The hard constraints (capability, features,
 * pool state, account enabled, quota remaining) are *filters*, kept
 * separate from scoring so a low score can never be mistaken for a hard
 * no (docs 03 §2: a capability miss is "unusable", not "low").
 *
 * Every function here is a pure function of (spec, state, request, now),
 * which is what makes the audit log replayable: the same `state.json`
 * snapshot plus the same request always produces the same pick.
 */

/** One candidate as the scheduler sees it: spec + state. */
export interface Candidate {
  spec: Core.CandidateSpec
  health: CandidateHealth
  metrics: Metrics.CandidateMetrics
  /**
   * Remaining quota fraction in [0, 1], when the account declares a budget
   * and the store has tracked usage. Absent when the budget is unknown —
   * the quota term scores 1 in that case, because an unknown ceiling must
   * not be a penalty.
   */
  quotaRemaining?: number
}

/** How the pool came to be: the ordinary path or the relaxed one. */
export interface PoolContext {
  relaxed: boolean
}

/**
 * Hard constraints, docs 03 §2 and the §3.3 pool definition. A candidate
 * failing any of these leaves the pool entirely — no score, no penalty,
 * exclusion.
 */
export function eligible(c: Candidate, req: Core.ResolveRequest, now: number, ctx: PoolContext): string[] {
  const out: string[] = []
  const features = ctx.relaxed ? [] : (req.requiredFeatures ?? [])
  if (Core.tierIndex(c.spec.model.tier) < Core.tierIndex(req.capability)) out.push("capability")
  if (!features.every((f) => c.spec.model.capabilities.includes(f))) out.push("feature")
  if (!IN_POOL.has(c.health.state)) out.push("state")
  if (c.spec.account.enabled === false) out.push("account-disabled")
  // Quota: a 429 with no reset is EXHAUSTED until the window rolls.
  if (c.health.state === "EXHAUSTED") {
    const reset = c.health.quotaResetAt ?? (c.spec.account.quota ? Core.quotaWindowReset(c.spec.account.quota, now) : undefined)
    if (reset === undefined || reset > now) out.push("quota-exhausted")
  }
  if (typeof c.quotaRemaining === "number" && c.quotaRemaining <= 0) out.push("quota-remaining")
  return out
}

/** True when the candidate passes the hard filters for this request. */
export function inPool(c: Candidate, req: Core.ResolveRequest, now: number, ctx: PoolContext): boolean {
  return eligible(c, req, now, ctx).length === 0
}

/** The pool definition from docs 03 §3.3. */
export function pool(candidates: readonly Candidate[], req: Core.ResolveRequest, now: number, relaxed: boolean): Candidate[] {
  const ctx: PoolContext = { relaxed }
  return candidates.filter((c) => inPool(c, req, now, ctx))
}

/**
 * The hard filter, docs 03 §2: tier and features. Kept separate from
 * `inPool` because the *pick* function wants it, and a capability miss
 * must stay visible as its own exclusion rather than lumped with the
 * dynamic state checks.
 */
export function hardFilter(c: Candidate, req: Core.ResolveRequest, relaxed: boolean): boolean {
  const tierOk = Core.tierIndex(c.spec.model.tier) >= Core.tierIndex(req.capability)
  if (!tierOk) return false
  if (relaxed) return true // the relaxed path drops the "long-context"-style features
  return (req.requiredFeatures ?? []).every((f) => c.spec.model.capabilities.includes(f))
}

export interface Terms {
  capability: number
  quota: number
  health: number
  latency: number
  reliability: number
  cost: number
}

/** The six normalised terms, docs 03 §3.1. All in [0, 1], higher is better. */
export function dims(c: Candidate, req: Core.ResolveRequest, poolCosts: readonly number[]): Terms {
  const delta = Core.tierIndex(c.spec.model.tier) - Core.tierIndex(req.capability)
  return {
    // Exact match scores 1; each tier of margin above is worth 0.25. A
    // tier above the request is wasted capability, which is exactly what
    // the request did not ask for.
    capability: 1 - Math.min(1, Math.max(0, delta) * 0.25),
    // A declared budget that is spent scores 0; an unknown ceiling scores 1.
    quota: c.quotaRemaining === undefined ? 1 : Math.min(1, Math.max(0, c.quotaRemaining)),
    // The state machine is the source of truth for health; the term is a
    // mapping onto [0,1] for the weighted sum.
    health: healthTerm(c.health.state),
    // P50 EWMA (or the vendor prior) against the 8s budget, docs 03 §3.1.
    latency: Math.max(0, 1 - latencyMs(c.metrics, c.spec.provider?.id ?? c.spec.model.provider) / Core.LATENCY_BUDGET_MS),
    // Windowed success rate with the 0.9 cold-start prior, docs 03 §3.2.
    reliability: reliabilityOf(c.metrics),
    // 1 − cost(c) over the eligible pool's cost; an all-free pool is all 1s.
    cost: costTerm(c, poolCosts),
  }
}

export function healthTerm(state: CandidateState): number {
  switch (state) {
    case "HEALTHY":
      return 1
    case "DEGRADED":
      return 0.5
    case "UNHEALTHY":
    case "EXHAUSTED":
      return 0
    default:
      // INVALID / UNAVAILABLE are filtered out before scoring; 0 is the
      // safe fallback if one ever slips through.
      return 0
  }
}

export function costTerm(c: Candidate, poolCosts: readonly number[]): number {
  const cost = costOf(c.spec.model)
  const max = poolCosts.length ? Math.max(...poolCosts) : 0
  if (max <= 0) return 1 // all-free or unknown-cost pool: no cost signal
  if (cost <= 0) return 1 // a free candidate beats the paid ones slightly
  return Math.max(0, 1 - cost / max)
}

/** The candidate's cost in its declared currency, 0 = free/unknown. */
export function costOf(model: Core.ModelSpec): number {
  return model.costPerMtok ? model.costPerMtok.output + model.costPerMtok.input : 0
}

export interface Weighted {
  candidate: Candidate
  terms: Terms
  score: number
}

/** The total score, docs 03 §3.1: Σ dᵢ·wᵢ. */
export function weightedScore(c: Candidate, req: Core.ResolveRequest, poolCosts: readonly number[], weights: Core.SchedulerWeights): number {
  const t = dims(c, req, poolCosts)
  return (
    t.capability * weights.capability +
    t.quota * weights.quota +
    t.health * weights.health +
    t.latency * weights.latency +
    t.reliability * weights.reliability +
    t.cost * weights.cost
  )
}

/** Normalise user-supplied weights so they sum to 1, docs 03 §3.1. */
export function normaliseWeights(w: Core.SchedulerWeights): Core.SchedulerWeights {
  const sum = Object.values(w).reduce((a, b) => a + b, 0)
  if (sum <= 0) return Core.DEFAULT_WEIGHTS
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, (v as number) / sum])) as unknown as Core.SchedulerWeights
}

export interface Pick {
  candidate: Candidate
  terms: Terms
  score: number
  /** "sticky" when the session kept its binding; "score" otherwise. */
  path: "score" | "sticky"
  /** Set when the pick came from the relaxed pool. */
  degradedPath?: true
  /** Which candidates were excluded and why, for the audit log. */
  excluded: Array<{ id: string; reason: string }>
}

/**
 * The pick, docs 03 §3.3.
 *
 * 1. The pool under the hard filters; when it is empty, the relaxed pool
 *    (requiredFeatures dropped). Both empty → `undefined`, the caller turns
 *    that into NoResourceError and the SUSPENDED path.
 * 2. Every pool candidate is scored; the best wins.
 * 3. Within EPS of the runner-up, jitter: the faster P50 wins, and if that
 *    is still a tie, the account with more remaining concurrency — a live
 *    tie-break, not a random coin.
 * 4. The session's current binding keeps its seat while its score stays
 *    within STICKY_DELTA of the winner; a manual override is terminal and
 *    skips sticky comparison entirely.
 */
export function pick(
  candidates: readonly Candidate[],
  req: Core.ResolveRequest,
  opts: {
    weights?: Core.SchedulerWeights
    /** The session's current binding, e.g. "deepseek/deepseek-chat@deepseek-main". */
    current?: string
    /** Set when the caller's binding is a manual override (sticky is off for it). */
    override?: boolean
    eps?: number
    stickyDelta?: number
    now?: number
    /** Random tie-break seed, injectable so replay stays deterministic. */
    jitterSeed?: number
  } = {},
): Pick | undefined {
  const weights = normaliseWeights(opts.weights ?? Core.DEFAULT_WEIGHTS)
  const eps = opts.eps ?? Core.DEFAULT_TIE_EPS
  const stickyDelta = opts.stickyDelta ?? Core.DEFAULT_STICKY_DELTA
  const now = opts.now ?? Date.now()

  const strict = pool(candidates, req, now, false)
  const useRelaxed = strict.length === 0
  const inPool = useRelaxed ? pool(candidates, req, now, true) : strict
  if (inPool.length === 0) return undefined

  const poolCosts = inPool.map((c) => costOf(c.spec.model))
  const scored: Weighted[] = inPool.map((c) => ({
    candidate: c,
    terms: dims(c, req, poolCosts),
    score: weightedScore(c, req, poolCosts, weights),
  }))
  scored.sort((a, b) => b.score - a.score || a.candidate.spec.model.id.localeCompare(b.candidate.spec.model.id))

  let [top, runnerUp] = [scored[0], scored[1]]
  if (runnerUp && top.score - runnerUp.score < eps) {
    // The jittered tie-break, docs 03 §3.3: latency first, then the
    // account's remaining concurrency. A deterministic fallback to the
    // seed keeps replay honest when both tie on those too.
    const jitter = jitterValue(opts.jitterSeed ?? 0, top.candidate.spec.model.id, runnerUp.candidate.spec.model.id)
    const topLat = latencyMs(top.candidate.metrics, top.candidate.spec.provider?.id ?? top.candidate.spec.model.provider)
    const upLat = latencyMs(runnerUp.candidate.metrics, runnerUp.candidate.spec.provider?.id ?? runnerUp.candidate.spec.model.provider)
    const conc = (c: Candidate) => c.spec.account.concurrency ?? 1
    const topWins = topLat < upLat || (topLat === upLat && (conc(top.candidate) > conc(runnerUp.candidate) || (conc(top.candidate) === conc(runnerUp.candidate) && jitter < 0.5)))
    if (!topWins) [top, runnerUp] = [runnerUp, top]
  }

  const binding = (c: Candidate) => `${c.spec.model.id}@${c.spec.account.id}`
  const excluded: Pick["excluded"] = []
  for (const c of candidates) {
    const why = inPool.includes(c) ? undefined : eligible(c, req, now, { relaxed: useRelaxed })[0]
    if (why) excluded.push({ id: binding(c), reason: why })
  }

  // Sticky routing, docs 03 §4.2.
  if (!opts.override && opts.current !== undefined) {
    const currentIn = scored.find((row) => binding(row.candidate) === opts.current)
    if (currentIn && top.score - currentIn.score <= stickyDelta) {
      return {
        candidate: currentIn.candidate,
        terms: currentIn.terms,
        score: currentIn.score,
        path: "sticky",
        degradedPath: useRelaxed ? true : undefined,
        excluded,
      }
    }
    // The current binding has fallen out of the pool, or is more than
    // STICKY_DELTA behind: the session rebinds to the winner.
    return {
      candidate: top.candidate,
      terms: top.terms,
      score: top.score,
      path: "score",
      degradedPath: useRelaxed ? true : undefined,
      excluded,
    }
  }

  return {
    candidate: top.candidate,
    terms: top.terms,
    score: top.score,
    path: "score",
    degradedPath: useRelaxed ? true : undefined,
    excluded,
  }
}

/** A stable 0..1 value from a seed and two ids — same inputs, same jitter. */
function jitterValue(seed: number, a: string, b: string): number {
  let h = seed
  for (const ch of `${a}|${b}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h / 0x1_0000_0000
}

/**
 * The quota-window reset check, docs 03 §5: a scheduled task calls this
 * and candidates in EXHAUSTED whose window has rolled are re-admitted via
 * the probe. Pure: returns a new candidate list with their state advanced.
 */
export function admitResetWindows(candidates: readonly Candidate[], now: number): Candidate[] {
  return candidates.map((c) => {
    if (c.health.state !== "EXHAUSTED") return c
    const reset = c.health.quotaResetAt ?? (c.spec.account.quota ? Core.quotaWindowReset(c.spec.account.quota, now) : undefined)
    if (reset !== undefined && reset <= now) {
      return { ...c, health: onQuotaReset(c.health, now) }
    }
    return c
  })
}
