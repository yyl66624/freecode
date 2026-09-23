export * as Metrics from "./metrics"

import * as Core from "./types"

/**
 * Dynamic-metric math for the six dimensions: latency EWMA, sliding-window
 * reliability with Laplace smoothing, cold-start priors, and the 24h
 * staleness rule from docs 03 §8.
 *
 * These are the numbers the scorer consumes; the scorer (scoring.ts) decides
 * how they become [0,1] terms. Keeping the math here, pure and testable, is
 * what makes the audit log replayable: a `state.json` snapshot plus the
 * request is a fully determined input to `Scorer.dims`.
 */

export interface CallObservation {
  ok: boolean
  /** Observed latency of a successful call, in milliseconds. */
  latencyMs?: number
  at: number
}

/** One recent call, for the sliding-window reliability. */
interface WindowCall {
  ok: boolean
  at: number
}

export interface CandidateMetrics {
  /**
   * Exponentially weighted P50 latency, in milliseconds. Reacts within a few
   * calls; `undefined` until the first observation, in which case the
   * latency prior applies.
   */
  latencyEwmaMs?: number
  /**
   * Windowed reliability: (successes + α) / (total + β) with α = β = 1,
   * Laplace-smoothed so a candidate with fewer than ten samples leans to
   * the 0.9 cold-start prior rather than being all-penalty, docs 03 §3.2.
   */
  reliability?: number
  /** Window sample count, for the audit log and the TUI. */
  windowSamples?: number
  /** Total calls served since first registration. */
  totalCalls?: number
  /** True while the candidate is inside its first-contact sampling window. */
  sampling?: boolean
  /** When the sampling window opened. */
  samplingSince?: number
  lastObservedAt?: number
  /** The sliding window itself, persisted so a restart does not forget it. */
  window?: WindowCall[]
}

/**
 * Weight of the newest sample, docs 03 §3.2: 0.3 reacts to a change within a
 * handful of calls without letting a single outlier dominate.
 */
export const LATENCY_EMA_ALPHA = 0.3

export function initialMetrics(): CandidateMetrics {
  return { sampling: true, samplingSince: Date.now(), window: [] }
}

/**
 * Fold one call outcome into a candidate's metrics. Pure.
 *
 * Failures take no latency sample — a slow failure is a failure, and it is
 * already scored through the health and reliability terms.
 */
export function onCall(prev: CandidateMetrics | undefined, obs: CallObservation, now = Date.now()): CandidateMetrics {
  const base: CandidateMetrics = prev ?? initialMetrics()
  const next: CandidateMetrics = {
    ...base,
    window: [...(base.window ?? []), { ok: obs.ok, at: obs.at }],
    totalCalls: (base.totalCalls ?? 0) + 1,
    lastObservedAt: obs.at,
  }

  if (obs.ok && typeof obs.latencyMs === "number" && obs.latencyMs > 0) {
    next.latencyEwmaMs =
      next.latencyEwmaMs === undefined
        ? obs.latencyMs
        : next.latencyEwmaMs * (1 - LATENCY_EMA_ALPHA) + obs.latencyMs * LATENCY_EMA_ALPHA
  }

  // The window: the smaller of the last hour and the last 100 calls.
  const calls = next.window!.slice(-Core.RELIABILITY_WINDOW_CALLS)
  const windowed = calls.filter((call) => call.at >= obs.at - Core.RELIABILITY_WINDOW_MS)
  next.window = windowed
  const successes = windowed.filter((call) => call.ok).length
  next.windowSamples = windowed.length
  // Laplace smoothing: (s + α) / (n + β) with α = β = 1 — with n = 0 the
  // value is the cold-start prior 0.9, with more samples it converges to the
  // raw success rate.
  next.reliability = (successes + 1) / (windowed.length + 2)

  // Leave the sampling window once either boundary is hit, docs 03 §7.
  if (next.sampling && ((next.totalCalls ?? 0) >= Core.STEADY_AFTER_CALLS || obs.at - (next.samplingSince ?? obs.at) >= Core.STEADY_AFTER_MS)) {
    next.sampling = false
  }

  void now
  return next
}

/**
 * Staleness on load, docs 03 §8: dynamic values older than 24h go back to
 * priors (latency → vendor prior, reliability → undefined → prior at
 * scoring time) while the static facts are kept. EXHAUSTED and INVALID are
 * *facts*, not observations — they never go stale, and this function does
 * not touch the state machine, only the metric block.
 */
export function applyStaleness(metrics: CandidateMetrics, provider: string, now = Date.now()): CandidateMetrics {
  const next = { ...metrics }
  const age = now - (next.lastObservedAt ?? now)
  if (age >= Core.DYNAMIC_MAX_AGE_MS) {
    next.latencyEwmaMs = Core.PRIOR[provider] ?? Core.PRIOR.default
    next.reliability = undefined
    next.windowSamples = 0
    next.window = []
    next.sampling = false
  }
  return next
}

/**
 * The latency prior for a vendor with no observation yet, docs 03 §6/§7:
 * the cold start does not pretend to know a vendor's speed, it uses the
 * documented default P50 and learns from the first shadow calls.
 */
export function latencyMs(metrics: CandidateMetrics | undefined, provider: string): number {
  if (metrics?.latencyEwmaMs !== undefined && metrics.latencyEwmaMs > 0) return metrics.latencyEwmaMs
  return Core.PRIOR[provider] ?? Core.PRIOR.default
}

/**
 * The reliability to score with, docs 03 §3.1: the windowed rate when the
 * candidate has observations, otherwise the 0.9 cold-start prior so a fresh
 * resource gets a chance instead of scoring zero on a metric nobody has
 * measured.
 */
export function reliabilityOf(metrics: CandidateMetrics | undefined): number {
  return metrics?.reliability ?? Core.COLD_START_RELIABILITY
}
