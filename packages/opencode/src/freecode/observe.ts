export * as Observe from "./observe"

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import { ResourceState, load, save, type FailureInput } from "./state"

/**
 * Records what actually happened to each model, so the scheduler has facts.
 *
 * The scheduler can only be as good as its inputs. Quota, health, latency and
 * reliability are all observations, and without them every resource scores
 * identically and `model: auto` degenerates into "first entry in the pool". This
 * module is the observation half.
 *
 * One classification decision drives everything: **was the provider at fault, or
 * the task?** A task that fails because the code is hard is not evidence against
 * the account it ran on, and treating it as such teaches the scheduler to avoid
 * its best model. Only provider-side failures degrade health, open a circuit, or
 * record quota exhaustion.
 *
 * Recording is best effort throughout. A failure to write down an observation
 * must never fail the request that produced it.
 */

/**
 * Provider-side failure signals.
 *
 * Deliberately narrow. Anything not listed is treated as a task failure, because
 * wrongly degrading a healthy resource is worse than missing a signal: the
 * resource stops being scheduled, while a missed signal costs one retry.
 */
const PROVIDER_FAILURE_PATTERNS = [
  /rate.?limit/i,
  /\b429\b/,
  /quota/i,
  /insufficient_quota/i,
  /too many requests/i,
  /\b50[0-9]\b/,
  /overloaded/i,
  /at capacity/i,
  /service unavailable/i,
  /timed? ?out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /socket hang ?up/i,
  /fetch failed/i,
  /network/i,
  /unauthorized/i,
  /\b401\b/,
  /\b403\b/,
  /invalid api key/i,
  /context length/i,
  /maximum context/i,
]

const QUOTA_PATTERNS = [/quota/i, /insufficient_quota/i, /\b429\b/, /rate.?limit/i, /too many requests/i]

export interface Outcome {
  provider: boolean
  quotaExhausted: boolean
  message?: string
}

/**
 * Decide whether a failure belongs to the provider or to the task.
 *
 * Exported because it is the judgement this whole module rests on, and because
 * the reverse — a provider error misread as a task error — is invisible in
 * aggregate statistics.
 */
export function classify(error: unknown): Outcome {
  const text = errorText(error)
  if (!text) return { provider: false, quotaExhausted: false }

  const provider = PROVIDER_FAILURE_PATTERNS.some((pattern) => pattern.test(text))
  if (!provider) return { provider: false, quotaExhausted: false, message: text.slice(0, 200) }

  const quotaExhausted = QUOTA_PATTERNS.some((pattern) => pattern.test(text))
  return { provider: true, quotaExhausted, message: text.slice(0, 200) }
}

function errorText(error: unknown): string {
  if (!error) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === "object") {
    const record = error as Record<string, unknown>
    const message = typeof record.message === "string" ? record.message : ""
    const code = typeof record.code === "string" ? record.code : ""
    return `${code} ${message}`.trim()
  }
  return String(error)
}

/**
 * Fold one request outcome into the durable store.
 *
 * Read-modify-write on every request. The file is small and this happens once per
 * provider turn, so the alternative — an in-memory cache with invalidation — would
 * buy nothing but a class of bug where two FreeCode processes disagree about
 * whether an account is rate limited.
 */
export function record(resourceID: string, outcome: { ok: true; latencyMs: number } | ({ ok: false } & FailureInput)) {
  try {
    const snapshot = load()
    const previous = snapshot.resources[resourceID]
    snapshot.resources[resourceID] =
      outcome.ok === true
        ? ResourceState.recordSuccess(previous, outcome.latencyMs)
        : ResourceState.recordFailure(previous, outcome)
    save(snapshot)
  } catch {
    // Observation is not worth failing a request over.
  }
}

/** Fold a thrown or failed provider call into the durable store. */
export function recordFailure(resourceID: string, error: unknown) {
  const outcome = classify(error)
  record(resourceID, { ok: false, provider: outcome.provider, quotaExhausted: outcome.quotaExhausted })
}

/**
 * Stream-level observation.
 *
 * `onExit` rather than a success hook or a `tapCause`, because it is the only
 * place that sees all three endings: completion, failure, and interruption. A
 * stream that ends without error is the success case latency is measured on, and
 * an interruption must be discarded rather than blamed on the provider.
 */
export function onExit<E, R>(resourceID: string, exit: Exit.Exit<unknown, E>, startedAt: number) {
  return Effect.sync(() => {
    if (Exit.isSuccess(exit)) {
      record(resourceID, { ok: true, latencyMs: Date.now() - startedAt })
      return
    }
    // An interruption is a user cancelling, not a provider failure. Recording it
    // would degrade a resource for something it did not do.
    if (Cause.hasInterruptsOnly(exit.cause)) return
    recordFailure(resourceID, Cause.squash(exit.cause))
  })
}
