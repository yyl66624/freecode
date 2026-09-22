export * as Setup from "./setup"

import path from "path"
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from "fs"
import os from "os"

/**
 * First-run setup: turn a machine with no configuration into one that can run a
 * task.
 *
 * The goal is that `freecode` never greets a new user with a configuration error.
 * Everything this writes is something the user could have written by hand and can
 * edit afterwards; nothing here is a hidden registry.
 *
 * **Secrets never go in the configuration file.** The key is written to
 * `~/.freecode/secrets.env` with mode 600 and referenced from config as
 * `{file:...}`, because a config file gets committed, pasted into issues and
 * synced between machines, and a secret in one is a secret everywhere. The
 * `{env:VAR}` form is offered for users who would rather keep it in their shell
 * environment, which is what an existing OpenCode setup already does.
 */

export interface ProviderTemplate {
  /** Shown in the menu. */
  label: string
  /** npm provider package, for OpenAI-compatible style endpoints. */
  npm: string
  /** Default base URL, if the provider has one. */
  baseURL?: string
  /** Prefilled model ids, so a user can accept the defaults. */
  models: string[]
  /** Environment variable an existing setup would already use. */
  env?: string
  /** Whether this needs an API key at all. */
  needsKey: boolean
  /** Note shown under the choice. */
  note?: string
}

/**
 * The providers a new user is most likely to have.
 *
 * Deliberately short. A list of thirty is a worse first-run experience than six,
 * and every one of these is OpenAI-compatible or trivially so, which keeps setup
 * to one code path. `Custom` covers everything else.
 */
export const TEMPLATES: ProviderTemplate[] = [
  {
    label: "OpenAI Compatible",
    note: "DeepSeek, Kimi, MiniMax, vLLM, Ollama and most others expose this API",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-v4-pro"],
    env: "DEEPSEEK_API_KEY",
    needsKey: true,
  },
  {
    label: "OpenAI",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-5"],
    env: "OPENAI_API_KEY",
    needsKey: true,
  },
  {
    label: "Anthropic",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4"],
    env: "ANTHROPIC_API_KEY",
    needsKey: true,
  },
  {
    label: "Local (Ollama)",
    note: "no API key; needs Ollama running",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5-coder"],
    needsKey: false,
  },
  {
    label: "Custom",
    note: "any OpenAI-compatible endpoint, including self-hosted gateways",
    npm: "@ai-sdk/openai-compatible",
    models: [],
    needsKey: true,
  },
]

/** Where the generated secret file lives. */
export function secretsPath(home = process.env["FREECODE_HOME"] ?? path.join(os.homedir(), ".freecode")) {
  return path.join(home, "secrets.env")
}

/**
 * Write a key to the secret file and return the `{file:...}` reference to use in
 * config.
 *
 * Appends rather than overwrites, so setting up a second provider does not silently
 * discard the first provider's key.
 */
export function writeSecret(variable: string, value: string, home?: string): string {
  const file = secretsPath(home)
  mkdirSync(path.dirname(file), { recursive: true })

  const existing = existsSync(file) ? readFileSync(file, "utf8") : ""
  const lines = existing
    .split("\n")
    .filter((line) => line.trim())
    // Matched on the assignment form, not a bare prefix: the file writes
    // `export VAR=...`, so a check for `VAR=` would never match and rotating a key
    // would leave the old one in the file alongside the new one.
    .filter((line) => !new RegExp(`^\\s*(export\\s+)?${variable}\\s*=`).test(line))

  lines.push(`export ${variable}=${value}`)
  writeFileSync(file, lines.join("\n") + "\n")
  // 600 unconditionally: an existing file may have been created with a looser mode,
  // and a secret file's permissions should not depend on its history.
  chmodSync(file, 0o600)

  return `{file:${file}}`
}

export interface Draft {
  /** Provider id, which is also the account name. */
  id: string
  npm: string
  name: string
  baseURL?: string
  /** Either `{file:...}`, `{env:VAR}`, or a literal key. */
  apiKey?: string
  models: string[]
  /** Tier to place the models in. */
  tier: string
}

/**
 * The config patch for a draft.
 *
 * Pure, so what setup writes is testable without touching a config file. The pool
 * is filled at every tier from `local` upward to `strong` because a new user has
 * one model and every tier must resolve to something; over-provisioning a single
 * model costs nothing, while an empty tier means routing silently falls back.
 */
export function draftToConfig(draft: Draft) {
  const entry: Record<string, unknown> = {
    npm: draft.npm,
    name: draft.name,
    models: Object.fromEntries(draft.models.map((id) => [id, { name: id }])),
  }
  if (draft.baseURL) entry.options = { baseURL: draft.baseURL, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) }
  else if (draft.apiKey) entry.options = { apiKey: draft.apiKey }

  const models = draft.models.map((id) => `${draft.id}/${id}`)
  const tiers = ["local", "fast", "standard", "strong", "max"]
  const pool: Record<string, string[]> = {}
  const start = Math.max(0, tiers.indexOf(draft.tier))
  for (const tier of tiers) {
    // Everything at and above the declared floor, so nothing routes to an empty
    // tier. Below it stays empty: a cheaper model is not implied by a strong one.
    pool[tier] = tiers.indexOf(tier) >= start ? models : []
  }

  return {
    provider: { [draft.id]: entry },
    freecode: { pool },
  }
}

/**
 * Validate a draft before anything is written.
 *
 * Returns messages rather than throwing, so an interactive caller can re-ask
 * instead of dying, and a non-interactive caller can print all problems at once.
 */
export function validate(draft: Draft): string[] {
  const problems: string[] = []
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(draft.id)) {
    problems.push(`provider name ${JSON.stringify(draft.id)} must start with a letter or digit and contain only letters, digits, dot, dash or underscore`)
  }
  if (!draft.npm) problems.push("npm package is required")
  if (!draft.models.length) problems.push("at least one model id is required")
  if (draft.baseURL && !/^https?:\/\//.test(draft.baseURL)) {
    problems.push(`base URL ${JSON.stringify(draft.baseURL)} must start with http:// or https://`)
  }
  if (draft.models.some((id) => id.includes("/"))) {
    // The pool is built as `<provider>/<model>`, so a slash in the model id would
    // produce an id FreeCode cannot resolve.
    problems.push("model ids must not contain '/'")
  }
  return problems
}
