export * as Resources from "./resources"

import type { Candidate, Capability, Resource } from "./scheduler"
import type { Tier } from "./resolver"
import { ResourceState, averageLatency, load } from "./state"
import type { ResolvedModel } from "./route"

/**
 * Turns configured pools and observed state into scheduler candidates.
 *
 * The honest situation with capability data: OpenCode's model catalogue exposes
 * `capabilities.reasoning` as a boolean and per-model token cost, and nothing
 * else that maps onto "how good is this at coding". So this module derives what
 * it can from real numbers — relative cost, and whether the model reasons — and
 * says plainly that the rest is a placeholder.
 *
 * That is a deliberate trade. Inventing capability scores from model names would
 * produce a scheduler that looks clever and routes by branding. The weighting
 * reflects it: quota and health together carry 45% of the score and are backed by
 * observation, while capability carries 30% and is a constant until better data
 * exists. When capability data does arrive — a benchmark table, or a per-model
 * declaration in config — only `capabilityOf` has to change.
 */

/** Capability used when nothing is known. Neutral, so it neither helps nor hurts. */
const DEFAULT_CAPABILITY = 0.5

export interface BuildInput {
  /** Tier pools from config: tier name to `provider/model` ids in preference order. */
  pool: Record<string, string[] | undefined>
  /** Registry lookup, used to read real model metadata. */
  model: (providerID: string, modelID: string) => ResolvedModel | undefined
  /** Observed state, defaulting to whatever is on disk. */
  state?: Record<string, ResourceState>
}

/**
 * Build scheduler candidates for every tier in the pool.
 *
 * One candidate per configured model, carrying every tier it serves, so a model
 * listed under two tiers is a single resource with two eligible tiers rather than
 * two resources competing with themselves.
 */
export function build(input: BuildInput): Candidate[] {
  const observed = input.state ?? load().resources
  const byId = new Map<string, { resource: Resource; candidate: Candidate }>()

  for (const [tier, entries] of Object.entries(input.pool)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const separator = entry.indexOf("/")
      if (separator === -1) continue
      const providerID = entry.slice(0, separator)
      const modelID = entry.slice(separator + 1)
      const id = `${providerID}/${modelID}`
      const known = input.model(providerID, modelID)

      const existing = byId.get(id)
      if (existing) {
        if (!existing.resource.tiers.includes(tier as Tier)) {
          ;(existing.resource.tiers as Tier[]).push(tier as Tier)
        }
        continue
      }

      const resource: Resource = {
        id,
        provider: providerID,
        account: accountOf(providerID),
        model: modelID,
        tiers: [tier as Tier],
        capability: capabilityOf(known),
        cost: costOf(known),
      }
      byId.set(id, { resource, candidate: { resource, state: observed[id] } })
    }
  }

  return [...byId.values()].map((entry) => entry.candidate)
}

/**
 * Account label for a provider id.
 *
 * FreeCode expresses an account pool as several provider ids sharing a vendor
 * prefix, because upstream resolves credentials per provider id and one id
 * cannot hold two keys. The suffix is the account; `deepseek` alone is its own
 * account.
 */
export function accountOf(provider: string): string {
  const separator = provider.search(/[-_.]/)
  if (separator === -1) return "default"
  return provider.slice(separator + 1)
}

/**
 * Capability derived from what the catalogue actually knows.
 *
 * `reasoning` is a real declaration from the provider metadata, so a model that
 * reasons is trusted more on the axes that need it. Coding, review and speed are
 * placeholders and are documented as such rather than guessed from names.
 */
export function capabilityOf(model: ResolvedModel | undefined): Capability {
  const reasons = model?.capabilities?.reasoning === true
  return {
    reasoning: reasons ? 0.75 : DEFAULT_CAPABILITY,
    coding: reasons ? 0.65 : DEFAULT_CAPABILITY,
    review: reasons ? 0.7 : DEFAULT_CAPABILITY,
    speed: DEFAULT_CAPABILITY,
  }
}

/**
 * Relative cost, 1.0 being the pool's baseline.
 *
 * Uses the catalogue's output-token price against a nominal cheap-model price, so
 * the number is comparable between runs and pools instead of being normalised
 * against whatever happens to be configured today.
 */
const NOMINAL_CHEAP_OUTPUT_PRICE = 0.5

export function costOf(model: ResolvedModel | undefined): number {
  const output = model?.cost?.output
  if (typeof output !== "number" || output <= 0) return 1
  return Math.max(0.1, output / NOMINAL_CHEAP_OUTPUT_PRICE)
}

/**
 * The scheduler's view of one resource, for diagnostics.
 *
 * Prints the score breakdown so a user can see why a task went where it did
 * instead of having to trust it.
 */
export function describe(candidate: Candidate): string {
  const state = candidate.state
  const latency = averageLatency(state)
  return [
    candidate.resource.id,
    `tiers=${candidate.resource.tiers.join("|")}`,
    `cost=${candidate.resource.cost.toFixed(2)}`,
    `health=${state?.health ?? "unseen"}`,
    `quota=${state?.quota?.status ?? "unknown"}`,
    `latency=${latency === undefined ? "-" : `${Math.round(latency)}ms`}`,
    `attempts=${state?.attempts ?? 0}`,
  ].join(" ")
}

/** Snapshot of the whole pool, used by the `/route` report. */
export function report(candidates: readonly Candidate[]): string[] {
  return candidates.map(describe).sort()
}
