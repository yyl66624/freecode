import { describe, expect, test } from "bun:test"
import { Failure } from "@/freecode/failure"

function classify(error: unknown) {
  return Failure.classify(error)
}

describe("failure classification", () => {
  test("distinguishes a rate limit from a quota exhaustion", () => {
    const limited = classify(new Error("429 Too Many Requests: rate limit exceeded, retry after 20s"))
    expect(limited.class).toBe("rate_limit")
    expect(limited.resource).toBe(true)
    expect(limited.escalate).toBe(false)

    const broke = classify(new Error("insufficient_quota: you exceeded your current quota"))
    expect(broke.class).toBe("quota")
    expect(broke.resource).toBe(true)
    expect(broke.escalate).toBe(false)
  })

  test("classifies authentication, timeout, server and model errors as resource failures", () => {
    expect(classify(new Error("401 Unauthorized: invalid api key")).class).toBe("authentication")
    expect(classify(new Error("request timed out after 60000ms")).class).toBe("timeout")
    expect(classify(new Error("fetch failed")).class).toBe("timeout")
    expect(classify(new Error("503 Service Unavailable")).class).toBe("server")
    expect(classify(new Error("The model is currently at capacity due to high demand")).class).toBe("server")
    expect(classify(new Error("404 model not found: gpt-9")).class).toBe("model_unavailable")
    expect(classify(new Error("This model's maximum context length is 128000 tokens")).class).toBe("context_limit")
  })

  test("every resource failure is flagged as retryable on another resource", () => {
    for (const message of [
      "429 Too Many Requests",
      "insufficient_quota",
      "401 Unauthorized",
      "request timed out",
      "502 Bad Gateway",
      "model not found",
      "maximum context length exceeded",
    ]) {
      const verdict = classify(new Error(message))
      expect(verdict.resource).toBe(true)
      // None of these should cost a Head agent token: a different resource is
      // the fix, not a smarter model.
      expect(verdict.escalate).toBe(false)
    }
  })

  test("classifies ordinary task failures as the task's problem", () => {
    for (const message of [
      "File not found: src/missing.ts",
      "The user rejected permission to use this specific tool call",
      "SyntaxError: Unexpected token }",
      "Test failed: expected 2 to equal 3",
      "Tool call edit failed: string not found",
    ]) {
      const verdict = classify(new Error(message))
      expect(verdict.class).toBe("task_failure")
      expect(verdict.resource).toBe(false)
      // These are the ones worth telling the Head agent about.
      expect(verdict.escalate).toBe(true)
    }
  })

  test("task-shaped wording wins over provider-shaped wording", () => {
    // A tool error that happens to mention a timeout is still a task failure;
    // retrying it on another account would waste that account's quota.
    const verdict = classify(new Error("Tool call failed: permission rejected after timeout"))
    expect(verdict.class).toBe("task_failure")
    expect(verdict.resource).toBe(false)
  })

  test("reads structured provider errors, not only Error instances", () => {
    expect(classify({ status: 429, message: "slow down" }).class).toBe("rate_limit")
    expect(classify({ code: "ECONNRESET" }).class).toBe("timeout")
    expect(classify({ type: "server_error", message: "internal server error" }).class).toBe("server")
  })

  test("treats an empty or unrecognised error as unknown, and escalates it", () => {
    for (const input of [undefined, null, "", {}]) {
      const verdict = classify(input)
      expect(verdict.class).toBe("unknown")
      expect(verdict.resource).toBe(false)
    }
    // An unrecognised error is the one case where a stronger model is a
    // reasonable next step, because nothing says another resource would differ.
    expect(classify(new Error("something inexplicable happened")).escalate).toBe(true)
  })
})

describe("reset time extraction", () => {
  const now = 1_700_000_000_000

  test("reads a relative retry hint in seconds, minutes and hours", () => {
    expect(Failure.resetFrom("retry after 20s", now)).toBe(now + 20_000)
    expect(Failure.resetFrom("Retry-After: 45 seconds", now)).toBe(now + 45_000)
    expect(Failure.resetFrom("please try again in 2 minutes", now)).toBe(now + 120_000)
    expect(Failure.resetFrom("available in 1 hour", now)).toBe(now + 3_600_000)
    expect(Failure.resetFrom("retry in 500ms", now)).toBe(now + 500)
  })

  test("reads a reset hint phrased as the quota resetting", () => {
    expect(Failure.resetFrom("quota resets in 30s", now)).toBe(now + 30_000)
  })

  test("returns nothing when the provider did not say, so a default cooldown applies", () => {
    expect(Failure.resetFrom("429 Too Many Requests", now)).toBeUndefined()
    expect(Failure.resetFrom("insufficient_quota", now)).toBeUndefined()
  })

  test("carries the reset time through classification", () => {
    const verdict = classify(new Error("429 rate limit exceeded, retry after 30s"))
    expect(verdict.resetAt).toBeGreaterThan(Date.now() + 25_000)
    expect(verdict.resetAt).toBeLessThan(Date.now() + 35_000)
  })
})
