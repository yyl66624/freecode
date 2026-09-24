import type { Candidate } from "@/freecode/core/scoring"
import type { CandidateHealth, ProbeResult } from "@/freecode/core/state-machine"
import type { CandidateMetrics } from "@/freecode/core/metrics"
import {
  initialState,
  probeOptions,
  onCall as onCallHealth,
  onProbe as onProbeHealth,
} from "@/freecode/core/state-machine"
import { initialMetrics, onCall as onCallMetrics } from "@/freecode/core/metrics"
import type { Core } from "@/freecode/core/types"
import type { CallOutcome } from "@/freecode/core/state-machine"

/**
 * The injectable mock provider: deterministic fault injection at the
 * call level, not the network level. It produces `CallOutcome` /
 * `ProbeResult` objects that feed the real scheduler core, so every row
 * of docs 03 §5 can be reproduced end-to-end without a live endpoint.
 *
 * All randomness comes from a mulberry32 stream keyed on the configured
 * seed — same seed + same call sequence ⇒ identical outcomes, always.
 */

/** The kinds of injectable faults. */
export type FailureKind = "401" | "403" | "429" | "5xx" | "timeout" | "connection"

/**
 * The injectable behaviour profile for one candidate key
 * ("modelID@accountID"). Everything is deterministic: the failure draw
 * is the call index mixed into the seed.
 */
export interface MockProfile {
  /**
   * Failure rate in [0, 1]. The call at index i fails when
   * hash(seed, callIndex, i) / 2^32 < rate. 0 = never fails;
   * 1 = every call fails.
   */
  failureRate: number
  /** The fault produced when a call fails. */
  failWith?: FailureKind
  /**
   * Success latency, in ms. A `fixed` value is exact; a `range` gives a
   * deterministic band (call index chooses within it). Defaults to 200.
   */
  latency?: { fixed?: number; range?: [number, number] }
  /**
   * Quota ceiling. When set, successful calls decrement the remaining
   * counter; once it hits 0, all subsequent calls fail with 429
   * (EXHAUSTED) regardless of `failureRate`.
   */
  quota?: { limit: number; resetAt?: number }
}

/** The default profile: never fails, fixed 200 ms, no quota. */
export const defaultProfile: MockProfile = { failureRate: 0, latency: { fixed: 200 } }

/** The outcome of one call attempt. */
export interface CallResult {
  ok: boolean
  latencyMs?: number
  /** The HTTP status when the call failed with one (401/403/429/5xx). */
  status?: number
  /** True when the failure was a timeout. */
  timeout?: boolean
  /** True when the failure was a connection-level miss (offline / endpoint down). */
  connection?: boolean
  /** The failure kind, always present when ok === false. */
  kind?: FailureKind
  /** Whether the call hit the quota ceiling (429 from quota, not from the profile's failure rate). */
  quotaHit?: boolean
}

/** Deterministic 0..1 draw: same (seed, callIndex, streamIndex) ⇒ same value. */
function draw(seed: number, callIndex: number, streamIndex: number): number {
  let h = seed ^ 0x9e3779b9
  h = Math.imul(h ^ callIndex, 0x85ebca6b)
  h = Math.imul(h ^ streamIndex, 0xc2b2ae35)
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 0x27d4eb2f)
  h = (h ^ (h >>> 15)) >>> 0
  return h / 0x1_0000_0000
}

/** The deterministic success latency for a profile + call index. */
function latencyFor(profile: MockProfile, seed: number, callIndex: number): number {
  const spec = profile.latency
  if (spec?.fixed !== undefined) return spec.fixed
  const [lo, hi] = spec?.range ?? [100, 400]
  const d = draw(seed, callIndex, 0x51ed2701)
  return lo + Math.floor(d * (hi - lo + 1))
}

/** Map a FailureKind to the `CallOutcome` payload it produces. */
export function toCallOutcome(result: CallResult, at: number): CallOutcome {
  if (result.ok) return { ok: true, latencyMs: result.latencyMs ?? 0, at }
  if (result.timeout) return { ok: false, timeout: true, at }
  if (result.connection) return { ok: false, connection: true, at }
  if (result.status === 429) {
    return { ok: false, status: 429, at } as CallOutcome
  }
  return { ok: false, status: result.status ?? 500, at }
}

export class MockProvider {
  readonly seed: number
  private profiles: Map<string, MockProfile>
  /** Per-candidate call counter (determines which draw we're on). */
  private callIndex: Map<string, number>
  /** Per-candidate successful-call counter (drives quota decrement). */
  private successCount: Map<string, number>

  constructor(options: { seed: number; profiles?: Record<string, MockProfile> }) {
    this.seed = options.seed
    this.profiles = new Map(Object.entries(options.profiles ?? {}))
    this.callIndex = new Map()
    this.successCount = new Map()
  }

  /** The profile a candidate key gets; defaults when absent. */
  profileOf(key: string): MockProfile {
    return this.profiles.get(key) ?? defaultProfile
  }

  /** How many calls have been issued for a key so far (test inspection). */
  callsIssued(key: string): number {
    return this.callIndex.get(key) ?? 0
  }

  /**
   * The next call outcome for a candidate key. Pure over
   * (seed, key, callCount, profile) — two providers with the same seed
   * and the same call sequence return identical outcomes.
   */
  nextCall(key: string, now = 0): CallResult {
    const profile = this.profileOf(key)
    const i = this.callIndex.get(key) ?? 0
    this.callIndex.set(key, i + 1)

    // Quota ceiling: once spent, everything is 429 until the window rolls.
    if (profile.quota) {
      const spent = this.successCount.get(key) ?? 0
      if (spent >= profile.quota.limit) {
        return { ok: false, status: 429, kind: "429", quotaHit: true, latencyMs: 0 }
      }
    }

    // The deterministic failure draw.
    const d = draw(this.seed, i, 0x1f2e3d4c)
    const kind = profile.failWith ?? "5xx"
    if (d < profile.failureRate) {
      const status = statusForKind(kind)
      return {
        ok: false,
        kind,
        status,
        timeout: kind === "timeout" ? true : undefined,
        connection: kind === "connection" ? true : undefined,
        latencyMs: 0,
      }
    }

    const latencyMs = latencyFor(profile, this.seed, i)
    this.successCount.set(key, (this.successCount.get(key) ?? 0) + 1)
    return { ok: true, latencyMs }
  }

  /** The probe outcome for a key. Probes never count against the quota. */
  nextProbe(key: string, now = 0): ProbeResult {
    const result = this.nextCall(key, now)
    if (result.ok) return { ok: true, kind: "http", at: now }
    if (result.connection) return { ok: false, kind: "connection", at: now }
    return { ok: false, kind: "http", at: now }
  }

  /**
   * Feed one call into a candidate's health + metrics. Convenience for the
   * test harness: `applyCall` × N is the standard way to build a pool.
   */
  applyCall(
    key: string,
    health: CandidateHealth,
    metrics: CandidateMetrics,
    now: number,
  ): { health: CandidateHealth; metrics: CandidateMetrics; result: CallResult } {
    const result = this.nextCall(key, now)
    const outcome = toCallOutcome(result, now)
    const nextHealth = onCallHealth(health, outcome, probeOptions(), now)
    const nextMetrics = onCallMetrics(metrics, {
      ok: result.ok,
      ...(result.ok ? { latencyMs: result.latencyMs } : {}),
      at: now,
    })
    return { health: nextHealth, metrics: nextMetrics, result }
  }

  /** Feed one probe into a candidate's health (probes don't update metrics). */
  applyProbe(
    key: string,
    health: CandidateHealth,
    now: number,
  ): { health: CandidateHealth; result: ProbeResult } {
    const result = this.nextProbe(key, now)
    const nextHealth = onProbeHealth(health, result, probeOptions(), now)
    return { health: nextHealth, result }
  }

  /** Reset the call counters (the seed and profiles are kept). */
  reset(): void {
    this.callIndex.clear()
    this.successCount.clear()
  }

  /** A clone at its current position — same seed, same counters. */
  clone(): MockProvider {
    const copy = new MockProvider({ seed: this.seed, profiles: Object.fromEntries(this.profiles) })
    copy["callIndex"] = new Map(this.callIndex)
    copy["successCount"] = new Map(this.successCount)
    return copy
  }
}

/** Map a FailureKind to its representative HTTP status. */
export function statusForKind(kind: FailureKind): number | undefined {
  switch (kind) {
    case "401":
      return 401
    case "403":
      return 403
    case "429":
      return 429
    case "5xx":
      return 503
    default:
      return undefined
  }
}

/**
 * Build a scheduler-core `Candidate` from a spec by feeding `calls` calls
 * through the mock. This is the standard way to get a pool for
 * `SchedulerCore.resolve` in a §5 matrix scenario.
 */
export function buildCandidate(
  provider: MockProvider,
  spec: Core.CandidateSpec,
  calls: number,
  now: number,
): Candidate {
  const key = `${spec.model.id}@${spec.account.id}`
  let health = initialState(now)
  let metrics = initialMetrics()
  for (let i = 0; i < calls; i++) {
    const r = provider.applyCall(key, health, metrics, now + i * 1000)
    health = r.health
    metrics = r.metrics
  }
  const profile = provider.profileOf(key)
  // The mock's quota is a ceiling: at most `limit` successful calls. The
  // scheduler core reads a remaining fraction in [0,1]. Limit 0 → 0 spent,
  // so the fraction is `min(1, 0/calls)` — never NaN. A limit of N means
  // after N successes the next call 429s and the fraction is 0.
  const quotaRemaining = profile.quota
    ? Math.min(1, Math.max(0, calls === 0 ? 1 : (profile.quota.limit - calls) / Math.max(1, calls)))
    : undefined
  return { spec, health, metrics, quotaRemaining }
}

/**
 * The four named §5 fault scenarios, as one-line profile builders.
 * Keys are "modelID@accountID".
 */
export const scenarios = {
  /** All cloud candidates hard-failing 5xx (3 consecutive → UNHEALTHY). */
  cloudDown: (keys: string[]): Record<string, MockProfile> =>
    Object.fromEntries(keys.map((k) => [k, { failureRate: 1, failWith: "5xx" as const }])),

  /** Cloud 5xx + one healthy local Ollama candidate: the fallback path. */
  ollamaFallback: (cloudKeys: string[], ollamaKey: string): Record<string, MockProfile> => ({
    ...scenarios.cloudDown(cloudKeys),
    [ollamaKey]: { failureRate: 0, latency: { fixed: 2000 } },
  }),

  /** One account's quota is spent (429 → EXHAUSTED); the sibling is healthy. */
  quotaExhausted: (
    exhaustedKey: string,
    healthyKey: string,
    limit = 0,
    resetAt?: number,
  ): Record<string, MockProfile> => ({
    [exhaustedKey]: { failureRate: 0, quota: { limit, resetAt } },
    [healthyKey]: defaultProfile,
  }),

  /** Credentials 401/403 (second hit → INVALID). */
  invalidCredential: (
    keys: string[],
    kind: "401" | "403" = "401",
  ): Record<string, MockProfile> =>
    Object.fromEntries(keys.map((k) => [k, { failureRate: 1, failWith: kind } as MockProfile])),

  /** Offline: connection-level misses (3 → UNAVAILABLE, distinct from 5xx). */
  offline: (keys: string[]): Record<string, MockProfile> =>
    Object.fromEntries(keys.map((k) => [k, { failureRate: 1, failWith: "connection" as const }])),

  /** Timeouts (counted as health failures, distinct from "not started"). */
  timeout: (keys: string[]): Record<string, MockProfile> =>
    Object.fromEntries(keys.map((k) => [k, { failureRate: 1, failWith: "timeout" as const }])),
} as const

// The barrel consumers import: `import { MockProvider, scenarios, ... } from "@test/freecode/mock-provider"`.
export type { MockProfile, FailureKind, CallResult }
