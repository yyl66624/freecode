// ResourceStore: the registration registry the four layers report into,
// docs/architecture/02 §7.
//
// The design constraint, quoted from the issue: "Provider/Model/Account
// modules don't import each other, they register into a shared
// `ResourceStore`." The store is the shared surface. It does not import
// from provider/, model/, or account/ code — those modules call into
// it, and it owns the view of what is currently registered.
//
// The scheduler consumes a snapshot of the store; a mutation to the store
// during a scoring pass does not affect the in-progress pick, which keeps
// the resolver's audit log replayable (docs 03 §4.3).
export * as ResourceStore from "./store"

import type { ProviderSpec, ModelSpec, AccountSpec, CapabilityTier } from "../core/types"
import { validateProvider, validateModel, validateAccount, type Entry } from "./types"

export interface RegisteredResources {
  providers: Record<string, Entry<ProviderSpec>>
  models: Record<string, Entry<ModelSpec>>
  accounts: Record<string, Entry<AccountSpec>>
  /** Pool by tier, what the scheduler actually uses. */
  pool: Record<string, string[]>
}

export interface Store {
  /** Read a snapshot of the currently-registered resources. */
  snapshot(): RegisteredResources
  /**
   * Register or replace a single provider spec.
   * Invalid specs land with an `invalid` marker (isolation, docs 02 §6)
   * and never block other registrations.
   */
  registerProvider(id: string, spec: ProviderSpec): void
  registerModel(id: string, spec: ModelSpec): void
  registerAccount(id: string, spec: AccountSpec): void
  /** Set the pool for one tier. A pool entry that names an unregistered
   *  (model, account) is tolerated; the scheduler's hard filter handles it. */
  setPool(tier: CapabilityTier | (string & {}), entries: readonly string[]): void
  /** Drop a single entry. Called by the CLI's `freecode account disable`. */
  removeProvider(id: string): void
  removeModel(id: string): void
  removeAccount(id: string): void
  /**
   * The credential resolver the scheduler uses. The store owns the
   * registration point; the lookup is provided by the environment
   * (env vars, keychain helper, file path) so the store itself stays
   * storage-agnostic.
   */
  setCredentialLookup(lookup: (ref: { scheme: "env" | "keychain" | "file"; name: string }) => string | undefined): void
  resolveCredential(ref: string): string | undefined
}

export function makeStore(): Store {
  const providers: Record<string, Entry<ProviderSpec>> = {}
  const models: Record<string, Entry<ModelSpec>> = {}
  const accounts: Record<string, Entry<AccountSpec>> = {}
  const pool: Record<string, string[]> = {}
  let credentialLookup: (ref: { scheme: "env" | "keychain" | "file"; name: string }) => string | undefined = () => undefined

  return {
    snapshot() {
      // structuredClone keeps the caller from mutating the live store;
      // the shape is all scalars and arrays so a deep copy is cheap.
      return structuredClone({ providers, models, accounts, pool })
    },
    registerProvider(id, spec) {
      providers[id] = validateProvider(spec)
    },
    registerModel(id, spec) {
      models[id] = validateModel(spec)
    },
    registerAccount(id, spec) {
      accounts[id] = validateAccount(spec)
    },
    setPool(tier, entries) {
      pool[tier] = [...entries]
    },
    removeProvider(id) {
      delete providers[id]
    },
    removeModel(id) {
      delete models[id]
    },
    removeAccount(id) {
      delete accounts[id]
    },
    setCredentialLookup(lookup) {
      credentialLookup = lookup
    },
    resolveCredential(ref) {
      const parsed = parseRef(ref)
      return parsed ? credentialLookup(parsed) : undefined
    },
  }
}

// Local copy of the reference grammar so the store doesn't depend on
// types.ts's exported parseCredentialRef (which is a pure function, so
// this would also be safe, but the local version keeps the dependency
// direction one-way: the store owns its own parsing, not a shared helper).
function parseRef(credential: string): { scheme: "env" | "keychain" | "file"; name: string } | undefined {
  const idx = credential.indexOf(":")
  if (idx <= 1) return undefined
  const scheme = credential.slice(0, idx)
  if (scheme !== "env" && scheme !== "keychain" && scheme !== "file") return undefined
  const name = credential.slice(idx + 1)
  if (name.length === 0) return undefined
  return { scheme: scheme as "env" | "keychain" | "file", name }
}
