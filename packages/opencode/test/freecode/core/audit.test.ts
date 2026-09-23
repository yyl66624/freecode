import { describe, expect, test } from "bun:test"
import * as Core from "@/freecode/core/types"
import { initialState, probeOptions } from "@/freecode/core/state-machine"
import { initialMetrics, onCall as metricsOnCall } from "@/freecode/core/metrics"
import * as SchedulerCore from "@/freecode/core/scheduler-core"
import * as SchedulerState from "@/freecode/core/state-store"
import type { Candidate } from "@/freecode/core/scoring"

/**
 * The audit replay acceptance criterion: given a `state.json` snapshot and
 * the same request, resolve() produces the same pick. The audit row and
 * the decision log are written from the *same* deterministic pick, so a
 * replay reads the log and reproduces it.
 */

const NOW = 1_700_000_000_000

const spec = (modelID: string, accountID: string, providerID: string, tier: Core.CapabilityTier = "standard"): Core.CandidateSpec => ({
  model: {
    id: modelID,
    provider: providerID,
    contextWindow: 32_768,
    maxOutput: 8_192,
    capabilities: ["tools", "json"],
    tier,
    costPerMtok: { input: 0, output: 2 },
  },
  account: { id: accountID, provider: providerID, credential: `env:${providerID.toUpperCase()}_KEY`, concurrency: 4 },
  provider: {
    id: providerID,
    protocol: "openai-chat",
    endpoint: `https://api.${providerID}.example.com/v1`,
    auth: "bearer",
    models: [modelID],
    accounts: [accountID],
  },
})

/** A deterministic pool: one fast-and-healthy, one slow-and-degraded, one cold. */
function pool(): Candidate[] {
  const fast: Candidate = {
    spec: spec("deepseek/deepseek-chat", "deepseek-main", "deepseek"),
    health: initialState(),
    metrics: (() => {
      let m = initialMetrics()
      for (let i = 0; i < 6; i++) m = metricsOnCall(m, { ok: true, latencyMs: 1_100, at: NOW + i * 1_000 })
      return m
    })(),
    quotaRemaining: 0.8,
  }
  const slow: Candidate = {
    spec: spec("zhipu/glm-4-plus", "zhipu-main", "zhipu", "deep"),
    health: { ...initialState(), state: "DEGRADED", consecutiveFailures: 1 },
    metrics: (() => {
      let m = initialMetrics()
      for (let i = 0; i < 6; i++) m = metricsOnCall(m, { ok: i % 3 === 0, latencyMs: 4_800, at: NOW + i * 1_000 })
      return m
    })(),
    quotaRemaining: 0.9,
  }
  const cold: Candidate = {
    spec: spec("minimax/abab-6.5s-chat", "minimax-main", "minimax"),
    health: initialState(),
    metrics: initialMetrics(), // cold start: priors
  }
  return [fast, slow, cold]
}

const request: Core.ResolveRequest = { capability: "standard", requiredFeatures: ["tools"], task: "coder/refactor" }

const label = (id: string) => {
  const at = id.indexOf("@")
  return { model: id.slice(0, at), account: id.slice(at + 1) }
}

describe("decision audit and replay (docs 03 §4.3, acceptance criterion)", () => {
  test("the same state snapshot and the same request give the same pick", () => {
    const candidates = pool()
    const first = SchedulerCore.resolve(candidates, request, { now: NOW, jitterSeed: 0 })
    const second = SchedulerCore.resolve(candidates, request, { now: NOW, jitterSeed: 0 })
    expect(first.binding.model.id).toBe(second.binding.model.id)
    expect(first.binding.account.id).toBe(second.binding.account.id)
    expect(first.pick.score).toBe(second.pick.score)
  })

  test("a state.json snapshot replays: persisted states give the same pick as the live ones", () => {
    const live = pool()
    const snapshot: SchedulerCore.StateSnapshot = {
      version: 1,
      candidates: {},
      sessions: { "sess-1": { binding: `${live[0].spec.model.id}@${live[0].spec.account.id}` } },
      suspended: {},
      decisions: [],
    }
    for (const c of live) snapshot.candidates[`${c.spec.model.id}@${c.spec.account.id}`] = { health: c.health, metrics: c.metrics, quotaRemaining: c.quotaRemaining }
    const readBack: Candidate[] = live.map((c) => {
      const entry = snapshot.candidates[`${c.spec.model.id}@${c.spec.account.id}`]!
      return { ...c, health: entry.health, metrics: entry.metrics, quotaRemaining: entry.quotaRemaining }
    })

    const livePick = SchedulerCore.resolve(live, request, { now: NOW, jitterSeed: 0 })
    const replayedPick = SchedulerCore.resolve(readBack, request, { now: NOW, jitterSeed: 0 })
    expect(replayedPick.binding.model.id).toBe(livePick.binding.model.id)
    expect(replayedPick.binding.account.id).toBe(livePick.binding.account.id)
  })

  test("the audit row records enough to explain the pick and to replay it", () => {
    const candidates = pool()
    const outcome = SchedulerCore.resolve(candidates, request, { now: NOW, jitterSeed: 0 })
    const row = outcome.audit
    const parts = label(row.pick)
    expect(row.pick).toBe(`${outcome.binding.model.id}@${outcome.binding.account.id}`)
    expect(row.req).toBe("standard+tools")
    expect(row.task).toBe("coder/refactor")
    expect(row.path).toBe("score")
    expect(row.candidates[0].score).toBe(Number(outcome.pick.score.toFixed(4)))
    expect(parts.model).toBe(outcome.binding.model.id)
    // A /scheduler explain replay reads back this row.
    expect(row.ts).toBe(new Date(NOW).toISOString())
  })

  test("a manual override is recorded as an override, not a scored pick", () => {
    const candidates = pool()
    const target = `${candidates[2].spec.model.id}@${candidates[2].spec.account.id}`
    const outcome = SchedulerCore.resolve(candidates, { ...request, modelOverride: target }, { now: NOW })
    expect(outcome.binding.via).toBe("override")
    expect(outcome.audit.path).toBe("override")
    expect(outcome.audit.reason).toContain("override")
    expect(outcome.binding.model.id).toBe(target.split("@")[0])
  })

  test("an override naming a candidate the pool does not know is a NoResourceError, not a silent drop", () => {
    const candidates = pool()
    expect(() => SchedulerCore.resolve(candidates, { ...request, modelOverride: "ghost/model@ghost" }, { now: NOW })).toThrow(Core.NoResourceError)
  })

  test("an override onto a candidate whose account is INVALID is refused, not served", () => {
    const candidates = pool().map((c) =>
      c.spec.account.id === "deepseek-main" ? { ...c, health: { ...initialState(), state: "INVALID" as const } } : c,
    )
    expect(() =>
      SchedulerCore.resolve(candidates, { ...request, modelOverride: "deepseek/deepseek-chat@deepseek-main" }, { now: NOW }),
    ).toThrow(Core.NoResourceError)
  })

  test("the decision log rolls at 500 entries", () => {
    const candidates = pool()
    const snapshot = SchedulerState.empty()
    for (let i = 0; i < 600; i++) {
      const row = SchedulerCore.resolve(candidates, { ...request, task: `t${i}` }, { now: NOW + i, jitterSeed: i }).audit
      snapshot.decisions.push(row)
      snapshot.decisions = snapshot.decisions.slice(-Core.DECISION_LOG_LIMIT)
    }
    expect(snapshot.decisions).toHaveLength(500)
    expect(snapshot.decisions[0].task).toBe("t100")
    expect(snapshot.decisions[499].task).toBe("t599")
  })

  test("a fresh snapshot is empty and loads back to the same shape", () => {
    const empty = SchedulerState.empty()
    expect(empty.decisions).toHaveLength(0)
    const loaded = SchedulerState.load() // no XDG_DATA_HOME in the test → in-memory empty
    expect(loaded).toEqual(empty)
  })
})
