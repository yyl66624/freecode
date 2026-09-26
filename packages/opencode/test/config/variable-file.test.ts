import { describe, expect, test } from "bun:test"
import { writeFileSync, rmSync, mkdtempSync } from "fs"
import os from "os"
import path from "path"
import { ConfigVariable } from "@/config/variable"

/**
 * FREE-28 regression: `ConfigVariable.substitute`'s `{file:...}` branch used
 * to expand to the file's ENTIRE content. When the target is a shared env
 * file (what `writeSecret` produces: `export VAR=VALUE` lines, possibly for
 * several providers), the multi-line text became the Bearer token and every
 * request 401'd (§5/§7/§8 chain, qa `01a0dd6b`). The fix extracts the
 * credential value:
 *
 * - env-file shape (`VAR=VALUE` / `export VAR=VALUE` lines): return the
 *   value of the hinted variable (provider file name), else the sole
 *   assignment, else undefined (ambiguous → missing credential, never the
 *   raw multi-line text);
 * - bare-value file (legacy single-key shape): the whole trimmed content
 *   is still the value (no regression for the documented shape).
 */

async function expand(configText: string, dir: string): Promise<string> {
  const substituted = await ConfigVariable.substitute({
    text: configText,
    type: "virtual",
    dir,
    source: "test",
    missing: "empty",
  })
  // The substituted text is still valid JSON; pull back the single key
  // value the test is asserting on.
  return (JSON.parse(substituted) as { apiKey: string }).apiKey
}

describe("FREE-28: {file:...} extracts the credential value, not the whole file", () => {
  test("shared secrets.env with the provider's own variable (export prefix) → key value only", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f28-file-"))
    try {
      // setup writes keys to a per-provider file, e.g.
      // <project>/.freecode/deepseek-main.env ← writeSecret(envVarFor(id))
      const file = path.join(dir, "secrets.env")
      writeFileSync(
        file,
        "export DEEPSEEK_MAIN_API_KEY=sk-repro-abc\nexport OTHER=irrelevant\n",
      )
      const configText = `{"apiKey":"{file:${file}}"}`
      // The filename carries no provider hint ("secrets"), and the file has
      // two assignments, so the generic config layer cannot pick one — the
      // {file:...} token must be left in place for the provider layer
      // (ProviderTest.expandApiKeyPlaceholder, which knows the provider id)
      // to resolve. Assert that positively: the result is the untouched
      // token, not the raw multi-line content (the FREE-28 401 shape).
      const result = await expand(configText, dir)
      expect(result).toBe(`{file:${file}}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a provider-named env file picks that provider's key value", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f28-file-"))
    try {
      const file = path.join(dir, "deepseek-main.env")
      writeFileSync(
        file,
        "export DEEPSEEK_MAIN_API_KEY=sk-provider-xyz\nexport GEMINI_API_KEY=sk-other\n",
      )
      const configText = `{"apiKey":"{file:${file}}"}`
      const result = await expand(configText, dir)
      expect(result).toBe("sk-provider-xyz")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a shared secrets.env with a single assignment → that value (not raw text)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f28-file-"))
    try {
      const file = path.join(dir, "secrets.env")
      writeFileSync(file, "export DEEPSEEK_MAIN_API_KEY=sk-single\n")
      const result = await expand(`{"apiKey":"{file:${file}}"}`, dir)
      expect(result).toBe("sk-single")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a bare value file (legacy single-key shape) still expands to the whole content", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f28-file-"))
    try {
      const file = path.join(dir, "key.txt")
      writeFileSync(file, "bare-key-value-no-assignment\n")
      const result = await expand(`{"apiKey":"{file:${file}}"}`, dir)
      expect(result).toBe("bare-key-value-no-assignment")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
