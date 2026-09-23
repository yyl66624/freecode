export * as Core from "./types"
export * as StateMachine from "./state-machine"
export * as Metrics from "./metrics"
export * as Scoring from "./scoring"
export * as SchedulerCore from "./scheduler-core"
export * as Suspend from "./suspend"
export * as SchedulerState from "./state-store"

/**
 * The six-dimension scheduler core.
 *
 * One module, one contract. The candidate pool, the state machine, the
 * scorer, the resolver, and the SUSPENDED path are all here; the
 * configuration layer (ResourceStore, FREE-15) and the harness glue
 * (Stage 3) build on top of this, not the other way round.
 */

export {
  // The data model and constants.
  TIER_ORDER,
  DEFAULT_WEIGHTS,
  DEFAULT_TIE_EPS,
  DEFAULT_STICKY_DELTA,
  LATENCY_BUDGET_MS,
  NoResourceError,
  type CapabilityTier,
  type SchedulerWeights,
  type HealthSpec,
  type QuotaSpec,
  type AccountSpec,
  type ModelSpec,
  type ProviderSpec,
  type CandidateSpec,
  type ResolveRequest,
  type ResourceBinding,
} from "./types"

// The state machine's events and states.
export {
  type CandidateState,
  type CandidateHealth,
  type ProbeResult,
  type CallOutcome,
  initialState,
  onProbe,
  onCall,
  onQuotaReset,
  onCredentialRotated,
  onDisabled,
  onEnabled,
  probeOptions,
} from "./state-machine"

// The dynamic metrics.
export {
  type CallObservation,
  type CandidateMetrics,
  LATENCY_EMA_ALPHA,
  initialMetrics,
  onCall as metricOnCall,
  applyStaleness,
  latencyMs,
  reliabilityOf,
} from "./metrics"

// The scorer.
export {
  type Candidate,
  type Terms,
  type Pick,
  eligible,
  inPool,
  pool,
  hardFilter,
  dims,
  healthTerm,
  costTerm,
  costOf,
  weightedScore,
  normaliseWeights,
  pick,
} from "./scoring"

// The resolver.
export { type ResolveContext, type DecisionLogEntry, type StateSnapshot, type ResolveOutcome, resolve } from "./scheduler-core"

// The SUSPENDED path.
export {
  type SuspendedSnapshot,
  DEFAULT_AUTO_RESUME,
  park,
  reProbe,
  sweepQuotaWindows,
} from "./suspend"
