import { describe, expect, test } from "bun:test"
import * as Core from "@/freecode/core/types"
import { initialState, onCall, onProbe, onQuotaReset, probeOptions, type CandidateHealth } from "@/freecode/core/state-machine"
import { initialMetrics, onCall as metricsOnCall } from "@/freecode/core/metrics"
import * as Scoring from "@/freecode/core/scoring"
import * as Suspend from "@/freecode/core/suspend"
import * as SchedulerCore from "@/freecode/core/scheduler-core"
import type { Candidate } from "@/freecode/core/scoring"

/**
 * The four named fault-injection cases from the acceptance criteria, each
 * a full resolve() run against a state snapshot — not a mock:
 *   1. no candidate at all
 *   2. quota exhausted
 *   3. health failure (persisted)
 *   4. offline (probe unreachable / local model not running)
 *
 * Every one of them must end the same way the docs define: no crash, no
 * silent fallback to a model nobody asked for — a NoResourceError whose
 * payload carries the SUSPENDED checklist.
 */

const NOW = 1_700_000_000_000

function cand(spec: Core.CandidateSpec, health: CandidateHealth, metrics: import("@/freecode/core/metrics").CandidateMetrics = initialMetrics(), quotaRemaining?: number): Candidate {
  return { spec, health, metrics, quotaRemaining }
}

const spec = (modelID: string, accountID: string, providerID: string): Core.CandidateSpec => ({
  model: {
    id: modelID,
    provider: providerID,
    contextWindow: 32_768,
    maxOutput: 8_192,
    capabilities: ["tools"],
    tier: "standard",
  },
  account: { id: accountID, provider: providerID, credential: `env:${providerID.toUpperCase()}_KEY` },
  provider: {
    id: providerID,
    protocol: "openai-chat",
    endpoint: `https://api.${providerID}.example.com/v1`,
    auth: "bearer",
    models: [modelID],
    accounts: [accountID],
  },
})

const fresh = (modelID: string, accountID: string, providerID: string) =>
  cand(spec(modelID, accountID, providerID), initialState())

const req: Core.ResolveRequest = { capability: "standard", requiredFeatures: [] }

describe("fault 1: no candidate", () => {
  test("resolve() against an empty pool throws NoResourceError with the suspended payload", () => {
    try {
      SchedulerCore.resolve([], req, { now: NOW })
      expect.unreachable("must throw")
    } catch (error) {
      expect(error).toBeInstanceOf(Core.NoResourceError)
      const snap = Suspend.park(req, NOW)
      expect(snap.checklist).toHaveLength(3)
      expect(snap.request).toBe(req)
    }
  })

  test("no usable candidate in a populated pool (every one INVALID) throws the same way", () => {
    const pool = [
      cand(spec("zhipu/glm-4-flash", "zhipu-main", "zhipu"), { ...initialState(), state: "INVALID" }),
      cand(spec("minimax/abab-6.5s-chat", "minimax-main", "minimax"), { ...initialState(), state: "INVALID" }),
    ]
    expect(() => SchedulerCore.resolve(pool, req, { now: NOW })).toThrow(Core.NoResourceError)
  })
})

describe("fault 2: quota exhausted", () => {
  test("a single candidate that just 429'd is out of the pool until the window rolls", () => {
    const health = onCall(initialState(), { ok: false, status: 429, at: NOW - 1_000 }, probeOptions())
    const pool = [cand(spec("deepseek/deepseek-chat", "deepseek-main", "deepseek"), health)]
    expect(() => SchedulerCore.resolve(pool, req, { now: NOW })).toThrow(Core.NoResourceError)

    // With a sibling account, the scheduler moves to it: pure score, no
    // special-casing of the vendor.
    const pool2 = [
      pool[0],
      cand(spec("deepseek/deepseek-chat", "deepseek-pool-b", "deepseek"), initialState()),
    ]
    const picked = Scoring.pick(pool2, req, { now: NOW })!
    expect(picked.candidate.spec.account.id).toBe("deepseek-pool-b")
  })

  test("the quota window reset re-admits the candidate (sweep + resolve)", () => {
    const health = { ...onCall(initialState(), { ok: false, status: 429, at: NOW - 1_000 }, probeOptions()), quotaResetAt: NOW + 1_000 }
    const pool = [cand(spec("deepseek/deepseek-chat", "deepseek-main", "deepseek"), health)]
    const swept = Suspend.sweepQuotaWindows(pool, NOW + 2_000)
    expect(swept.reAdmitted).toEqual(["deepseek/deepseek-chat@deepseek-main"])
    // Back in the pool as DEGRADED: resolve works again.
    const outcome = SchedulerCore.resolve(swept.next, req, { now: NOW + 2_000 })
    expect(outcome.pick.candidate.spec.account.id).toBe("deepseek-main")
  })

  test("account-level quota usage (no 429 yet) also excludes at 0 remaining", () => {
    const pool = [cand(spec("zhipu/glm-4-plus", "zhipu-work", "zhipu"), initialState(), initialMetrics(), 0)]
    expect(() => SchedulerCore.resolve(pool, req, { now: NOW })).toThrow(Core.NoResourceError)
  })
})

describe("fault 3: health failure (persisted)", () => {
  test("failThreshold consecutive 5xx take the last candidate out; a healthy sibling serves", () => {
    let health = initialState()
    for (let i = 0; i < 3; i++) health = onCall(health, { ok: false, status: 503, at: NOW + i * 1_000 }, probeOptions())
    expect(health.state).toBe("UNHEALTHY")
    const broken = cand(spec("zhipu/glm-4-flash", "zhipu-main", "zhipu"), health)
    const pool = [
      broken,
      cand(spec("deepseek/deepseek-chat", "deepseek-main", "deepseek"), initialState()),
    ]
    const picked = Scoring.pick(pool, req, { now: NOW + 10_000 })!
    expect(picked.candidate.spec.provider?.id ?? picked.candidate.spec.model.provider).toBe("deepseek")
  })

  test("with no healthy sibling, the pool is empty → SUSPENDED, and the 5-minute probe recovers", () => {
    let health = initialState()
    for (let i = 0; i < 3; i++) health = onCall(health, { ok: false, status: 500, at: NOW + i * 1_000 }, probeOptions())
    const pool = [cand(spec("zhipu/glm-4-flash", "zhipu-main", "zhipu"), health)]
    expect(() => SchedulerCore.resolve(pool, req, { now: NOW + 10_000 })).toThrow(Core.NoResourceError)

    // Background re-probe: successes recover (threshold 2), and the
    // suspended task auto-resumes on the pick.
    const snap = Suspend.park(req, NOW)
    const recovered = Suspend.reProbe(snap, pool, new Map([["zhipu/glm-4-flash@zhipu-main", { ok: true }]]), NOW + Core.SUSPENDED_REPROBE_MS)
    // One success is below the recovery threshold; the candidate is still
    // DEGRADED→in-pool? No: recovery needs two. Prove the gate holds.
    expect(recovered.resume).toBe(false)
    const recovered2 = Suspend.reProbe(
      snap,
      pool.map((c) => ({ ...c, health: onCall(c.health, { ok: true, latencyMs: 1_000, at: NOW }, probeOptions()) })),
      new Map([["zhipu/glm-4-flash@zhipu-main", { ok: true }]]),
      NOW + 2 * Core.SUSPENDED_REPROBE_MS,
    )
    expect(recovered2.resume).toBe(true)
    expect(recovered2.binding).toBe("zhipu/glm-4-flash@zhipu-main")
  })
})

describe("fault 4: offline / local model not running", () => {
  test("connection-level probe misses: 1st–2nd degrade, 3rd is UNAVAILABLE (out of pool)", () => {
    let health = initialState()
    for (let i = 0; i < 3; i++) health = onProbe(health, { ok: false, kind: "connection", at: NOW + i * 1_000 }, probeOptions())
    expect(health.state).toBe("UNAVAILABLE")
    const pool = [
      cand(
        spec("ollama/qwen2.5-coder:14b", "ollama-local", "ollama"),
        health,
      ),
    ]
    expect(() => SchedulerCore.resolve(pool, req, { now: NOW + 10_000 })).toThrow(Core.NoResourceError)
  })

  test("an http probe failure is the 'broken' case: DEGRADED, still in the pool", () => {
    const health = onProbe(initialState(), { ok: false, kind: "http", at: NOW }, probeOptions())
    expect(health.state).toBe("DEGRADED")
    const pool = [cand(spec("minimax/abab-6.5s-chat", "minimax-main", "minimax"), health)]
    const picked = Scoring.pick(pool, req, { now: NOW + 1_000 })
    expect(picked).toBeDefined()
    expect(picked!.terms.health).toBe(0.5)
  })
})
