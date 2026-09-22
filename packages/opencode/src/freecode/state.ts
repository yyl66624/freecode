export * as ResourceState from "./state"

import path from "path"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { Global } from "@opencode-ai/core/global"
import type { Health, Quota } from "./scheduler"

/**
 * Durable per-resource observations.
 *
 * The scheduler's input is not configuration, it is what the pool has actually
 * done: what failed, what it cost, how fast it was, whether a provider told us
 * we are out of quota. None of that survives a process restart unless it is
 * written down, and a scheduler that forgets a rate limit every time FreeCode
 * restarts is worse than one that never learned it.
 *
 * The store is deliberately small and boring — one JSON file, synchronous I/O,
 * atomic replace — because it is read on every routing decision and must never
 * be the reason a task is slow or fails. Corruption is survivable: an unreadable
 * file is treated as empty.
 */

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
  /** Set while a circuit is open; the scheduler treats the resource as ineligible. */
  circuitOpenUntil?: number
  /** Consecutive failures, which is what opens a circuit. */
  consecutiveFailures: number
  updatedAt: number
}

export interface Snapshot {
  version: 1
  resources: Record<string, ResourceState>
}

const VERSION = 1

// Consecutive provider failures before the circuit opens, and how long it stays
// open. Both are deliberately gentle: a wrong "unavailable" costs the user a
// capable resource, while a wrong "available" costs one failed request.
export const CIRCUIT_THRESHOLD = 3
export const CIRCUIT_OPEN_MS = 60_000

// A provider-reported rate limit is authoritative and worth remembering for
// longer than a transient error.
export const QUOTA_COOLDOWN_MS = 5 * 60_000

export function empty(): ResourceState {
  return {
    attempts: 0,
    successes: 0,
    providerFailures: 0,
    health: "available",
    totalLatencyMs: 0,
    latencySamples: 0,
    consecutiveFailures: 0,
    updatedAt: Date.now(),
  }
}

/**
 * On-disk location.
 *
 * Under the global data directory rather than a project, because a provider
 * account's quota is a property of the account and is shared by every project
 * that uses it.
 */
export function file(): string {
  return path.join(Global.Path.data, "freecode", "resources.json")
}

export function load(): Snapshot {
  const location = file()
  if (!existsSync(location)) return { version: VERSION, resources: {} }
  try {
    const parsed = JSON.parse(readFileSync(location, "utf8"))
    if (!isRecord(parsed) || parsed.version !== VERSION || !isRecord(parsed.resources)) {
      return { version: VERSION, resources: {} }
    }
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
    circuitOpenUntil: typeof value.circuitOpenUntil === "number" ? value.circuitOpenUntil : undefined,
    consecutiveFailures: typeof value.consecutiveFailures === "number" ? value.consecutiveFailures : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null
}

function isHealth(value: unknown): value is Health {
  return value === "available" || value === "degraded" || value === "unavailable"
}

function isQuota(value: unknown): value is Quota {
  if (!isRecord(value)) return false
  return (
    (value.status === "healthy" || value.status === "low" || value.status === "exhausted" || value.status === "unknown") &&
    typeof value.updatedAt === "number"
  )
}

/** Fold one observed outcome into a resource's state. Pure, so it is testable. */
export function recordSuccess(previous: ResourceState | undefined, latencyMs: number, at = Date.now()): ResourceState {
  const state = previous ? { ...previous } : empty()
  state.attempts += 1
  state.successes += 1
  state.consecutiveFailures = 0
  state.circuitOpenUntil = undefined
  state.health = "available"
  if (latencyMs > 0) {
    state.totalLatencyMs += latencyMs
    state.latencySamples += 1
  }
  state.updatedAt = at
  return state
}

export interface FailureInput {
  /** True when the provider, not the task, was at fault. */
  provider: boolean
  /** Set when the provider reported a rate limit or quota exhaustion. */
  quotaExhausted?: boolean
  /** Set when the provider reported a reset time. */
  resetAt?: number
  at?: number
}

/**
 * Fold one failure into a resource's state.
 *
 * The provider/task distinction is the whole point: a task that fails because the
 * code is hard is not evidence against the account, and treating it as such is
 * how a scheduler learns to avoid its best model.
 */
export function recordFailure(previous: ResourceState | undefined, input: FailureInput): ResourceState {
  const at = input.at ?? Date.now()
  const state = previous ? { ...previous } : empty()
  state.attempts += 1
  state.updatedAt = at

  if (!input.provider) {
    // Task failures still count as attempts, so reliability is honest, but they
    // must not degrade the resource or open a circuit.
    return state
  }

  state.providerFailures += 1
  state.consecutiveFailures += 1

  if (input.quotaExhausted) {
    state.quota = {
      status: "exhausted",
      source: "header",
      remaining: 0,
      resetAt: input.resetAt,
      updatedAt: at,
    }
    // A known reset time is better information than a fixed cooldown, so use it.
    state.circuitOpenUntil = input.resetAt ?? at + QUOTA_COOLDOWN_MS
    state.health = "degraded"
    return state
  }

  if (state.consecutiveFailures >= CIRCUIT_THRESHOLD) {
    state.circuitOpenUntil = at + CIRCUIT_OPEN_MS
    state.health = "unavailable"
    return state
  }

  state.health = "degraded"
  return state
}

export function averageLatency(state: ResourceState | undefined): number | undefined {
  if (!state || state.latencySamples === 0) return undefined
  return state.totalLatencyMs / state.latencySamples
}
