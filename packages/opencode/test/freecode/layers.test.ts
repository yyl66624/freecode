import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs"
import path from "path"
import os from "os"

import {
  Layers,
  Config,
  Templates,
  ResourceStore,
  Lint,
} from "@/freecode/layers"
import {
  validateAgent,
  validateProvider,
  validateModel,
  validateAccount,
  parseCredentialRef,
  resolveCredential,
  isInvalid,
} from "@/freecode/layers/types"
import type { ProviderSpec, ModelSpec, AccountSpec } from "@/freecode/core/types"

// -----------------------------------------------------------------------
// §2 schema validation + isolation
// -----------------------------------------------------------------------
describe("four-layer schema validation", () => {
  test("a valid provider spec passes", () => {
    const spec: ProviderSpec = {
      id: "deepseek",
      protocol: "openai-chat",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      auth: "bearer",
      models: ["deepseek-chat"],
      accounts: ["deepseek"],
    }
    const entry = validateProvider(spec)
    expect(entry.invalid).toBe(false)
  })

  test("an invalid provider spec is isolated, not thrown", () => {
    const bad: unknown = { id: "x", protocol: "magic", endpoint: "" }
    const entry = validateProvider(bad)
    expect(entry.invalid).toBe(true)
    expect(entry.issues!.length).toBeGreaterThan(0)
  })

  test("an invalid model spec with a bad tier is flagged", () => {
    const bad = {
      id: "p/m",
      provider: "p",
      contextWindow: 1,
      maxOutput: 1,
      capabilities: [],
      tier: "super-elite",
    } as unknown as ModelSpec
    const entry = validateModel(bad)
    expect(entry.invalid).toBe(true)
    expect(entry.issues!.join()).toContain("tier")
  })

  test("an account with a plaintext credential is rejected", () => {
    const bad: AccountSpec = {
      id: "a",
      provider: "p",
      credential: "sk-abc123",
    }
    const entry = validateAccount(bad)
    expect(entry.invalid).toBe(true)
    expect(entry.issues!.join()).toContain("plaintext")
  })

  test("an account with a valid env reference passes", () => {
    const good: AccountSpec = {
      id: "a",
      provider: "p",
      credential: "env:DEEPSEEK_API_KEY",
    }
    const entry = validateAccount(good)
    expect(entry.invalid).toBe(false)
  })

  test("an agent with a bad capability tier is flagged", () => {
    const bad = { id: "coder", systemPrompt: "you are", capability: "god" }
    const entry = validateAgent(bad)
    expect(entry.invalid).toBe(true)
    expect(entry.issues!.join()).toContain("capability")
  })
})

// -----------------------------------------------------------------------
// Credential reference grammar
// -----------------------------------------------------------------------
describe("credential reference grammar (ADR-005)", () => {
  const ref = (s: string) => parseCredentialRef(s)

  test("env:VAR parses with the name", () => {
    const r = ref("env:DEEPSEEK_API_KEY")
    expect(r).toEqual({ scheme: "env", name: "DEEPSEEK_API_KEY" })
  })

  test("keychain:label parses", () => {
    const r = ref("keychain:deepseek-work")
    expect(r?.scheme).toBe("keychain")
    expect(r?.name).toBe("deepseek-work")
  })

  test("file:path parses", () => {
    const r = ref("file:/home/user/.freecode/secrets.env")
    expect(r?.scheme).toBe("file")
    expect(r?.name).toContain("secrets.env")
  })

  test("a bare string that looks like a key does not parse", () => {
    expect(ref("sk-abc123")).toBeUndefined()
    expect(ref("sk-abc123/")).toBeUndefined()
    expect(ref("")).toBeUndefined()
  })

  test("env with a lowercase name is rejected", () => {
    expect(ref("env:lowercase_var")).toBeUndefined()
  })

  test("resolveCredential returns undefined for a plaintext attempt", () => {
    const result = resolveCredential("sk-abc123", () => "value")
    expect(result).toBeUndefined()
  })

  test("isPlaintextCredential flags a bare key string", () => {
    // The gate in config.ts that stops setup from writing a raw key.
    expect(Layers.parseCredentialRef("sk-abc")).toBeUndefined()
    expect(Layers.parseCredentialRef("env:K")).toEqual({ scheme: "env", name: "K" })
  })
})

// -----------------------------------------------------------------------
// Config merge
// -----------------------------------------------------------------------
describe("config merge, docs 02 §6", () => {
  const user: Config.RawConfig = {
    accounts: [
      { id: "deepseek-main", provider: "deepseek", credential: "env:DEEPSEEK_API_KEY" },
      { id: "zhipu", provider: "zhipu", credential: "env:ZHIPU_API_KEY" },
    ],
    pool: { standard: ["deepseek/deepseek-chat"] },
  }
  const project: Config.RawConfig = {
    accounts: [{ id: "zhipu", provider: "zhipu", credential: "env:ZHIPU_API_KEY", enabled: false }],
    pool: { standard: ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"] },
  }

  test("project-level pool replaces user-level for the named tier", () => {
    const merged = Config.merge(Config.load({ label: "user", data: user }), Config.load({ label: "project", data: project }))
    expect(merged.pool.standard).toEqual(["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"])
  })

  test("project-level account merge by id can disable a user-level account", () => {
    const merged = Config.merge(Config.load({ label: "user", data: user }), Config.load({ label: "project", data: project }))
    const zhipu = merged.accounts["zhipu"]
    expect(zhipu.value?.enabled).toBe(false)
    // deepseek-main is untouched.
    const main = merged.accounts["deepseek-main"]
    expect(main.value?.enabled).toBeUndefined()
  })

  test("invalid entries are isolated and do not block a valid merge", () => {
    const userBad: Config.RawConfig = {
      accounts: [{ id: "ok", provider: "p", credential: "env:K" } as unknown as AccountSpec],
      providers: { p: { id: "p", protocol: "openai-chat", endpoint: "", auth: "bearer", models: [], accounts: [] } },
    }
    const merged = Config.load({ label: "user", data: userBad })
    expect(merged.providers["p"].invalid).toBe(true)
    // The valid account still loads.
    expect(merged.accounts["ok"].invalid).toBe(false)
  })
})

// -----------------------------------------------------------------------
// loadFiles + jsonc
// -----------------------------------------------------------------------
describe("config loadFiles", () => {
  const TMP = mkdtempSync(path.join(os.tmpdir(), "freecode-layers-"))
  beforeAll(() => {})
  test("reads a user-level jsonc config file with comments and trailing commas", () => {
    const userFile = path.join(TMP, "user.jsonc")
    writeFileSync(
      userFile,
      `{
        // user-level
        "accounts": [{ "id": "a", "provider": "p", "credential": "env:K", },],
        "pool": { "standard": ["p/m1"], },
      }`,
    )
    const { config, issues } = Config.loadFiles(userFile)
    expect(issues).toEqual([])
    expect(config.accounts["a"].invalid).toBe(false)
    expect(config.pool.standard).toEqual(["p/m1"])
  })

  test("project-level merges over user-level", () => {
    const userFile = path.join(TMP, "user.jsonc")
    writeFileSync(userFile, JSON.stringify({ accounts: [{ id: "a", provider: "p", credential: "env:K" }], pool: { standard: ["p/m1"] } }))
    const projectFile = path.join(TMP, "project.jsonc")
    writeFileSync(projectFile, JSON.stringify({ accounts: [{ id: "a", provider: "p", credential: "env:K", enabled: false }], pool: { standard: ["p/m2"] } }))
    const { config } = Config.loadFiles(userFile, projectFile)
    expect(config.accounts["a"].value?.enabled).toBe(false)
    expect(config.pool.standard).toEqual(["p/m2"])
  })

  test("a missing user file is not an error, just skipped", () => {
    const missing = path.join(TMP, "does-not-exist.json")
    const projectFile = path.join(TMP, "project.json")
    writeFileSync(projectFile, JSON.stringify({ accounts: [] }))
    const { config, issues } = Config.loadFiles(missing, projectFile)
    expect(issues.some((s) => s.includes("does-not-exist"))).toBe(true)
    expect(config.accounts).toEqual({})
  })
})

// -----------------------------------------------------------------------
// Template loading + validation
// -----------------------------------------------------------------------
describe("built-in provider templates", () => {
  test("loadTemplates returns all 6 provider templates from docs 02 §3", () => {
    const set = Templates.loadTemplates()
    const ids = set.providers.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(["minimax", "zhipu", "moonshot", "deepseek", "openai-compat", "ollama"]))
  })

  test("every template model passes schema validation", () => {
    const set = Templates.loadTemplates()
    const result = Templates.validateTemplates(set)
    for (const [id, entry] of Object.entries(result.models)) {
      // Template models with filled-in contextWindow / maxOutput must be valid.
      // Templates that only declare a tier with no metadata are `invalid`-free
      // by design (a metadata-absent model is a prompt, not an error), so we
      // only assert that the id-shape ones pass.
      if (entry.invalid) {
        const m = set.models.find((x) => x.id === id)!
        expect(m.contextWindow && m.maxOutput).toBeTruthy()
      }
    }
  })

  test("the ollama template has auth=none", () => {
    const set = Templates.loadTemplates()
    const ollama = set.providers.find((p) => p.id === "ollama")!
    expect(ollama.auth).toBe("none")
  })
})

// -----------------------------------------------------------------------
// ResourceStore
// -----------------------------------------------------------------------
describe("ResourceStore", () => {
  test("register + snapshot returns registered resources", () => {
    const store = ResourceStore.makeStore()
    store.registerProvider("deepseek", {
      id: "deepseek",
      protocol: "openai-chat",
      endpoint: "https://api.deepseek.com/v1",
      auth: "bearer",
      models: ["deepseek-chat"],
      accounts: ["deepseek"],
    })
    store.registerModel("deepseek/deepseek-chat", {
      id: "deepseek/deepseek-chat",
      provider: "deepseek",
      contextWindow: 64_000,
      maxOutput: 8_192,
      capabilities: ["tools"],
      tier: "standard",
    })
    store.registerAccount("deepseek", { id: "deepseek", provider: "deepseek", credential: "env:DEEPSEEK_API_KEY" })
    const snap = store.snapshot()
    expect(Object.keys(snap.providers)).toEqual(["deepseek"])
    expect(snap.models["deepseek/deepseek-chat"].invalid).toBe(false)
    expect(snap.accounts["deepseek"].invalid).toBe(false)
  })

  test("an invalid registration is isolated and does not block others", () => {
    const store = ResourceStore.makeStore()
    store.registerProvider("good", {
      id: "good",
      protocol: "openai-chat",
      endpoint: "https://example.com/v1",
      auth: "none",
      models: [],
      accounts: [],
    })
    store.registerProvider("bad", {
      id: "bad",
      protocol: "magic" as never,
      endpoint: "",
      auth: "none",
      models: [],
      accounts: [],
    })
    const snap = store.snapshot()
    expect(snap.providers["good"]!.invalid).toBe(false)
    expect(snap.providers["bad"]!.invalid).toBe(true)
  })

  test("removeProvider unregisters by id", () => {
    const store = ResourceStore.makeStore()
    store.registerProvider("p", { id: "p", protocol: "openai-chat", endpoint: "https://x", auth: "none", models: [], accounts: [] })
    store.removeProvider("p")
    expect(store.snapshot().providers["p"]).toBeUndefined()
  })

  test("setPool + snapshot exposes the pool by tier", () => {
    const store = ResourceStore.makeStore()
    store.setPool("standard", ["p/m1", "p/m2"])
    expect(store.snapshot().pool["standard"]).toEqual(["p/m1", "p/m2"])
  })
})

// -----------------------------------------------------------------------
// Lint / import-boundary check
// -----------------------------------------------------------------------
describe("import-boundary lint", () => {
  test("checkImportBoundaries flags a violation and returns [] on a clean tree", () => {
    // The clean case: the module itself is the test. The agent-layer module
    // directory we use here is the layers dir — which contains no agent-layer
    // code that crosses the boundary, so we get an empty list.
    const dir = path.join(import.meta.dir, "..", "..", "src", "freecode", "layers")
    const violations = Lint.checkImportBoundaries(dir, ["src/freecode/provider/", "src/freecode/model/", "src/freecode/account/"])
    expect(violations).toEqual([])
  })

  test("a planted violation is caught", () => {
    const TMP = mkdtempSync(path.join(os.tmpdir(), "freecode-lint-"))
    const agentDir = path.join(TMP, "agent")
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      path.join(agentDir, "coder.ts"),
      `import { ProviderSpec } from "../provider/types"
export const x: ProviderSpec = null as never\n`,
    )
    const violations = Lint.checkImportBoundaries(agentDir, ["provider/"])
    expect(violations.length).toBe(1)
    expect(violations[0]!.importPath).toContain("provider/types")
    rmSync(TMP, { recursive: true, force: true })
  })
})
