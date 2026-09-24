// Four-layer data model, docs/architecture/02-four-layer-model.md §2.
//
// The authoritative shapes live in ../core/types.ts (CapabilityTier, ProviderSpec,
// ModelSpec, AccountSpec, ResourceBinding), which the scheduler consumes. This
// module owns:
//   - AgentSpec, the fourth layer the scheduler core does not need (an agent is
//     a task description, not a scheduling input — the resolver only receives a
//     CapabilityTier + requiredFeatures, never the spec that produced it);
//   - a validation entry point over the other three specs;
//   - the "invalid" marker and its isolation rule (docs 02 §6: a bad entry is
//     quarantined, it never blocks startup, and never participates in routing).
//
// Dependency direction, docs 02 §7: Agent code must reference only
// CapabilityTier (and, for resolving, ResolveRequest). This file must not
// import provider/model/account implementations — it owns the shared tier type
// and the spec shapes, nothing more. The lint rule FREE-15 ships (the
// import-whitelist check) enforces this.
export * as Layers from "./types"

import type {
  AccountSpec,
  CapabilityTier,
  ModelSpec,
  ProviderSpec,
} from "../core/types"

export type { AccountSpec, CapabilityTier, ModelSpec, ProviderSpec }

export const CAPABILITY_TIERS = ["light", "standard", "deep", "expert"] as const
export const MODEL_CAPABILITIES = [
  "tools",
  "json",
  "streaming",
  "reasoning",
  "vision",
  "long-context",
] as const
export const PROVIDER_PROTOCOLS = ["openai-chat", "openai-responses", "local-http"] as const
export const CREDENTIAL_SCHEMES = ["env", "keychain", "file"] as const

/** Task role, docs 02 §2.1. */
export interface AgentSpec {
  id: string
  systemPrompt: string | { file: string }
  tools?: string[]
  /** Declared requirement tier; the scheduler maps it to (model, account). */
  capability: CapabilityTier
  subagents?: string[]
  env?: Record<string, string>
}

/** A validated layer object. `invalid` is the isolation marker, docs 02 §6. */
export interface Validated<T> {
  value: T
  invalid: false
  issues?: never
}
export interface Rejected<T> {
  value: T | undefined
  invalid: true
  /** Every schema problem found, so a bad entry is fully explainable. */
  issues: string[]
}
export type Entry<T> = Validated<T> | Rejected<T>

export const isInvalid = <T>(entry: Entry<T>): entry is Rejected<T> => entry.invalid

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Validate one agent spec. Non-throwing: problems accumulate. */
export function validateAgent(input: unknown): Entry<AgentSpec> {
  const spec = input as AgentSpec | undefined
  const issues: string[] = []
  if (typeof spec?.id !== "string" || !IDENTIFIER.test(spec.id))
    issues.push(`agent id must be a usable identifier (got ${JSON.stringify(spec?.id)})`)
  if (typeof spec?.capability !== "string" || !(CAPABILITY_TIERS as readonly string[]).includes(spec.capability))
    issues.push(`agent ${spec?.id ?? "?"}: capability must be one of ${CAPABILITY_TIERS.join(" | ")}`)
  if (spec?.systemPrompt !== undefined) {
    const p = spec.systemPrompt
    if (typeof p !== "string" && !(typeof p === "object" && p !== null && typeof (p as { file?: unknown }).file === "string"))
      issues.push(`agent ${spec?.id ?? "?"}: systemPrompt must be a string or { file: string }`)
  }
  for (const field of ["tools", "subagents"] as const) {
    const value = spec?.[field]
    if (value !== undefined && (!Array.isArray(value) || value.some((x) => typeof x !== "string")))
      issues.push(`agent ${spec?.id ?? "?"}: ${field} must be a string[] when present`)
  }
  if (spec?.env !== undefined && (typeof spec.env !== "object" || spec.env === null || Array.isArray(spec.env)))
    issues.push(`agent ${spec?.id ?? "?"}: env must be an object when present`)
  return issues.length
    ? { value: spec, invalid: true, issues }
    : { value: spec!, invalid: false }
}

/** Validate one provider spec, docs 02 §2.2. */
export function validateProvider(input: unknown): Entry<ProviderSpec> {
  const spec = input as ProviderSpec | undefined
  const issues: string[] = []
  const label = spec?.id ?? "?"
  if (typeof spec?.id !== "string" || !IDENTIFIER.test(spec.id))
    issues.push(`provider id must be a usable identifier (got ${JSON.stringify(spec?.id)})`)
  if (typeof spec?.protocol !== "string" || !(PROVIDER_PROTOCOLS as readonly string[]).includes(spec.protocol))
    issues.push(`provider ${label}: protocol must be one of ${PROVIDER_PROTOCOLS.join(" | ")} (got ${JSON.stringify(spec?.protocol)})`)
  if (typeof spec?.endpoint !== "string" || spec.endpoint.length === 0)
    issues.push(`provider ${label}: endpoint is required`)
  if (typeof spec?.auth !== "string" || !/^header:[a-zA-Z0-9_-]+$/.test(spec.auth) && spec.auth !== "bearer" && spec.auth !== "none")
    issues.push(`provider ${label}: auth must be "bearer", "none" or "header:<name>" (got ${JSON.stringify(spec?.auth)})`)
  if (spec?.health !== undefined) {
    const h = spec.health
    if (typeof h.method === "string" && h.method !== "GET" && h.method !== "POST")
      issues.push(`provider ${label}: health.method must be GET or POST`)
    for (const field of ["intervalSec", "failThreshold", "recoveryThreshold"] as const) {
      const v = h[field]
      if (v !== undefined && (typeof v !== "number" || v <= 0))
        issues.push(`provider ${label}: health.${field} must be a positive number when present`)
    }
  }
  for (const field of ["models", "accounts"] as const) {
    const value = spec?.[field]
    if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
      issues.push(`provider ${label}: ${field} must be a string[]`)
  }
  return issues.length
    ? { value: spec, invalid: true, issues }
    : { value: spec!, invalid: false }
}

/** Validate one model spec, docs 02 §2.3. */
export function validateModel(input: unknown): Entry<ModelSpec> {
  const spec = input as ModelSpec | undefined
  const issues: string[] = []
  const label = spec?.id ?? "?"
  if (typeof spec?.id !== "string" || !spec.id.includes("/"))
    issues.push(`model id must be "<provider>/<model>" (got ${JSON.stringify(spec?.id)})`)
  if (typeof spec?.provider !== "string" || spec.provider.length === 0)
    issues.push(`model ${label}: provider is required`)
  if (typeof spec?.contextWindow !== "number" || spec.contextWindow <= 0)
    issues.push(`model ${label}: contextWindow must be a positive number`)
  if (typeof spec?.maxOutput !== "number" || spec.maxOutput <= 0)
    issues.push(`model ${label}: maxOutput must be a positive number`)
  if (typeof spec?.tier !== "string" || !(CAPABILITY_TIERS as readonly string[]).includes(spec.tier))
    issues.push(`model ${label}: tier must be one of ${CAPABILITY_TIERS.join(" | ")} (got ${JSON.stringify(spec?.tier)})`)
  if (spec?.capabilities !== undefined && (!Array.isArray(spec.capabilities) || spec.capabilities.some((c) => typeof c !== "string")))
    issues.push(`model ${label}: capabilities must be a string[] when present`)
  if (spec?.costPerMtok !== undefined) {
    const cost = spec.costPerMtok
    if (typeof cost.input !== "number" || cost.input < 0 || typeof cost.output !== "number" || cost.output < 0)
      issues.push(`model ${label}: costPerMtok.input/output must be non-negative numbers when present`)
    if (cost.currency !== undefined && cost.currency !== "CNY" && cost.currency !== "USD")
      issues.push(`model ${label}: costPerMtok.currency must be "CNY" or "USD" when present`)
  }
  if (spec?.rate !== undefined) {
    const rate = spec.rate
    for (const f of ["rpm", "tpm"] as const)
      if (rate[f] !== undefined && (typeof rate[f] !== "number" || rate[f] <= 0))
        issues.push(`model ${label}: rate.${f} must be a positive number when present`)
  }
  return issues.length
    ? { value: spec, invalid: true, issues }
    : { value: spec!, invalid: false }
}

/** Validate one account spec, docs 02 §2.4 + ADR-005 (credential is a reference). */
export function validateAccount(input: unknown): Entry<AccountSpec> {
  const spec = input as AccountSpec | undefined
  const issues: string[] = []
  const label = spec?.id ?? "?"
  if (typeof spec?.id !== "string" || !IDENTIFIER.test(spec.id))
    issues.push(`account id must be a usable identifier (got ${JSON.stringify(spec?.id)})`)
  if (typeof spec?.provider !== "string" || spec.provider.length === 0)
    issues.push(`account ${label}: provider is required`)
  if (typeof spec?.credential !== "string" || spec.credential.length === 0)
    issues.push(`account ${label}: credential reference is required`)
  else if (!CREDENTIAL_SCHEMES.some((s) => spec.credential.startsWith(`${s}:`)))
    issues.push(
      `account ${label}: credential must be a reference of the form env:<VAR>, keychain:<id> or file:<path> — plaintext keys are rejected (ADR-005)`,
    )
  if (spec?.models !== undefined && (!Array.isArray(spec.models) || spec.models.some((m) => typeof m !== "string")))
    issues.push(`account ${label}: models must be a string[] when present`)
  if (spec?.quota !== undefined) {
    const q = spec.quota
    if (q.window !== "calendar-month" && q.window !== "rolling-30d")
      issues.push(`account ${label}: quota.window must be "calendar-month" or "rolling-30d"`)
    for (const f of ["monthlyBudgetCents", "monthlyBudgetUnits"] as const)
      if (q[f] !== undefined && (typeof q[f] !== "number" || q[f] < 0))
        issues.push(`account ${label}: quota.${f} must be a non-negative number when present`)
  }
  if (spec?.concurrency !== undefined && (typeof spec.concurrency !== "number" || spec.concurrency < 1))
    issues.push(`account ${label}: concurrency must be a positive number when present`)
  return issues.length
    ? { value: spec, invalid: true, issues }
    : { value: spec!, invalid: false }
}

/**
 * The credential reference grammar, ADR-005: `env:KEY`, `keychain:<id>`,
 * `file:<path>`. Anything else — including a bare string that looks like an
 * actual key — is a plaintext attempt and must never reach a scheduler.
 */
export interface CredentialRef {
  scheme: "env" | "keychain" | "file"
  name: string
}

export function parseCredentialRef(credential: string): CredentialRef | undefined {
  const idx = credential.indexOf(":")
  if (idx <= 1) return undefined
  const scheme = credential.slice(0, idx) as CredentialRef["scheme"]
  const name = credential.slice(idx + 1)
  if (!(CREDENTIAL_SCHEMES as readonly string[]).includes(scheme)) return undefined
  if (name.length === 0) return undefined
  if (scheme === "env" && !/^[A-Z_][A-Z0-9_]*$/.test(name)) return undefined
  if (scheme === "keychain" && !IDENTIFIER.test(name)) return undefined
  if (scheme === "file" && name.startsWith("\0")) return undefined
  return { scheme, name }
}

/**
 * Resolve a credential reference to its value.
 *
 * ADR-005 §2 priority: explicit `env:` reference > project-level keychain >
 * user-level keychain. Callers pass a `lookup` that encapsulates that
 * priority (env first, then whatever keychain/file sources are visible at this
 * level); the function itself stays pure.
 */
export function resolveCredential(
  reference: string,
  lookup: (ref: CredentialRef) => string | undefined,
): string | undefined {
  const parsed = parseCredentialRef(reference)
  return parsed ? lookup(parsed) : undefined
}
