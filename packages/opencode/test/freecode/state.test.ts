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

function withState(resource: Resource, state: ResourceState): Candidate {
  return { resource, state }
}

function quota(status: "healthy" | "low" | "exhausted", remaining: number, resetAt?: number): ResourceState {
  return {
    ...ResourceState.empty(),
    quota: { status, source: "header", remaining, resetAt, updatedAt: Date.now() },
  }
}

describe("scheduler eligibility", () => {
  test("rejects a resource that does not serve the tier", () => {
    const candidate: Candidate = { resource: resource({ id: "a/cheap", tiers: ["fast"] }) }
    expect(Scheduler.eligible([candidate], { tier: "strong" })).toEqual([])
    expect(Scheduler.eligible([candidate], { tier: "fast" })).toHaveLength(1)
  })

  test("rejects an exhausted quota", () => {
    const candidate = withState(resource({ id: "a/model" }), quota("exhausted", 0))
    expect(Scheduler.eligible([candidate], { tier: "standard" })).toEqual([])
  })

  test("accepts an exhausted quota once its window has reset", () => {
    const candidate = withState(resource({ id: "a/model" }), quota("exhausted", 0, Date.now() - 1))
    expect(Scheduler.eligible([candidate], { tier: "standard" })).toHaveLength(1)
  })

  test("rejects a resource whose circuit is open", () => {
    const state: ResourceState = {
      ...ResourceState.empty(),
      circuit: { state: "open", consecutiveFailures: 3, retryAt: Date.now() + 60_000, reason: "server" },
    }
    expect(Scheduler.eligible([withState(resource({ id: "a/model" }), state)], { tier: "standard" })).toEqual([])
  })

  test("admits a resource whose cooldown expired, so it can be probed", () => {
    const state: ResourceState = {
      ...ResourceState.empty(),
      circuit: { state: "open", consecutiveFailures: 3, retryAt: Date.now() - 1, reason: "server" },
      health: "degraded",
    }
    expect(Scheduler.eligible([withState(resource({ id: "a/model" }), state)], { tier: "standard" })).toHaveLength(1)
  })

  test("rejects a resource that falls short on a needed capability axis", () => {
    const weak = resource({ id: "a/weak", capability: { coding: 0.3, reasoning: 0.3, review: 0.3, speed: 0.5 } })
    const strong = resource({ id: "a/strong", capability: { coding: 0.9, reasoning: 0.9, review: 0.9, speed: 0.5 } })
    const eligible = Scheduler.eligible(
      [withState(weak, ResourceState.empty()), withState(strong, ResourceState.empty())],
      { tier: "standard", needs: { reasoning: 0.8 } },
    )
    expect(eligible.map((candidate) => candidate.resource.id)).toEqual(["a/strong"])
    expect(Scheduler.eligible([withState(weak, ResourceState.empty())], { tier: "standard" })).toHaveLength(1)
  })

  test("applies the capability filter to a resource with no observed state", () => {
    // Regression: eligibility returned early for an unseen resource and skipped
    // the capability check, so the weakest model could win a strong task.
    const weak = resource({ id: "a/weak", capability: { coding: 0.2, reasoning: 0.2, review: 0.2, speed: 0.5 } })
    expect(Scheduler.eligible([{ resource: weak }], { tier: "standard", needs: { coding: 0.8 } })).toEqual([])
  })
})

describe("scheduler scoring", () => {
  test("prefers the resource with more quota headroom when everything else is equal", () => {
    const low = withState(resource({ id: "a/low" }), quota("low", 0.05))
    const high = withState(resource({ id: "a/high" }), quota("healthy", 0.9))
    expect(Scheduler.select([low, high], { tier: "standard" })?.candidate.resource.id).toBe("a/high")
  })

  test("prefers the healthy resource over the degraded one", () => {
    const degraded = withState(resource({ id: "a/degraded" }), { ...ResourceState.empty(), health: "degraded" })
    const healthy = withState(resource({ id: "a/healthy" }), { ...ResourceState.empty(), health: "available" })
    expect(Scheduler.select([degraded, healthy], { tier: "standard" })?.candidate.resource.id).toBe("a/healthy")
  })

  test("unknown quota scores neutrally rather than as either extreme", () => {
    expect(Scheduler.quotaTerm(undefined)).toBe(0.5)
    expect(Scheduler.quotaTerm(quota("healthy", 1))).toBe(1)
    expect(
      Scheduler.quotaTerm({ ...ResourceState.empty(), quota: { status: "unknown", source: "unknown", updatedAt: 0 } }),
    ).toBe(0.5)
  })

  test("a cheaper resource wins when capability, quota and health are equal", () => {
    const cheap: Candidate = { resource: resource({ id: "a/cheap", cost: 0 }) }
    const dear: Candidate = { resource: resource({ id: "a/dear", cost: 10 }) }
    expect(Scheduler.select([dear, cheap], { tier: "standard" })?.candidate.resource.id).toBe("a/cheap")
  })

  test("cost is penalised on an absolute scale, not relative to the pool", () => {
    // Regression: normalising cost against the most expensive candidate meant a
    // pool of uniformly expensive models paid no cost penalty at all.
    expect(Scheduler.costTerm(resource({ id: "a/x", cost: 1 }))).toBeGreaterThan(
      Scheduler.costTerm(resource({ id: "a/y", cost: 8 })),
    )
    expect(Scheduler.costTerm(resource({ id: "a/z", cost: 9 }))).toBeLessThan(0.2)
  })

  test("breaks ties deterministically so an unchanged pool keeps its order", () => {
    const first: Candidate = { resource: resource({ id: "a/one" }) }
    const second: Candidate = { resource: resource({ id: "a/two" }) }
    const forward = Scheduler.rank([first, second], { tier: "standard" }).map((row) => row.candidate.resource.id)
    const reversed = Scheduler.rank([second, first], { tier: "standard" }).map((row) => row.candidate.resource.id)
    expect(forward).toEqual(reversed)
    expect(forward).toEqual(["a/one", "a/two"])
  })

  test("prefers the currently fast resource over one with a stale good mean", () => {
    const slowed = withState(resource({ id: "a/slowed" }), {
      ...ResourceState.empty(),
      totalLatencyMs: 1000,
      latencySamples: 10,
      latencyEMA: 40_000,
    })
    const fast = withState(resource({ id: "a/fast" }), {
      ...ResourceState.empty(),
      totalLatencyMs: 30_000,
      latencySamples: 10,
      latencyEMA: 1_000,
    })
    expect(Scheduler.select([slowed, fast], { tier: "standard" })?.candidate.resource.id).toBe("a/fast")
  })

  test("returns undefined when nothing is eligible", () => {
    expect(
      Scheduler.select([{ resource: resource({ id: "a/model", tiers: ["fast"] }) }], { tier: "max" }),
    ).toBeUndefined()
  })

  test("explains a decision in terms of its own inputs", () => {
    const scored = Scheduler.select([{ resource: resource({ id: "a/model" }) }], { tier: "standard" })
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
    expect(Scheduler.sameVendor(candidates, "deepseek-main").map((c) => c.resource.provider)).toEqual([
      "deepseek-main",
      "deepseek-backup",
    ])
  })

  test("falls back to a second account when the first is exhausted", () => {
    const candidates: Candidate[] = [
      withState(resource({ id: "deepseek-main/flash", provider: "deepseek-main" }), quota("exhausted", 0)),
      withState(resource({ id: "deepseek-backup/flash", provider: "deepseek-backup" }), quota("healthy", 0.8)),
    ]
    expect(Scheduler.select(candidates, { tier: "standard" })?.candidate.resource.id).toBe("deepseek-backup/flash")
  })
})

describe("circuit breaker", () => {
  test("a task failure is recorded without degrading the resource", () => {
    const state = ResourceState.recordFailure(undefined, { class: "task_failure", resource: false })
    expect(state.attempts).toBe(1)
    expect(state.providerFailures).toBe(0)
    expect(state.health).toBe("available")
    expect(state.circuit.state).toBe("closed")
    expect(state.circuit.consecutiveFailures).toBe(0)
  })

  test("consecutive provider failures open the circuit", () => {
    let state = ResourceState.empty()
    for (let i = 0; i < ResourceState.CIRCUIT_THRESHOLD; i += 1) {
      state = ResourceState.recordFailure(state, { class: "server", resource: true })
    }
    expect(state.circuit.state).toBe("open")
    expect(state.circuit.retryAt).toBeGreaterThan(Date.now())
    expect(state.health).toBe("unavailable")
  })

  test("task failures never count toward opening the circuit", () => {
    let state = ResourceState.empty()
    for (let i = 0; i < ResourceState.CIRCUIT_THRESHOLD + 2; i += 1) {
      state = ResourceState.recordFailure(state, { class: "task_failure", resource: false })
    }
    expect(state.circuit.state).toBe("closed")
    expect(state.circuit.consecutiveFailures).toBe(0)
  })

  test("a rate limit opens the circuit immediately rather than counting to a threshold", () => {
    const state = ResourceState.recordFailure(undefined, { class: "rate_limit", resource: true })
    expect(state.circuit.state).toBe("open")
    expect(state.circuit.consecutiveFailures).toBe(1)
    expect(state.quota?.status).toBe("exhausted")
    expect(state.circuit.reason).toBe("rate_limit")
  })

  test("a stated reset time is used as the exact cooldown", () => {
    const resetAt = Date.now() + 42_000
    const state = ResourceState.recordFailure(undefined, { class: "rate_limit", resource: true, resetAt })
    expect(state.circuit.retryAt).toBe(resetAt)
    expect(state.quota?.source).toBe("header")
  })

  test("an unstated reset falls back to an estimated cooldown and says so", () => {
    const state = ResourceState.recordFailure(undefined, { class: "rate_limit", resource: true })
    expect(state.quota?.source).toBe("estimated")
    expect(state.circuit.retryAt).toBeGreaterThan(Date.now())
  })

  test("an expired open circuit is promoted to half_open so it can be probed once", () => {
    const state: ResourceState = {
      ...ResourceState.empty(),
      circuit: { state: "open", consecutiveFailures: 3, retryAt: 2_000, reason: "server" },
    }
    const promoted = ResourceState.read({ version: 2, resources: { r: state } }, "r", 3_000)
    expect(promoted?.circuit.state).toBe("half_open")
    expect(ResourceState.usable(promoted, 3_000)).toBe(true)
  })

  test("a circuit that is still cooling down is not usable", () => {
    const state: ResourceState = {
      ...ResourceState.empty(),
      circuit: { state: "open", consecutiveFailures: 3, retryAt: 10_000, reason: "server" },
    }
    expect(ResourceState.usable(state, 5_000)).toBe(false)
    expect(ResourceState.read({ version: 2, resources: { r: state } }, "r", 5_000)?.circuit.state).toBe("open")
  })

  test("a successful probe closes the circuit", () => {
    const probing: ResourceState = {
      ...ResourceState.empty(),
      circuit: { state: "half_open", consecutiveFailures: 3, reason: "server" },
      health: "unavailable",
    }
    const recovered = ResourceState.recordSuccess(probing, 900)
    expect(recovered.circuit.state).toBe("closed")
    expect(recovered.circuit.consecutiveFailures).toBe(0)
    expect(recovered.health).toBe("available")
  })

  test("a failed probe reopens with a longer cooldown than a plain failure", () => {
    const probing: ResourceState = {
      ...ResourceState.empty(),
      circuit: { state: "half_open", consecutiveFailures: 3, retryAt: Date.now(), reason: "server" },
    }
    const reopened = ResourceState.recordFailure(probing, { class: "server", resource: true })
    expect(reopened.circuit.state).toBe("open")
    expect(reopened.circuit.retryAt).toBeGreaterThan(Date.now() + ResourceState.CIRCUIT_OPEN_MS)
  })

  test("a repeatedly failing probe cannot back off beyond the cap", () => {
    let state: ResourceState = {
      ...ResourceState.empty(),
      circuit: { state: "half_open", consecutiveFailures: 9, retryAt: Date.now(), reason: "server" },
    }
    for (let i = 0; i < 20; i += 1) {
      state = ResourceState.recordFailure(state, { class: "server", resource: true })
      state = { ...state, circuit: { ...state.circuit, state: "half_open" } }
    }
    expect((state.circuit.retryAt ?? 0) - Date.now()).toBeLessThanOrEqual(ResourceState.CIRCUIT_MAX_OPEN_MS)
  })

  test("reports why a resource is excluded, in words", () => {
    const open = ResourceState.recordFailure(undefined, { class: "rate_limit", resource: true })
    expect(ResourceState.exclusionReason(open)).toContain("circuit open")
    expect(ResourceState.exclusionReason(open)).toContain("rate_limit")
    expect(ResourceState.exclusionReason(ResourceState.empty())).toBeUndefined()
  })
})

describe("resource metrics", () => {
  test("latency averages over sampled successes and tracks an exponential average", () => {
    let state = ResourceState.recordSuccess(undefined, 1000)
    state = ResourceState.recordSuccess(state, 3000)
    expect(ResourceState.averageLatency(state)).toBe(2000)
    // The exponential average must sit between the samples and lean to the newer.
    expect(state.latencyEMA).toBeGreaterThan(1000)
    expect(state.latencyEMA).toBeLessThan(3000)
    expect(ResourceState.averageLatency(ResourceState.empty())).toBeUndefined()
  })

  test("the success rate reacts faster than the all-time ratio", () => {
    let state = ResourceState.empty()
    for (let i = 0; i < 5; i += 1) state = ResourceState.recordSuccess(state, 100)
    expect(state.successEMA).toBeCloseTo(1, 5)
    state = ResourceState.recordFailure(state, { class: "server", resource: true })
    // One failure in six leaves the all-time ratio at 0.833, while the exponential
    // average drops further because it weights the recent sample.
    expect(1 - (state.successEMA ?? 0)).toBeGreaterThan(1 - state.successes / state.attempts)
  })
})

describe("state migration", () => {
  test("reads a pre-breaker record instead of discarding a known rate limit", () => {
    const migrated = ResourceState.fromPersisted({
      attempts: 4,
      successes: 1,
      providerFailures: 3,
      health: "unavailable",
      consecutiveFailures: 3,
      circuitOpenUntil: Date.now() + 30_000,
      totalLatencyMs: 0,
      latencySamples: 0,
      updatedAt: Date.now(),
    })
    expect(migrated?.circuit.state).toBe("open")
    expect(migrated?.circuit.consecutiveFailures).toBe(3)
    expect(migrated?.circuit.retryAt).toBeGreaterThan(Date.now())
  })

  test("reads an expired legacy circuit as closed", () => {
    const migrated = ResourceState.fromPersisted({
      attempts: 1,
      successes: 1,
      health: "available",
      consecutiveFailures: 0,
      circuitOpenUntil: Date.now() - 1_000,
      updatedAt: Date.now(),
    })
    expect(migrated?.circuit.state).toBe("closed")
  })

  test("rejects a record that is not a resource state at all", () => {
    expect(ResourceState.fromPersisted(null)).toBeUndefined()
    expect(ResourceState.fromPersisted("nonsense")).toBeUndefined()
    expect(ResourceState.fromPersisted({ attempts: 1 })).toBeUndefined()
  })
})
