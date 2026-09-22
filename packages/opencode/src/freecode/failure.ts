export * as Failure from "./failure"

/**
 * Why a model call failed, and whether trying a different resource could help.
 *
 * This taxonomy exists to answer one question: **should FreeCode spend a Head
 * agent token on this failure, or is it the resource's problem?** The first seven
 * classes are resource failures — retrying the same task on another account is
 * the correct response and costs nothing but a request. Only `task_failure` and a
 * genuinely unknown error are worth escalating, because those are the cases where
 * a different model would likely fail the same way and a stronger model might not.
 *
 * Classification is text-based because that is what providers actually give us:
 * a status code when we are lucky, a human sentence when we are not. The patterns
 * are checked most-specific first, since "429 rate limit exceeded" must not be
 * read as a generic server error.
 */

export type FailureClass =
  | "rate_limit"
  | "quota"
  | "authentication"
  | "timeout"
  | "server"
  | "context_limit"
  | "model_unavailable"
  | "task_failure"
  | "unknown"

export interface Classification {
  class: FailureClass
  /**
   * True when another resource might succeed. The scheduler treats this as
   * "exclude this resource for a while", not as "this task is hopeless".
   */
  resource: boolean
  /**
   * True when the provider said when the limit lifts. Only then is the cooldown
   * exact; otherwise it is a guess and the circuit breaker uses its default.
   */
  resetAt?: number
  /** Whether the Head agent should be told, as opposed to a silent retry. */
  escalate: boolean
  /** Trimmed provider text, for logs and the `/why` report. */
  detail?: string
}

interface Rule {
  class: FailureClass
  patterns: RegExp[]
}

/**
 * Ordered most-specific first.
 *
 * `rate_limit` precedes `quota` because a 429 that mentions "quota" is a rate
 * limit with poor wording unless it says the balance is gone; `quota` catches the
 * billing sense specifically.
 */
const RULES: Rule[] = [
  {
    class: "rate_limit",
    patterns: [
      /\b429\b/,
      /rate.?limit/i,
      /too many requests/i,
      /requests per (minute|second|day)/i,
      /tokens per (minute|day)/i,
      /slow ?down/i,
    ],
  },
  {
    class: "quota",
    patterns: [
      /insufficient_quota/i,
      /quota exceeded/i,
      /exceeded your current quota/i,
      /out of credits?/i,
      /no (remaining )?(credits?|balance)/i,
      /billing/i,
      /payment required/i,
      /402/,
    ],
  },
  {
    class: "authentication",
    patterns: [
      /\b401\b/,
      /\b403\b/,
      /unauthoriz/i,
      /forbidden/i,
      /invalid api key/i,
      /incorrect api key/i,
      /authentication/i,
      /api key not valid/i,
    ],
  },
  {
    class: "context_limit",
    patterns: [
      /context length/i,
      /context window/i,
      /maximum context/i,
      /too many tokens/i,
      /prompt is too long/i,
      /reduce the length/i,
    ],
  },
  {
    class: "model_unavailable",
    patterns: [
      /\b404\b/,
      /model not found/i,
      /no such model/i,
      /does not exist/i,
      /not available in your (region|country)/i,
      /deprecated/i,
    ],
  },
  {
    class: "timeout",
    patterns: [
      /timed? ?out/i,
      /ETIMEDOUT/,
      /ESOCKETTIMEDOUT/,
      /deadline exceeded/i,
      /stream (ended|closed) (unexpectedly|prematurely)/i,
      /connection (reset|closed|aborted)/i,
      /ECONNRESET/,
      /ECONNREFUSED/,
      /EPIPE/,
      /socket hang ?up/i,
      /fetch failed/i,
      /network error/i,
      /upstream connect error/i,
    ],
  },
  {
    class: "server",
    patterns: [
      /\b50[0-9]\b/,
      /\b529\b/,
      /internal server error/i,
      /bad gateway/i,
      /service unavailable/i,
      /gateway time-?out/i,
      /overloaded/i,
      /at capacity/i,
      /temporarily unavailable/i,
      /try again later/i,
    ],
  },
]

/**
 * Classes that mean "another resource may work".
 *
 * `context_limit` is included because a larger-context model genuinely can
 * succeed where a small one cannot, which makes it a resource property rather
 * than a task defect.
 */
const RESOURCE_CLASSES = new Set<FailureClass>([
  "rate_limit",
  "quota",
  "authentication",
  "timeout",
  "server",
  "context_limit",
  "model_unavailable",
])

/** Failure text that is really the task going badly, not the provider breaking. */
const TASK_PATTERNS = [
  /permission/i,
  /rejected permission/i,
  /aborted/i,
  /cancell?ed/i,
  /user (rejected|aborted|denied)/i,
  /tool call/i,
  /edit failed/i,
  /file not found/i,
  /no such file/i,
  /syntax ?error/i,
  /type ?error/i,
  /assertion/i,
  /expected .* to (be|equal)/i,
  /test(s)? failed/i,
]

export function classify(error: unknown): Classification {
  const detail = errorText(error)
  if (!detail) return { class: "unknown", resource: false, escalate: true, detail: "" }

  // Task-shaped wording wins over provider-shaped wording, because a tool error
  // mentioning "timeout" is still a task failure and retrying it elsewhere wastes
  // a resource's quota.
  if (TASK_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { class: "task_failure", resource: false, escalate: true, detail: trim(detail) }
  }

  for (const rule of RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(detail))) continue
    const resource = RESOURCE_CLASSES.has(rule.class)
    return {
      class: rule.class,
      resource,
      resetAt: resetFrom(detail),
      // A resource failure is retried silently; only the classes below ever reach
      // the Head agent, and only after silent retries are exhausted.
      escalate: !resource,
      detail: trim(detail),
    }
  }

  return { class: "unknown", resource: false, escalate: true, detail: trim(detail) }
}

/**
 * Extract a reset time from provider text, if one is there.
 *
 * Providers express this half a dozen ways — `Retry-After: 20`, "try again in
 * 30s", "resets at 14:00" — and an exact deadline is worth far more than a fixed
 * cooldown, because it lets the circuit reopen precisely when the window does.
 * Anything unparseable yields `undefined` and the default cooldown applies.
 */
export function resetFrom(text: string, now = Date.now()): number | undefined {
  const relative =
    /(?:retry|try again|available)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(
      text,
    )
  if (relative) {
    const amount = Number(relative[1])
    if (Number.isFinite(amount)) return now + amount * unitMs(relative[2])
  }

  // "resets in 2 minutes" / "quota resets in 30s"
  const resets = /resets?[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(
    text,
  )
  if (resets) {
    const amount = Number(resets[1])
    if (Number.isFinite(amount)) return now + amount * unitMs(resets[2])
  }

  return undefined
}

function unitMs(unit: string): number {
  const normalised = unit.toLowerCase()
  if (normalised.startsWith("ms") || normalised.startsWith("milli")) return 1
  if (normalised.startsWith("h")) return 3_600_000
  if (normalised.startsWith("m") && normalised !== "ms") return 60_000
  return 1_000
}

function trim(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300)
}

/** Human-readable error text from whatever the provider threw. */
export function errorText(error: unknown): string {
  if (!error) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === "object") {
    const record = error as Record<string, unknown>
    const parts = [record.code, record.status, record.type, record.message]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map(String)
    if (parts.length) return parts.join(" ")
    try {
      return JSON.stringify(error).slice(0, 500)
    } catch {
      return String(error)
    }
  }
  return String(error)
}
