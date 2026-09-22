import { describe, expect, test } from "bun:test"
import { Observe } from "@/freecode/observe"

describe("failure classification", () => {
  test("rates provider-side signals as provider failures", () => {
    for (const message of [
      "429 Too Many Requests",
      "Rate limit exceeded, retry after 20s",
      "The model is currently at capacity due to high demand",
      "503 Service Unavailable",
      "fetch failed",
      "request timed out",
      "invalid api key",
      "This model's maximum context length is 128000 tokens",
    ]) {
      expect(Observe.classify(new Error(message)).provider).toBe(true)
    }
  })

  test("rates an ordinary task failure as a task failure", () => {
    // These are the errors that must NOT degrade a resource: the model answered,
    // the work went badly, or the user cancelled. Blaming the provider for them
    // teaches the scheduler to avoid its best model.
    for (const message of [
      "File not found: src/missing.ts",
      "The user rejected permission to use this specific tool call",
      "SyntaxError: Unexpected token }",
      "Test failed: expected 2 to equal 3",
    ]) {
      expect(Observe.classify(new Error(message)).provider).toBe(false)
    }
  })

  test("recognises quota exhaustion specifically, not just a provider failure", () => {
    expect(Observe.classify(new Error("insufficient_quota: you have no credits")).quotaExhausted).toBe(true)
    expect(Observe.classify(new Error("429 Too Many Requests")).quotaExhausted).toBe(true)
    // A generic provider failure is not a quota problem, and must not mark the
    // account as exhausted.
    expect(Observe.classify(new Error("503 Service Unavailable")).quotaExhausted).toBe(false)
    expect(Observe.classify(new Error("fetch failed")).quotaExhausted).toBe(false)
  })

  test("reads structured errors, not just Error instances", () => {
    expect(Observe.classify({ code: "ECONNRESET", message: "connection reset" }).provider).toBe(true)
    expect(Observe.classify({ message: "no such file" }).provider).toBe(false)
  })

  test("treats an empty or unknown error as a task failure", () => {
    expect(Observe.classify(undefined).provider).toBe(false)
    expect(Observe.classify(null).provider).toBe(false)
    expect(Observe.classify("").provider).toBe(false)
    expect(Observe.classify({}).provider).toBe(false)
  })
})
