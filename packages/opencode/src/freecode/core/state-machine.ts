export * as StateMachine from "./state-machine"

import * as Core from "./types"

/**
 * The candidate-level state machine, docs 03 §4.1.
 *
 * A candidate is a (model, account) binding, and state lives here — not at
 * the provider level — because one account failing must not take its sibling
 * accounts down. Provider-level "down" is derived for display only.
 *
 * States:
 *   HEALTHY      — serving. The normal resting state.
 *   DEGRADED     — a real call or probe failed but the threshold has not
 *                  been reached. Still in the pool, scored lower.
 *   UNHEALTHY    — failThreshold consecutive failures. Out of the pool until
 *                  recoveryThreshold consecutive successes (via the re-probe).
 *   EXHAUSTED     — the account's quota is spent. Out until the window
 *                  (calendar month / rolling 30d) resets, after which the
 *                  candidate re-enters via probe. Not an observation, a fact.
 *   INVALID      — credential 401/403 after one automatic retry, or the
 *                  account was manually disabled. Recovers only by credential
 *                  rotation or manual re-enable; never by probing.
 *   UNAVAILABLE  — the probe itself cannot reach the target (offline, or a
 *                  local model that is not running). Three consecutive
 *                  *connection-level* failures mark it, distinguishing
 *                  "broken" from "not on".
 *
 * Only two event kinds drive transitions: probe results, and real call
 * outcomes (docs 03 §4.1: 4xx → 401/403 INVALID, 429 → quota + reliability,
 * 5xx/timeout → health + latency). Everything else is derived.
 */

export type CandidateState = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "EXHAUSTED" | "INVALID" | "UNAVAILABLE"

export const IN_POOL: ReadonlySet<CandidateState> = new Set(["HEALTHY", "DEGRADED"])

/** The two ways a probe can fail, which are different states. */
export type ProbeFailureKind = "connection" | "http"

export interface ProbeResult {
  ok: boolean
  /** How it failed, when it did. "connection": could not reach the target at all. */
  kind?: ProbeFailureKind
  at: number
}

export type CallOutcome =
  | { ok: true; latencyMs: number; at: number }
  | { ok: false; status: 401 | 403; at: number; /** first automatic retry, docs 03 §5. */ retried?: boolean }
  | { ok: false; status: 429; at: number; resetAt?: number }
  | { ok: false; status: number; at: number } // 5xx and anything else
  | { ok: false; timeout: true; at: number }
  | { ok: false; connection: true; at: number }

export interface CandidateHealth {
  state: CandidateState
  /** Consecutive real-call/probe failures since the last success. */
  consecutiveFailures: number
  /** Consecutive successes since the last failure (drives recovery). */
  consecutiveSuccesses: number
  /** Consecutive connection-level probe failures (drives UNAVAILABLE). */
  connectionFailures: number
  /** True while the 401/403 single automatic retry has not happened yet. */
  awaitingAuthRetry?: boolean
  /** The quota window reset time set by a 429 with a known reset. */
  quotaResetAt?: number
  updatedAt: number
}

export interface StateMachineOptions {
  /** Consecutive failures that flip a candidate to UNHEALTHY. Docs: 3. */
  failThreshold?: number
  /** Consecutive successes that recover it. Docs: 2. */
  recoveryThreshold?: number
  /** Connection-level failures that flip a candidate to UNAVAILABLE. Docs: 3. */
  connectFailThreshold?: number
}

const DEFAULTS = { failThreshold: 3, recoveryThreshold: 2, connectFailThreshold: Core.CONNECT_FAILURE_THRESHOLD }

export function initialState(now = Date.now()): CandidateHealth {
  return {
    state: "HEALTHY",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    connectionFailures: 0,
    updatedAt: now,
  }
}

/** The default probe knobs for a provider, from its spec or the docs defaults. */
export function probeOptions(health?: Core.HealthSpec): Required<StateMachineOptions> {
  return {
    failThreshold: health?.failThreshold ?? DEFAULTS.failThreshold,
    recoveryThreshold: health?.recoveryThreshold ?? DEFAULTS.recoveryThreshold,
    connectFailThreshold: DEFAULTS.connectFailThreshold,
  }
}

/**
 * Apply a probe result. Pure: returns the next state; the caller persists it.
 *
 * A successful probe closes the failure streaks. An http failure counts as a
 * regular health failure (the target is reachable but answering badly —
 * "broken"). A connection failure is tracked separately: it is the
 * "not on" case, and only three of them in a row take the candidate out.
 */
export function onProbe(prev: CandidateHealth, result: ProbeResult, opts: StateMachineOptions = {}, now = Date.now()): CandidateHealth {
  const { failThreshold, recoveryThreshold, connectFailThreshold } = { ...DEFAULTS, ...opts }

  // Excluded candidates that only recover by an act of the user do not move
  // on probe outcomes: re-probing an expired key will never flip it back.
  if (prev.state === "INVALID" || prev.state === "EXHAUSTED") {
    // Even EXHAUSTED remembers nothing about probes; quota facts outlive health.
    return { ...prev, updatedAt: now }
  }

  const next = { ...prev, updatedAt: now }
  if (result.ok) {
    next.consecutiveSuccesses += 1
    next.consecutiveFailures = 0
    next.connectionFailures = 0
    if (next.state === "DEGRADED" && next.consecutiveSuccesses >= recoveryThreshold) next.state = "HEALTHY"
    else if (next.state === "UNHEALTHY" && next.consecutiveSuccesses >= recoveryThreshold) next.state = "HEALTHY"
    else if (next.state === "UNAVAILABLE") next.state = "DEGRADED" // it came back; treat cautiously
    return next
  }

  next.consecutiveSuccesses = 0
  next.consecutiveFailures += 1

  if (result.kind === "connection") {
    // Distinguish "broken" from "not on": connection-level misses keep the
    // candidate scoring-degraded until three in a row, then unavailable.
    next.connectionFailures += 1
    if (next.connectionFailures >= connectFailThreshold) next.state = "UNAVAILABLE"
    else if (next.state === "HEALTHY") next.state = "DEGRADED"
    return next
  }

  next.connectionFailures = 0
  if (next.consecutiveFailures >= failThreshold) next.state = "UNHEALTHY"
  else if (next.state === "HEALTHY") next.state = "DEGRADED"
  return next
}

/**
 * Apply a real call outcome, docs 03 §4.1 and §5:
 *
 *   401/403  → one automatic retry; a second one marks the candidate INVALID
 *              (credential rotated or account disabled; no auto-recovery).
 *   429      → quota: the candidate is EXHAUSTED for the window, and the
 *              failure also counts against reliability; a known reset time
 *              is remembered so the window can re-open exactly.
 *   5xx      → health failure.
 *   timeout  → health and latency observation.
 *   success  → closes failure streaks; two in a row recover a candidate.
 */
export function onCall(prev: CandidateHealth, outcome: CallOutcome, opts: StateMachineOptions = {}, now = Date.now()): CandidateHealth {
  const { failThreshold, recoveryThreshold } = { ...DEFAULTS, ...opts }
  const next = { ...prev, updatedAt: now }

  // The `timeout` and `connection` outcome variants do not carry a status;
  // narrow before reading it so the guards below are sound.
  const status: number | undefined = "timeout" in outcome || "connection" in outcome ? undefined : (outcome as { status?: number }).status

  if (outcome.ok === false && (status === 401 || status === 403)) {
    // The first 401/403 gets one automatic retry in case the token lapsed;
    // the second is authoritative. INVALID is terminal for the scheduler.
    if (!prev.awaitingAuthRetry) {
      next.awaitingAuthRetry = true
      // Until the retry answers, treat it like a failed health observation.
      next.consecutiveFailures += 1
      next.consecutiveSuccesses = 0
      if (next.consecutiveFailures >= failThreshold) next.state = "UNHEALTHY"
      else if (next.state === "HEALTHY") next.state = "DEGRADED"
      return next
    }
    next.state = "INVALID"
    next.awaitingAuthRetry = false
    next.consecutiveFailures = 0
    next.consecutiveSuccesses = 0
    return next
  }

  next.awaitingAuthRetry = false

  if (outcome.ok) {
    next.consecutiveSuccesses += 1
    next.consecutiveFailures = 0
    if (next.consecutiveSuccesses >= recoveryThreshold && (next.state === "DEGRADED" || next.state === "UNHEALTHY")) {
      next.state = "HEALTHY"
    }
    return next
  }

  next.consecutiveSuccesses = 0
  next.consecutiveFailures += 1

  if (status === 429) {
    // Quota fact: the account is spent for this window. The candidate leaves
    // the pool; the window reset (or clearing usage) brings it back.
    next.state = "EXHAUSTED"
    const resetAt = "resetAt" in outcome ? outcome.resetAt : undefined
    if (resetAt !== undefined) next.quotaResetAt = resetAt
    return next
  }

  // 5xx, timeout, other: a health observation.
  if (next.consecutiveFailures >= failThreshold) next.state = "UNHEALTHY"
  else if (next.state === "HEALTHY") next.state = "DEGRADED"
  return next
}

/** A quota window has reset (calendar month / rolling 30d): re-enter via probe. */
export function onQuotaReset(prev: CandidateHealth, now = Date.now()): CandidateHealth {
  const next = { ...prev, updatedAt: now }
  if (next.state === "EXHAUSTED") {
    next.state = "DEGRADED"
    next.quotaResetAt = undefined
    next.consecutiveFailures = 0
    next.consecutiveSuccesses = 0
  }
  return next
}

/**
 * A credential was rotated, or the user re-enabled the account: the only way
 * back out of INVALID, and it lands in DEGRADED until the recovery threshold
 * proves it works again.
 */
export function onCredentialRotated(prev: CandidateHealth, now = Date.now()): CandidateHealth {
  if (prev.state !== "INVALID") return prev
  return {
    ...prev,
    state: "DEGRADED",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    awaitingAuthRetry: false,
    updatedAt: now,
  }
}

/** A manual disable of the account. INVALID, and stays so until re-enabled. */
export function onDisabled(prev: CandidateHealth, now = Date.now()): CandidateHealth {
  return { ...prev, state: "INVALID", updatedAt: now }
}

/** A manual re-enable of the account. */
export function onEnabled(prev: CandidateHealth, now = Date.now()): CandidateHealth {
  if (prev.state !== "INVALID") return prev
  return onCredentialRotated(prev, now)
}
