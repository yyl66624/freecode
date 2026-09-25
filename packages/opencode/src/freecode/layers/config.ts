// Configuration layer: loading, merging, and isolation, docs/architecture/02 §6
// and ADR-005.
//
// Layout:
//   user-level   ~/.freecode/config.json          (global defaults, template overrides)
//   project-level <project>/.freecode/config.json  (whitelist, budget ceilings)
//
// Merge rules, docs 02 §6:
//   - project overrides user, field-level deep merge;
//   - accounts[] merge by id: project can disable a user-level account;
//   - credentials NEVER appear in config.json as plaintext: Account.credential
//     is a reference (env:/keychain:/file:) resolved at runtime, so a project
//     config is safe to commit to git;
//   - every layer object is schema-validated on load; an invalid entry is
//     quarantined with an `invalid` marker and never blocks startup.
export * as Config from "./config"

import { readFileSync, existsSync, statSync } from "fs"
import path from "path"
import type { ProviderSpec, ModelSpec, AccountSpec } from "../core/types"
import {
  parseCredentialRef,
  resolveCredential,
  validateAgent,
  validateProvider,
  validateModel,
  validateAccount,
  type AgentSpec,
  type Entry,
} from "./types"

/** What a config file may contain. The pool is scheduler-facing; the four
 *  layers are the resource declarations this module owns. */
export interface RawConfig {
  provider?: Record<string, unknown>
  providers?: Record<string, unknown>
  models?: unknown[]
  accounts?: unknown[]
  agents?: unknown[]
  pool?: Record<string, string[] | undefined>
  [key: string]: unknown
}

export interface MergedConfig {
  providers: Record<string, Entry<ProviderSpec>>
  models: Record<string, Entry<ModelSpec>>
  accounts: Record<string, Entry<AccountSpec>>
  agents: Record<string, Entry<AgentSpec>>
  pool: Record<string, string[]>
}

/** A loader input: parsed content plus where it came from (for error paths). */
export interface ConfigSource {
  label: string
  data: RawConfig
}

/**
 * Parse + validate + isolate one config file's worth of data.
 *
 * Nothing throws here: a malformed file must not stop FreeCode from starting
 * (docs 02 §6 "不阻断启动"). Every problem lands in the entry's `issues`.
 */
export function load(source: ConfigSource): MergedConfig {
  const providers: MergedConfig["providers"] = {}
  // Accept both `provider` (legacy, OpenCode's config key) and `providers` (this module's key).
  for (const [id, raw] of Object.entries({ ...source.data.provider, ...source.data.providers })) {
    const entry = validateProvider(withProviderId(raw, id))
    providers[id] = entry
  }

  const models: MergedConfig["models"] = {}
  for (const raw of source.data.models ?? []) {
    const entry = validateModel(raw)
    const id = (entry.value as ModelSpec | undefined)?.id ?? `unknown#${Object.keys(models).length}`
    models[id] = entry
  }

  const accounts: MergedConfig["accounts"] = {}
  for (const raw of source.data.accounts ?? []) {
    const entry = validateAccount(raw)
    const id = (entry.value as AccountSpec | undefined)?.id ?? `unknown#${Object.keys(accounts).length}`
    accounts[id] = entry
  }

  const agents: MergedConfig["agents"] = {}
  for (const raw of source.data.agents ?? []) {
    const entry = validateAgent(raw)
    const id = (entry.value as AgentSpec | undefined)?.id ?? `unknown#${Object.keys(agents).length}`
    agents[id] = entry
  }

  return {
    providers,
    models,
    accounts,
    agents,
    pool: normalizePool(source.data.pool),
  }
}

/**
 * The merge, docs 02 §6: project over user, field-level; accounts by id.
 *
 * `override` (project) wins field-by-field over `base` (user) for scalars;
 * arrays and objects replace; lists merge by id and the override side can
 * disable a base entry (`enabled: false`).
 */
export function merge(base: MergedConfig, override: MergedConfig): MergedConfig {
  const merged: MergedConfig = structuredClone(base)

  for (const [id, entry] of Object.entries(override.providers)) {
    const target: Entry<ProviderSpec> = entry.invalid ? entry : { value: withProviderId(entry.value, id) as ProviderSpec, invalid: false }
    merged.providers[id] = target
  }
  for (const [id, entry] of Object.entries(override.models)) merged.models[id] = entry
  for (const [id, entry] of Object.entries(override.accounts)) merged.accounts[id] = entry
  for (const [id, entry] of Object.entries(override.agents)) merged.agents[id] = entry

  // pool: per-tier replace, override wins when it names the tier at all.
  merged.pool = { ...base.pool, ...override.pool }

  // accounts merge by id: the override side can disable a user-level account
  // without deleting it from disk.
  for (const [id, baseEntry] of Object.entries(base.accounts)) {
    const overrideEntry = merged.accounts[id]
    if (overrideEntry && baseEntry.value && overrideEntry.value && !baseEntry.invalid && !overrideEntry.invalid) {
      const combined: AccountSpec = { ...baseEntry.value, ...overrideEntry.value }
      merged.accounts[id] = { value: combined, invalid: false }
    }
  }

  return merged
}

/** Load from disk: user-level then project-level, in that order. */
export function loadFiles(userPath?: string, projectPath?: string): {
  config: MergedConfig
  issues: string[]
} {
  const issues: string[] = []
  const sources: ConfigSource[] = []
  for (const [label, p] of [["user", userPath], ["project", projectPath]] as const) {
    if (!p) continue
    const parsed = readJsonc(p, issues)
    if (parsed === undefined) continue
    sources.push({ label, data: parsed as RawConfig })
  }
  if (sources.length === 0) return { config: emptyConfig(), issues }
  const [first, ...rest] = sources
  let config = load(first)
  for (const s of rest) config = merge(config, load(s))
  return { config, issues }
}

export function emptyConfig(): MergedConfig {
  return { providers: {}, models: {}, accounts: {}, agents: {}, pool: {} }
}

/**
 * Read a .json or .jsonc config file. jsonc is just JSON with // and #
 * comments and trailing commas; strip those without a parser round-trip,
 * since config is user data and we want stable error paths.
 */
function readJsonc(file: string, issues: string[]): unknown {
  if (!existsSync(file)) {
    issues.push(`config file not found: ${file}`)
    return undefined
  }
  const raw = readFileSync(file, "utf8")
  try {
    const stripped = stripJsonc(raw)
    return JSON.parse(stripped)
  } catch (e) {
    issues.push(`config ${file}: ${String(e)}`)
    return undefined
  }
}

function stripJsonc(text: string): string {
  // A comment starts at // or # outside a string literal. We walk the text
  // once tracking in-string state; a JSON config never has // or # inside a
  // string in practice (ids and paths use /, not //), so a small state
  // machine is enough and keeps the function dependency-free.
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += text[++i] ?? ""
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "#" || (ch === "/" && text[i + 1] === "/")) {
      // Strip to end of line but keep the newline so offsets stay stable.
      while (i < text.length && text[i]! !== "\n") i++
      continue
    }
    out += ch
  }
  // Trailing commas: JSON.parse rejects ,} or ,] — drop the comma when the
  // next non-whitespace character is } or ]
  let result = ""
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!
    if (ch === ",") {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j]!)) j++
      if (out[j] === "}" || out[j] === "]") continue
    }
    result += ch
  }
  return result
}

function withProviderId(raw: unknown, id: string): unknown {
  const obj = (raw ?? {}) as Record<string, unknown>
  return { ...obj, id: (obj.id as string) ?? id }
}

function normalizePool(pool: RawConfig["pool"]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!pool) return out
  for (const [tier, entries] of Object.entries(pool)) {
    out[tier] = Array.isArray(entries) ? entries.filter((e): e is string => typeof e === "string") : []
  }
  return out
}

/**
 * The isolation contract, docs 02 §6: given a merged config, the usable
 * resources are the ones whose entry is not `invalid`. Invalid entries stay
 * in the structure (so `freecode doctor` can show them) but are filtered
 * out of any pool or scheduler candidate set.
 */
export function validEntries<T>(entries: Record<string, Entry<T>>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [id, entry] of Object.entries(entries)) if (!entry.invalid) out[id] = entry.value as T
  return out
}

export function invalidEntries<T>(entries: Record<string, Entry<T>>): Record<string, Entry<T>> {
  const out: Record<string, Entry<T>> = {}
  for (const [id, entry] of Object.entries(entries)) if (entry.invalid) out[id] = entry
  return out
}

/**
 * Resolve every account's credential reference against a lookup that
 * implements the ADR-005 priority. Accounts whose reference cannot be
 * resolved get an empty-string credential with a marker — the caller
 * decides the downstream state (INVALID on 401/403 per docs 03 §4.1).
 */
export function resolveAllCredentials(
  accounts: Record<string, Entry<AccountSpec>>,
  lookup: (ref: ReturnType<typeof parseCredentialRef>) => string | undefined,
): Map<string, { value: string | undefined; problem?: string }> {
  const out = new Map<string, { value: string | undefined; problem?: string }>()
  for (const [id, entry] of Object.entries(accounts)) {
    if (entry.invalid) {
      out.set(id, { value: undefined, problem: entry.issues.join("; ") })
      continue
    }
    const value = resolveCredential(entry.value.credential, lookup)
    out.set(id, value === undefined ? { value: undefined, problem: `credential ${entry.value.credential} unresolved` } : { value })
  }
  return out
}

/**
 * The reference form FreeCode writes to a config patch: it never inlines the
 * key itself. This is the shape `freecode account add` (cli-dev, FREE-3) and
 * `freecode setup` (setup.ts) write.
 */
export function credentialRef(scheme: "env" | "keychain" | "file", name: string): string {
  return `${scheme}:${name}`
}

/**
 * The plaintext gate, ADR-005: a credential value that is not one of the
 * three reference forms is rejected. This is what stops a hand-written
 * config from silently putting a real key on disk — the user gets a named
 * error, not a working config that leaks.
 */
export function isPlaintextCredential(credential: string): boolean {
  return parseCredentialRef(credential) === undefined
}

export type { AgentSpec }
export { parseCredentialRef, resolveCredential, validateAgent, validateProvider, validateModel, validateAccount }
