import { Context } from "effect"

export * as FreeCodeContext from "./context"

/**
 * Per-provider-turn routing context.
 *
 * The model is chosen deep inside `Provider.getModel`, which receives only a
 * provider id and a model id — never the agent or the task. Rather than thread
 * two more parameters through every call site (and every future one), the
 * entry points that *do* know the task publish it here, and the resolver reads
 * it.
 *
 * A missing value is normal, not an error: title generation, summaries, and
 * background maintenance all resolve models without a user task behind them.
 * Those calls fall back to the session default instead of being routed.
 */
export interface RoutingContext {
  /** Agent that will run the turn, e.g. `coder`. */
  agent: string
  /** The task text the agent was asked to perform. */
  task: string
  /** Tools available to the agent. */
  tools?: string[]
  /** Capability tier the agent declared as a floor. */
  tier?: "local" | "fast" | "standard" | "strong" | "max"
  /** How many times this task already failed, if it is a retry. */
  priorFailures?: number
}

export const RoutingRef = Context.Reference<RoutingContext | undefined>("~freecode/RoutingContext", {
  defaultValue: () => undefined,
})

/**
 * Upper bound on the task text handed to the classifier.
 *
 * Laya's `typed-decisions` checkpoint caps its sequence at 1024 tokens, and the
 * question head consumes roughly 256 of them. 2000 characters is comfortably
 * inside the remainder while keeping a long pasted prompt from crowding out the
 * signal that actually classifies it.
 */
export const ROUTING_TASK_LIMIT = 2000

/** The shape this module needs from an agent; a structural subset of `Agent.Info`. */
export interface RoutingAgent {
  name: string
  tier?: RoutingContext["tier"]
}

/** A prompt part, as far as routing cares: user text and nothing else. */
export interface RoutingPart {
  type: string
  text?: string
}

/**
 * Build the routing context for one turn.
 *
 * Synthetic parts are excluded on purpose. File attachments rendered as text and
 * harness-injected reminders describe the environment rather than the task, and
 * feeding them to a capability estimator biases it toward whatever the injected
 * boilerplate happens to look like.
 */
export function context(agent: RoutingAgent, parts: readonly RoutingPart[]): RoutingContext {
  return {
    agent: agent.name,
    task: parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => (part.text ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, ROUTING_TASK_LIMIT),
    tier: agent.tier,
  }
}
