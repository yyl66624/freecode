import { describe, expect, test } from "bun:test"
import * as Core from "@/freecode/core/types"
import { initialState, onCall, probeOptions } from "@/freecode/core/state-machine"
import { initialMetrics, applyStaleness, reliabilityOf, latencyMs } from "@/freecode/core/metrics"
import type { Candidate } from "@/freecode/core/scoring"
import * as SchedulerState from "@/freecode/core/state-store"
import * as SchedulerCore from "@/freecode/core/scheduler-core"
import * as Suspend from "@/freecode/core/suspend"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * The persistence contract from docs 03 §8: `state.json` carries candidate
 * states, EWMA values, window counters, and the decision log; on load,
 * dynamic values older than 24h go back to priors while the static facts
 * stay; EXHAUSTED/INVALID never expire. Write failure degrades to
 * in-memory, never to a failed resolve.
 */

const NOW = 1_700_000_000_000

function withXDG(fn: () => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "freecode-state-"))
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dir
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
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
  account: { id: accountID, provider: providerID, credential: "env:KEY" },
  provider: {
    id: providerID,
    protocol: "openai-chat",
    endpoint: `https://api.${providerID}.example.com`,
    auth: "bearer",
    models: [modelID],
    accounts: [accountID],
  },
})

describe("state.json persistence (docs 03 §8)", () => {
  test("a snapshot writes, survives a read-back, and rolls the log at 500", () => {
    withXDG(() => {
      const file = SchedulerState.file()!
      mkdirSync(path.dirname(file), { recursive: true })
      const snapshot = SchedulerState.empty()
      const candidate = { spec: spec("deepseek/deepseek-chat", "deepseek-main", "deepseek"), health: initialState(), metrics: initialMetrics() }
      snapshot.candidates[`${candidate.spec.model.id}@${candidate.spec.account.id}`] = { health: candidate.health, metrics: candidate.metrics }
      for (let i = 0; i < 520; i++) {
        snapshot.decisions.push({ ts: String(i), task: `t${i}`, req: "standard", candidates: [], pick: "x", path: "score", reason: "test" })
        snapshot.decisions = snapshot.decisions.slice(-Core.DECISION_LOG_LIMIT)
      }
      SchedulerState.save(snapshot)

      const loaded = SchedulerState.load()
      expect(loaded.candidates).toEqual(snapshot.candidates)
      expect(loaded.decisions).toHaveLength(Core.DECISION_LOG_LIMIT)
      expect(loaded.decisions[0].task).toBe("t20")
      expect(readFileSync(file, "utf8")).toContain("deepseek/deepseek-chat@deepseek-main")
    })
  })

  test("a corrupt file reads as empty rather than throwing", () => {
    withXDG(() => {
      const file = SchedulerState.file()!
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, "{ not json")
      const loaded = SchedulerState.load()
      expect(loaded).toEqual(SchedulerState.empty())
    })
  })

  test("EXHAUSTED and INVALID survive a restart; dynamic values do not", () => {
    withXDG(() => {
      const exhausted = onCall(initialState(), { ok: false, status: 429, at: NOW }, probeOptions())
      expect(exhausted.state).toBe("EXHAUSTED")
      const invalid = { ...initialState(), state: "INVALID" as const }

      const snapshot = SchedulerState.empty()
      snapshot.candidates = {
        "a/x@a-main": { health: exhausted, metrics: initialMetrics() },
        "b/y@b-main": { health: invalid, metrics: initialMetrics() },
      }
      SchedulerState.save(snapshot)

      // Read back: the facts are still there.
      const loaded = SchedulerState.load()
      expect(loaded.candidates["a/x@a-main"]!.health.state).toBe("EXHAUSTED")
      expect(loaded.candidates["b/y@b-main"]!.health.state).toBe("INVALID")

      // Staleness applies only to the dynamic block: the metrics go to
      // priors after 24h, the state machine does not.
      const staleMetrics = applyStaleness(loaded.candidates["a/x@a-main"]!.metrics, "a", NOW + 25 * 60 * 60_000)
      expect(staleMetrics.reliability).toBeUndefined()
      expect(reliabilityOf(staleMetrics)).toBe(Core.COLD_START_RELIABILITY)
      expect(loaded.candidates["a/x@a-main"]!.health.state).toBe("EXHAUSTED")
    })
  })

  test("write failure degrades to in-memory: save never throws", () => {
    withXDG(() => {
      // Point the store at a file it cannot write into.
      const file = SchedulerState.file()!
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, "x")
      const snapshot = SchedulerState.empty()
      // No exception: the catch in save() swallows it, docs 03 §8.
      expect(() => SchedulerState.save(snapshot)).not.toThrow()
      expect(() => SchedulerState.recordDecision({ ts: "t", task: "x", req: "standard", candidates: [], pick: "p", path: "score", reason: "r" })).not.toThrow()
    })
  })

  test("a quota window reset re-admits EXHAUSTED via DEGRADED, then the scheduler serves it again", () => {
    const health = onCall(initialState(), { ok: false, status: 429, at: NOW, resetAt: NOW + 86_400_000 }, probeOptions())
    const candidate: Candidate = { spec: spec("zhipu/glm-4-flash", "zhipu-work", "zhipu"), health, metrics: initialMetrics() }
    // Before the reset: out of the pool, no resource.
    expect(() => SchedulerCore.resolve([candidate], { capability: "standard" as Core.CapabilityTier }, { now: NOW + 1_000 })).toThrow(Core.NoResourceError)
    // After: the sweep re-admits via DEGRADED; the resolver works.
    const swept = Suspend.sweepQuotaWindows([candidate], NOW + 87_000_000)
    expect(swept.reAdmitted).toEqual(["zhipu/glm-4-flash@zhipu-work"])
    expect(swept.next[0].health.state).toBe("DEGRADED")
    const outcome = SchedulerCore.resolve(swept.next, { capability: "standard" as Core.CapabilityTier }, { now: NOW + 87_000_000 })
    expect(outcome.binding.model.id).toBe("zhipu/glm-4-flash")
  })
})
