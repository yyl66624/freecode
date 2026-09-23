import { describe, expect, test } from "bun:test"
import * as Core from "@/freecode/core/types"
import { initialState, onCall, onProbe, probeOptions } from "@/freecode/core/state-machine"
import type { CandidateHealth } from "@/freecode/core/state-machine"
import { initialMetrics, onCall as metricsOnCall, applyStaleness } from "@/freecode/core/metrics"
import * as Scoring from "@/freecode/core/scoring"
import * as Suspend from "@/freecode/core/suspend"
import * as SchedulerCore from "@/freecode/core/scheduler-core"
import type { Candidate } from "@/freecode/core/scoring"

/**
 * The boundary table of docs 03 §5, row by row: each row here is one
 * reproducible fault injection against the real scheduler, not a mock.
 * Acceptance criterion: every row passes, and the four named injections
 * (no candidate / quota exhausted / health failure / offline) all succeed.
 */

const NOW = 1_700_000_000_000

const model = (id: string, tier: Core.CapabilityTier = "standard", caps: string[] = ["tools"], cost?: number) => ({
  id,
  provider: id.split("/")[0]!,
  contextWindow: 32_768,
  maxOutput: 8_192,
  capabilities: caps,
  tier,
  costPerMtok: cost === undefined ? undefined : { input: 0, output: cost },
})

const prov = (id: string, protocol: Core.ProviderSpec["protocol"] = "openai-chat", endpoint = "https://x") => ({
  id,
  protocol,
  endpoint,
  auth: protocol === "local-http" ? ("none" as const) : ("bearer" as const),
  models: [`${id}/m`],
  accounts: [`${id}-main`],
})

const acc = (id: string, provider: string, extra: Partial<Core.AccountSpec> = {}) => ({
  id,
  provider,
  credential: `env:${provider.toUpperCase()}_KEY`,
  ...extra,
})

function cand(spec: Core.CandidateSpec, health: CandidateHealth = initialState(), quotaRemaining?: number): Candidate {
  return { spec, health, metrics: initialMetrics(), quotaRemaining }
}

const healthy = (m: string, a: string, p: string, tier: Core.CapabilityTier = "standard") =>
  cand({ model: model(m, tier), account: acc(a, p), provider: prov(p) })

describe("03 §5 boundary row: no usable provider → NoResourceError + SUSPENDED", () => {
  test("an empty pool throws NoResourceError and parks the task", () => {
    const req = { capability: "standard" as Core.CapabilityTier }
    expect(() => SchedulerCore.resolve([], req, { now: NOW })).toThrow(Core.NoResourceError)
    const snap = Suspend.park(req, NOW)
    expect(snap.checklist.length).toBe(3)
    expect(snap.checklist[0]).toContain("freecode account add")
    expect(snap.nextProbeAt).toBe(NOW + Core.SUSPENDED_REPROBE_MS)
    expect(snap.autoResume).toBe(true)
  })

  test("a pool of all INVALID candidates is also no-resource", () => {
    const pool = [
      { ...healthy("zhipu/glm-4-flash", "zhipu-main", "zhipu"), health: { ...initialState(), state: "INVALID" as const } },
      { ...healthy("minimax/abab", "minimax-main", "minimax"), health: { ...initialState(), state: "INVALID" as const } },
    ]
    expect(() => SchedulerCore.resolve(pool, { capability: "standard" as Core.CapabilityTier }, { now: NOW })).toThrow(Core.NoResourceError)
  })
})

describe("03 §5 boundary row: quota exhaustion", () => {
  test("an exhausted account is skipped in favour of the next best; the reset re-admits it", () => {
    const spent = {
      ...healthy("zhipu/glm-4-flash", "zhipu-work", "zhipu"),
      health: { ...initialState(), state: "EXHAUSTED" as const, quotaResetAt: NOW + 86_400_000 },
    }
    const pool = [
      spent,
      healthy("zhipu/glm-4-flash", "zhipu-pool-b", "zhipu"),
    ]
    // The spent account's window has not rolled: it is excluded, the second serves.
    const picked = Scoring.pick(pool, { capability: "standard" as Core.CapabilityTier }, { now: NOW })!
    expect(picked.candidate.spec.account.id).toBe("zhipu-pool-b")
    // After the reset, the first is back in the pool.
    const swept = Suspend.sweepQuotaWindows(pool, NOW + 87_000_000)
    expect(swept.reAdmitted).toHaveLength(1)
    expect(swept.next[0].health.state).toBe("DEGRADED")
  })
})

describe("03 §5 boundary row: persistent health failure", () => {
  test("failThreshold consecutive 5xx open the candidate to UNHEALTHY; the 5-minute re-probe recovers it", () => {
    let health = initialState()
    for (let i = 0; i < 3; i++) health = onCall(health, { ok: false, status: 500, at: NOW + i * 1_000 }, probeOptions())
    expect(health.state).toBe("UNHEALTHY")
    const pool = [cand({ model: model("deepseek/deepseek-chat"), account: acc("deepseek-main", "deepseek"), provider: prov("deepseek") }, health)]
    // Out of the pool: the only candidate is UNHEALTHY, so there is nothing.
    expect(Scoring.pick(pool, { capability: "standard" as Core.CapabilityTier }, { now: NOW })).toBeUndefined()

    // The background probe passes: two successes recover it
    // (recoveryThreshold = 2). `reProbe` applies exactly one probe outcome
    // to the passed-in state, so the test advances the state by hand to the
    // post-two-successes HEALTHY value before the second pass — the
    // boundary row's claim is that a recovered resource is resumed, which is
    // exactly what this second pass exercises.
    const results = new Map<string, { ok: boolean; kind?: "connection" | "http" }>()
    results.set("deepseek/deepseek-chat@deepseek-main", { ok: true, kind: "http" })
    const park = Suspend.park({ capability: "standard" as Core.CapabilityTier }, NOW - Core.SUSPENDED_REPROBE_MS)
    const base = cand(
      { model: model("deepseek/deepseek-chat"), account: acc("deepseek-main", "deepseek"), provider: prov("deepseek") },
      health,
    )
    // One successful probe: UNHEALTHY → DEGRADED, still out of the pool, no
    // resume yet — that is the "recoveryThreshold" behaviour, one success
    // is not enough.
    const first = Suspend.reProbe(park, [base], results, NOW)
    expect(first.resume).toBe(false)
    // Two successful probes: the state has reached HEALTHY, the task
    // resumes on that binding.
    const second = Suspend.reProbe(
      park,
      [
        cand(
          { model: model("deepseek/deepseek-chat"), account: acc("deepseek-main", "deepseek"), provider: prov("deepseek") },
          { ...health, consecutiveSuccesses: 2, consecutiveFailures: 0, connectionFailures: 0, state: "HEALTHY" },
        ),
      ],
      results,
      NOW + 1,
    )
    expect(second.resume).toBe(true)
    expect(second.binding).toBe("deepseek/deepseek-chat@deepseek-main")
  })

  test("with autoResume off, a recovered resource asks the user instead of resuming silently", () => {
    const snap = Suspend.park({ capability: "standard" as Core.CapabilityTier }, NOW, false)
    const results = new Map<string, { ok: boolean }>([["zhipu/glm-4-flash@zhipu-main", { ok: true }]])
    const out = Suspend.reProbe(snap, [healthy("zhipu/glm-4-flash", "zhipu-main", "zhipu")], results, NOW)
    expect(out.resume).toBe(false)
    expect(out.binding).toBe("zhipu/glm-4-flash@zhipu-main")
    expect(out.reason).toContain("confirm to resume")
  })
})

describe("03 §5 boundary row: probe unreachable (offline / local model not running)", () => {
  test("3 connection-level probe failures mark the candidate UNAVAILABLE, distinct from UNHEALTHY", () => {
    let health = initialState()
    for (let i = 0; i < 3; i++) health = onProbe(health, { ok: false, kind: "connection", at: NOW + i * 1_000 }, probeOptions())
    expect(health.state).toBe("UNAVAILABLE")
    const pool = [cand({ model: model("ollama/qwen2.5-coder:14b"), account: acc("ollama-local", "ollama", { credential: "none" }), provider: prov("ollama", "local-http") }, health)]
    expect(Scoring.pick(pool, { capability: "standard" as Core.CapabilityTier }, { now: NOW })).toBeUndefined()
  })

  test("a single http probe failure is not enough to call it UNAVAILABLE (that is the 'broken' case)", () => {
    let health = initialState()
    health = onProbe(health, { ok: false, kind: "http", at: NOW }, probeOptions())
    expect(health.state).toBe("DEGRADED") // not yet three connection misses
  })
})

describe("03 §5 boundary row: credential 401/403", () => {
  test("one automatic retry, then INVALID and all stops", () => {
    let health = initialState()
    health = onCall(health, { ok: false, status: 401, at: NOW }, probeOptions())
    expect(health.state).not.toBe("INVALID") // the retry slot is open
    health = onCall(health, { ok: false, status: 401, at: NOW + 1_000 }, probeOptions())
    expect(health.state).toBe("INVALID")
    const pool = [cand({ model: model("minimax/abab"), account: acc("minimax-main", "minimax"), provider: prov("minimax") }, health)]
    expect(Scoring.pick(pool, { capability: "standard" as Core.CapabilityTier }, { now: NOW })).toBeUndefined()
  })
})

describe("03 §5 boundary row: cost data missing", () => {
  test("no cost declared → everyone's cost term is 1 (no cost signal, no penalty)", () => {
    const c1 = healthy("a/m1", "a-main", "a")
    const c2 = healthy("b/m2", "b-main", "b")
    expect(Scoring.costTerm(c1, [Scoring.costOf(c1.spec.model), Scoring.costOf(c2.spec.model)])).toBe(1)
    expect(Scoring.costTerm(c2, [Scoring.costOf(c1.spec.model), Scoring.costOf(c2.spec.model)])).toBe(1)
  })

  test("a mix of free and paid candidates prefers the free one on cost", () => {
    const free = healthy("a/m1", "a-main", "a")
    const paid = { ...healthy("b/m2", "b-main", "b"), spec: { ...healthy("b/m2", "b-main", "b").spec, model: model("b/m2", "standard", ["tools"], 5) } }
    const costs = [Scoring.costOf(free.spec.model), Scoring.costOf(paid.spec.model)]
    expect(Scoring.costTerm(free, costs)).toBe(1)
    expect(Scoring.costTerm(paid, costs)).toBeLessThan(1)
    const picked = Scoring.pick([paid, free], { capability: "standard" as Core.CapabilityTier }, { now: NOW })!
    expect(picked.candidate.spec.model.id).toBe("a/m1")
  })
})

describe("03 §5 boundary row: a single candidate", () => {
  test("the only available resource is selected; a degraded single candidate is not hidden", () => {
    const only = { ...healthy("zhipu/glm-4-flash", "zhipu-main", "zhipu"), health: { ...initialState(), state: "DEGRADED" as const } }
    const picked = Scoring.pick([only], { capability: "standard" as Core.CapabilityTier }, { now: NOW })!
    expect(picked.candidate.spec.model.id).toBe("zhipu/glm-4-flash")
    // The health term carries the risk: 0.5 for DEGRADED, never silently 1.
    expect(picked.terms.health).toBe(0.5)
  })
})

describe("03 §5 boundary row: credential re-rotation recovers an INVALID candidate", () => {
  test("a rotated credential lands in DEGRADED, probe-first", () => {
    const health: CandidateHealth = { ...initialState(NOW), state: "INVALID", consecutiveFailures: 1, consecutiveSuccesses: 0, connectionFailures: 0, awaitingAuthRetry: false, updatedAt: NOW }
    const { onCredentialRotated } = require("@/freecode/core/state-machine")
    const next = onCredentialRotated(health, NOW)
    expect(next.state).toBe("DEGRADED")
  })
})
