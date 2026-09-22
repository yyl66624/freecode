export * as Route from "./route"

import * as Effect from "effect/Effect"
import { RoutingRef } from "./context"
import { ModelPool } from "./pool"
import { ModelResolver } from "./resolver"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"

/**
 * The `model: auto` seam inside `Provider.getModel`.
 *
 * `parseModel("auto")` yields the sentinel pair `freecode/auto`, so what arrives
 * here is not a real provider id. This is the only place FreeCode turns a
 * capability decision into a concrete model, which is what keeps the fork's
 * routing auditable from one file and impossible to bypass from a new call site.
 *
 * Routing is expressed as a factory rather than a bare function because the
 * caller owns both the provider registry lookup and the instance state that
 * lookup needs. Passing that capability in keeps this module free of an import
 * cycle with `provider.ts`, which imports this module.
 */
/**
 * The concrete model routing resolves to.
 *
 * Deliberately structural rather than `Provider.Model`: importing the provider's
 * model type here would make this module's signature depend on `Provider.getModel`,
 * which calls back into this function — a type cycle that collapses to `any` and
 * silently disables checking at the seam. `Provider.Model` is a superset, so the
 * two stay assignable in both directions where it matters.
 */
export interface ResolvedModel {
  readonly id: string
  readonly providerID: string
}

export interface Registry {
  /**
   * Capability-tier pools, tier name to `provider/model` ids in preference
   * order. Supplied by the caller so routing needs no configuration service of
   * its own.
   */
  readonly pool: Record<string, string[] | undefined>
  /**
   * Deterministic model to use when a sentinel arrives with no routing context.
   * `undefined` means no model is registered, in which case the sentinel is
   * reported as a genuine lookup failure by the caller.
   */
  readonly fallback: { providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined
  /**
   * Resolve a `provider/model` pair to a registered model, or `undefined` when
   * the pair is not registered.
   *
   * Declared as a method so its parameters are compared bivariantly: callers
   * hand over lookup functions whose branded id parameters stay branded on their
   * side while this side only ever passes plain strings. A missing model is an
   * ordinary answer here, not a failure, because every caller treats it as
   * "try the next candidate".
   */
  get(providerID: string, modelID: string): Effect.Effect<ResolvedModel | undefined>
}

/**
 * Returns the routed model, or `undefined` when routing does not apply.
 *
 * The common case is `undefined`: any explicitly configured model, every
 * internal helper agent, and every call made outside a user task.
 */
export function auto(
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  registry: Registry,
): Effect.Effect<ResolvedModel | undefined> {
  // `Effect.suspend` keeps this function's return type independent of the
  // generator's inference. Without it, TypeScript has to type the body to type
  // the call, the body's registry callback refers back to the caller's
  // `getModel`, and the cycle resolves to `any` — which would silently disable
  // checking at the one seam that matters most.
  return Effect.suspend(() => resolve(providerID, modelID, registry))
}

function resolve(
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  registry: Registry,
): Effect.Effect<ResolvedModel | undefined> {
  return Effect.gen(function* () {
    if (!isSentinel(providerID, modelID)) return undefined

    const routing = yield* RoutingRef
    if (!routing) {
      // A sentinel with no routing context reaches the provider from a fiber
      // that outlived the turn that created it — a subagent resolving on its own
      // after the parent turn returned. There is nothing to classify, and
      // reporting a missing model named `freecode` would only confuse the user,
      // so resolve the instance default instead.
      yield* Effect.logDebug("model:auto without routing context, using the instance default", {
        providerID,
        modelID,
      })
      return yield* resolveFallback(registry)
    }

    const resolution = yield* Effect.promise(() =>
      ModelResolver.resolve({
        agent: routing.agent,
        prompt: routing.task,
        tools: routing.tools,
        tier: routing.tier,
        priorFailures: routing.priorFailures,
      }),
    )

    yield* Effect.logInfo("freecode route", {
      agent: routing.agent,
      mode: resolution.mode,
      tier: resolution.tier,
      confidence: resolution.decision?.confidence,
      source: resolution.decision?.source,
      reason: resolution.reason,
    })

    const selected = yield* Effect.promise(() =>
      ModelPool.select(registry.pool, resolution.tier, (candidateProvider, candidateModel) =>
        Effect.runPromise(registry.get(candidateProvider, candidateModel)),
      ),
    )

    if (!selected) {
      // An empty tier is a configuration state, not an error: the session keeps
      // the model it would have used anyway, and the log says why.
      yield* Effect.logInfo("freecode route found no model for tier, using the caller default", {
        tier: resolution.tier,
        configured: ModelPool.configuredTiers(registry.pool),
      })
      return yield* resolveFallback(registry)
    }

    return selected
  })
}

/**
 * Last resort for a routing request that cannot be routed: resolve the
 * instance's default model through the same registry the pool uses, so the
 * caller receives a genuinely registered model.
 */
function resolveFallback(registry: Registry): Effect.Effect<ResolvedModel | undefined> {
  return Effect.gen(function* () {
    const fallback = registry.fallback
    if (!fallback) return undefined
    return yield* registry.get(fallback.providerID, fallback.modelID)
  })
}

/**
 * Whether a model reference is FreeCode's routing sentinel.
 *
 * Two shapes reach here. `parseModel("auto")` produces `freecode/auto`, which
 * configuration and the agent registry hand over directly. The Task tool instead
 * carries a subagent's model through the session as a `ModelRef` and arrives
 * with an empty `modelID` for `freecode`, because `auto` is not a model the
 * provider registry knows and is dropped on the way. `freecode` is never a real
 * provider id, so accepting either shape costs nothing and stops a routed
 * subagent from failing as a missing model.
 */
function isSentinel(providerID: ProviderV2.ID, modelID: ModelV2.ID) {
  if (providerID !== "freecode" && providerID !== "auto") return false
  return modelID === "auto" || modelID === ""
}
