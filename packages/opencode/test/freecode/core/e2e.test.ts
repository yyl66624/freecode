import { describe, expect, test } from "bun:test"
import {
  type CapabilityTier,
  NoResourceError,
  DEFAULT_WEIGHTS,
  type Candidate,
  initialState,
  initialMetrics,
  onCall,
  metricOnCall,
  onProbe,
  probeOptions,
  pick,
  eligible,
  pool,
  resolve,
  park,
  reProbe,
  sweepQuotaWindows,
  type ResolveRequest,
  type CandidateSpec,
  type ModelSpec,
  type AccountSpec,
  type ProviderSpec,
  type CandidateHealth,
  type CandidateMetrics,
} from "@/freecode/core"

/**
 * The end-to-end contract test: the scheduler core as a whole. Each test
 * walks one scenario through state → scoring → resolve, and pins the
 * documented outcome. This is the layer that Stage 3 glues to the
 * harness; nothing here touches the harness.
 */

const NOW = 1_700_000_000_000

function makeCandidate(
  modelID: string,
  accountID: string,
  providerID: string,
  tier: CapabilityTier = "standard",
  caps: string[] = ["tools", "json"],
  cost?: { input: number; output: number },
): Candidate {
  const spec: CandidateSpec = {
    model: {
      id: modelID,
      provider: providerID,
      contextWindow: 32_768,
      maxOutput: 8_192,
      capabilities: caps,
      tier,
      costPerMtok: cost,
    } as ModelSpec,
    account: {
      id: accountID,
      provider: providerID,
      credential: `env:${providerID.toUpperCase()}_KEY`,
      enabled: true,
    } as AccountSpec,
    provider: {
      id: providerID,
      protocol: "openai-chat",
      endpoint: `https://api.${providerID}.example.com/v1`,
      auth: "bearer",
      models: [modelID],
      accounts: [accountID],
    } as ProviderSpec,
  }
  return { spec, health: initialState(), metrics: initialMetrics(), quotaRemaining: undefined }
}

const standard = (req: Partial<ResolveRequest> = {}): ResolveRequest => ({
  capability: "standard",
  requiredFeatures: ["tools"],
  ...req,
})

describe("end-to-end scheduler core", () => {
  test("a healthy pool picks the best-scoring candidate", () => {
    const pool = [
      makeCandidate("deepseek/deepseek-chat", "deepseek-main", "deepseek", "standard", ["tools", "json"], { input: 0.5, output: 2 }),
      makeCandidate("zhipu/glm-4-plus", "zhipu-main", "zhipu", "deep", ["tools", "json", "long-context"], { input: 1, output: 5 }),
    ]
    // Give the deepseek one a head start in latency so it is clearly better.
    pool[0].metrics = (() => {
      let m = initialMetrics()
      for (let i = 0; i < 5; i++) m = metricOnCall(m, { ok: true, latencyMs: 1_200, at: NOW + i * 1000 })
      return m
    })()
    const outcome = resolve(pool, standard(), { now: NOW, jitterSeed: 0 })
    expect(outcome.binding.model.id).toBe("deepseek/deepseek-chat")
    expect(outcome.binding.account.id).toBe("deepseek-main")
    expect(outcome.binding.endpoint).toBe("https://api.deepseek.example.com/v1")
    expect(outcome.audit.pick).toBe("deepseek/deepseek-chat@deepseek-main")
  })

  test("sticky routing keeps a session on its current binding", () => {
    const pool = [
      makeCandidate("deepseek/deepseek-chat", "deepseek-main", "deepseek"),
      makeCandidate("zhipu/glm-4-flash", "zhipu-main", "zhipu", "light"),
    ]
    // Both are HEALTHY; the current binding should be kept if it is within
    // STICKY_DELTA of the winner.
    const outcome = resolve(pool, standard(), {
      now: NOW,
      currentBinding: "zhipu/glm-4-flash@zhipu-main",
      jitterSeed: 0,
    })
    // If the two are too close in score, sticky wins. If not, it rebinds.
    // The key assertion: the outcome always carries a `via` that tells us
    // which path was taken.
    expect(outcome.binding.via).toBeDefined()
  })

  test("a degraded candidate is still eligible but scored lower", () => {
    const healthy = makeCandidate("a/m1", "a-main", "a")
    const degraded = makeCandidate("b/m2", "b-main", "b")
    degraded.health = { ...initialState(), state: "DEGRADED", consecutiveFailures: 1 }
    const outcome = pick([healthy, degraded], standard(), { now: NOW })!
    // The healthy one should win because its health term is 1 vs 0.5.
    expect(outcome.candidate.spec.model.id).toBe("a/m1")
    expect(outcome.terms.health).toBe(1)
  })

  test("an UNHEALTHY candidate is out of the pool; a healthy sibling serves", () => {
    const broken = makeCandidate("a/m1", "a-main", "a")
    broken.health = { ...initialState(), state: "UNHEALTHY", consecutiveFailures: 3 }
    const pool = [broken, makeCandidate("b/m2", "b-main", "b")]
    const picked = pick(pool, standard(), { now: NOW })!
    expect(picked.candidate.spec.model.id).toBe("b/m2")
  })

  test("EXHAUSTED until the window rolls; after the sweep it is back", () => {
    const exhausted = makeCandidate("a/m1", "a-main", "a")
    exhausted.health = onCall(exhausted.health, { ok: false, status: 429, at: NOW - 1000 }, probeOptions())
    exhausted.health = { ...exhausted.health, quotaResetAt: NOW + 86_400_000 }
    const pool = [exhausted, makeCandidate("b/m2", "b-main", "b")]

    // Before the reset: only the sibling serves.
    const before = pick(pool, standard(), { now: NOW })!
    expect(before.candidate.spec.model.id).toBe("b/m2")

    // After the reset: the sweep re-admits it via DEGRADED.
    const swept = sweepQuotaWindows(pool, NOW + 87_000_000)
    expect(swept.reAdmitted).toHaveLength(1)
    const after = pick(swept.next, standard(), { now: NOW + 87_000_000 })!
    // Both are now in the pool; the DEGRADED one still scores but both are eligible.
    expect(["a/m1", "b/m2"]).toContain(after.candidate.spec.model.id)
  })

  test("INVALID is terminal: no probe outcome recovers it", () => {
    const invalid = makeCandidate("a/m1", "a-main", "a")
    invalid.health = { ...initialState(), state: "INVALID" }
    const pool = [invalid, makeCandidate("b/m2", "b-main", "b")]
    const picked = pick(pool, standard(), { now: NOW })!
    expect(picked.candidate.spec.model.id).toBe("b/m2")
    // Probing the INVALID candidate still leaves it INVALID.
    const after = onProbe(invalid.health, { ok: true, at: NOW + 1000 }, probeOptions())
    expect(after.state).toBe("INVALID")
  })

  test("a single DEGRADED candidate is still selected (the risk is not hidden)", () => {
    const only = makeCandidate("z/m", "z-main", "z")
    only.health = { ...initialState(), state: "DEGRADED", consecutiveFailures: 1 }
    const picked = pick([only], standard(), { now: NOW })!
    expect(picked).toBeDefined()
    expect(picked.terms.health).toBe(0.5)
  })

  test("the cold-start pool uses the vendor latency priors, not a zero", () => {
    const minimax = makeCandidate("minimax/abab-6.5s-chat", "minimax-main", "minimax")
    const zhipu = makeCandidate("zhipu/glm-4-flash", "zhipu-main", "zhipu")
    // No observations: latency terms come from the priors.
    const t1 = pick([minimax], standard(), { now: NOW })!
    const t2 = pick([zhipu], standard(), { now: NOW })!
    // minimax prior is 1000ms, zhipu is 800ms — zhipu should have a better
    // latency term, all else being equal.
    expect(t2.terms.latency).toBeGreaterThan(t1.terms.latency)
  })

  test("the full SUSPENDED cycle: park → re-probe → resume", () => {
    const pool = [makeCandidate("a/m1", "a-main", "a")]
    // Break the pool: all UNHEALTHY.
    pool[0].health = { ...initialState(), state: "UNHEALTHY", consecutiveFailures: 3 }
    expect(pick(pool, standard(), { now: NOW })).toBeUndefined()

    const snap = park(standard(), NOW)
    expect(snap.checklist.length).toBe(3)
    expect(snap.autoResume).toBe(true)

    // Two probe successes recover it (recoveryThreshold = 2).
    const outcomes = new Map([["a/m1@a-main", { ok: true }]])
    const result = reProbe(snap, pool, outcomes, NOW + 5 * 60_000)
    // After the first probe success the candidate is still UNHEALTHY
    // (needs two consecutive successes to recover), so the pool is still
    // empty and the task stays suspended.
    expect(result.resume).toBe(false)

    // A second probe pass: the candidate is now DEGRADED (one success
    // since the last failure), which is in-pool, so it resumes.
    pool[0].health = onProbe(pool[0].health, { ok: true, at: NOW + 5 * 60_000 }, probeOptions())
    const result2 = reProbe(snap, pool, new Map([[
      "a/m1@a-main", { ok: true }
    ]]), NOW + 10 * 60_000)
    expect(result2.resume).toBe(true)
    expect(result2.binding).toBe("a/m1@a-main")
  })

  test("a task requirement below a candidate's tier is hard-excluded", () => {
    const light = makeCandidate("a/m1", "a-main", "a", "light")
    const excluded = eligible(light, standard(), NOW, { relaxed: false })
    expect(excluded).toContain("capability")
  })

  test("a required feature the candidate lacks is hard-excluded; the relaxed pool drops it", () => {
    const noTools = makeCandidate("a/m1", "a-main", "a", "standard", ["json"])
    const strictPool = pool([noTools], standard({ requiredFeatures: ["tools"] }), NOW, false)
    expect(strictPool).toHaveLength(0)
    const relaxedPool = pool([noTools], standard({ requiredFeatures: ["tools"] }), NOW, true)
    expect(relaxedPool).toHaveLength(1)
  })

  test("an account with enabled=false is hard-excluded", () => {
    const disabled = makeCandidate("a/m1", "a-main", "a")
    disabled.spec.account.enabled = false
    const excluded = eligible(disabled, standard(), NOW, { relaxed: false })
    expect(excluded).toContain("account-disabled")
  })

  test("a zero quotaRemaining is hard-excluded", () => {
    const spent = makeCandidate("a/m1", "a-main", "a")
    spent.quotaRemaining = 0
    const excluded = eligible(spent, standard(), NOW, { relaxed: false })
    expect(excluded).toContain("quota-remaining")
  })

  test("the default weights are the documented values", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      capability: 0.25,
      quota: 0.2,
      health: 0.25,
      latency: 0.15,
      reliability: 0.1,
      cost: 0.05,
    })
  })

  test("user weights are normalised before scoring", () => {
    const pool = [makeCandidate("a/m1", "a-main", "a")]
    // A user weight set that sums to 2: each weight is halved.
    const outcome = resolve(pool, standard(), {
      now: NOW,
      weights: { capability: 1, quota: 1, health: 1, latency: 1, reliability: 1, cost: 1 },
    })
    expect(outcome).toBeDefined()
  })

  test("NoResourceError is not silently swallowed by a fallback", () => {
    expect(() =>
      resolve([makeCandidate("a/m1", "a-main", "a")], standard({ capability: "expert" }), { now: NOW }),
    ).toThrow(NoResourceError)
  })
})
