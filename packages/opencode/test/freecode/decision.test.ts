import { describe, expect, test } from "bun:test"
import { Decision } from "@/freecode/decision"
import { Scheduler, type Candidate } from "@/freecode/scheduler"
import { ResourceState } from "@/freecode/state"

function candidate(id: string, tiers: Candidate["resource"]["tiers"] = ["standard"]): Candidate {
  const [provider, model] = id.split("/")
  return {
    resource: {
      id,
      provider: provider ?? "a",
      account: "main",
      model: model ?? "model",
      tiers,
      capability: { coding: 0.5, reasoning: 0.5, review: 0.5, speed: 0.5 },
      cost: 1,
    },
  }
}

describe("decision records", () => {
  test("records every candidate, including the ones the scheduler refused to score", () => {
    // The whole point of the record is answering "why not the other one", which
    // is impossible if only scored candidates are stored.
    const all = [candidate("a/strong"), candidate("a/weak", ["fast"])]
    const rows = Decision.candidates(all, Scheduler.rank(all, { tier: "standard" }))

    expect(rows).toHaveLength(2)
    const weak = rows.find((row) => row.resource === "a/weak")
    expect(weak?.eligible).toBe(false)
    expect(weak?.excluded).toBeTruthy()
    expect(weak?.score).toBeUndefined()
  })

  test("sorts by score so the winner reads first", () => {
    const all = [candidate("a/plain"), candidate("a/nothing")]
    const rows = Decision.candidates(all, Scheduler.rank(all, { tier: "standard" }))
    expect(rows.every((row) => typeof row.score === "number")).toBe(true)
    expect(rows[0]!.score!).toBeGreaterThanOrEqual(rows[1]!.score!)
  })

  test("records the winner's score components, not just the total", () => {
    const all = [candidate("a/model")]
    const rows = Decision.candidates(all, Scheduler.rank(all, { tier: "standard" }))
    expect(Object.keys(rows[0]!.components ?? {}).sort()).toEqual([
      "capability",
      "cost",
      "health",
      "latency",
      "quota",
      "reliability",
    ])
  })
})

describe("decision rendering", () => {
  const record: Decision.DecisionRecord = {
    version: 1,
    at: 1_700_000_000_000,
    agent: "coder",
    task: "Fix the failing loader test",
    mode: "tier",
    tier: "strong",
    routing: {
      kind: "debug",
      tier: "strong",
      difficulty: 4,
      needsReview: true,
      parallelizable: false,
      confidence: 0.05,
      source: "laya",
      reason: "rules=debug/strong laya=test/fast",
    },
    routingReason: "rules=debug/strong laya=test/fast agree=False",
    selected: "a/strong",
    candidates: [
      { resource: "a/strong", provider: "a", account: "main", model: "strong", eligible: true, score: 0.8, components: { capability: 0.7, quota: 0.9 } },
      { resource: "a/weak", provider: "a", account: "main", model: "weak", eligible: false, excluded: "quota exhausted, resets in 30s" },
    ],
  }

  test("shows what was selected and the arithmetic behind it", () => {
    const text = Decision.render(record)
    expect(text).toContain("Selected  a/strong")
    expect(text).toContain("+ capability")
    expect(text).toContain("+ quota")
    expect(text).toContain("= score")
  })

  test("shows why each other candidate lost", () => {
    const text = Decision.render(record)
    expect(text).toContain("Not selected")
    expect(text).toContain("quota exhausted, resets in 30s")
  })

  test("shows the router's reasoning and the tier it asked for", () => {
    const text = Decision.render(record)
    expect(text).toContain("tier    strong")
    expect(text).toContain("kind=debug")
    expect(text).toContain("confidence=0.05")
  })

  test("says plainly when nothing was selected rather than implying a choice was made", () => {
    const text = Decision.render({
      ...record,
      selected: undefined,
      fallbackReason: "no eligible model for tier strong",
      candidates: [],
    })
    expect(text).toContain("none")
    expect(text).toContain("no eligible model for tier strong")
  })

  test("renders a decision with no candidates without crashing", () => {
    expect(() =>
      Decision.render({ ...record, selected: undefined, candidates: [] }),
    ).not.toThrow()
  })

  test("a stored record survives a round trip through JSON", () => {
    const parsed = JSON.parse(JSON.stringify(record)) as Decision.DecisionRecord
    expect(Decision.render(parsed)).toEqual(Decision.render(record))
  })

  test("an empty task is labelled rather than rendered as a blank line", () => {
    const text = Decision.render({ ...record, task: "" })
    expect(text).toContain("(empty)")
  })
})

describe("decision persistence", () => {
  test("writes and reads back an identical record", () => {
    const before = Decision.read()
    const written = {
      agent: "coder",
      task: "round trip",
      mode: "auto" as const,
      tier: "standard",
      selected: "a/model",
      candidates: [
        { resource: "a/model", provider: "a", account: "main", model: "model", eligible: true, score: 0.5, components: {} },
      ],
    }
    Decision.write(written)
    const after = Decision.read()
    expect(after?.task).toBe("round trip")
    expect(after?.selected).toBe("a/model")
    expect(after?.candidates).toHaveLength(1)

    // Restore whatever was there, so this test does not disturb a real run.
    if (before) Decision.write(before)
  })

  test("a corrupt record reads as absent instead of throwing", () => {
    const { writeFileSync, mkdirSync } = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const location = Decision.file()
    const previous = (() => {
      try {
        return require("fs").readFileSync(location, "utf8")
      } catch {
        return undefined
      }
    })()

    mkdirSync(path.dirname(location), { recursive: true })
    writeFileSync(location, "{ this is not json")
    expect(Decision.read()).toBeUndefined()

    if (previous === undefined) return
    writeFileSync(location, previous)
  })
})

describe("resource state is reflected in the record", () => {
  test("an excluded resource is recorded as ineligible, not as a low score", () => {
    const all: Candidate[] = [
      candidate("a/open"),
      {
        ...candidate("a/cooling"),
        state: {
          ...ResourceState.empty(),
          circuit: { state: "open", consecutiveFailures: 3, retryAt: Date.now() + 60_000, reason: "rate_limit" },
        },
      },
    ]
    const rows = Decision.candidates(all, Scheduler.rank(all, { tier: "standard" }))
    const cooling = rows.find((row) => row.resource === "a/cooling")
    expect(cooling?.eligible).toBe(false)
    // A hard exclusion must never look like a merely worse score.
    expect(cooling?.score).toBeUndefined()
  })
})
