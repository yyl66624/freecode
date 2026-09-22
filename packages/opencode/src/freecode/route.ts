export * as Route from "./route"

import * as Effect from "effect/Effect"
import { RoutingRef } from "./context"
import { ModelPool } from "./pool"
import { Resources } from "./resources"
import { Scheduler } from "./scheduler"
import { Fallback } from "./fallback"
import type { Tier } from "./resolver"
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
  /**
   * Catalogue metadata, when the registry supplies it.
   *
   * Typed minimally rather than as `Provider.Model`, for the same reason this
   * interface exists at all: importing the provider's model type would rebuild
   * the type cycle. The scheduler reads real `capabilities.reasoning` and
   * `cost.output` off these, so they are optional-but-honest rather than absent.
   */
  readonly capabilities?: { readonly reasoning?: boolean }
  readonly cost?: { readonly input?: number; readonly output?: number }
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

    // The scheduler's job: turn "this task needs tier X" into the best concrete
    // resource given quota, health, latency, reliability and cost. It filters
    // hard on tier and capability, then scores what remains.
    // Resolved inside this Effect, not via `Effect.runPromise`: the registry
    // lookup needs the instance context that this fiber carries, and a fresh
    // runtime started from a promise would not have it.
    const resolved = yield* resolvePool(registry)
    const candidates = Resources.build({ pool: registry.pool, model: (p, m) => resolved.get(`${p}/${m}`) })
    const winner = Scheduler.select(candidates, { tier: resolution.tier })

    if (!winner) {
      // Either the tier has no pool entry, or every entry is currently
      // ineligible — an exhausted quota, an open circuit. Both are states, not
      // errors: the session keeps the model it would have used anyway.
      yield* Effect.logInfo("freecode route found no eligible model for tier, using the caller default", {
        tier: resolution.tier,
        configured: ModelPool.configuredTiers(registry.pool),
        pool: Resources.report(candidates),
      })
      return yield* resolveFallback(registry)
    }

    yield* Effect.logInfo("freecode schedule", {
      tier: resolution.tier,
      chosen: Scheduler.explain(winner),
      eligible: Scheduler.rank(candidates, { tier: resolution.tier }).length,
      total: candidates.length,
    })

    return yield* registry.get(winner.candidate.resource.provider, winner.candidate.resource.model)
  })
}

/**
 * Resolve every configured pool entry to a registered model.
 *
 * An entry naming a provider or model this user has not configured is absent from
 * the result rather than fatal, which is also what makes a typo in the pool
 * harmless. Failures are caught per entry so one bad line cannot empty the pool.
 */
function resolvePool(registry: Registry) {
  return Effect.gen(function* () {
    const resolved = new Map<string, ResolvedModel>()
    for (const entries of Object.values(registry.pool)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (resolved.has(entry)) continue
        const separator = entry.indexOf("/")
        if (separator === -1) continue
        const model = yield* registry.get(entry.slice(0, separator), entry.slice(separator + 1)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (model) resolved.set(entry, model)
      }
    }
    return resolved
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

/**
 * A replacement model for a turn whose provider call failed.
 *
 * Unlike `auto`, this does not re-classify the task: the task has not changed, and
 * re-asking the classifier would cost a Laya pass to learn nothing. It reuses the
 * tier the turn already committed to and asks the scheduler for the next eligible
 * resource, with the just-failed one excluded.
 *
 * Returns `undefined` when no failover is warranted — the task failed rather than
 * the provider, attempts are exhausted, or nothing else is eligible. The caller
 * then keeps its own behaviour, which is what preserves the upstream retry and
 * halt paths.
 */
export const replacementFor = Effect.fn("FreeCode.Route.replacement")(function* (
  failed: ResolvedModel,
  tier: Tier,
  attempts: number,
  registry: Registry,
) {
  const resolved = yield* resolvePool(registry).pipe(Effect.catch(() => Effect.succeed(new Map<string, ResolvedModel>())))
  const plan = Fallback.plan({
    failed,
    tier,
    // The stream's exit handler has already classified and recorded this failure,
    // so read the verdict rather than re-classifying: a second classification
    // would count the same failure twice against the account.
    recorded: Fallback.recordedFor(`${failed.providerID}/${failed.id}`),
    attempts,
    pool: registry.pool,
    model: (providerID, modelID) => resolved.get(`${providerID}/${modelID}`),
  })

  yield* Effect.logInfo("freecode fallback", {
    failing: plan.failed,
    class: plan.class,
    escalate: plan.escalate,
    next: plan.next ? `${plan.next.providerID}/${plan.next.id}` : undefined,
    reason: plan.reason,
  })

  return plan.next
})
