export * as Doctor from "./doctor"

import path from "path"
import { existsSync } from "fs"
import { $ } from "bun"
import { Global } from "@opencode-ai/core/global"
import { bridgeDirectories } from "./router/client"
import { Worktree } from "./worktree"
import { ResourceState, load, promote } from "./state"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

/**
 * Environment checks, in one command.
 *
 * The purpose is narrow and specific: when someone reports "FreeCode will not
 * start", the answer should be a paste of one command rather than a conversation.
 * Every check therefore reports a concrete value it observed, not a verdict — a
 * failure that says which path was searched is diagnosable; one that says
 * "router unavailable" is not.
 *
 * Checks never throw. A doctor that fails to run when something is broken is
 * useless precisely when it is needed.
 */

export type Status = "ok" | "warn" | "fail" | "skip"

export interface Check {
  /** Group the check belongs to, used for the report layout. */
  group: string
  name: string
  status: Status
  /** What was observed. Always concrete. */
  detail: string
  /** What to do about it, when there is something to do. */
  remedy?: string
}

export interface Input {
  /** FreeCode's release version. */
  version: string
  /** The upstream OpenCode base, so a bug report identifies the fork point too. */
  upstream?: string
  /** Project the user is in. */
  workspace: string
  config?: ConfigV1.Info
  /** Names of configured provider ids, for the providers group. */
  providers?: string[]
}

export async function run(input: Input): Promise<Check[]> {
  const checks: Check[] = []
  const add = (check: Check) => checks.push(check)

  // --- core -------------------------------------------------------------------

  add({
    group: "Core",
    name: "binary",
    status: "ok",
    // Both versions: the product one identifies the release, the upstream one makes
    // a rebase reproducible from a bug report alone.
    detail: `${input.version}${input.upstream ? ` (upstream ${input.upstream})` : ""} at ${process.execPath}`,
  })

  const platform = `${process.platform}-${process.arch}`
  add({
    group: "Core",
    name: "platform",
    status: process.platform === "darwin" && process.arch === "arm64" ? "ok" : "warn",
    detail: platform,
    remedy:
      process.platform === "darwin" && process.arch === "arm64"
        ? undefined
        : "FreeCode v0.4 ships darwin-arm64 only; other platforms are untested rather than expected to fail",
  })

  add({
    group: "Core",
    name: "config",
    status: existsSync(Global.Path.config) ? "ok" : "warn",
    detail: Global.Path.config,
    remedy: existsSync(Global.Path.config)
      ? undefined
      : "Run `freecode setup` to create a starter config, or point FREECODE_CONFIG_DIR at one",
  })

  add({
    group: "Core",
    name: "data",
    status: "ok",
    detail: Global.Path.data,
  })

  const workspace = input.workspace
  add({
    group: "Core",
    name: "workspace",
    status: existsSync(workspace) ? "ok" : "fail",
    detail: workspace,
  })

  const git = await version("git", ["--version"])
  add({
    group: "Core",
    name: "git",
    status: git ? "ok" : "warn",
    detail: git ?? "not found on PATH",
    remedy: git ? undefined : "Install git; isolation and task merging need it",
  })

  // --- router -----------------------------------------------------------------

  add({
    group: "Router",
    name: "rules",
    status: "ok",
    // The rules path has no dependencies, which is exactly why Laya is optional.
    detail: "always available",
  })

  const bridge = findBridge()
  if (!bridge) {
    const searched = bridgeDirectories()
    add({
      group: "Router",
      name: "laya",
      status: "warn",
      detail: `bridge not found; searched ${searched.length} locations`,
      remedy: "Optional. Run `freecode setup` to prepare it, or ignore this: routing works on rules alone",
    })
    for (const directory of searched) {
      add({ group: "Router", name: "searched", status: "skip", detail: directory })
    }
  } else {
    add({ group: "Router", name: "laya", status: "ok", detail: `bridge at ${bridge}` })

    const python = process.env["FREECODE_PYTHON"] ?? "python3"
    const pythonVersion = await version(python, ["--version"])
    add({
      group: "Router",
      name: "python",
      status: pythonVersion ? "ok" : "warn",
      detail: pythonVersion ? `${pythonVersion} (${python})` : `${python} not runnable`,
    })

    const warmed = warmCheck(bridge)
    add({
      group: "Router",
      name: "model cache",
      status: warmed ? "ok" : "warn",
      detail: warmed ?? "no checkpoint cached yet",
      remedy: warmed ? undefined : "The first routed task downloads it; no action needed",
    })
  }

  // --- providers --------------------------------------------------------------

  const pool = input.config?.freecode?.pool ?? {}
  const configured = Object.entries(pool).filter(([, models]) => Array.isArray(models) && models.length > 0)
  add({
    group: "Providers",
    name: "pool",
    status: configured.length ? "ok" : "fail",
    detail: configured.length
      ? configured.map(([tier, models]) => `${tier}: ${models!.length}`).join(", ")
      : "no tier has any model",
    remedy: configured.length
      ? undefined
      : "Add a provider and a freecode.pool to freecode.jsonc. `freecode setup` can do it",
  })

  const providers = input.providers ?? []
  add({
    group: "Providers",
    name: "configured",
    status: providers.length ? "ok" : "warn",
    detail: providers.length ? providers.join(", ") : "none",
  })

  // Observed health is the part users ask about, and it is already recorded.
  const snapshot = promote(load())
  const observed = Object.entries(snapshot.resources)
  if (observed.length === 0) {
    add({
      group: "Providers",
      name: "health",
      status: "skip",
      detail: "nothing observed yet; health appears after the first task",
    })
  } else {
    for (const [id, state] of observed) {
      const reason = ResourceState.exclusionReason(state)
      add({
        group: "Providers",
        name: id,
        status: reason ? "warn" : state.health === "available" ? "ok" : "warn",
        detail: reason ?? `${state.health}, ${state.successes}/${state.attempts} ok`,
      })
    }
  }

  // --- isolation --------------------------------------------------------------

  const isRepo = await Worktree.available(workspace)
  add({
    group: "Isolation",
    name: "git repository",
    status: isRepo ? "ok" : "warn",
    detail: isRepo ? "yes" : "no",
    remedy: isRepo ? undefined : "Writing subagents will share the checkout instead of using worktrees",
  })

  if (isRepo) {
    const scratch = path.join(workspace, ".freecode", "worktrees")
    const writable = await canWrite(workspace)
    add({
      group: "Isolation",
      name: "worktree support",
      status: writable ? "ok" : "warn",
      detail: writable ? `worktrees under ${scratch}` : `${workspace} is not writable`,
    })

    const existing = await Worktree.list(workspace)
    add({
      group: "Isolation",
      name: "tasks in flight",
      status: existing.length ? "warn" : "ok",
      detail: existing.length ? `${existing.length} isolated task(s); see \`freecode tasks\`` : "none",
    })
  }

  // --- filesystem -------------------------------------------------------------

  const writableData = await canWrite(Global.Path.data)
  add({
    group: "Filesystem",
    name: "data writable",
    status: writableData ? "ok" : "fail",
    detail: Global.Path.data,
    remedy: writableData ? undefined : "FreeCode cannot record resource health or routing decisions",
  })

  const writableHome = await canWrite(workspace)
  add({
    group: "Filesystem",
    name: "workspace writable",
    status: writableHome ? "ok" : "warn",
    detail: workspace,
  })

  return checks
}

function findBridge(): string | undefined {
  for (const directory of bridgeDirectories()) {
    if (existsSync(path.join(directory, "main.py"))) return directory
  }
  return undefined
}

/**
 * Whether a Laya checkpoint is already on disk.
 *
 * Reports the cache directory rather than running the bridge: the doctor must be
 * fast and must not load a model to answer a question about a file.
 */
function warmCheck(bridge: string): string | undefined {
  const cache =
    process.env["FREECODE_LAYA_CACHE"] ?? path.join(Global.Path.data, "laya-cache")
  const hub = path.join(cache, "hub")
  if (!existsSync(cache)) return undefined
  return existsSync(hub) ? `checkpoints cached under ${cache}` : `cache directory ${cache} is empty`
}

async function version(command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await $`${command} ${args}`.quiet().nothrow()
    if (result.exitCode !== 0) return undefined
    return (result.stdout.toString() + result.stderr.toString()).trim().split("\n")[0] || undefined
  } catch {
    return undefined
  }
}

async function canWrite(directory: string): Promise<boolean> {
  try {
    const probe = path.join(directory, `.freecode-write-probe-${process.pid}`)
    await Bun.write(probe, "")
    const { rmSync } = await import("fs")
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

const GLYPH: Record<Status, string> = {
  ok: "✓",
  warn: "!",
  fail: "×",
  skip: "·",
}

/**
 * Render the report.
 *
 * A failing check is never buried: the summary names every failure and every
 * actionable warning, because a doctor whose output has to be read line by line
 * is no faster than asking a human.
 */
export function render(checks: Check[]): { text: string; failures: number; warnings: number } {
  const lines: string[] = ["FreeCode Doctor", ""]
  let group = ""
  for (const check of checks) {
    if (check.group !== group) {
      group = check.group
      lines.push(group)
    }
    lines.push(`  ${GLYPH[check.status]} ${check.name.padEnd(20)} ${check.detail}`)
    if (check.remedy && check.status !== "ok") lines.push(`      ${check.remedy}`)
  }

  const failures = checks.filter((check) => check.status === "fail")
  const warnings = checks.filter((check) => check.status === "warn" && check.remedy)

  lines.push("")
  if (failures.length === 0 && warnings.length === 0) {
    lines.push("Everything FreeCode needs is present.")
  } else {
    if (failures.length) {
      lines.push(`${failures.length} problem(s) must be fixed:`)
      for (const check of failures) lines.push(`  × ${check.group} / ${check.name}: ${check.detail}`)
    }
    if (warnings.length) {
      lines.push(`${warnings.length} warning(s):`)
      for (const check of warnings) lines.push(`  ! ${check.group} / ${check.name}: ${check.detail}`)
    }
    if (failures.length === 0) lines.push("FreeCode is usable.")
  }

  return { text: lines.join("\n"), failures: failures.length, warnings: warnings.length }
}
