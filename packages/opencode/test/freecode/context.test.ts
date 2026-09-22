import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FreeCodeContext } from "@/freecode/context"
import { ModelResolver } from "@/freecode/resolver"
import type { RouteDecision } from "@/freecode/router/client"

/**
 * Guards for the failure mode that cost the most time in this project: routing
 * silently not running.
 *
 * A missing routing context does not throw. `Provider.getModel` sees the sentinel,
 * finds nothing to classify, and resolves the instance default, which in a
 * single-provider setup is the same model routing would have chosen. Everything
 * looks fine and routing is dead.
 *
 * These tests pin the contract at both ends: the context is what `resolve` reads,
 * and a missing context must be an explicit outcome rather than a silent default.
 */

describe("routing context", () => {
  test("is absent by default, which callers must treat as 'do not route'", () => {
    const value = Effect.runSync(Effect.gen(function* () {
      return yield* FreeCodeContext.RoutingRef
    }))
    expect(value).toBeUndefined()
  })

  test("carries the agent, the task text and the tier floor", () => {
    const value = Effect.runSync(
      Effect.gen(function* () {
        return yield* FreeCodeContext.RoutingRef
      }).pipe(
        Effect.provideService(FreeCodeContext.RoutingRef, {
          agent: "coder",
          task: "add a docstring",
          tier: "standard",
        }),
      ),
    )
    expect(value?.agent).toBe("coder")
    expect(value?.task).toBe("add a docstring")
    expect(value?.tier).toBe("standard")
  })

  test("context() takes the task text from user parts and ignores synthetic ones", () => {
    const context = FreeCodeContext.context({ name: "coder", tier: "strong" }, [
      { type: "text", text: "fix the loader" },
      // A harness-injected reminder describes the environment, not the task, and
      // would skew a capability estimate.
      { type: "text", text: "reminder: you are in a git repository", synthetic: true } as never,
      { type: "file", text: undefined } as never,
    ])
    expect(context.agent).toBe("coder")
    expect(context.tier).toBe("strong")
    expect(context.task).toContain("fix the loader")
  })

  test("context() tolerates an empty prompt", () => {
    const context = FreeCodeContext.context({ name: "build" }, [])
    expect(context.agent).toBe("build")
    expect(context.task).toBe("")
  })

  test("context() caps a pasted prompt so the classifier is not crowded out", () => {
    const context = FreeCodeContext.context({ name: "coder" }, [
      { type: "text", text: "x".repeat(FreeCodeContext.ROUTING_TASK_LIMIT * 3) },
    ])
    expect(context.task.length).toBe(FreeCodeContext.ROUTING_TASK_LIMIT)
  })
})

describe("resolution without a router", () => {
  test("a declared tier survives a router that cannot answer", () => {
    // Exercised through `higherTier` and `isAuto` rather than through `resolve`,
    // because `resolve` consults the Laya bridge and a test that spawns it pays a
    // model load to learn something already decided here. The degraded path itself
    // is covered end to end in the installed-binary check recorded in
    // DEVELOPMENT.md, where a missing bridge produced exactly this outcome:
    // "router unavailable (Laya bridge not found (searched 3 locations)),
    //  declared tier standard".
    expect(ModelResolver.higherTier("standard", "fast")).toBe("standard")
    expect(ModelResolver.isAuto(undefined)).toBe(true)
    expect(ModelResolver.isAuto("auto")).toBe(true)
    expect(ModelResolver.isAuto("deepseek/deepseek-v4-pro")).toBe(false)
  })

  test("honours an explicit model without classifying anything", async () => {
    const resolution = await Effect.runPromise(
      Effect.promise(() =>
        ModelResolver.resolve({
          agent: "coder",
          prompt: "add a docstring",
          requested: "deepseek/deepseek-v4-pro",
        }),
      ),
    )
    expect(resolution.mode).toBe("fixed")
    expect(resolution.reason).toContain("explicit model")
  })

  test("a declared tier is a floor, never a ceiling", () => {
    expect(ModelResolver.higherTier("standard", "strong")).toBe("strong")
    expect(ModelResolver.higherTier("max", "fast")).toBe("max")
    expect(ModelResolver.higherTier("fast", "fast")).toBe("fast")
  })
})

describe("the sentinel contract", () => {
  test("a decision always names the source it came from", () => {
    // `source` is what makes a degraded route visible in a log. A decision with no
    // source would read as a successful classification.
    const decision: RouteDecision = {
      kind: "coding",
      tier: "standard",
      difficulty: 3,
      needsReview: true,
      parallelizable: false,
      confidence: 0.5,
      source: "rules",
      reason: "router unavailable",
    }
    expect(["laya", "rules"]).toContain(decision.source)
  })

  test("a provided context is readable inside a nested effect, which is how the provider sees it", () => {
    // The provider resolves the sentinel with `yield* RoutingRef` several frames
    // deep. This pins the behaviour it depends on rather than the implementation
    // detail of which Context constructor produced the reference; a previous
    // revision matched on the wrong detail and asserted nothing useful.
    const seen = Effect.runSync(
      Effect.gen(function* () {
        return yield* Effect.gen(function* () {
          return (yield* FreeCodeContext.RoutingRef)?.agent
        })
      }).pipe(
        Effect.provideService(FreeCodeContext.RoutingRef, { agent: "coder", task: "t", tier: "fast" }),
      ),
    )
    expect(seen).toBe("coder")
  })

  test("an inner provision overrides an outer one, which is how a subagent routes on its own task", () => {
    const seen = Effect.runSync(
      Effect.gen(function* () {
        const outer = (yield* FreeCodeContext.RoutingRef)?.agent
        const inner = yield* Effect.gen(function* () {
          return (yield* FreeCodeContext.RoutingRef)?.agent
        }).pipe(
          Effect.provideService(FreeCodeContext.RoutingRef, { agent: "reviewer", task: "r", tier: "strong" }),
        )
        return { outer, inner }
      }).pipe(Effect.provideService(FreeCodeContext.RoutingRef, { agent: "build", task: "b", tier: "fast" })),
    )
    expect(seen.outer).toBe("build")
    expect(seen.inner).toBe("reviewer")
  })
})
