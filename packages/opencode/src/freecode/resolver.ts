export * as ModelResolver from "./resolver"

import { LayaClient, type RouteDecision, type RouteState } from "./router/client"

/**
 * The single entry point through which FreeCode chooses a model.
 *
 * Every model decision in the fork funnels through `resolve`. Nothing else may
 * route: not the Task tool, not the agent registry, not the TUI, not the
 * provider layer. One entry point is what keeps this fork small enough to
 * rebase against upstream, and what makes routing behaviour explainable from a
 * single place when a task lands on the wrong model.
 *
 * Resolution is deliberately three-staged:
 *
 *   1. `requested` — an explicit `provider/model` always wins. A user who names
 *      a model is never second-guessed, and this is what keeps every existing
 *      OpenCode configuration byte-for-byte compatible.
 *   2. `tier` — an agent that declares a required capability tier gets the
 *      cheapest resource meeting it.
 *   3. `auto` — the router classifies the task and the tier follows from the
 *      classification.
 *
 * Resource *selection* is the scheduler's job and is not implemented in this
 * stage: `resolve` reports the tier it decided and the decision behind it, and
 * the caller keeps its existing default until a pool exists.
 */

export type Tier = RouteDecision["tier"]

/** Ordered weakest to strongest. Index comparisons are meaningful. */
export const TIERS: readonly Tier[] = ["local", "fast", "standard", "strong", "max"] as const

export interface ResolveInput {
  /** Agent name, used for routing context and logging. */
  agent: string
  /** The task text the model would be asked to perform. */
  prompt: string
  /** Tools the agent can call; a strong signal for read-only vs writing work. */
  tools?: string[]
  /**
   * Explicit model requested by configuration or the user, as `provider/model`.
   * `"auto"` (or absent) opts into routing.
   */
  requested?: string
  /** Capability tier the agent requires. Treated as a floor, never a ceiling. */
  tier?: Tier
  /** Files the task is expected to touch, when known. */
  files?: number
  /** How many times this task has already failed. Raises the tier floor. */
  priorFailures?: number
  /** Extra constraints worth showing the classifier, e.g. "no network access". */
  constraints?: string
}

export interface Resolution {
  /** Whether routing happened, or an explicit model was honoured. */
  mode: "fixed" | "tier" | "auto"
  /** The tier FreeCode decided the task needs. */
  tier: Tier
  /** The router's classification, absent when an explicit model was requested. */
  decision?: RouteDecision
  /** Human-readable explanation, surfaced in logs and debug output. */
  reason: string
}

const AUTO = "auto"

/**
 * Decide which capability tier a request needs.
 *
 * Never throws and never blocks indefinitely: the router is an optimisation,
 * and a session must not fail because a local decision model is unavailable.
 */
export async function resolve(input: ResolveInput): Promise<Resolution> {
  const requested = input.requested?.trim()

  if (requested && requested !== AUTO) {
    return {
      mode: "fixed",
      tier: input.tier ?? "standard",
      reason: `explicit model ${requested}`,
    }
  }

  const floor = input.tier
  const state: RouteState = {
    agent: input.agent,
    task: input.prompt,
    tools: input.tools,
    files: input.files,
    prior_failures: input.priorFailures,
    constraints: input.constraints,
  }

  const decision = await LayaClient.route(state)

  if (!decision) {
    // No router available. Honour the declared tier if there is one, otherwise
    // assume ordinary engineering work rather than guessing at either extreme.
    //
    // The bridge's own failure reason is included rather than a bare "unavailable":
    // "Laya is not installed" and "Laya is installed but crashed" are different
    // problems, and a user reading a log should not have to guess which they have.
    const tier = floor ?? "standard"
    const why = LayaClient.instance().failure ?? "bridge did not answer"
    return {
      mode: requested ? "auto" : floor ? "tier" : "auto",
      tier,
      reason: `router unavailable (${why}), ${floor ? `declared tier ${tier}` : "default tier standard"}`,
    }
  }

  const tier = floor ? higherTier(floor, decision.tier) : decision.tier
  return {
    mode: floor && !requested ? "tier" : "auto",
    tier,
    decision,
    reason: floor && TIERS.indexOf(floor) > TIERS.indexOf(decision.tier) ? `declared tier ${floor} over ${decision.tier}` : decision.reason,
  }
}

/** The stronger of two tiers, used to apply a declared tier as a floor. */
export function higherTier(left: Tier, right: Tier): Tier {
  return TIERS.indexOf(left) >= TIERS.indexOf(right) ? left : right
}

/** Whether a model spec opts into routing rather than naming a model. */
export function isAuto(model: string | undefined): boolean {
  return !model || model.trim() === AUTO
}
