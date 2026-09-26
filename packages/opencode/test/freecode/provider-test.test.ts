import { describe, expect, test } from "bun:test"
import { writeFileSync, rmSync, mkdtempSync } from "fs"
import os from "os"
import path from "path"
import { ProviderTest } from "@/freecode/provider-test"

/**
 * The probe's decision logic, without a real network: `probeUrl` and
 * `resolveCredential` are pure and directly testable; `probe`'s fetch is
 * stubbed per case so the 200/401/timeout branches each have their own
 * reproducible example, as the doctor's "Connectivity" group relies on.
 */

describe("probe URL shapes", () => {
  test("a generic provider's base URL gets /models appended", () => {
    expect(ProviderTest.probeUrl("deepseek-main", "https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/models",
    )
  })

  test("a trailing slash is normalised away", () => {
    expect(ProviderTest.probeUrl("deepseek-main", "https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1/models",
    )
  })

  test("Ollama always probes /api/tags regardless of the configured base URL", () => {
    expect(ProviderTest.probeUrl("ollama", "http://127.0.0.1:11434/v1")).toBe(
      "http://127.0.0.1:11434/api/tags",
    )
    expect(ProviderTest.probeUrl("custom-ollama", "http://10.0.0.5:11434")).toBe(
      "http://127.0.0.1:11434/api/tags",
    )
  })
})

describe("credential resolution order", () => {
  test("an explicit {env:VAR} reference wins over the conventional variable", () => {
    delete process.env["MY_CUSTOM_KEY"]
    process.env["OTHER_KEY"] = "other"
    const value = ProviderTest.resolveCredential("any", { apiKey: "{env:OTHER_KEY}" } as never)
    expect(value).toBe("other")
    delete process.env["OTHER_KEY"]
  })

  test("the conventional env var is the fallback when no explicit key is configured", () => {
    process.env["DEEPSEEK_MAIN_API_KEY"] = "from-env"
    const value = ProviderTest.resolveCredential("deepseek-main", undefined)
    expect(value).toBe("from-env")
    delete process.env["DEEPSEEK_MAIN_API_KEY"]
  })

  test("a literal key is returned as-is", () => {
    const value = ProviderTest.resolveCredential("x", { apiKey: "literal-key" } as never)
    expect(value).toBe("literal-key")
  })

  test("an env var with an unusual provider id is uppercased and underscores-substituted", () => {
    expect(ProviderTest.envVarFor("deepseek-main")).toBe("DEEPSEEK_MAIN_API_KEY")
    expect(ProviderTest.envVarFor("my.provider")).toBe("MY_PROVIDER_API_KEY")
  })

  // FREE-27 M2 regression (qa 01a0dd15): writeSecret's canonical form is
  // `export VAR=VALUE\n`.  The old find-callback only matched the empty
  // placeholder line (`VAR=` with no value), so a real secret written in
  // the canonical form made `{file:...}` return undefined and the whole
  // run fell through to 401.  These pin both the canonical write form and
  // the bare form.
  test("{file:...} matches the writeSecret canonical `export VAR=VALUE` form", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f27-file-"))
    try {
      const secret = path.join(dir, "secrets.env")
      writeFileSync(secret, "export DEEPSEEK_MAIN_API_KEY=sk-repro-abc\nexport OTHER=x\n")
      const value = ProviderTest.expandApiKeyPlaceholder("{file:" + secret + "}", "deepseek-main", {})
      expect(value).toBe("sk-repro-abc")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("{file:...} still matches the bare `VAR=VALUE` form", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f27-file-"))
    try {
      const secret = path.join(dir, "secrets.env")
      writeFileSync(secret, "DEEPSEEK_MAIN_API_KEY=sk-repro-bare\n")
      const value = ProviderTest.expandApiKeyPlaceholder("{file:" + secret + "}", "deepseek-main", {})
      expect(value).toBe("sk-repro-bare")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("{file:...} returns undefined when the variable line is absent", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f27-file-"))
    try {
      const secret = path.join(dir, "secrets.env")
      writeFileSync(secret, "export UNRELATED=1\n")
      const value = ProviderTest.expandApiKeyPlaceholder("{file:" + secret + "}", "deepseek-main", {})
      expect(value).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("probe outcome classification (fetch stubbed)", () => {
  test("200 is reachable", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    try {
      const result = await ProviderTest.probe("x", { baseURL: "http://x.test/v1" }, 1000)
      expect(result.ok).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("401 is reachable-but-unauthenticated, which the doctor reports as warn, not fail", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch
    try {
      const result = await ProviderTest.probe("x", { baseURL: "http://x.test/v1" }, 1000)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(401)
      expect(result.hint).toContain("credential")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("a missing base URL fails before any fetch attempt, with a setup hint", async () => {
    const originalFetch = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    try {
      const result = await ProviderTest.probe("x", undefined, 1000)
      expect(result.ok).toBe(false)
      expect(called).toBe(false)
      if (!result.ok) expect(result.hint).toContain("freecode setup")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("Ollama probes need no credential at all", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/api/tags")
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    try {
      const result = await ProviderTest.probe("ollama", undefined, 1000)
      expect(result.ok).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
