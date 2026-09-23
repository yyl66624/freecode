export * as SchedulerState from "./state-store"

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DECISION_LOG_LIMIT } from "./types"
import type { DecisionLogEntry, StateSnapshot } from "./scheduler-core"

/**
 * Persistence for the scheduler's durable state — `state.json` from docs
 * 03 §8: candidate states, EWMA values, window counters, and the rolling
 * decision log, under the data directory.
 *
 * The shape is one JSON file with atomic replace, because the scheduler
 * reads it on every resolve and must never be the reason a task is slow.
 * A corrupt file reads as empty: the dynamic values go back to priors,
 * the static facts come from the specs. EXHAUSTED/INVALID survive
 * restarts because they are *facts about the account*, not observations
 * about the provider, and dropping them on upgrade is the exact failure
 * this store exists to prevent.
 */

export function empty(): StateSnapshot {
  return { version: 1, candidates: {}, sessions: {}, suspended: {}, decisions: [] }
}

/**
 * On-disk location.
 *
 * Under `XDG_DATA_HOME/freecode` (same place as `resources.json` and the
 * trace file), so a test that points the environment at its own prefix
 * gets its own state file. Absent `XDG_DATA_HOME`, the module operates
 * purely in memory — persistence is off rather than scattered across
 * machine-global state.
 */
export function file(): string | undefined {
  const dataHome = process.env.XDG_DATA_HOME
  if (!dataHome) return undefined
  return path.join(dataHome, "freecode", "state.json")
}

export function load(): StateSnapshot {
  const location = file()
  if (!location || !existsSync(location)) return empty()
  try {
    const parsed = JSON.parse(readFileSync(location, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return empty()
    return {
      version: 1,
      candidates: typeof parsed.candidates === "object" && parsed.candidates !== null ? parsed.candidates : {},
      sessions: typeof parsed.sessions === "object" && parsed.sessions !== null ? parsed.sessions : {},
      suspended: typeof parsed.suspended === "object" && parsed.suspended !== null ? parsed.suspended : {},
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    }
  } catch {
    return empty()
  }
}

/**
 * Persist one decision, rolling the log at 500 entries. Best effort: a
 * failure to write down the decision must never fail the request that
 * produced it (docs 03 §8, last row).
 */
export function recordDecision(entry: DecisionLogEntry): void {
  const snapshot = load()
  snapshot.decisions.push(entry)
  snapshot.decisions = snapshot.decisions.slice(-DECISION_LOG_LIMIT)
  save(snapshot)
}

/** Save a full snapshot; atomic replace so a crash mid-write cannot truncate the file. */
export function save(snapshot: StateSnapshot): void {
  const location = file()
  if (!location) return
  try {
    mkdirSync(path.dirname(location), { recursive: true })
    const temporary = `${location}.tmp`
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2))
    renameSync(temporary, location)
  } catch {
    // Best effort by design: on write failure the state degrades to
    // in-memory only and the TUI notes it once; the scheduler does not stop.
  }
}
