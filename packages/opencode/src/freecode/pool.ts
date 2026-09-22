export * as ModelPool from "./pool"

import type { ResolvedModel } from "./route"
import type { Tier } from "./resolver"

/**
 * Resolves a capability tier into a concrete registered model.
 *
 * The router answers "what capability does this task need"; this module answers
 * "which of the models this user actually configured has it". Keeping the two
 * apart is what lets the same routing decision work against entirely different
 * provider sets, and what will let the scheduler replace this module without
 * the router noticing.
 *
 * The pool is user configuration, not inference:
 *
 * ```jsonc
 * { "freecode": { "pool": { "standard": ["deepseek/deepseek-v4-pro"], "strong": ["anthropic/claude-sonnet-4"] } } }
 * ```
 *
 * An empty or unconfigured tier yields `undefined` so the caller keeps whatever
 * default it already had. FreeCode never invents a model the user has not
 * registered, and never reaches for a stronger tier than the route asked for —
 * spending more than the decision authorised is the scheduler's call to make
 * later, with quota data this module does not have.
 */
export function candidates(pool: Record<string, string[] | undefined>, tier: Tier): string[] {
  return pool[tier] ?? []
}

/**
 * First pool entry for `tier` that the provider registry can actually resolve.
 *
 * Entries are tried in order because a pool may name several equivalent models;
 * the first unavailable one must not disable the tier.
 */
export function select(
  pool: Record<string, string[] | undefined>,
  tier: Tier,
  resolve: (providerID: string, modelID: string) => Promise<ResolvedModel | undefined>,
): Promise<ResolvedModel | undefined> {
  return firstResolvable(candidates(pool, tier), resolve)
}

async function firstResolvable(
  entries: readonly string[],
  resolve: (providerID: string, modelID: string) => Promise<ResolvedModel | undefined>,
): Promise<ResolvedModel | undefined> {
  for (const entry of entries) {
    const separator = entry.indexOf("/")
    if (separator === -1) continue
    const model = await resolve(entry.slice(0, separator), entry.slice(separator + 1))
    if (model) return model
  }
  return undefined
}

/** Every tier the user has configured, for diagnostics and the `/route` report. */
export function configuredTiers(pool: Record<string, string[] | undefined>): string[] {
  return Object.entries(pool)
    .filter(([, models]) => Array.isArray(models) && models.length > 0)
    .map(([tier]) => tier)
}
