import { describe, expect, test } from "bun:test"
import {
  type CapabilityTier,
  type ModelSpec,
  type ProviderSpec,
  type AccountSpec,
  type CandidateSpec,
} from "@/freecode/core/types"
import { initialState, onCall, onProbe, onQuotaReset, onCredentialRotated, onDisabled, onEnabled, probeOptions } from "@/freecode/core/state-machine"
import { initialMetrics, onCall as metricsOnCall, applyStaleness, latencyMs, reliabilityOf, LATENCY_EMA_ALPHA } from "@/freecode/core/metrics"
import * as Scoring from "@/freecode/core/scoring"
import type { Candidate } from "@/freecode/core/scoring"

/**
 * A candidate pool for the tests: two vendors, an Ollama fallback, and
 * one account per vendor, so a failure on one never takes its sibling
 * down. The pool is built from specs + state, which is the shape
 * scheduler-core.resolve() consumes.
 */

const model = (id: string, overrides: Partial<ModelSpec> = {}): ModelSpec => ({
  id,
  provider: id.split("/")[0] ?? "test",
  contextWindow: 32_768,
  maxOutput: 8_192,
  capabilities: ["tools", "json"],
  tier: "standard",
  ...overrides,
})

const provider = (id: string, overrides: Partial<ProviderSpec> = {}): ProviderSpec => ({
  id,
  protocol: "openai-chat",
  endpoint: `https://api.${id}.example.com/v1`,
  auth: "bearer",
  models: [`${id}/m`],
  accounts: [`${id}-main`],
  ...overrides,
})

const account = (id: string, providerID: string, overrides: Partial<AccountSpec> = {}): AccountSpec => ({
  id,
  provider: providerID,
  credential: `env:${providerID.toUpperCase()}_API_KEY`,
  ...overrides,
})

function candidate(
  modelID: string,
  accountID: string,
  providerID: string,
  opts: { model?: Partial<ModelSpec>; account?: Partial<AccountSpec>; provider?: Partial<ProviderSpec> } = {},
): Candidate {
  const spec: CandidateSpec = {
    model: model(`${providerID === "ollama" ? "ollama/local" : modelID}`, {
      tier: "standard",
      ...(opts.model ?? {}),
    }),
    account: account(accountID, providerID, opts.account ?? {}),
    provider: provider(providerID, opts.provider ?? {}),
  }
  return { spec, health: initialState(), metrics: initialMetrics(), quotaRemaining: undefined }
}

const NOW = 1_700_000_000_000

const req = (overrides: Partial<import("@/freecode/core/types").ResolveRequest> = {}) => ({
  capability: "standard" as CapabilityTier,
  requiredFeatures: [] as string[],
  ...overrides,
})

describe("six-dimension state machine (docs 03 §4.1)", () => {
  test("a fresh candidate is HEALTHY and a probe success keeps it there", () => {
    let s = initialState(NOW)
    s = onProbe(s, { ok: true, at: NOW + 1_000 }, probeOptions())
    expect(s.state).toBe("HEALTHY")
  })

  test("one failure demotes to DEGRADED; failThreshold consecutive failures make it UNHEALTHY", () => {
    let s = initialState(NOW)
    s = onCall(s, { ok: false, status: 503, at: NOW + 1_000 }, probeOptions())
    expect(s.state).toBe("DEGRADED")
    s = onCall(s, { ok: false, status: 500, at: NOW + 2_000 }, probeOptions())
    expect(s.state).toBe("DEGRADED")
    s = onCall(s, { ok: false, status: 502, at: NOW + 3_000 }, probeOptions())
    expect(s.state).toBe("UNHEALTHY")
  })

  test("recoveryThreshold consecutive successes recover UNHEALTHY to HEALTHY", () => {
    let s = initialState(NOW)
    for (let i = 0; i < 3; i++) s = onCall(s, { ok: false, status: 500, at: NOW + i * 1_000 }, probeOptions())
    expect(s.state).toBe("UNHEALTHY")
    s = onCall(s, { ok: true, latencyMs: 1_200, at: NOW + 3_000 }, probeOptions())
    expect(s.state).toBe("UNHEALTHY") // one success is not enough
    s = onCall(s, { ok: true, latencyMs: 1_000, at: NOW + 4_000 }, probeOptions())
    expect(s.state).toBe("HEALTHY")
  })

  test("a 429 marks the candidate EXHAUSTED, remembering a known reset", () => {
    let s = initialState(NOW)
    s = onCall(s, { ok: false, status: 429, at: NOW, resetAt: NOW + 86_400_000 }, probeOptions())
    expect(s.state).toBe("EXHAUSTED")
    expect(s.quotaResetAt).toBe(NOW + 86_400_000)
  })

  test("a quota window reset re-admits EXHAUSTED via DEGRADED", () => {
    let s = initialState(NOW)
    s = onCall(s, { ok: false, status: 429, at: NOW }, probeOptions())
    expect(s.state).toBe("EXHAUSTED")
    s = onQuotaReset(s, NOW + 86_400_000)
    expect(s.state).toBe("DEGRADED")
    // Two successes back to full health.
    s = onCall(s, { ok: true, latencyMs: 900, at: NOW + 86_400_001 }, probeOptions())
    s = onCall(s, { ok: true, latencyMs: 900, at: NOW + 86_400_002 }, probeOptions())
    expect(s.state).toBe("HEALTHY")
  })

  test("a 401 gets one automatic retry; a second one marks INVALID, which is terminal", () => {
    let s = initialState(NOW)
    s = onCall(s, { ok: false, status: 401, at: NOW }, probeOptions())
    expect(s.state).toBe("DEGRADED") // the retry slot is still open
    // The retry succeeds: the key was just lapsed.
    let s2 = onCall(s, { ok: true, latencyMs: 1_000, at: NOW + 1_000 }, probeOptions())
    expect(s2.state).toBe("DEGRADED") // one success, under the recovery threshold
    s2 = onCall(s2, { ok: true, latencyMs: 1_000, at: NOW + 2_000 }, probeOptions())
    expect(s2.state).toBe("HEALTHY")

    // The terminal case: the retry fails too.
    let s3 = initialState(NOW)
    s3 = onCall(s3, { ok: false, status: 403, at: NOW }, probeOptions())
    s3 = onCall(s3, { ok: false, status: 401, at: NOW + 1_000 }, probeOptions())
    expect(s3.state).toBe("INVALID")
    // Probes cannot move an INVALID candidate back.
    s3 = onProbe(s3, { ok: true, at: NOW + 2_000 })
    expect(s3.state).toBe("INVALID")
    // Only credential rotation recovers it, and then cautiously.
    s3 = onCredentialRotated(s3, NOW + 3_000)
    expect(s3.state).toBe("DEGRADED")
  })

  test("manual disable → INVALID; manual re-enable → DEGRADED (probe first)", () => {
    let s = initialState(NOW)
    s = onDisabled(s, NOW + 1_000)
    expect(s.state).toBe("INVALID")
    s = onEnabled(s, NOW + 2_000)
    expect(s.state).toBe("DEGRADED")
  })

  test("a connection failure is not an http failure: 3 in a row → UNAVAILABLE, breaking ones → DEGRADED", () => {
    let s = initialState(NOW)
    s = onProbe(s, { ok: false, kind: "connection", at: NOW + 1_000 }, probeOptions())
    expect(s.state).toBe("DEGRADED")
    // An http failure in between breaks the connection streak.
    s = onProbe(s, { ok: false, kind: "http", at: NOW + 2_000 }, probeOptions())
    expect(s.connectionFailures).toBe(0)
    s = onProbe(s, { ok: false, kind: "connection", at: NOW + 3_000 }, probeOptions())
    s = onProbe(s, { ok: false, kind: "connection", at: NOW + 4_000 }, probeOptions())
    s = onProbe(s, { ok: false, kind: "connection", at: NOW + 5_000 }, probeOptions())
    expect(s.state).toBe("UNAVAILABLE")
    // "It came back": a successful probe drops it to DEGRADED, not straight to HEALTHY.
    s = onProbe(s, { ok: true, at: NOW + 6_000 }, probeOptions())
    expect(s.state).toBe("DEGRADED")
  })

  test("EXHAUSTED does not move on probe outcomes", () => {
    let s = initialState(NOW)
    s = onCall(s, { ok: false, status: 429, at: NOW }, probeOptions())
    expect(s.state).toBe("EXHAUSTED")
    s = onProbe(s, { ok: true, at: NOW + 1_000 }, probeOptions())
    expect(s.state).toBe("EXHAUSTED")
  })
})

describe("dynamic metrics (docs 03 §3.2, §7, §8)", () => {
  test("latency EWMA with α = 0.3 reacts within a few calls", () => {
    let m = initialMetrics()
    m = metricsOnCall(m, { ok: true, latencyMs: 4_000, at: NOW })
    expect(m.latencyEwmaMs).toBe(4_000)
    m = metricsOnCall(m, { ok: true, latencyMs: 2_000, at: NOW + 1_000 })
    expect(m.latencyEwmaMs).toBeCloseTo(4_000 * (1 - LATENCY_EMA_ALPHA) + 2_000 * LATENCY_EMA_ALPHA)
    m = metricsOnCall(m, { ok: true, latencyMs: 2_000, at: NOW + 2_000 })
    // 3400·0.7 + 2000·0.3 = 2980: the test's original 2800 figure was
    // 4000·0.7 + 2000·0.3 (one update from the seed), not the value after
    // two updates had already moved the EMA to 3400.
    expect(m.latencyEwmaMs).toBeCloseTo(3_400 * (1 - LATENCY_EMA_ALPHA) + 2_000 * LATENCY_EMA_ALPHA)
  })

  test("failures take no latency sample but count in reliability", () => {
    let m = initialMetrics()
    m = metricsOnCall(m, { ok: true, latencyMs: 2_000, at: NOW })
    const before = m.latencyEwmaMs
    m = metricsOnCall(m, { ok: false, at: NOW + 1_000 })
    expect(m.latencyEwmaMs).toBe(before)
    // One success and one failure, Laplace-smoothed over the window of 2:
    // (1 success + 1) / (2 + 2) = 0.5.
    expect(m.reliability).toBe(0.5)
  })

  test("the reliability window is the intersection of the last hour and the last 100 calls", () => {
    let m = initialMetrics()
    for (let i = 0; i < 100; i++) m = metricsOnCall(m, { ok: i < 95, latencyMs: 1_000, at: NOW + i * 100 })
    expect(m.windowSamples).toBe(100)
    const allIn = (95 + 1) / (100 + 2)
    expect(m.reliability).toBeCloseTo(allIn)
    // A call from more than an hour ago drops out of the window.
    m = metricsOnCall(m, { ok: true, latencyMs: 1_000, at: NOW + 61 * 60_000 })
    expect(m.windowSamples).toBeLessThan(100)
  })

  test("cold start: a candidate with no samples scores the 0.9 prior, not 0", () => {
    expect(reliabilityOf(undefined)).toBe(0.9)
    expect(reliabilityOf(initialMetrics())).toBe(0.9)
  })

  test("values older than 24h go back to priors; EXHAUSTED/INVALID never do", () => {
    let m = initialMetrics()
    for (let i = 0; i < 5; i++) m = metricsOnCall(m, { ok: true, latencyMs: 5_000, at: NOW })
    expect(m.latencyEwmaMs).toBe(5_000)
    const stale = applyStaleness(m, "minimax", NOW + 25 * 60 * 60_000)
    expect(stale.latencyEwmaMs).toBe(1_000) // the minimax prior, docs 03 §6
    expect(stale.reliability).toBeUndefined() // back to the 0.9 prior at scoring time
    // The staleness rule only touches dynamic values: the state machine
    // (facts) is a separate block and is untouched here.
    const fresh = applyStaleness(m, "minimax", NOW + 23 * 60 * 60_000)
    expect(fresh.latencyEwmaMs).toBe(5_000)
  })

  test("the latency prior applies when there is no observation", () => {
    expect(latencyMs(undefined, "ollama")).toBe(2_000)
    expect(latencyMs(undefined, "unknown-vendor")).toBe(1_500)
  })
})

describe("scoring and the six dimensions (docs 03 §3)", () => {
  const deepseek = candidate("deepseek/deepseek-chat", "deepseek-main", "deepseek")
  const zhipu = candidate("zhipu/glm-4-flash", "zhipu-main", "zhipu", {
    model: { costPerMtok: { input: 0, output: 0 } },
  })

  test("the default weights are the documented ones", () => {
    expect(Scoring.normaliseWeights({ capability: 0.25, quota: 0.2, health: 0.25, latency: 0.15, reliability: 0.1, cost: 0.05 }).capability).toBe(0.25)
    // A user-supplied set is auto-normalised to sum to 1.
    expect(
      Object.values(Scoring.normaliseWeights({ capability: 1, quota: 1, health: 1, latency: 1, reliability: 1, cost: 1 })).reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBeCloseTo(1)
  })

  test("the capability term rewards an exact fit and penalises margin", () => {
    const t = Scoring.dims(deepseek, req({ capability: "standard" }), [0])
    expect(t.capability).toBe(1) // exact match
    const deep = candidate("deepseek/deepseek-chat", "deepseek-main", "deepseek", {
      model: { tier: "deep" as CapabilityTier },
    })
    const t2 = Scoring.dims(deep, req({ capability: "standard" }), [0])
    expect(t2.capability).toBe(0.75) // one tier of margin = 1 - 0.25
  })

  test("a tier below the requirement is a hard exclusion, not a low score", () => {
    const weak = candidate("zhipu/glm-4-flash", "zhipu-main", "zhipu", { model: { tier: "light" as CapabilityTier } })
    expect(Scoring.eligible(weak, req({ capability: "deep" }), NOW, { relaxed: false })).toContain("capability")
    // And the pool check refuses it: an ineligible candidate is out, full stop.
    expect(Scoring.inPool(weak, req({ capability: "deep" }), NOW, { relaxed: false })).toBe(false)
  })

  test("a required feature the candidate lacks is a hard exclusion, and the relaxed pool drops it", () => {
    const pool_ = [deepseek, zhipu]
    const noLong = req({ requiredFeatures: ["long-context"] })
    expect(Scoring.pool(pool_, noLong, NOW, false).length).toBe(0) // both lack it
    // The relaxed path drops the feature requirement; the pool is back.
    expect(Scoring.pool(pool_, noLong, NOW, true).length).toBe(2)
  })

  test("an unknown budget scores the quota term as 1; a spent budget as 0", () => {
    expect(Scoring.dims(deepseek, req(), [0]).quota).toBe(1)
    const spent = { ...deepseek, quotaRemaining: 0 }
    expect(Scoring.dims(spent, req(), [0]).quota).toBe(0)
  })

  test("the health term maps the state machine states onto [0,1]", () => {
    expect(Scoring.healthTerm("HEALTHY")).toBe(1)
    expect(Scoring.healthTerm("DEGRADED")).toBe(0.5)
    expect(Scoring.healthTerm("UNHEALTHY")).toBe(0)
    expect(Scoring.healthTerm("EXHAUSTED")).toBe(0)
  })

  test("the latency term decays linearly to 0 at the 8s P50 budget", () => {
    const fast: Candidate = { ...deepseek, metrics: { ...initialMetrics(), latencyEwmaMs: 2_000 } }
    expect(Scoring.dims(fast, req(), [0]).latency).toBeCloseTo(1 - 2_000 / 8_000)
    const slow: Candidate = { ...deepseek, metrics: { ...initialMetrics(), latencyEwmaMs: 12_000 } }
    expect(Scoring.dims(slow, req(), [0]).latency).toBe(0)
  })

  test("the cost term normalises against the eligible pool and lets an all-free pool tie at 1", () => {
    // An all-free pool: everyone's cost term is 1.
    expect(Scoring.costTerm(zhipu, [0, 0])).toBe(1)
    // A mixed pool: the free one is 1, the paid one is 1 − cost/max.
    const paid = candidate("minimax/abab", "minimax-main", "minimax", { model: { costPerMtok: { input: 1, output: 4 } } })
    const costs = [Scoring.costOf(zhipu.spec.model), Scoring.costOf(paid.spec.model)]
    expect(Scoring.costTerm(zhipu, costs)).toBe(1)
    expect(Scoring.costTerm(paid, costs)).toBe(0)
  })

  test("the weighted score adds every term with the default weights", () => {
    const t = Scoring.dims(deepseek, req(), [0])
    const w = { capability: 0.25, quota: 0.2, health: 0.25, latency: 0.15, reliability: 0.1, cost: 0.05 }
    const expected =
      t.capability * w.capability +
      t.quota * w.quota +
      t.health * w.health +
      t.latency * w.latency +
      t.reliability * w.reliability +
      t.cost * w.cost
    expect(Scoring.weightedScore(deepseek, req(), [0], w)).toBeCloseTo(expected)
  })
})

describe("the pick rule: EPS jitter and sticky routing (docs 03 §3.3, §4.2)", () => {
  const a = candidate("deepseek/deepseek-chat", "deepseek-main", "deepseek")
  const b = candidate("zhipu/glm-4-plus", "zhipu-main", "zhipu")

  test("the best score wins outright when it beats the runner-up by more than EPS", () => {
    const [first, second] = [a, b]
    const picked = Scoring.pick([first, second], req({ capability: "light" }), { now: NOW })
    expect(picked).toBeDefined()
    // Identical resources apart from the id: the tie-break is deterministic
    // (the localeCompare in the rank), and a light request puts both at the
    // same margin.
    expect(picked!.path).toBe("score")
  })

  test("a tie within EPS uses the latency jitter, and a still-tie uses concurrency", () => {
    // Give the two candidates identical scores apart from latency.
    const slow = { ...a, metrics: { ...a.metrics, latencyEwmaMs: 6_000 } }
    const fast = { ...b, metrics: { ...b.metrics, latencyEwmaMs: 1_000 } }
    const picked = Scoring.pick([slow, fast], req({ capability: "standard" }), { now: NOW, eps: 0.5, jitterSeed: 0 })
    expect(picked!.candidate.spec.model.id).toBe(fast.spec.model.id) // latency wins the jitter
  })

  test("the same seed replays to the same pick (audit determinism)", () => {
    const slow = { ...a, metrics: { ...a.metrics, latencyEwmaMs: 3_000 } }
    const fast = { ...b, metrics: { ...b.metrics, latencyEwmaMs: 3_000 } } // same latency
    const r1 = Scoring.pick([slow, fast], req({ capability: "standard" }), { now: NOW, eps: 0.5, jitterSeed: 7 })
    const r2 = Scoring.pick([fast, slow], req({ capability: "standard" }), { now: NOW, eps: 0.5, jitterSeed: 7 })
    // A seed-stable jitter gives the same winner regardless of input order.
    expect(r1!.candidate.spec.model.id).toBe(r2!.candidate.spec.model.id)
  })

  test("sticky routing keeps the current binding within STICKY_DELTA of the winner", () => {
    // `a` is the current binding; `b` is only slightly better, inside 0.10.
    const current = { ...a, metrics: { ...a.metrics, latencyEwmaMs: 4_000 } }
    const better = { ...b, metrics: { ...b.metrics, latencyEwmaMs: 1_000 } }
    const pool = [better, current]
    const picked = Scoring.pick(pool, req(), { now: NOW, current: `${current.spec.model.id}@${current.spec.account.id}`, stickyDelta: 0.1 })
    expect(picked!.path).toBe("sticky")
    expect(picked!.candidate.spec.model.id).toBe(current.spec.model.id)
  })

  test("a binding more than STICKY_DELTA behind the winner is replaced", () => {
    const current = { ...a, metrics: { ...a.metrics, latencyEwmaMs: 9_000 }, quotaRemaining: 0.01 }
    const better = { ...b, metrics: { ...b.metrics, latencyEwmaMs: 1_000 }, quotaRemaining: 0.99 }
    const picked = Scoring.pick([better, current], req(), { now: NOW, current: `${current.spec.model.id}@@main`.replace("@@main", `@${current.spec.account.id}`), stickyDelta: 0.1 })
    expect(picked!.path).toBe("score")
    expect(picked!.candidate.spec.model.id).toBe(better.spec.model.id)
  })

  test("a manual override skips sticky comparison entirely", () => {
    const current = { ...a, metrics: { ...a.metrics, latencyEwmaMs: 4_000 } }
    const better = { ...b, metrics: { ...b.metrics, latencyEwmaMs: 1_000 } }
    const picked = Scoring.pick([better, current], req(), {
      now: NOW,
      current: `${current.spec.model.id}@${current.spec.account.id}`,
      override: true,
    })
    // Sticky is off: the better one wins on score, the override is terminal.
    expect(picked!.path).toBe("score")
    expect(picked!.candidate.spec.model.id).toBe(better.spec.model.id)
  })
})
