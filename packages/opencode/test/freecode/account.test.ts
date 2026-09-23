import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import { Setup } from "@/freecode/setup"

/**
 * `freecode account add` (the CLI command in `cli/cmd/account-freecode.ts`)
 * is built entirely out of `Setup`'s draft/validation/secret-writing
 * primitives, so these tests pin the *shape* the command writes: the same
 * `draftToConfig` output `freecode setup` writes, so the two paths cannot
 * drift apart into two different pool representations.
 */

describe("account add writes the same config shape as setup", () => {
  const draft: Setup.Draft = {
    id: "deepseek-backup",
    npm: "@ai-sdk/openai-compatible",
    name: "DeepSeek Backup",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "{file:/home/user/.freecode/secrets.env}",
    models: ["deepseek-v4-pro"],
    tier: "standard",
  }

  test("a second account for the same vendor is a distinct provider id, not a second key on the first", () => {
    // The pool entry names the account, not the vendor: this is the whole
    // point of the four-layer model (docs/architecture/02 §2.4), and it is
    // what makes `freecode account disable deepseek-backup` deletable
    // without touching deepseek-main's credential.
    const patch = Setup.draftToConfig(draft)
    expect(Object.keys(patch.provider as Record<string, unknown>)).toEqual(["deepseek-backup"])
    expect((patch.freecode?.pool as Record<string, string[]>).standard).toEqual(["deepseek-backup/deepseek-v4-pro"])
  })

  test("pool membership follows the declared tier floor, same as setup", () => {
    const patch = Setup.draftToConfig(draft)
    const pool = patch.freecode?.pool as Record<string, string[]>
    expect(pool.local).toEqual([])
    expect(pool.fast).toEqual([])
    expect(pool.standard).toEqual(["deepseek-backup/deepseek-v4-pro"])
    expect(pool.strong).toEqual(["deepseek-backup/deepseek-v4-pro"])
    expect(pool.max).toEqual(["deepseek-backup/deepseek-v4-pro"])
  })

  test("a `{file:...}` key reference is written as-is, never inlined", () => {
    const patch = Setup.draftToConfig(draft)
    const entry = (patch.provider as Record<string, any>)["deepseek-backup"]
    expect(entry.options.apiKey).toBe("{file:/home/user/.freecode/secrets.env}")
  })

  test("an account id that would be an invalid provider identifier is refused the same way setup refuses it", () => {
    const problems = Setup.validate({ ...draft, id: "has space" })
    expect(problems.length).toBeGreaterThan(0)
  })
})
