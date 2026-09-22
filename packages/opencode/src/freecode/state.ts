export * as ResourceState from "./state"

import path from "path"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { Global } from "@opencode-ai/core/global"
import type { Health, Quota } from "./scheduler"
import type { FailureClass } from "./failure"

/**
 * Durable per-resource observations, including the circuit breaker.
 *
 * The scheduler's input is not configuration, it is what the pool has actually
 * done: what failed and why, what it cost, how fast it was, whether a provider
 * said we are out of quota. None of that survives a process restart unless it is
 * written down, and a scheduler that forgets a rate limit on restart is worse
 * than one that never learned it.
 *
 * The store is deliberately small and boring — one JSON file, synchronous I/O,
 * atomic replace — because it is read on every routing decision and must never be
 * the reason a task is slow or fails. Corruption is survivable: an unreadable
 * file is treated as empty.
 */

/**
 * Circuit breaker states.
 *
 * `closed`  — normal. Failures are counted.
 * `open`    — excluded from scheduling until `retryAt`. Set by consecutive
 *             failures, or immediately by a rate limit with a known reset.
 * `half_open` — the cooldown expired; exactly one probe is allowed. A success
 *             closes the circuit, a failure reopens it for longer than before.
 *
 * `half_open` is deliberately not automatic: letting a resource back in purely
 * because time passed, with no probe, is how a broken account gets a share of
 * every round-robin.
 */
export type CircuitState = "closed" | "open" | "half_open"

export interface Circuit {
  state: CircuitState
  consecutiveFailures: number
  lastFailureAt?: number
  /** When an `open` circuit may next be probed. */
  retryAt?: number
  /** What opened it, for the `/why` report. */
  reason?: FailureClass
}

export interface ResourceState {
  /** Attempts observed in this process and previous ones. */
  attempts: number
  successes: number
  /** Failures attributed to the provider rather than the task. */
  providerFailures: number
  health: Health
  quota?: Quota
  /** Rolling time for successful attempts. Used by the latency term. */
  totalLatencyMs: number
  latencySamples: number
  circuit: Circuit
  /** Exponentially weighted latency, in milliseconds. Reacts faster than the mean. */
  latencyEMA?: number
  /** Exponentially weighted success rate in [0, 1]. */
  successEMA?: number
  updatedAt: number
}

export interface Snapshot {
  version: 2
  resources: Record<string, ResourceState>
}

const VERSION = 2

// Consecutive provider failures before the circuit opens.
export const CIRCUIT_THRESHOLD = 3

// Default cooldown when the provider gave no reset time. Short on purpose: the
// cost of a premature probe is one failed request, while the cost of a long
// cooldown is a capable resource sitting idle.
export const CIRCUIT_OPEN_MS = 60_000

// A re-opened circuit after a failed probe waits longer, so a persistently broken
// account cannot consume a probe on every request.
export const CIRCUIT_BACKOFF_MULTIPLIER = 3
export const CIRCUIT_MAX_OPEN_MS = 30 * 60_000

// A rate limit without a stated reset still deserves a real cooldown.
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000

// Weight of the newest sample in the exponential moving averages. 0.3 reacts to a
// change within a handful of requests without letting one outlier dominate.
const EMA_ALPHA = 0.3

export function empty(): ResourceState {
  return {
    attempts: 0,
    successes: 0,
    providerFailures: 0,
    health: "available",
    totalLatencyMs: 0,
    latencySamples: 0,
    circuit: { state: "closed", consecutiveFailures: 0 },
    updatedAt: Date.now(),
  }
}

/**
 * On-disk location.
 *
 * Under the global data directory rather than a project, because an account's
 * quota and health are properties of the account, shared by every project that
 * uses it.
 */
export function file(): string {
  return path.join(Global.Path.data, "resources.json")
}

export function load(): Snapshot {
  const location = file()
  if (!existsSync(location)) return { version: VERSION, resources: {} }
  try {
    const parsed = JSON.parse(readFileSync(location, "utf8"))
    if (!isRecord(parsed) || !isRecord(parsed.resources)) return { version: VERSION, resources: {} }
    const resources: Record<string, ResourceState> = {}
    for (const [id, value] of Object.entries(parsed.resources)) {
      const state = normalise(value)
      if (state) resources[id] = state
    }
    return { version: VERSION, resources }
  } catch {
    // An unreadable or corrupt file must not stop routing. Losing the history is
    // recoverable; refusing to start is not.
    return { version: VERSION, resources: {} }
  }
}

export function save(snapshot: Snapshot): void {
  const location = file()
  try {
    mkdirSync(path.dirname(location), { recursive: true })
    // Write-then-rename so a crash mid-write cannot leave a truncated file that
    // the next run would have to discard.
    const temporary = `${location}.tmp`
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2))
    renameSync(temporary, location)
  } catch {
    // Best effort by design: failing to record an observation is not a reason to
    // fail the request that produced it.
  }
}

/**
 * Read a resource's state, promoting an expired `open` circuit to `half_open`.
 *
 * Promotion happens on read rather than on a timer, so a process that was not
 * running when the cooldown expired still makes the right decision immediately.
 */
export function read(snapshot: Snapshot, id: string, now = Date.now()): ResourceState | undefined {
  const state = snapshot.resources[id]
  if (!state) return undefined
  if (state.circuit.state !== "open") return state
  if (state.circuit.retryAt && state.circuit.retryAt > now) return state
  return { ...state, circuit: { ...state.circuit, state: "half_open" } }
}

/** Promote every expired circuit in a snapshot. Used before scheduling. */
export function promote(snapshot: Snapshot, now = Date.now()): Snapshot {
  const resources: Record<string, ResourceState> = {}
  for (const [id, state] of Object.entries(snapshot.resources)) {
    resources[id] = read(snapshot, id, now) ?? state
  }
  return { version: VERSION, resources }
}

/**
 * Read one persisted resource record, including pre-breaker shapes.
 *
 * Exported so the migration from version 1 is testable without filesystem I/O:
 * losing a known rate limit on upgrade is exactly the failure this store exists
 * to prevent, so it should not be the one path with no test.
 */
export function fromPersisted(value: unknown): ResourceState | undefined {
  return normalise(value)
}

function normalise(value: unknown): ResourceState | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.attempts !== "number" || typeof value.successes !== "number") return undefined
  return {
    attempts: value.attempts,
    successes: value.successes,
    providerFailures: typeof value.providerFailures === "number" ? value.providerFailures : 0,
    health: isHealth(value.health) ? value.health : "available",
    quota: isQuota(value.quota) ? value.quota : undefined,
    totalLatencyMs: typeof value.totalLatencyMs === "number" ? value.totalLatencyMs : 0,
    latencySamples: typeof value.latencySamples === "number" ? value.latencySamples : 0,
    circuit: normaliseCircuit(value.circuit, value),
    latencyEMA: typeof value.latencyEMA === "number" ? value.latencyEMA : undefined,
    successEMA: typeof value.successEMA === "number" ? value.successEMA : undefined,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  }
}

/**
 * Read the circuit, migrating the pre-breaker shape.
 *
 * Version 1 kept `consecutiveFailures` and `circuitOpenUntil` at the top level.
 * Those files exist on developer machines, so they are read rather than
 * discarded: losing a known rate limit on upgrade is exactly the failure this
 * store is meant to prevent.
 */
function normaliseCircuit(value: unknown, legacy: Record<string, any>): Circuit {
  if (isRecord(value)) {
    return {
      state: isCircuitState(value.state) ? value.state : "closed",
      consecutiveFailures: typeof value.consecutiveFailures === "number" ? value.consecutiveFailures : 0,
      lastFailureAt: typeof value.lastFailureAt === "number" ? value.lastFailureAt : undefined,
      retryAt: typeof value.retryAt === "number" ? value.retryAt : undefined,
      reason: typeof value.reason === "string" ? (value.reason as FailureClass) : undefined,
    }
  }
  const openUntil = typeof legacy.circuitOpenUntil === "number" ? legacy.circuitOpenUntil : undefined
  return {
    state: openUntil && openUntil > Date.now() ? "open" : "closed",
    consecutiveFailures: typeof legacy.consecutiveFailures === "number" ? legacy.consecutiveFailures : 0,
    retryAt: openUntil,
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null
}

function isHealth(value: unknown): value is Health {
  return value === "available" || value === "degraded" || value === "unavailable"
}

function isCircuitState(value: unknown): value is CircuitState {
  return value === "closed" || value === "open" || value === "half_open"
}

function isQuota(value: unknown): value is Quota {
  if (!isRecord(value)) return false
  return (
    (value.status === "healthy" || value.status === "low" || value.status === "exhausted" || value.status === "unknown") &&
    typeof value.updatedAt === "number"
  )
}

/** Fold one observed success into a resource's state. Pure, so it is testable. */
export function recordSuccess(previous: ResourceState | undefined, latencyMs: number, at = Date.now()): ResourceState {
  const state = previous ? clone(previous) : empty()
  state.attempts += 1
  state.successes += 1
  state.health = "available"
  // A probe that works closes the circuit outright; anything else would leave the
  // resource in half-open and probe forever.
  state.circuit = { state: "closed", consecutiveFailures: 0 }
  if (latencyMs > 0) {
    state.totalLatencyMs += latencyMs
    state.latencySamples += 1
    state.latencyEMA = ema(state.latencyEMA, latencyMs)
  }
  state.successEMA = ema(state.successEMA, 1)
  state.updatedAt = at
  return state
}

export interface FailureInput {
  /** Why it failed, from `failure.ts`. */
  class: FailureClass
  /** True when another resource might succeed. */
  resource: boolean
  /** Exact reset time, when the provider stated one. */
  resetAt?: number
  at?: number
}

/**
 * Fold one failure into a resource's state.
 *
 * The resource/task distinction is the whole point: a task that fails because the
 * code is hard is not evidence against the account, and treating it as such is
 * how a scheduler learns to avoid its best model. Task failures count as attempts
 * — so reliability stays honest — and nothing else.
 */
export function recordFailure(previous: ResourceState | undefined, input: FailureInput): ResourceState {
  const at = input.at ?? Date.now()
  const state = previous ? clone(previous) : empty()
  state.attempts += 1
  state.updatedAt = at

  if (!input.resource) {
    state.successEMA = ema(state.successEMA, 0)
    return state
  }

  state.providerFailures += 1
  state.successEMA = ema(state.successEMA, 0)
  state.circuit = {
    ...state.circuit,
    consecutiveFailures: state.circuit.consecutiveFailures + 1,
    lastFailureAt: at,
    reason: input.class,
  }

  // A rate limit or quota exhaustion is authoritative and should exclude the
  // resource immediately: the provider told us to stop, so counting to a
  // threshold first would spend requests re-learning what we were just told.
  if (input.class === "rate_limit" || input.class === "quota") {
    const retryAt = input.resetAt ?? at + RATE_LIMIT_COOLDOWN_MS
    state.quota = {
      status: "exhausted",
      source: input.resetAt ? "header" : "estimated",
      remaining: 0,
      resetAt: retryAt,
      updatedAt: at,
    }
    state.circuit.retryAt = retryAt
    state.circuit.state = "open"
    state.health = "degraded"
    return state
  }

  // A failed probe is a strong signal: the resource was given its chance after a
  // cooldown and failed again, so back off further rather than re-probing soon.
  if (state.circuit.state === "half_open") {
    const previousWait = state.circuit.retryAt ? Math.max(CIRCUIT_OPEN_MS, at - state.circuit.retryAt + CIRCUIT_OPEN_MS) : CIRCUIT_OPEN_MS
    const wait = Math.min(CIRCUIT_MAX_OPEN_MS, previousWait * CIRCUIT_BACKOFF_MULTIPLIER)
    state.circuit.retryAt = at + wait
    state.circuit.state = "open"
    state.health = "unavailable"
    return state
  }

  if (state.circuit.consecutiveFailures >= CIRCUIT_THRESHOLD) {
    state.circuit.retryAt = at + CIRCUIT_OPEN_MS
    state.circuit.state = "open"
    state.health = "unavailable"
    return state
  }

  state.health = "degraded"
  return state
}

function clone(state: ResourceState): ResourceState {
  return { ...state, circuit: { ...state.circuit }, quota: state.quota ? { ...state.quota } : undefined }
}

function ema(previous: number | undefined, sample: number): number {
  if (previous === undefined) return sample
  return previous * (1 - EMA_ALPHA) + sample * EMA_ALPHA
}

export function averageLatency(state: ResourceState | undefined): number | undefined {
  if (!state || state.latencySamples === 0) return undefined
  return state.totalLatencyMs / state.latencySamples
}

/** Whether the scheduler may attempt this resource right now. */
export function usable(state: ResourceState | undefined, now = Date.now()): boolean {
  if (!state) return true
  const circuit = state.circuit
  if (circuit.state === "open") return circuit.retryAt !== undefined && circuit.retryAt <= now
  if (circuit.state === "half_open") return true
  if (state.health === "unavailable") return false
  if (state.quota?.status === "exhausted") {
    // An exhausted quota is only a reason to wait until the window resets.
    return state.quota.resetAt !== undefined && state.quota.resetAt <= now
  }
  return true
}

/** Why a resource is currently excluded, for the `/why` report. */
export function exclusionReason(state: ResourceState | undefined, now = Date.now()): string | undefined {
  if (!state) return undefined
  if (state.circuit.state === "open") {
    const seconds = state.circuit.retryAt ? Math.max(0, Math.round((state.circuit.retryAt - now) / 1000)) : 0
    return `circuit open (${state.circuit.reason ?? "failure"}), retrying in ${seconds}s`
  }
  if (state.health === "unavailable") return "health unavailable"
  if (state.quota?.status === "exhausted") {
    const seconds = state.quota.resetAt ? Math.max(0, Math.round((state.quota.resetAt - now) / 1000)) : 0
    return `quota exhausted, resets in ${seconds}s`
  }
  return undefined
}
