import { describe, expect, test, beforeEach } from "bun:test"
import { Fallback } from "@/freecode/fallback"
import { Observe } from "@/freecode/observer"
import { ResourceState, load, save } from "@/freecode/state"
import type { ResolvedModel } from "@/freecode/route"

/**
 * The failover contract, tested where it is decidable.
 *
 * End-to-end failover is hard to provoke deliberately: the scheduler scores a
 * broken account down before it is ever chosen, which is the correct behaviour but
 * makes "does a failure switch accounts" untestable through the UI. These tests
 * drive `plan` directly instead, which is the function that actually decides.
 */

const POOL = {
  standard: ["primary/model", "backup/model"],
  strong: ["primary/model", "backup/model"],
}

const MODELS: Record<string, ResolvedModel> = {
  "primary/model": { id: "model", providerID: "primary" },
  "backup/model": { id: "model", providerID: "backup" },
}

const lookup = (providerID: string, modelID: string) => MODELS[`${providerID}/${modelID}`]

/** Reset the durable store so each test starts from "nothing observed yet". */
function resetStore() {
  save({ version: 2, resources: {} })
}

beforeEach(resetStore)

describe("failover planning", () => {
  test("switches to another account when the provider rate limits", () => {
    const plan = Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      error: new Error("429 Too Many Requests: retry after 30s"),
      attempts: 1,
      pool: POOL,
      model: lookup,
    })

    expect(plan.class).toBe("rate_limit")
    expect(plan.escalate).toBe(false)
    expect(plan.next?.providerID).toBe("backup")
    expect(plan.reason).toContain("primary/model")
    expect(plan.reason).toContain("backup/model")
  })

  test("the failed account is excluded before the replacement is chosen", () => {
    // Recorded first, so a plan cannot hand the task back to the account that
    // just refused it.
    Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      error: new Error("503 Service Unavailable"),
      attempts: 1,
      pool: POOL,
      model: lookup,
    })
    const state = ResourceState.fromPersisted(load().resources["primary/model"])
    expect(state?.providerFailures).toBe(1)
    expect(state?.health).toBe("degraded")
  })

  test("does not escalate a provider failure: the Head agent is not woken", () => {
    for (const message of [
      "429 Too Many Requests",
      "insufficient_quota",
      "401 Unauthorized",
      "504 Gateway Timeout",
      "model not found",
    ]) {
      resetStore()
      const plan = Fallback.plan({
        failed: MODELS["primary/model"]!,
        tier: "standard",
        error: new Error(message),
        attempts: 1,
        pool: POOL,
        model: lookup,
      })
      expect(plan.escalate).toBe(false)
      expect(plan.next).toBeDefined()
    }
  })

  test("escalates a task failure instead, because another account would fail the same way", () => {
    const plan = Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      error: new Error("Test failed: expected 2 to equal 3"),
      attempts: 1,
      pool: POOL,
      model: lookup,
    })
    expect(plan.class).toBe("task_failure")
    expect(plan.escalate).toBe(true)
    expect(plan.next).toBeUndefined()
    expect(plan.reason).toContain("retrying elsewhere would not help")
  })

  test("stops after the attempt budget rather than walking the whole pool", () => {
    const plan = Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      error: new Error("503 Service Unavailable"),
      attempts: Fallback.MAX_ATTEMPTS,
      pool: POOL,
      model: lookup,
    })
    expect(plan.escalate).toBe(true)
    expect(plan.next).toBeUndefined()
    expect(plan.reason).toContain(`giving up after ${Fallback.MAX_ATTEMPTS} attempts`)
  })

  test("escalates when no alternative serves the tier", () => {
    const plan = Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      error: new Error("503 Service Unavailable"),
      attempts: 1,
      pool: { standard: ["primary/model"] },
      model: lookup,
    })
    expect(plan.escalate).toBe(true)
    expect(plan.reason).toContain("no other resource is eligible")
  })

  test("skips an alternative that is itself on cooldown", () => {
    // The backup was rate limited a moment ago, so failing over to it would waste
    // the retry. A third account must be chosen instead, or none.
    Observe.record("backup/model", {
      ok: false,
      verdict: { class: "rate_limit", resource: true, escalate: false, resetAt: Date.now() + 60_000 },
    })

    const plan = Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      error: new Error("503 Service Unavailable"),
      attempts: 1,
      pool: POOL,
      model: lookup,
    })
    expect(plan.next).toBeUndefined()
    expect(plan.escalate).toBe(true)
  })

  test("uses a third healthy account when the backup is cooling down", () => {
    Observe.record("backup/model", {
      ok: false,
      verdict: { class: "rate_limit", resource: true, escalate: false, resetAt: Date.now() + 60_000 },
    })

    const pool = { standard: ["primary/model", "backup/model", "third/model"] }
    const models: Record<string, ResolvedModel> = {
      ...MODELS,
      "third/model": { id: "model", providerID: "third" },
    }
    const plan = Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      error: new Error("503 Service Unavailable"),
      attempts: 1,
      pool,
      model: (p, m) => models[`${p}/${m}`],
    })
    expect(plan.next?.providerID).toBe("third")
  })

  test("reads the verdict the stream already recorded instead of counting the failure twice", () => {
    Observe.recordFailure("primary/model", new Error("429 Too Many Requests"))
    const before = ResourceState.fromPersisted(load().resources["primary/model"])!

    const plan = Fallback.plan({
      failed: MODELS["primary/model"]!,
      tier: "standard",
      recorded: Fallback.recordedFor("primary/model"),
      attempts: 1,
      pool: POOL,
      model: lookup,
    })

    const after = ResourceState.fromPersisted(load().resources["primary/model"])!
    expect(plan.class).toBe("rate_limit")
    expect(after.providerFailures).toBe(before.providerFailures)
    expect(after.attempts).toBe(before.attempts)
  })

  test("reports every excluded resource for the /why report", () => {
    Observe.recordFailure("backup/model", new Error("429 Too Many Requests: retry after 45s"))
    const lines = Fallback.excluded(POOL)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("backup/model")
    expect(lines[0]).toContain("circuit open")
    expect(lines[0]).toContain("rate_limit")
  })
})
