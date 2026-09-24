import { describe, expect, test } from "bun:test"
import * as Core from "@/freecode/core/types"
import type { Candidate } from "@/freecode/core/scoring"
import * as SchedulerCore from "@/freecode/core/scheduler-core"
import * as Scoring from "@/freecode/core/scoring"
import * as Suspend from "@/freecode/core/suspend"
import { initialState, onProbe } from "@/freecode/core/state-machine"
import { initialMetrics } from "@/freecode/core/metrics"
import { MockProvider, buildCandidate, scenarios, defaultProfile, type MockProfile } from "@test/freecode/mock-provider"

/**
 * The §5 injection matrix through the mock provider: every row of
 * docs 03 §5 (cloud down → Ollama fallback → SUSPENDED, quota
 * exhaustion → account switch, 401/403 → INVALID, offline "not started"
 * vs "broken") is reproduced by driving N deterministic calls through
 * the mock and feeding the resulting pool into the real scheduler core.
 *
 * Acceptance: each scenario is reproducible (same seed + same call count
 * ⇒ same outcome), and no flakiness — the mock never touches the
 * network or the wall clock.
 */

const NOW = 1_700_000_000_000
const SEED = 42

const spec = (
  modelID: string,
  accountID: string,
  providerID: string,
  opts: { protocol?: Core.ProviderSpec["protocol"]; tier?: Core.CapabilityTier; cost?: number } = {},
): Core.CandidateSpec => ({
  model: {
    id: modelID,
    provider: providerID,
    contextWindow: 32_768,
    maxOutput: 8_192,
    capabilities: ["tools"],
    tier: opts.tier ?? "standard",
    costPerMtok: opts.cost === undefined ? undefined : { input: 0, output: opts.cost },
  },
  account: {
    id: accountID,
    provider: providerID,
    credential: providerID === "ollama" ? "none" : `env:${providerID.toUpperCase()}_KEY`,
  },
  provider: {
    id: providerID,
    protocol: opts.protocol ?? "openai-chat",
    endpoint: providerID === "ollama" ? "http://127.0.0.1:11434/v1" : `https://api.${providerID}.example.com/v1`,
    auth: providerID === "ollama" ? "none" : "bearer",
    models: [modelID],
    accounts: [accountID],
  },
})

const key = (m: string, a: string) => `${m}@${a}`

const healthySpecs = (): Core.CandidateSpec[] => [
  spec("deepseek/deepseek-chat", "deepseek-main", "deepseek"),
  spec("zhipu/glm-4-flash", "zhipu-main", "zhipu"),
]

const req = (extra: Partial<Core.ResolveRequest> = {}): Core.ResolveRequest => ({
  capability: "standard",
  requiredFeatures: [],
  ...extra,
})

describe("mock provider: determinism contract", () => {
  test("two providers with the same seed produce identical outcome streams", () => {
    const profiles: Record<string, MockProfile> = {
      [key("m/x", "a")]: { failureRate: 0.4, failWith: "5xx", latency: { range: [50, 500] } },
    }
    const p1 = new MockProvider({ seed: SEED, profiles })
    const p2 = new MockProvider({ seed: SEED, profiles })
    for (let i = 0; i < 20; i++) {
      const a = p1.nextCall(key("m/x", "a"), NOW + i)
      const b = p2.nextCall(key("m/x", "a"), NOW + i)
      expect(a).toEqual(b)
    }
  })

  test("a different seed diverges (the streams are seed-keyed, not global)", () => {
    const profiles: Record<string, MockProfile> = {
      [key("m/x", "a")]: { failureRate: 0.5, failWith: "5xx" },
    }
    const p1 = new MockProvider({ seed: 1, profiles })
    const p2 = new MockProvider({ seed: 2, profiles })
    const a1 = Array.from({ length: 10 }, (_, i) => p1.nextCall(key("m/x", "a"), i).ok)
    const a2 = Array.from({ length: 10 }, (_, i) => p2.nextCall(key("m/x", "a"), i).ok)
    expect(a1).not.toEqual(a2)
  })

  test("reset() rewinds the counters: replaying the same calls gives the same results", () => {
    const p = new MockProvider({
      seed: SEED,
      profiles: { [key("m/x", "a")]: { failureRate: 0.6, failWith: "5xx" } },
    })
    const first = Array.from({ length: 10 }, (_, i) => p.nextCall(key("m/x", "a"), i))
    p.reset()
    const replay = Array.from({ length: 10 }, (_, i) => p.nextCall(key("m/x", "a"), i))
    expect(replay).toEqual(first)
  })

  test("success latency is deterministic within the declared range", () => {
    const p = new MockProvider({
      seed: SEED,
      profiles: { [key("m/x", "a")]: { failureRate: 0, latency: { range: [100, 200] } } },
    })
    for (let i = 0; i < 25; i++) {
      const r = p.nextCall(key("m/x", "a"))
      expect(r.ok).toBe(true)
      expect(r.latencyMs).toBeGreaterThanOrEqual(100)
      expect(r.latencyMs).toBeLessThanOrEqual(200)
    }
  })
})

describe("§5 matrix · cloud vendors down → local Ollama fallback → SUSPENDED", () => {
  test("all-cloud-down, no local candidate: NoResourceError + SUSPENDED checklist", () => {
    const specs = healthySpecs()
    const provider = new MockProvider({ seed: SEED, profiles: scenarios.cloudDown(specs.map((s) => key(s.model.id, s.account.id))) })
    const pool = specs.map((s) => buildCandidate(provider, s, 3, NOW))
    // 3 consecutive 5xx → UNHEALTHY → out of the pool.
    for (const c of pool) expect(c.health.state).toBe("UNHEALTHY")
    expect(() => SchedulerCore.resolve(pool, req(), { now: NOW })).toThrow(Core.NoResourceError)
    const snap = Suspend.park(req(), NOW)
    expect(snap.checklist).toHaveLength(3)
  })

  test("with a healthy Ollama candidate in the pool, the scheduler binds to it", () => {
    const cloudSpecs = healthySpecs()
    const ollamaSpec = spec("ollama/qwen2.5-coder:14b", "ollama-local", "ollama", { protocol: "local-http" })
    const all = [...cloudSpecs, ollamaSpec]
    const provider = new MockProvider({
      seed: SEED,
      profiles: scenarios.ollamaFallback(
        cloudSpecs.map((s) => key(s.model.id, s.account.id)),
        key(ollamaSpec.model.id, ollamaSpec.account.id),
      ),
    })
    const pool = all.map((s) => buildCandidate(provider, s, 3, NOW))
    const outcome = SchedulerCore.resolve(pool, req(), { now: NOW, jitterSeed: 0 })
    expect(outcome.binding.model.id).toBe("ollama/qwen2.5-coder:14b")
    expect(outcome.binding.account.id).toBe("ollama-local")
  })

  test("determinism: the same matrix replayed gives the same pick", () => {
    const pickOnce = (): string => {
      const cloudSpecs = healthySpecs()
      const ollamaSpec = spec("ollama/qwen2.5-coder:14b", "ollama-local", "ollama", { protocol: "local-http" })
      const all = [...cloudSpecs, ollamaSpec]
      const provider = new MockProvider({
        seed: SEED,
        profiles: scenarios.ollamaFallback(
          cloudSpecs.map((s) => key(s.model.id, s.account.id)),
          key(ollamaSpec.model.id, ollamaSpec.account.id),
        ),
      })
      const pool = all.map((s) => buildCandidate(provider, s, 3, NOW))
      return SchedulerCore.resolve(pool, req(), { now: NOW, jitterSeed: 0 }).binding.model.id
    }
    expect(pickOnce()).toBe(pickOnce())
  })
})

describe("§5 matrix · quota exhaustion → cross-account switch", () => {
  test("a spent account (quota 0) is excluded; the sibling serves; the window reset re-admits it", () => {
    const specs = [
      spec("zhipu/glm-4-flash", "zhipu-work", "zhipu"),
      spec("zhipu/glm-4-flash", "zhipu-pool-b", "zhipu"),
    ]
    const exhaustedKey = key("zhipu/glm-4-flash", "zhipu-work")
    const healthyKey = key("zhipu/glm-4-flash", "zhipu-pool-b")

    // Quota limit 0: the very first call 429s → EXHAUSTED, quotaRemaining 0.
    const provider = new MockProvider({
      seed: SEED,
      profiles: scenarios.quotaExhausted(exhaustedKey, healthyKey, 0),
    })
    const pool = specs.map((s) => buildCandidate(provider, s, 1, NOW))
    expect(pool[0].health.state).toBe("EXHAUSTED")
    expect(pool[0].quotaRemaining).toBe(0)

    // The scheduler skips the exhausted account and picks the sibling.
    const picked = Scoring.pick(pool, req(), { now: NOW })
    expect(picked!.candidate.spec.account.id).toBe("zhipu-pool-b")

    // The 429 outcome carries the reset time; the sweep re-admits after it.
    const withReset = new MockProvider({
      seed: SEED,
      profiles: scenarios.quotaExhausted(exhaustedKey, healthyKey, 0, NOW + 86_400_000),
    })
    const pool2 = specs.map((s) => buildCandidate(withReset, s, 1, NOW))
    // EXHAUSTED candidates are out of the pool until the window rolls; set the
    // reset timestamp on the health state the way the real 429 handler does.
    pool2[0].health = { ...pool2[0].health, quotaResetAt: NOW + 86_400_000 }
    // The window has rolled: the sweep re-admits it as DEGRADED.
    const swept = Suspend.sweepQuotaWindows(pool2, NOW + 86_400_001)
    expect(swept.reAdmitted).toHaveLength(1)
    expect(swept.next[0].health.state).toBe("DEGRADED")
  })

  test("a finite quota ceiling depletes after exactly `limit` successful calls", () => {
    const s = spec("deepseek/deepseek-chat", "deepseek-main", "deepseek")
    const k = key(s.model.id, s.account.id)
    const provider = new MockProvider({ seed: SEED, profiles: { [k]: { failureRate: 0, quota: { limit: 3 } } } })
    const calls = [0, 1, 2, 3].map((i) => provider.nextCall(k, NOW + i))
    expect(calls[0].ok).toBe(true)
    expect(calls[1].ok).toBe(true)
    expect(calls[2].ok).toBe(true)
    expect(calls[3].ok).toBe(false)
    expect(calls[3].status).toBe(429)
    expect(calls[3].quotaHit).toBe(true)
    // buildCandidate reports the depleted fraction: 0 remaining.
    const pool = [buildCandidate(provider, s, 4, NOW)]
    expect(pool[0].quotaRemaining).toBe(0)
  })
})

describe("§5 matrix · 401/403 → INVALID", () => {
  test("one 401 opens the automatic retry slot; the second lands INVALID; the candidate is out of the pool", () => {
    const s = spec("minimax/abab-6.5s-chat", "minimax-main", "minimax")
    const k = key(s.model.id, s.account.id)
    const provider = new MockProvider({ seed: SEED, profiles: scenarios.invalidCredential([k]) })
    const pool = [buildCandidate(provider, s, 2, NOW)]
    expect(pool[0].health.state).toBe("INVALID")
    expect(Scoring.pick(pool, req(), { now: NOW })).toBeUndefined()

    // The same run replayed gives the same result (determinism).
    const replay = new MockProvider({ seed: SEED, profiles: scenarios.invalidCredential([k]) })
    const pool2 = [buildCandidate(replay, s, 2, NOW)]
    expect(pool2[0].health.state).toBe("INVALID")
  })

  test("403 is handled the same way", () => {
    const s = spec("kimi/kimi-k2", "kimi-main", "kimi")
    const k = key(s.model.id, s.account.id)
    const provider = new MockProvider({ seed: SEED, profiles: scenarios.invalidCredential([k], "403") })
    const pool = [buildCandidate(provider, s, 2, NOW)]
    expect(pool[0].health.state).toBe("INVALID")
  })

  test("an INVALID pool is a NoResourceError — the SUSPENDED path, never a silent fallback", () => {
    const specs = [spec("minimax/abab-6.5s-chat", "minimax-main", "minimax")]
    const provider = new MockProvider({ seed: SEED, profiles: scenarios.invalidCredential([key(specs[0].model.id, specs[0].account.id)]) })
    const pool = specs.map((s) => buildCandidate(provider, s, 2, NOW))
    expect(() => SchedulerCore.resolve(pool, req(), { now: NOW })).toThrow(Core.NoResourceError)
  })
})

describe("§5 matrix · offline: 'not started' vs 'broken'", () => {
  test("3 connection-level probe misses mark the candidate UNAVAILABLE (distinct from UNHEALTHY)", () => {
    const s = spec("ollama/qwen2.5-coder:14b", "ollama-local", "ollama", { protocol: "local-http" })
    const k = key(s.model.id, s.account.id)
    const provider = new MockProvider({ seed: SEED, profiles: scenarios.offline([k]) })
    let health = initialState(NOW)
    for (let i = 0; i < 3; i++) {
      const r = provider.applyProbe(k, health, NOW + i * 1000)
      health = r.health
      expect(r.result.kind).toBe("connection")
    }
    expect(health.state).toBe("UNAVAILABLE")
    const pool: Candidate[] = [{ spec: s, health, metrics: initialMetrics() }]
    expect(Scoring.pick(pool, req(), { now: NOW })).toBeUndefined()
  })

  test("http-level failures (5xx) stay UNHEALTHY, never UNAVAILABLE — the 'broken' case", () => {
    const s = spec("deepseek/deepseek-chat", "deepseek-main", "deepseek")
    const k = key(s.model.id, s.account.id)
    const provider = new MockProvider({ seed: SEED, profiles: scenarios.cloudDown([k]) })
    let health = initialState(NOW)
    for (let i = 0; i < 3; i++) {
      const r = provider.applyProbe(k, health, NOW + i * 1000)
      health = r.health
    }
    expect(health.state).toBe("UNHEALTHY")
    expect(health.state).not.toBe("UNAVAILABLE")
  })

  test("timeouts count as health failures (broken endpoint), not connection misses", () => {
    const s = spec("zhipu/glm-4-flash", "zhipu-main", "zhipu")
    const k = key(s.model.id, s.account.id)
    const provider = new MockProvider({ seed: SEED, profiles: scenarios.timeout([k]) })
    const pool = [buildCandidate(provider, s, 3, NOW)]
    expect(pool[0].health.state).toBe("UNHEALTHY")
  })
})
