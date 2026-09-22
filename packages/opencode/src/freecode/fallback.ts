export * as Fallback from "./fallback"

import { Failure } from "./failure"
import { Observe } from "./observer"
import { ResourceState, load, promote } from "./state"
import { Resources } from "./resources"
import { Scheduler } from "./scheduler"
import type { ResolvedModel } from "./route"
import type { Tier } from "./resolver"

/**
 * Runtime failover: retry the same task on a different resource when the *provider*
 * was at fault.
 *
 * This is the part of FreeCode that keeps its promise about not wasting Head
 * tokens. A rate limit, a timeout, a 5xx, an expired key — none of those mean the
 * task was too hard. They mean this account, right now, cannot serve it. Retrying
 * the identical request against another account costs one request; escalating to
 * the Head agent costs a frontier-model turn and teaches it nothing.
 *
 * Only a task failure that has survived its retries is worth escalating, and this
 * module is where that distinction is actually acted on rather than merely
 * classified.
 */

/**
 * How many resources one turn may try before giving up.
 *
 * Three, not "all of them": a pool of ten accounts that are all rate limited will
 * not be fixed by ten requests, and the user is waiting. Three finds a healthy
 * account in every realistic case while bounding the worst case to three failed
 * requests.
 */
export const MAX_ATTEMPTS = 3

export interface Plan {
  /** The model to try next, absent when no failover is possible. */
  next?: ResolvedModel
  /** The resource that failed, so the caller can report it. */
  failed: string
  /** Why it failed. */
  class: Failure.FailureClass
  /**
   * True when the caller should surface this to the user / Head agent instead of
   * silently switching. Set when the failure was the task's or when no
   * alternative exists.
   */
  escalate: boolean
  /** Human-readable explanation, for logs and the `/why` report. */
  reason: string
}

/**
 * Record an outcome and decide what to do next.
 *
 * The failure is recorded before a replacement is chosen, so the resource that
 * just failed is already excluded from the pool the replacement comes from. Doing
 * it the other way round is how a scheduler hands a task straight back to the
 * account that just refused it.
 */
export function plan(input: {
  failed: ResolvedModel
  tier: Tier
  /**
   * The error, when the caller has it. `Observe.onExit` has usually recorded it
   * already, in which case pass `recorded` instead — classifying twice would
   * double-count the failure against the resource.
   */
  error?: unknown
  /**
   * The verdict already written to the resource's state. Preferred over `error`:
   * the stream's exit handler is the single place that sees every ending, so it
   * is the authoritative observation.
   */
  recorded?: Failure.Classification
  /** Attempts already made this turn, including the one that just failed. */
  attempts: number
  /** Pool, if the caller already has it; read from config state otherwise. */
  pool?: Record<string, string[] | undefined>
  /** Registry lookup for the pool's models. */
  model?: (providerID: string, modelID: string) => ResolvedModel | undefined
}): Plan {
  const failed = `${input.failed.providerID}/${input.failed.id}`
  const verdict = input.recorded ?? Observe.recordFailure(failed, input.error)

  // A task failure is not the resource's problem, so another resource will fail
  // the same way. This is the only case that reaches the Head agent.
  if (!verdict.resource) {
    return {
      failed,
      class: verdict.class,
      escalate: true,
      reason: `task failure on ${failed} (${verdict.class}), retrying elsewhere would not help`,
    }
  }

  if (input.attempts >= MAX_ATTEMPTS) {
    return {
      failed,
      class: verdict.class,
      escalate: true,
      reason: `${verdict.class} on ${failed}; giving up after ${input.attempts} attempts`,
    }
  }

  const next = selectReplacement(input)
  if (!next) {
    return {
      failed,
      class: verdict.class,
      escalate: true,
      reason: `${verdict.class} on ${failed}; no other resource is eligible for tier ${input.tier}`,
    }
  }

  return {
    next,
    failed,
    class: verdict.class,
    escalate: false,
    reason: `${verdict.class} on ${failed}, switching to ${next.providerID}/${next.id}`,
  }
}

/**
 * The next best resource for a tier, excluding resources already marked unusable.
 *
 * Reuses the scheduler rather than picking "the next pool entry": the whole point
 * of failing over is to land somewhere *better*, and a pool entry that is also on
 * cooldown is not better.
 */
function selectReplacement(input: {
  failed: ResolvedModel
  tier: Tier
  pool?: Record<string, string[] | undefined>
  model?: (providerID: string, modelID: string) => ResolvedModel | undefined
}): ResolvedModel | undefined {
  if (!input.pool || !input.model) return undefined

  // Promote any expired circuit first, so a resource whose cooldown just elapsed
  // is available as a replacement instead of being skipped for one more attempt.
  const snapshot = promote(load())
  const candidates = Resources.build({
    pool: input.pool,
    model: input.model,
    state: snapshot.resources,
  })

  const failedID = `${input.failed.providerID}/${input.failed.id}`
  const others = candidates.filter((candidate) => candidate.resource.id !== failedID)
  const winner = Scheduler.select(others, { tier: input.tier })
  if (!winner) return undefined

  return input.model(winner.candidate.resource.provider, winner.candidate.resource.model)
}

/**
 * Record that a task failed after its retries, so the reliability term learns.
 *
 * Kept separate from `plan` because escalation happens outside the failover loop:
 * the Head agent decision is not a provider matter.
 */
export function recordTaskFailure(model: ResolvedModel) {
  Observe.recordFailure(`${model.providerID}/${model.id}`, new Error("task failure: retries exhausted"))
}

/**
 * Every currently excluded resource, for the `/why` report.
 *
 * Deduplicated: a model listed under two tiers is one resource, and reporting it
 * twice would read as two broken accounts when there is one.
 */
export function excluded(pool: Record<string, string[] | undefined>): string[] {
  const snapshot = promote(load())
  const entries = new Set<string>()
  for (const tier of Object.values(pool)) {
    if (!Array.isArray(tier)) continue
    for (const entry of tier) entries.add(entry)
  }

  return [...entries]
    .flatMap((entry) => {
      const reason = ResourceState.exclusionReason(snapshot.resources[entry])
      return reason ? [`${entry}: ${reason}`] : []
    })
    .sort()
}

/**
 * The verdict most recently recorded for a resource.
 *
 * The failure is written to the store by the stream's exit handler, which is the
 * only place that sees every ending. Reading it back here keeps a single source of
 * truth for "what just happened" and stops the failure being counted twice.
 */
export function recordedFor(resourceID: string): Failure.Classification | undefined {
  const state = load().resources[resourceID]
  if (!state) return undefined
  const circuit = state.circuit
  // Only a provider-side failure leaves this evidence; a task failure changes
  // nothing observable about the resource, so `plan` must fall back to its own
  // judgement in that case (and does: the caller passes the error when it has it).
  if (!circuit.reason) return undefined
  return {
    class: circuit.reason,
    resource: true,
    escalate: false,
  }
}
