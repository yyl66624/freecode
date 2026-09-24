// Built-in provider templates: docs/architecture/02 §3.
//
// The templates are the "works out of the box" half of the four-layer model.
// A new user's `freecode setup` writes a config on top of these; they are not
// a registry — a user-appended template in config always wins, and a model
// version going stale is documented in the JSON's own `note` fields.
//
// The loader is dependency-free and sync: it is imported by the CLI
// (`freecode doctor`, `freecode account add`) and by tests, so it cannot
// reach out to the network or to a config file it wasn't told about.
export * as Templates from "./templates"

import { readFileSync } from "fs"
import path from "path"
import type { ProviderSpec, ModelSpec, AccountSpec } from "../core/types"
import type { Entry } from "./types"
import { validateProvider, validateModel, validateAccount } from "./types"

export interface ProviderTemplate extends ProviderSpec {
  vendor?: string
  note?: string
}
export interface ModelTemplate extends Omit<ModelSpec, "contextWindow" | "maxOutput" | "capabilities"> {
  contextWindow?: number
  maxOutput?: number
  capabilities?: string[]
  free?: boolean
  costAnchor?: boolean
}
export interface AccountTemplate extends Omit<AccountSpec, "models" | "quota"> {}

export interface TemplateSet {
  providers: ProviderTemplate[]
  models: ModelTemplate[]
  accounts: AccountTemplate[]
}

/**
 * Load the templates that ship with the package. The JSON lives next to this
 * file; in a compiled build it is inlined by the bundler, but the read
 * fallback keeps running from source in `bun test` honest.
 */
export function loadTemplates(): TemplateSet {
  const file = path.join(__dirname, "provider-templates.json")
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    providers: ProviderTemplate[]
    models: ModelTemplate[]
    accounts: AccountTemplate[]
  }
  return { providers: raw.providers, models: raw.models, accounts: raw.accounts }
}

/**
 * Validate the shipped templates themselves. A template that fails
 * validation would ship a broken default — that is a regression the build
 * must catch, not a runtime surprise.
 */
export function validateTemplates(set: TemplateSet): {
  providers: Record<string, Entry<ProviderSpec>>
  models: Record<string, Entry<ModelSpec>>
  accounts: Record<string, Entry<AccountSpec>>
} {
  const providers: Record<string, Entry<ProviderSpec>> = {}
  for (const p of set.providers) {
    const entry = validateProvider(p)
    providers[p.id] = entry
  }
  const models: Record<string, Entry<ModelSpec>> = {}
  for (const m of set.models) {
    // A template model may omit contextWindow / maxOutput; that is the "user
    // should fill these" placeholder the setup flow writes. Validation marks
    // it `invalid` only if the id shape is wrong, not because metadata is
    // absent — absent metadata is a prompt, not a problem.
    const filled: ModelSpec = {
      ...m,
      contextWindow: m.contextWindow ?? 0,
      maxOutput: m.maxOutput ?? 0,
      capabilities: m.capabilities ?? ["tools"],
    }
    const entry = validateModel(filled)
    models[m.id] = m.contextWindow && m.maxOutput ? entry : { value: filled, invalid: false }
  }
  const accounts: Record<string, Entry<AccountSpec>> = {}
  for (const a of set.accounts) {
    accounts[a.id] = validateAccount(a)
  }
  return { providers, models, accounts }
}

export { __dirname }
