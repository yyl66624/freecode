import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { HttpClient } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Env } from "@/env"
import { Doctor } from "@/freecode/doctor"
import { OpenCodeCompat } from "@/freecode/opencode-compat"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

/**
 * FREE-30: a machine that already ran OpenCode must keep its providers and
 * credentials after installing FreeCode.
 *
 * The rule under test had to be pinned in both directions — FreeCode wins on
 * conflict, OpenCode fills what FreeCode does not define — and in both halves of
 * the feature: the global config files and the `auth.json` credential store.
 * `doctor` has its own tests because "detected" and "in use" are distinct
 * answers a user acts on differently.
 */

const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [
    httpClient,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.die(`unexpected http request: ${request.method} ${request.url}`)),
    ),
  ],
])

const it = testEffect(layer)

// A second, real `Auth` stack: the credential fallback has to be exercised against
// the store that actually serves providers, not just through the pure helper.
const authLayer = LayerNode.compile(Auth.node)
const runAuth = <A, E>(effect: Effect.Effect<A, E, Auth.Service>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(authLayer)))
const authAll = () =>
  runAuth(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return yield* auth.all()
    }),
  )

type MutablePaths = { config: string; data: string; opencodeConfig: string; opencodeData: string }
const paths = Global.Path as unknown as MutablePaths

/**
 * Point both products' roots at throwaway directories for one test.
 *
 * The two roots have to move together: the point of the feature is the relation
 * between them, so a test that redirected only one side would assert nothing.
 */
async function withRoots<T>(fn: (roots: { freecode: string; opencode: string }) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(process.env["TMPDIR"] ?? "/tmp", "freecode-compat-"))
  const freecode = path.join(root, "freecode")
  const opencode = path.join(root, "opencode")
  await Promise.all([
    fs.mkdir(path.join(freecode, "config"), { recursive: true }),
    fs.mkdir(path.join(freecode, "data"), { recursive: true }),
    fs.mkdir(path.join(opencode, "config"), { recursive: true }),
    fs.mkdir(path.join(opencode, "data"), { recursive: true }),
  ])
  const before = {
    config: paths.config,
    data: paths.data,
    opencodeConfig: paths.opencodeConfig,
    opencodeData: paths.opencodeData,
  }
  const beforeFlags = {
    configDir: process.env["OPENCODE_CONFIG_DIR"],
    authContent: process.env["OPENCODE_AUTH_CONTENT"],
  }
  delete process.env["OPENCODE_CONFIG_DIR"]
  delete process.env["OPENCODE_AUTH_CONTENT"]
  paths.config = path.join(freecode, "config")
  paths.data = path.join(freecode, "data")
  paths.opencodeConfig = path.join(opencode, "config")
  paths.opencodeData = path.join(opencode, "data")
  try {
    return await fn({ freecode, opencode })
  } finally {
    paths.config = before.config
    paths.data = before.data
    paths.opencodeConfig = before.opencodeConfig
    paths.opencodeData = before.opencodeData
    if (beforeFlags.configDir === undefined) delete process.env["OPENCODE_CONFIG_DIR"]
    else process.env["OPENCODE_CONFIG_DIR"] = beforeFlags.configDir
    if (beforeFlags.authContent === undefined) delete process.env["OPENCODE_AUTH_CONTENT"]
    else process.env["OPENCODE_AUTH_CONTENT"] = beforeFlags.authContent
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** The global config as the process would load it, with no project involved. */
const readGlobal = () => Effect.runPromise(Config.use.getGlobal().pipe(Effect.scoped, Effect.provide(layer)))

const write = (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data))
const read = (file: string) => fs.readFile(file, "utf8")

// `Auth` freezes its own credential path at import time, so the primary file is
// the process-wide test one and only the OpenCode side is redirected. The primary
// file is snapshotted and restored because every test file in a run shares it.
const primaryAuthFile = () => path.join(Global.Path.data, "auth.json")

async function withCompatAuth<T>(fn: (input: { compatFile: string }) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(process.env["TMPDIR"] ?? "/tmp", "freecode-auth-compat-"))
  const compat = path.join(root, "opencode")
  await fs.mkdir(compat, { recursive: true })
  const beforeCompat = (Global.Path as unknown as { opencodeData: string }).opencodeData
  const beforePrimary = await read(primaryAuthFile()).catch(() => undefined)
  const beforeEnv = process.env["OPENCODE_AUTH_CONTENT"]
  delete process.env["OPENCODE_AUTH_CONTENT"]
  ;(Global.Path as unknown as { opencodeData: string }).opencodeData = compat
  try {
    return await fn({ compatFile: path.join(compat, "auth.json") })
  } finally {
    ;(Global.Path as unknown as { opencodeData: string }).opencodeData = beforeCompat
    if (beforePrimary === undefined) await fs.rm(primaryAuthFile(), { force: true })
    else await fs.writeFile(primaryAuthFile(), beforePrimary)
    if (beforeEnv === undefined) delete process.env["OPENCODE_AUTH_CONTENT"]
    else process.env["OPENCODE_AUTH_CONTENT"] = beforeEnv
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

describe("the fallback rule itself", () => {
  test("FreeCode's credential wins over OpenCode's for the same key", () => {
    const merged = OpenCodeCompat.mergeAuth(
      { deepseek: { type: "api", key: "freecode-key" } },
      { deepseek: { type: "api", key: "opencode-key" }, kimi: { type: "api", key: "opencode-only" } },
    )
    expect(merged["deepseek"]).toEqual({ type: "api", key: "freecode-key" })
    expect(merged["kimi"]).toEqual({ type: "api", key: "opencode-only" })
  })

  test("a clean machine has no OpenCode files to read", async () => {
    await withRoots(async () => {
      expect(OpenCodeCompat.configFiles()).toEqual([])
      expect(OpenCodeCompat.detect().authDetected).toBe(false)
    })
  })

  test("config files are read in merge order, lowest precedence first", async () => {
    await withRoots(async ({ opencode }) => {
      await write(path.join(opencode, "config", "opencode.json"), { username: "a" })
      await write(path.join(opencode, "config", "config.json"), { username: "b" })
      expect(OpenCodeCompat.configFiles()).toEqual([
        path.join(opencode, "config", "config.json"),
        path.join(opencode, "config", "opencode.json"),
      ])
    })
  })

  test("an explicit OPENCODE_CONFIG_DIR suppresses the config fallback", async () => {
    await withRoots(async ({ opencode }) => {
      await write(path.join(opencode, "config", "opencode.json"), { username: "a" })
      process.env["OPENCODE_CONFIG_DIR"] = path.join(opencode, "config")
      expect(OpenCodeCompat.configFallbackEnabled()).toBe(false)
      expect(OpenCodeCompat.configFiles()).toEqual([])
    })
  })
})

describe("global config fallback", () => {
  test("an existing OpenCode global config supplies what FreeCode does not define", async () => {
    await withRoots(async ({ freecode, opencode }) => {
      await write(path.join(opencode, "config", "opencode.json"), { model: "opencode/model", username: "opencode" })
      await write(path.join(freecode, "config", "freecode.jsonc"), { model: "freecode/model" })

      const cfg = await readGlobal()
      // Both halves: FreeCode's value wins where it exists, OpenCode's survives where it does not.
      expect(cfg.model).toBe("freecode/model")
      expect(cfg.username).toBe("opencode")
    })
  })

  test("FreeCode's `opencode.json` also beats the inherited copy of the same file", async () => {
    await withRoots(async ({ freecode, opencode }) => {
      await write(path.join(opencode, "config", "opencode.json"), { model: "opencode/model", username: "opencode" })
      await write(path.join(freecode, "config", "opencode.json"), { model: "freecode/model" })

      const cfg = await readGlobal()
      expect(cfg.model).toBe("freecode/model")
      expect(cfg.username).toBe("opencode")
    })
  })

  test("reading OpenCode's config does not rewrite it (no injected $schema)", async () => {
    await withRoots(async ({ freecode, opencode }) => {
      const inherited = path.join(opencode, "config", "opencode.json")
      const original = JSON.stringify({ model: "opencode/model" })
      await fs.writeFile(inherited, original)
      await write(path.join(freecode, "config", "freecode.jsonc"), { username: "freecode" })

      await readGlobal()
      // A `freecode.jsonc` in FreeCode's own root still gets its `$schema`; the
      // inherited file must come back byte-identical.
      expect(await read(inherited)).toBe(original)
    })
  })

  test("no OpenCode install leaves the global config exactly as it was", async () => {
    await withRoots(async ({ freecode }) => {
      await write(path.join(freecode, "config", "freecode.jsonc"), { model: "freecode/model" })
      const cfg = await readGlobal()
      expect(cfg.model).toBe("freecode/model")
      expect(cfg.username).not.toBe("opencode")
    })
  })

  test("an explicit OPENCODE_CONFIG_DIR turns the fallback off", async () => {
    await withRoots(async ({ freecode, opencode }) => {
      await write(path.join(opencode, "config", "opencode.json"), { username: "opencode" })
      await write(path.join(freecode, "config", "freecode.jsonc"), { model: "freecode/model" })
      process.env["OPENCODE_CONFIG_DIR"] = path.join(freecode, "config")

      const cfg = await readGlobal()
      expect(cfg.username).not.toBe("opencode")
    })
  })
})

describe("credential fallback", () => {
  test("detect reports OpenCode-only entries as in use and shared ones as overridden", async () => {
    await withRoots(async ({ freecode, opencode }) => {
      await write(path.join(freecode, "data", "auth.json"), {
        deepseek: { type: "api", key: "freecode-key" },
      })
      await write(path.join(opencode, "data", "auth.json"), {
        deepseek: { type: "api", key: "opencode-key" },
        kimi: { type: "api", key: "opencode-only" },
      })

      const detection = OpenCodeCompat.detect()
      expect(detection.authDetected).toBe(true)
      expect(detection.authInUse).toEqual(["kimi"])
      expect(detection.authOverridden).toEqual(["deepseek"])
    })
  })

  test("OPENCODE_AUTH_CONTENT means no credential file is consulted", async () => {
    await withRoots(async ({ opencode }) => {
      await write(path.join(opencode, "data", "auth.json"), { kimi: { type: "api", key: "opencode-only" } })
      process.env["OPENCODE_AUTH_CONTENT"] = JSON.stringify({ zhipu: { type: "api", key: "env" } })

      const detection = OpenCodeCompat.detect()
      expect(detection.authDetected).toBe(true)
      expect(detection.authEnabled).toBe(false)
      expect(detection.authInUse).toEqual([])
    })
  })
})

describe("the credential store itself", () => {
  test("Auth.all() serves OpenCode's entries underneath FreeCode's", async () => {
    await withCompatAuth(async ({ compatFile }) => {
      await fs.writeFile(
        compatFile,
        JSON.stringify({
          deepseek: { type: "api", key: "opencode-key" },
          kimi: { type: "api", key: "opencode-only" },
        }),
      )
      await write(primaryAuthFile(), { deepseek: { type: "api", key: "freecode-key" } })

      const all = await authAll()
      // FreeCode's key wins; the provider only OpenCode configured is still served.
      expect(all["deepseek"]).toMatchObject({ key: "freecode-key" })
      expect(all["kimi"]).toMatchObject({ key: "opencode-only" })
    })
  })

  test("set() writes FreeCode's file only, never OpenCode's", async () => {
    await withCompatAuth(async ({ compatFile }) => {
      const original = JSON.stringify({ kimi: { type: "api", key: "opencode-only" } })
      await fs.writeFile(compatFile, original)

      await runAuth(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set("deepseek", { type: "api", key: "freecode-key" })
        }),
      )

      // No copy, no write: the fallback is read-only, so credentials never
      // multiply on disk and OpenCode keeps working untouched.
      expect(await read(compatFile)).toBe(original)
      const stored = JSON.parse(await read(primaryAuthFile())) as Record<string, unknown>
      expect(stored["deepseek"]).toBeDefined()
      expect(stored["kimi"]).toBeUndefined()

      const all = await authAll()
      expect(all["kimi"]).toMatchObject({ key: "opencode-only" })
    })
  })
})

describe("doctor explains the source of an inherited setup", () => {
  const base = { version: "test", workspace: process.cwd(), connectivity: false } as const

  test("nothing detected is a skip, never a failure", async () => {
    const checks = await Doctor.run({
      ...base,
      opencode: {
        configDir: "/nope/.config/opencode",
        configFiles: [],
        configEnabled: true,
        authFile: "/nope/.local/share/opencode/auth.json",
        authDetected: false,
        authEnabled: true,
        authInUse: [],
        authOverridden: [],
      },
    })
    const compat = checks.filter((check) => check.group === "Compatibility")
    expect(compat.map((check) => check.status)).toEqual(["skip", "skip"])
    expect(compat.map((check) => check.name)).toEqual(["opencode config", "opencode credentials"])
  })

  test("detected and in use names the entries", async () => {
    const checks = await Doctor.run({
      ...base,
      opencode: {
        configDir: "/home/u/.config/opencode",
        configFiles: ["/home/u/.config/opencode/opencode.json"],
        configEnabled: true,
        authFile: "/home/u/.local/share/opencode/auth.json",
        authDetected: true,
        authEnabled: true,
        authInUse: ["deepseek", "kimi"],
        authOverridden: ["zhipu"],
      },
    })
    const credentials = checks.find((check) => check.name === "opencode credentials")
    expect(credentials?.status).toBe("ok")
    expect(credentials?.detail).toContain("deepseek, kimi")
    expect(credentials?.detail).toContain("zhipu")
    const config = checks.find((check) => check.name === "opencode config")
    expect(config?.status).toBe("ok")
    expect(config?.detail).toContain("opencode.json")
  })

  test("detected but fully overridden is still a pass, and says so", async () => {
    const checks = await Doctor.run({
      ...base,
      opencode: {
        configDir: "/home/u/.config/opencode",
        configFiles: [],
        configEnabled: true,
        authFile: "/home/u/.local/share/opencode/auth.json",
        authDetected: true,
        authEnabled: true,
        authInUse: [],
        authOverridden: ["deepseek"],
      },
    })
    const credentials = checks.find((check) => check.name === "opencode credentials")
    expect(credentials?.status).toBe("ok")
    expect(credentials?.detail).toContain("already configured in FreeCode")
  })
})

describe("regressions this must not break", () => {
  it.instance(
    "a project's .opencode config is still read",
    () =>
      Effect.gen(function* () {
        const cfg = yield* Config.use.get()
        // The precedence direction itself is pinned in the FREE-31 block below;
        // what must keep holding here is that an OpenCode project file is still
        // picked up at all.
        expect(cfg.username).toBe("opencode-project")
        expect(cfg.model).toBe("freecode/model")
      }),
    {
      git: true,
      init: (dir) =>
        Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.mkdir(path.join(dir, ".freecode"), { recursive: true })
          await write(path.join(dir, ".opencode", "opencode.json"), { username: "opencode-project" })
          await write(path.join(dir, ".freecode", "freecode.jsonc"), { model: "freecode/model" })
        }),
    },
  )
})

/**
 * FREE-31: the project-level merge order had the compatibility rule backwards —
 * `.opencode` beat `.freecode`, while FREE-30 fixed the global level to the
 * opposite direction and `paths.ts` documents "FreeCode file overrides
 * OpenCode file". Both halves of the project-level lookup are pinned here: the
 * filenames inside one directory, and the `.freecode`/`.opencode` directory walk.
 */
describe("a project's FreeCode config beats its OpenCode one", () => {
  it.instance(
    "freecode.jsonc beats opencode.json in the same directory",
    () =>
      Effect.gen(function* () {
        const cfg = yield* Config.use.get()
        expect(cfg.model).toBe("freecode/model")
        expect(cfg.username).toBe("freecode-project")
      }),
    {
      git: true,
      init: (dir) =>
        Effect.promise(async () => {
          await write(path.join(dir, "freecode.jsonc"), { model: "freecode/model", username: "freecode-project" })
          await write(path.join(dir, "opencode.json"), { model: "opencode/model", username: "opencode-project" })
        }),
    },
  )

  it.instance(
    ".freecode/ beats .opencode/ when both exist",
    () =>
      Effect.gen(function* () {
        const cfg = yield* Config.use.get()
        expect(cfg.model).toBe("freecode/model")
        expect(cfg.username).toBe("freecode-project")
      }),
    {
      git: true,
      init: (dir) =>
        Effect.promise(async () => {
          await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
          await fs.mkdir(path.join(dir, ".freecode"), { recursive: true })
          await write(path.join(dir, ".opencode", "opencode.json"), {
            model: "opencode/model",
            username: "opencode-project",
          })
          await write(path.join(dir, ".freecode", "freecode.jsonc"), {
            model: "freecode/model",
            username: "freecode-project",
          })
        }),
    },
  )
})
