export * as Observe from "./observer"

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import { Failure } from "./failure"
import { ResourceState, load, save } from "./state"

/**
 * Records what actually happened to each model, so the scheduler has facts.
 *
 * The scheduler can only be as good as its inputs. Quota, health, latency and
 * reliability are all observations, and without them every resource scores
 * identically and `model: auto` degenerates into "first entry in the pool". This
 * module is the observation half; `failure.ts` decides what a failure *means* and
 * this one writes it down.
 *
 * Recording is best effort throughout. A failure to write down an observation
 * must never fail the request that produced it.
 */

export type Verdict = Failure.Classification

/**
 * Decide what a failure means.
 *
 * Exported because it is the judgement the whole fallback path rests on, and
 * because a provider error misread as a task error is invisible in aggregate
 * statistics — it just looks like a model that is bad at hard work.
 */
export function classify(error: unknown): Verdict {
  return Failure.classify(error)
}

/**
 * Fold one request outcome into the durable store.
 *
 * Read-modify-write on every request. The file is small and this happens once per
 * provider turn, so the alternative — an in-memory cache with invalidation —
 * would buy nothing but a class of bug where two FreeCode processes disagree
 * about whether an account is rate limited.
 */
export function record(
  resourceID: string,
  outcome: { ok: true; latencyMs: number } | { ok: false; verdict: Verdict; at?: number },
) {
  try {
    const snapshot = load()
    const previous = snapshot.resources[resourceID]
    snapshot.resources[resourceID] =
      outcome.ok === true
        ? ResourceState.recordSuccess(previous, outcome.latencyMs)
        : ResourceState.recordFailure(previous, {
            class: outcome.verdict.class,
            resource: outcome.verdict.resource,
            resetAt: outcome.verdict.resetAt,
            at: outcome.at,
          })
    save(snapshot)
  } catch {
    // Observation is not worth failing a request over.
  }
}

/** Fold a thrown or failed provider call into the durable store. */
export function recordFailure(resourceID: string, error: unknown): Verdict {
  const verdict = classify(error)
  record(resourceID, { ok: false, verdict })
  return verdict
}

/**
 * Stream-level observation.
 *
 * `onExit` rather than a success hook or a `tapCause`, because it is the only
 * place that sees all three endings: completion, failure, and interruption. A
 * stream that ends without error is the success case latency is measured on, and
 * an interruption must be discarded rather than blamed on the provider — a user
 * pressing Ctrl-C is not evidence about an account.
 */
export function onExit<E>(resourceID: string, exit: Exit.Exit<unknown, E>, startedAt: number) {
  return Effect.sync(() => {
    if (Exit.isSuccess(exit)) {
      record(resourceID, { ok: true, latencyMs: Date.now() - startedAt })
      return
    }
    if (Cause.hasInterruptsOnly(exit.cause)) return
    recordFailure(resourceID, Cause.squash(exit.cause))
  })
}
