export * as OpenCodeCompat from "./opencode-compat"

import path from "path"
import { existsSync, readFileSync } from "fs"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"

/**
 * Read-only compatibility with an existing OpenCode installation (FREE-30).
 *
 * FreeCode rebrands every XDG root (`~/.config/freecode`, `~/.local/share/freecode`),
 * which is why a machine that already ran OpenCode would otherwise look empty on
 * first start: its global config and its `auth.json` credentials sit under the
 * `opencode` roots. FreeCode therefore reads those roots as a *lowest-precedence*
 * fallback and never writes to them. Migration is by reading, not by copying, so
 * credentials are not duplicated on disk and OpenCode keeps working unchanged.
 *
 * Precedence always runs FreeCode-over-OpenCode, exactly like the project-level
 * `.freecode` / `.opencode` compatibility this mirrors.
 */

/** Global config files OpenCode itself writes, in the order FreeCode merges them. */
export const configFileNames = ["config.json", "opencode.json", "opencode.jsonc"] as const

/** OpenCode's global config root (`~/.config/opencode`). */
export function configDir() {
  return Global.Path.opencodeConfig
}

/** OpenCode's data root (`~/.local/share/opencode`). */
export function dataDir() {
  return Global.Path.opencodeData
}

/** OpenCode's credential store (`~/.local/share/opencode/auth.json`). */
export function authFile() {
  return path.join(dataDir(), "auth.json")
}

/**
 * Whether FreeCode reads OpenCode's global config root.
 *
 * `OPENCODE_CONFIG_DIR` names the one config directory the user wants read;
 * appending OpenCode's root on top would silently ignore that instruction.
 */
export function configFallbackEnabled() {
  return !Flag.OPENCODE_CONFIG_DIR
}

/** Existing OpenCode global config files, in the order FreeCode merges them. */
export function configFiles() {
  if (!configFallbackEnabled()) return []
  return configFileNames.map((name) => path.join(configDir(), name)).filter((file) => existsSync(file))
}

/**
 * Overlay OpenCode's credentials under FreeCode's, per key.
 *
 * FreeCode's own entry always wins; OpenCode only supplies keys FreeCode does not
 * define. Pure, so `Auth` and `doctor` resolve the question the same way and a
 * test can pin the rule without touching the filesystem.
 */
export function mergeAuth(own: Record<string, unknown>, opencode: Record<string, unknown>) {
  return { ...opencode, ...own }
}

/** A credential entry, as opposed to an arbitrary JSON value. */
function entryKeys(data: Record<string, unknown>) {
  return Object.entries(data)
    .filter(([, value]) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false
      return typeof (value as { type?: unknown }).type === "string"
    })
    .map(([key]) => key)
}

function readObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // A missing, unreadable or malformed fallback simply means "nothing to
    // migrate"; it must never turn into a startup failure.
  }
  return {}
}

export interface Detection {
  /** OpenCode's global config root, and the files FreeCode would read from it. */
  configDir: string
  configFiles: string[]
  /** False when an explicit `OPENCODE_CONFIG_DIR` suppresses the config fallback. */
  configEnabled: boolean
  /** OpenCode's credential file and whether it exists. */
  authFile: string
  authDetected: boolean
  /** False when `OPENCODE_AUTH_CONTENT` makes FreeCode ignore credential files. */
  authEnabled: boolean
  /** Credential entries only OpenCode defines — the ones actually in use. */
  authInUse: string[]
  /** Credential entries both define; FreeCode's copy wins. */
  authOverridden: string[]
}

/**
 * What OpenCode left on this machine, and how much of it FreeCode is using.
 *
 * `doctor` renders this verbatim, so it reports concrete paths and concrete keys
 * rather than a verdict: "detected" and "in use" are separate facts, and a user
 * debugging a missing provider needs both.
 */
export function detect(): Detection {
  // Read the files directly rather than going through `Auth`: this must answer
  // even when auth resolution itself is the thing that is broken.
  const own = readObject(path.join(Global.Path.data, "auth.json"))
  const inherited = readObject(authFile())
  const ownKeys = new Set(entryKeys(own))
  const inheritedKeys = entryKeys(inherited)
  const authEnabled = !process.env["OPENCODE_AUTH_CONTENT"]
  return {
    configDir: configDir(),
    configFiles: configFiles(),
    configEnabled: configFallbackEnabled(),
    authFile: authFile(),
    authDetected: existsSync(authFile()),
    authEnabled,
    authInUse: authEnabled ? inheritedKeys.filter((key) => !ownKeys.has(key)) : [],
    authOverridden: authEnabled ? inheritedKeys.filter((key) => ownKeys.has(key)) : [],
  }
}
