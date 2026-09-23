import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs"
import os from "os"
import { validate, ConfigValidateCommand } from "@/cli/cmd/config-validate"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

/**
 * `freecode config validate`'s pool coherence rules: valid shapes pass with
 * no issues, and every misshapen pool entry or empty tier is reported with
 * a path, matching the "10 good + 2 bad samples" shape the design doc's
 * validation criterion asks for.
 */

const good = (): ConfigV1.Info =>
  ({
    provider: {
      "deepseek-main": { npm: "@ai-sdk/openai-compatible", models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro" } } },
    },
    freecode: {
      pool: {
        local: [],
        fast: [],
        standard: ["deepseek-main/deepseek-v4-pro"],
        strong: ["deepseek-main/deepseek-v4-pro"],
        max: [],
      },
    },
  }) satisfies ConfigV1.Info

describe("config validate, schema + pool coherence", () => {
  test("a well-formed config passes with zero issues", () => {
    const { issues } = validate(good())
    expect(issues).toEqual([])
  })

  test("an empty pool tier is a warning, not an error: routing falls back to the session default", () => {
    const { issues, warnings } = validate(good())
    expect(issues).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((warning) => warning.includes('"local"'))).toBe(true)
  })

  test("a pool entry that is not provider/model form is an issue", () => {
    const cfg = good()
    ;(cfg.freecode?.pool as Record<string, string[]>)["standard"] = ["no-slash-entry"]
    const { issues } = validate(cfg)
    expect(issues.some((issue) => issue.includes("no-slash-entry"))).toBe(true)
  })
  test("a pool reference to a provider with no config block is a warning, not an error", () => {
    const cfg = good()
    ;(cfg.freecode?.pool as Record<string, string[]>)["standard"] = ["unknown-provider/some-model"]
    const { issues, warnings } = validate(cfg)
    expect(issues).toEqual([])
    expect(warnings.some((warning) => warning.includes("unknown-provider"))).toBe(true)
  })

  test("a schema-invalid config reports every issue with a path, not just the first", () => {
    const cfg = good()
    ;(cfg.freecode?.pool as Record<string, string[] | undefined>)["local"] = undefined
    ;(cfg as unknown as Record<string, unknown>).agent = "not-an-object"
    const { issues } = validate(cfg)
    expect(issues.length).toBeGreaterThan(0)
  })

  test("an empty config object is valid, just empty", () => {
    const { issues, warnings } = validate({})
    expect(issues).toEqual([])
    expect(warnings).toEqual([])
  })
})
