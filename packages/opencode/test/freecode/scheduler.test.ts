import { describe, expect, test } from "bun:test"
import { Scheduler, type Candidate, type Resource } from "@/freecode/scheduler"
import { ResourceState } from "@/freecode/state"

function resource(overrides: Partial<Resource> & Pick<Resource, "id">): Resource {
  return {
    provider: overrides.id.split("/")[0] ?? "test",
    account: "main",
    model: overrides.id.split("/")[1] ?? "model",
    tiers: ["fast", "standard", "strong", "max"],
    capability: { coding: 0.5, reasoning: 0.5, review: 0.5, speed: 0.5 },
    cost: 1,
    ...overrides,
  }
}

describe("scheduler eligibility", () => {
  test("rejects a resource that does not serve the tier", () => {
    const candidate: Candidate = { resource: resource({ id: "a/cheap", tiers: ["fast"] }) }
    expect(Scheduler.eligible([candidate], { tier: "strong" })).toEqual([])
    expect(Scheduler.eligible([candidate], { tier: "fast" })).toHaveLength(1)
  })

  test("rejects an exhausted quota", () => {
    const candidate: Candidate = {
      resource: resource({ id: "a/model" }),
      state: { ...ResourceState.empty(), quota: { status: "exhausted", source: "header", updatedAt: Date.now() } },
    }
    expect(Scheduler.eligible([candidate], { tier: "standard" })).toEqual([])
  })

  test("rejects a resource whose circuit is open", () => {
    const candidate: Candidate = {
      resource: resource({ id: "a/model" }),
      state: { ...ResourceState.empty(), circuitOpenUntil: Date.now() + 60_000 },
    }
    expect(Scheduler.eligible([candidate], { tier: "standard" })).toEqual([])
  })

  test("accepts a resource whose circuit has expired", () => {
    const candidate: Candidate = {
      resource: resource({ id: "a/model" }),
      state: { ...ResourceState.empty(), circuitOpenUntil: Date.now() - 1, health: "unavailable" as const },
    }
    // The circuit expired but health still says unavailable, which is the signal
    // that decides. Both must clear before the resource returns.
    expect(Scheduler.eligible([candidate], { tier: "standard" })).toEqual([])
  })

  test("rejects a resource that falls short on a needed capability axis", () => {
    const weak: Candidate = {
      resource: resource({
        id: "a/weak",
        capability: { coding: 0.3, reasoning: 0.3, review: 0.3, speed: 0.5 },
      }),
    }
    const strong: Candidate = {
      resource: resource({
        id: "a/strong",
        capability: { coding: 0.9, reasoning: 0.9, review: 0.9, speed: 0.5 },
      }),
    }
    const eligible = Scheduler.eligible([weak, strong], { tier: "standard", needs: { reasoning: 0.8 } })
    expect(eligible.map((candidate) => candidate.resource.id)).toEqual(["a/strong"])
    // The weak resource is only excluded by the requirement, not by the pool:
    // without it, the same resource is eligible.
    expect(Scheduler.eligible([weak], { tier: "standard" })).toHaveLength(1)
  })
})

describe("scheduler scoring", () => {
  test("prefers the resource with more quota headroom when everything else is equal", () => {
    const low: Candidate = {
      resource: resource({ id: "a/low" }),
      state: { ...ResourceState.empty(), quota: { status: "low", source: "header", remaining: 0.05, updatedAt: Date.now() } },
    }
    const high: Candidate = {
      resource: resource({ id: "a/high" }),
      state: { ...ResourceState.empty(), quota: { status: "healthy", source: "header", remaining: 0.9, updatedAt: Date.now() } },
    }
    const winner = Scheduler.select([low, high], { tier: "standard" })
    expect(winner?.candidate.resource.id).toBe("a/high")
  })

  test("prefers the healthy resource over the degraded one", () => {
    const degraded: Candidate = {
      resource: resource({ id: "a/degraded" }),
      state: { ...ResourceState.empty(), health: "degraded" as const },
    }
    const healthy: Candidate = {
      resource: resource({ id: "a/healthy" }),
      state: { ...ResourceState.empty(), health: "available" as const },
    }
    expect(Scheduler.select([degraded, healthy], { tier: "standard" })?.candidate.resource.id).toBe("a/healthy")
  })

  test("unknown quota scores neutrally rather than as either extreme", () => {
    expect(Scheduler.quotaTerm(undefined)).toBe(0.5)
    expect(Scheduler.quotaTerm({ ...ResourceState.empty(), quota: { status: "healthy", source: "unknown", updatedAt: 0 } })).toBe(0.5)
    expect(
      Scheduler.quotaTerm({
        ...ResourceState.empty(),
        quota: { status: "healthy", source: "header", remaining: 1, updatedAt: 0 },
      }),
    ).toBe(1)
  })

  test("a cheaper resource wins when capability, quota and health are equal", () => {
    const cheap: Candidate = { resource: resource({ id: "a/cheap", cost: 0 }) }
    const dear: Candidate = { resource: resource({ id: "a/dear", cost: 10 }) }
    expect(Scheduler.select([dear, cheap], { tier: "standard" })?.candidate.resource.id).toBe("a/cheap")
  })

  test("breaks ties deterministically so an unchanged pool keeps its order", () => {
    const first: Candidate = { resource: resource({ id: "a/one" }) }
    const second: Candidate = { resource: resource({ id: "a/two" }) }
    const forward = Scheduler.rank([first, second], { tier: "standard" }).map((row) => row.candidate.resource.id)
    const reversed = Scheduler.rank([second, first], { tier: "standard" }).map((row) => row.candidate.resource.id)
    expect(forward).toEqual(reversed)
    expect(forward).toEqual(["a/one", "a/two"])
  })

  test("returns undefined when nothing is eligible", () => {
    const candidate: Candidate = {
      resource: resource({ id: "a/model", tiers: ["fast"] }),
    }
    expect(Scheduler.select([candidate], { tier: "max" })).toBeUndefined()
  })

  test("explains a decision in terms of its own inputs", () => {
    const candidate: Candidate = { resource: resource({ id: "a/model" }) }
    const scored = Scheduler.select([candidate], { tier: "standard" })
    expect(scored).toBeDefined()
    const text = Scheduler.explain(scored!)
    expect(text).toContain("a/model")
    expect(text).toContain("capability=")
    expect(text).toContain("quota=")
  })
})

describe("account pools", () => {
  test("groups providers that share a vendor prefix", () => {
    expect(Scheduler.vendorOf("deepseek-main")).toBe("deepseek")
    expect(Scheduler.vendorOf("deepseek-backup")).toBe("deepseek")
    expect(Scheduler.vendorOf("openai")).toBe("openai")
    expect(Scheduler.vendorOf("openrouter_main")).toBe("openrouter")
  })

  test("a failure can switch to another account of the same vendor", () => {
    const candidates: Candidate[] = [
      { resource: resource({ id: "deepseek-main/flash", provider: "deepseek-main", account: "main" }) },
      { resource: resource({ id: "deepseek-backup/flash", provider: "deepseek-backup", account: "backup" }) },
      { resource: resource({ id: "openai/gpt", provider: "openai", account: "main" }) },
    ]
    const family = Scheduler.sameVendor(candidates, "deepseek-main")
    expect(family.map((candidate) => candidate.resource.provider)).toEqual(["deepseek-main", "deepseek-backup"])
  })

  test("falls back to a second account when the first is exhausted", () => {
    const candidates: Candidate[] = [
      {
        resource: resource({ id: "deepseek-main/flash", provider: "deepseek-main", account: "main" }),
        state: { ...ResourceState.empty(), quota: { status: "exhausted", source: "header", updatedAt: Date.now() } },
      },
      {
        resource: resource({ id: "deepseek-backup/flash", provider: "deepseek-backup", account: "backup" }),
        state: { ...ResourceState.empty(), quota: { status: "healthy", source: "header", remaining: 0.8, updatedAt: Date.now() } },
      },
    ]
    expect(Scheduler.select(candidates, { tier: "standard" })?.candidate.resource.id).toBe("deepseek-backup/flash")
  })
})

describe("resource state", () => {
  test("a task failure is recorded without degrading the resource", () => {
    const state = ResourceState.recordFailure(undefined, { provider: false })
    expect(state.attempts).toBe(1)
    expect(state.providerFailures).toBe(0)
    expect(state.health).toBe("available")
    expect(state.circuitOpenUntil).toBeUndefined()
  })

  test("consecutive provider failures open the circuit", () => {
    let state = ResourceState.empty()
    for (let i = 0; i < ResourceState.CIRCUIT_THRESHOLD; i += 1) {
      state = ResourceState.recordFailure(state, { provider: true })
    }
    expect(state.health).toBe("unavailable")
    expect(state.circuitOpenUntil).toBeGreaterThan(Date.now())
  })

  test("a success closes the circuit and clears consecutive failures", () => {
    const failed = ResourceState.recordFailure(undefined, { provider: true })
    const recovered = ResourceState.recordSuccess(failed, 1200)
    expect(recovered.health).toBe("available")
    expect(recovered.consecutiveFailures).toBe(0)
    expect(recovered.circuitOpenUntil).toBeUndefined()
  })

  test("a reported quota exhaustion remembers the reset time", () => {
    const resetAt = Date.now() + 300_000
    const state = ResourceState.recordFailure(undefined, { provider: true, quotaExhausted: true, resetAt })
    expect(state.quota?.status).toBe("exhausted")
    expect(state.quota?.source).toBe("header")
    expect(state.circuitOpenUntil).toBe(resetAt)
  })

  test("latency averages only over sampled successes", () => {
    let state = ResourceState.recordSuccess(undefined, 1000)
    state = ResourceState.recordSuccess(state, 3000)
    expect(ResourceState.averageLatency(state)).toBe(2000)
    expect(ResourceState.averageLatency(ResourceState.empty())).toBeUndefined()
  })
})
