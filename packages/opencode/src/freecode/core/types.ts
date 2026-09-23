export * as Core from "./types"

/**
 * The static data model of the scheduler core.
 *
 * These are the *spec* types from docs/architecture/02-four-layer-model.md
 * §2, narrowed to what the six-dimension scheduler actually consumes. The
 * full ResourceStore (FREE-15, Stage 1) validates and merges user config into
 * these shapes; this module owns the shapes plus the constants the design
 * docs fix, so scoring and state transitions can be implemented and tested
 * without the configuration layer existing yet.
 *
 * Everything in this package is pure and dependency-free on purpose: the
 * scheduler must be replayable from a state snapshot, and replay is the
 * acceptance criterion (docs/architecture/03-scheduler.md §4.3).
 */

/** Capability tiers, weakest to strongest. Index comparisons are meaningful. */
export type CapabilityTier = "light" | "standard" | "deep" | "expert"

/** Ordered weakest to strongest, matching docs 03 §2. */
export const TIER_ORDER: readonly CapabilityTier[] = ["light", "standard", "deep", "expert"] as const

export const tierIndex = (tier: CapabilityTier): number => TIER_ORDER.indexOf(tier)

/**
 * Default dimension weights, docs 03 §3.1.
 *
 * Cost is deliberately the smallest term: availability beats saving money,
 * cost only tie-breaks. Overridable from user config; the loader
 * normalises, but the scheduler treats the sum as 1 either way (rank
 * does not divide by the weight sum — see `scoring.ts`).
 */
export interface SchedulerWeights {
  capability: number
  quota: number
  health: number
  latency: number
  reliability: number
  cost: number
}

export const DEFAULT_WEIGHTS: SchedulerWeights = {
  capability: 0.25,
  quota: 0.2,
  health: 0.25,
  latency: 0.15,
  reliability: 0.1,
  cost: 0.05,
}

/** Ties closer than this are broken by the jitter rule, docs 03 §3.3. */
export const DEFAULT_TIE_EPS = 0.02
/** A session only rebinds when the new pick is better by more than this, docs 03 §4.2. */
export const DEFAULT_STICKY_DELTA = 0.1
/** P50 latency beyond which the latency term decays to zero, docs 03 §3.1. */
export const LATENCY_BUDGET_MS = 8_000
/** The reliability window: the smaller of the last hour or the last 100 calls. */
export const RELIABILITY_WINDOW_MS = 60 * 60_000
export const RELIABILITY_WINDOW_CALLS = 100
/** Laplace smoothing constants, docs 03 §3.2: small samples lean to 0.9. */
export const RELIABILITY_SMOOTHING = 10
export const COLD_START_RELIABILITY = 0.9
/** Dynamic observations older than this go back to priors on load, docs 03 §8. */
export const DYNAMIC_MAX_AGE_MS = 24 * 60 * 60_000
/** The background re-probe interval while a task is suspended, docs 03 §5 / ADR-004. */
export const SUSPENDED_REPROBE_MS = 5 * 60_000
/** Consecutive connection-level probe failures before a candidate is UNAVAILABLE. */
export const CONNECT_FAILURE_THRESHOLD = 3
/** The decision log rolls at this many entries, docs 03 §4.3. */
export const DECISION_LOG_LIMIT = 500
/** Sampling window on first contact with an unfamiliar candidate, docs 03 §7. */
export const SHADOW_CALLS = 3
/** Steady state after at most this much time or this many calls, docs 03 §7. */
export const STEADY_AFTER_MS = 30 * 60_000
export const STEADY_AFTER_CALLS = 20

/** Health probe configuration, docs 02 §2.2. */
export interface HealthSpec {
  method?: "GET" | "POST"
  path?: string
  intervalSec?: number
  failThreshold?: number
  recoveryThreshold?: number
}

export interface QuotaSpec {
  monthlyBudgetCents?: number
  monthlyBudgetUnits?: number
  window: "calendar-month" | "rolling-30d"
}

/** The candidate's account, docs 02 §2.4. */
export interface AccountSpec {
  id: string
  provider: string
  credential: string
  models?: string[]
  quota?: QuotaSpec
  concurrency?: number
  /** Manual switch. An account nobody enabled is not a candidate. */
  enabled?: boolean
}

/** The candidate's model, docs 02 §2.3. */
export interface ModelSpec {
  /** Globally unique: "<provider>/<model>". */
  id: string
  provider: string
  contextWindow: number
  maxOutput: number
  /** "tools" | "json" | "streaming" | "reasoning" | "vision" | "long-context" | ... */
  capabilities: string[]
  tier: CapabilityTier
  /** CNY/USD per million tokens. 0 (the default) means free or unknown. */
  costPerMtok?: { input: number; output: number; currency?: "CNY" | "USD" }
}

/** The candidate's provider, docs 02 §2.2. */
export interface ProviderSpec {
  id: string
  protocol: "openai-chat" | "openai-responses" | "local-http"
  endpoint: string
  auth: "bearer" | "header:<name>" | "none"
  baseUrlOverride?: string
  timeoutMs?: number
  health?: HealthSpec
  models: string[]
  accounts: string[]
}

/**
 * A candidate is a (model, account) binding — docs 02 §2.5 calls this a
 * ResourceBinding; the scheduler treats it as the scheduling unit, which is
 * why state lives at this level rather than per provider or per model.
 *
 * `spec` is optional: a candidate can be constructed from its parts (the
 * test fixtures do this, and `reProbe` needs only the ids in there).
 */
export interface CandidateSpec {
  model: ModelSpec
  account: AccountSpec
  provider?: ProviderSpec
}

/** A request for a resource, docs 02 §4. */
export interface ResolveRequest {
  capability: CapabilityTier
  requiredFeatures?: string[]
  /** User's manual pick: highest priority, still validated for account availability. */
  modelOverride?: string
  /** Session key for sticky routing, docs 03 §4.2. */
  sessionKey?: string
  /** A task label for the decision log, e.g. "coder/refactor". */
  task?: string
}

/** The binding a resolve() produces, docs 02 §4. */
export interface ResourceBinding {
  model: ModelSpec
  account: AccountSpec
  endpoint: string
  effectiveCapabilities: string[]
  /** True when the pick came from the relaxed pool (degraded path). */
  degradedPath?: boolean
  /** How the pick was made: fresh score, sticky keep, or manual override. */
  via?: "override" | "sticky" | "score" | "score-degraded"
}

/** NoResourceError, docs 03 §5 first row and ADR-004. */
export class NoResourceError extends Error {
  /** What the task was waiting for, so the TUI can show the actionable list. */
  readonly required: { capability: CapabilityTier; features: string[] }
  constructor(required: { capability: CapabilityTier; features: string[] }) {
    super(`no eligible resource for ${required.capability}${required.features.length ? ` + ${required.features.join(", ")}` : ""}`)
    this.name = "NoResourceError"
    this.required = required
  }
}

/**
 * Per-vendor latency priors for cold start, docs 03 §6: P50 in milliseconds
 * for providers with no local observation yet. Missing vendors get the
 * generic prior, and local models are judged by what they actually do.
 */
export const LATENCY_PRIOR_MS: Record<string, number> = {
  minimax: 1_000,
  zhipu: 800,
  moonshot: 1_200,
  deepseek: 1_200,
  ollama: 2_000,
}
export const LATENCY_PRIOR_DEFAULT_MS = 1_500

export const PRIOR: Record<string, number> = {
  ...LATENCY_PRIOR_MS,
  default: LATENCY_PRIOR_DEFAULT_MS,
}

/**
 * When the quota window for this account resets, docs 03 §5. Calendar months
 * reset at the first of the next month 00:00; rolling windows after 30 days.
 * A 429 carrying a known `resetAt` always wins over this heuristic — an exact
 * deadline beats a guessed one.
 */
export function quotaWindowReset(spec: QuotaSpec, now = Date.now()): number {
  if (spec.window === "calendar-month") {
    const d = new Date(now)
    d.setMonth(d.getMonth() + 1)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return now + 30 * 24 * 60 * 60_000
}

/** Whether a candidate's provider is local, where "health" means "is it running at all". */
export const isLocalProtocol = (protocol: ProviderSpec["protocol"]): boolean => protocol === "local-http"
