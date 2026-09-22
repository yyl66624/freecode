export * as Scheduler from "./scheduler"

import type { Tier } from "./resolver"
import type { ResolvedModel } from "./route"
import { ResourceState } from "./state"

/**
 * FreeCode's model selection beyond the capability tier.
 *
 * The router answers "what capability does this task need". This module answers
 * "which of the models this user actually has should pay for it", using facts
 * the router has no business knowing: quota headroom, observed health, latency,
 * historical success, and cost.
 *
 * The split matters because the two halves fail differently. Routing is a
 * judgement about the task; scheduling is arithmetic over resource facts. Keeping
 * them apart is also what will let the router be replaced — by a fine-tuned
 * checkpoint, or by nothing at all — without the scheduler noticing.
 *
 * Scoring is deliberately transparent arithmetic rather than a learned policy:
 * when a task lands on an unexpected model, the explanation has to be readable
 * off the numbers. `explain` exists for exactly that.
 *
 * S = 0.30C + 0.25Q + 0.20H + 0.10L + 0.10R + 0.05K
 *
 * where C is capability match, Q quota headroom, H health, L latency, R
 * historical success and K cost headroom (1 for the cheapest model). Every term
 * points the same way — higher is better — which is the only way the weights stay
 * comparable to each other.
 */

export type QuotaStatus = "healthy" | "low" | "exhausted" | "unknown"
export type QuotaSource = "official" | "header" | "estimated" | "unknown"
export type Health = "available" | "degraded" | "unavailable"

export interface Quota {
  status: QuotaStatus
  source: QuotaSource
  /** Remaining fraction in [0, 1], when known. */
  remaining?: number
  /** Epoch milliseconds at which the window resets, when known. */
  resetAt?: number
  updatedAt: number
}

/** How well a resource matches a task, in [0, 1] per axis. */
export interface Capability {
  coding: number
  reasoning: number
  review: number
  speed: number
}

export interface Resource {
  /** Namespaced resource id, unique across the pool. */
  id: string
  /** OpenCode provider id. One account of a vendor is one provider id. */
  provider: string
  /** Account label within the vendor, for grouping and display. */
  account: string
  // NOTE: vendor is deliberately absent; it is derived from the provider id so
  // that the grouping cannot drift out of sync with what OpenCode registers.
  model: string
  /** Tiers this model is allowed to serve. */
  tiers: readonly Tier[]
  capability: Capability
  /** Relative cost per unit of work, 0 (free/local) upward. */
  cost: number
}

/** Tunable weights, overridable from config so nobody has to edit code to retune. */
export interface Weights {
  capability: number
  quota: number
  health: number
  latency: number
  reliability: number
  cost: number
}

export const DEFAULT_WEIGHTS: Weights = {
  capability: 0.3,
  quota: 0.25,
  health: 0.2,
  latency: 0.1,
  reliability: 0.1,
  cost: 0.05,
}

export interface Candidate {
  resource: Resource
  /** Observed state, if the pool has ever run this resource. */
  state?: ResourceState
}

export interface Scored {
  candidate: Candidate
  score: number
  terms: Record<keyof Weights, number>
}

export interface Requirements {
  tier: Tier
  /** Capability axes the task needs; missing axes are unconstrained. */
  needs?: Partial<Capability>
}

/**
 * Capability match in [0, 1].
 *
 * A resource that falls short on a requested axis is rejected by `eligible`
 * rather than scored low, so the score measures "how good a fit among models
 * that can do the job" and never quietly trades away capability for cost.
 */
export function capabilityMatch(resource: Resource, requirements: Requirements): number {
  const needs = requirements.needs ?? {}
  const axes: (keyof Capability)[] = ["coding", "reasoning", "review"]
  const relevant = axes.filter((axis) => needs[axis] !== undefined)
  if (relevant.length === 0) {
    // No explicit need: prefer the stronger model, mildly.
    return (resource.capability.coding + resource.capability.reasoning + resource.capability.review) / 3
  }
  return relevant.reduce((sum, axis) => sum + resource.capability[axis], 0) / relevant.length
}

/**
 * Resources that may serve this request at all.
 *
 * Every rejection here is a hard constraint, kept separate from scoring so that
 * a low score can never be mistaken for a hard no.
 */
export function eligible(candidates: readonly Candidate[], requirements: Requirements): Candidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.resource.tiers.includes(requirements.tier) &&
      meetsCapabilityNeed(candidate.resource, requirements) &&
      isUsableNow(candidate.state),
  )
}

/**
 * Whether a resource can do the job at all.
 *
 * Kept independent of observed state on purpose: capability is a property of the
 * model, not of how it has behaved, and folding the two together let a resource
 * with no history skip the check entirely.
 */
function meetsCapabilityNeed(resource: Resource, requirements: Requirements): boolean {
  const needs = requirements.needs ?? {}
  const axes: (keyof Capability)[] = ["coding", "reasoning", "review"]
  return axes.every((axis) => {
    const required = needs[axis]
    return required === undefined || resource.capability[axis] >= required
  })
}

/**
 * Whether observed state permits another attempt right now.
 *
 * Delegates to the state module so the circuit breaker has exactly one
 * implementation. A second copy here is how the scheduler and the breaker would
 * eventually disagree about whether an account is usable.
 */
function isUsableNow(state: ResourceState | undefined): boolean {
  return ResourceState.usable(state)
}

/** Quota headroom in [0, 1]. Unknown quota scores neutrally, never as full. */
export function quotaTerm(state?: ResourceState): number {
  const remaining = state?.quota?.remaining
  if (typeof remaining !== "number") return 0.5
  return Math.min(1, Math.max(0, remaining))
}

export function healthTerm(state?: ResourceState): number {
  if (!state) return 0.75
  if (state.health === "available") return 1
  if (state.health === "degraded") return 0.4
  return 0
}

/**
 * Latency term in [0, 1], 1 being fastest.
 *
 * Only defined for resources with at least one observed success, so a resource
 * that has never run is not punished for a latency nobody has measured.
 */
export const LATENCY_BUDGET_MS = 60_000

export function latencyTerm(state?: ResourceState): number {
  // The exponential moving average is preferred over the all-time mean: a
  // resource that was slow an hour ago and is fast now should score as fast. The
  // mean is the fallback so a migrated state file still contributes.
  const samples = state?.latencySamples ?? 0
  const mean = samples > 0 ? (state?.totalLatencyMs ?? 0) / samples : undefined
  const latency = state?.latencyEMA ?? mean
  if (typeof latency !== "number" || latency <= 0) return 0.5
  return Math.min(1, Math.max(0, 1 - latency / LATENCY_BUDGET_MS))
}

export function reliabilityTerm(state?: ResourceState): number {
  if (typeof state?.successEMA === "number") return Math.min(1, Math.max(0, state.successEMA))
  const attempts = state?.attempts ?? 0
  if (attempts === 0) return 0.5
  return Math.min(1, Math.max(0, (state?.successes ?? 0) / attempts))
}

/**
 * Cost term in [0, 1], 1 being cheapest and 0 at or above `COST_CEILING`.
 *
 * Normalising against the most expensive candidate in the pool was tried and
 * rejected: it makes the penalty scale-free, so a pool of uniformly expensive
 * models pays no cost penalty at all and the term silently stops working. An
 * absolute ceiling keeps the penalty meaningful whatever else is in the pool,
 * which is what lets cost be compared against quota and latency.
 *
 * `Resource.cost` is a relative multiple of the cheapest usable model, so the
 * ceiling is a judgement call rather than a derived constant.
 */
export const COST_CEILING = 10

export function costTerm(resource: Resource): number {
  if (resource.cost <= 0) return 1
  return Math.min(1, Math.max(0, 1 - resource.cost / COST_CEILING))
}

/**
 * Score every candidate and return them best first.
 *
 * Ties break on resource id so that an unchanged pool produces an unchanged
 * order; a scheduler that reshuffles on equal scores is impossible to debug.
 */
export function rank(candidates: readonly Candidate[], requirements: Requirements, weights: Weights = DEFAULT_WEIGHTS): Scored[] {
  return eligible(candidates, requirements)
    .map((candidate) => {
      const terms: Record<keyof Weights, number> = {
        capability: capabilityMatch(candidate.resource, requirements),
        quota: quotaTerm(candidate.state),
        health: healthTerm(candidate.state),
        latency: latencyTerm(candidate.state),
        reliability: reliabilityTerm(candidate.state),
        cost: costTerm(candidate.resource),
      }
      // Every term is "higher is better", `cost` included: `costTerm` returns 1
      // for the cheapest model, so all six are added. An earlier form of this
      // expression subtracted cost, which silently inverted the preference and
      // made the priciest candidate win. Keep the signs uniform.
      const score =
        weights.capability * terms.capability +
        weights.quota * terms.quota +
        weights.health * terms.health +
        weights.latency * terms.latency +
        weights.reliability * terms.reliability +
        weights.cost * terms.cost
      return { candidate, score, terms }
    })
    .sort((left, right) => right.score - left.score || left.candidate.resource.id.localeCompare(right.candidate.resource.id))
}

/** The winning resource, or `undefined` when nothing is eligible. */
export function select(
  candidates: readonly Candidate[],
  requirements: Requirements,
  weights: Weights = DEFAULT_WEIGHTS,
): Scored | undefined {
  return rank(candidates, requirements, weights)[0]
}

/**
 * Human-readable account of a decision.
 *
 * Exists because the alternative — a task landing on an unexpected model with no
 * visible reason — is the failure mode that makes a scheduler untrustworthy.
 */
export function explain(scored: Scored, weights: Weights = DEFAULT_WEIGHTS): string {
  const parts = (Object.keys(weights) as (keyof Weights)[])
    .filter((key) => weights[key] !== 0)
    .map((key) => `${key}=${scored.terms[key].toFixed(2)}`)
  return `${scored.candidate.resource.id} score=${scored.score.toFixed(3)} (${parts.join(" ")})`
}

/**
 * Resource id, and the vendor it belongs to.
 *
 * A resource is one account of one vendor. FreeCode expresses an account pool as
 * several OpenCode provider ids that share a vendor prefix — `deepseek-main` and
 * `deepseek-backup` — because upstream resolves credentials per provider id, so
 * one id cannot hold two keys. Deriving the vendor here rather than storing it
 * keeps the grouping from drifting away from what OpenCode actually registered.
 */
export function vendorOf(provider: string): string {
  const separator = provider.search(/[-_.]/)
  return separator === -1 ? provider : provider.slice(0, separator)
}

/** Resources belonging to one vendor, which are the ones a failure may switch between. */
export function sameVendor(candidates: readonly Candidate[], provider: string): Candidate[] {
  const vendor = vendorOf(provider)
  return candidates.filter((candidate) => vendorOf(candidate.resource.provider) === vendor)
}

export type { ResolvedModel }
