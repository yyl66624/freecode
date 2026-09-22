export * as Decision from "./decision"

import path from "path"
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "fs"
import { Global } from "@opencode-ai/core/global"
import type { Scheduler } from "./scheduler"
import type { RouteDecision } from "./router/client"

/**
 * A structured record of why a task landed on a particular model.
 *
 * FreeCode's claim is that model selection is not a black box. A log line is
 * enough for a developer reading `--print-logs`, but not enough for `/why`, not
 * enough to diff two runs, and not enough to answer "why was my strongest model
 * skipped" a week later. So every decision is written down in full: every
 * candidate, whether it was eligible, its score, its score components, and — for
 * the ones that lost — the reason.
 *
 * The record is written best effort and is deliberately *not* a history. Keeping
 * one file means it cannot grow without bound, and the interesting question is
 * almost always about the most recent decision.
 */

export interface CandidateRecord {
  resource: string
  provider: string
  account: string
  model: string
  eligible: boolean
  /** Why it was excluded, when it was. */
  excluded?: string
  score?: number
  components?: Record<string, number>
}

export interface DecisionRecord {
  version: 1
  at: number
  agent: string
  /** The task text the router saw. */
  task: string
  mode: "fixed" | "tier" | "auto"
  tier: string
  /** The router's classification, when routing ran. */
  routing?: RouteDecision
  routingReason?: string
  selected?: string
  /** Why nothing was selected, when nothing was. */
  fallbackReason?: string
  candidates: CandidateRecord[]
}

const VERSION = 1

/**
 * Location of the last decision.
 *
 * In the global data directory rather than the project: a routing decision is a
 * property of the pool and its health, and a user debugging "why this model"
 * usually wants the most recent answer regardless of which project produced it.
 */
export function file(): string {
  return path.join(Global.Path.data, "last-route.json")
}

export function write(record: Omit<DecisionRecord, "version" | "at"> & { at?: number }): void {
  try {
    const location = file()
    mkdirSync(path.dirname(location), { recursive: true })
    const payload: DecisionRecord = { version: VERSION, at: record.at ?? Date.now(), ...record }
    const temporary = `${location}.tmp`
    writeFileSync(temporary, JSON.stringify(payload, null, 2))
    // Write-then-rename: a reader must never observe a half-written decision.
    renameSync(temporary, location)
  } catch {
    // An audit trail is valuable but never worth failing a task over.
  }
}

export function read(): DecisionRecord | undefined {
  const location = file()
  if (!existsSync(location)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(location, "utf8"))
    if (!parsed || typeof parsed !== "object" || parsed.version !== VERSION) return undefined
    return parsed as DecisionRecord
  } catch {
    return undefined
  }
}

/**
 * Turn a scheduler ranking into candidate records.
 *
 * `ranked` is every candidate with a score; `all` is every candidate, including
 * the ones the scheduler refused to score. Both are needed: a report that only
 * lists scored candidates cannot answer "why was my strongest model skipped".
 */
export function candidates(
  all: readonly Scheduler.Candidate[],
  ranked: readonly Scheduler.Scored[],
): CandidateRecord[] {
  const scored = new Map(ranked.map((row) => [row.candidate.resource.id, row]))
  return all
    .map((candidate): CandidateRecord => {
      const row = scored.get(candidate.resource.id)
      const base = {
        resource: candidate.resource.id,
        provider: candidate.resource.provider,
        account: candidate.resource.account,
        model: candidate.resource.model,
      }
      if (!row) return { ...base, eligible: false, excluded: "not eligible for this tier" }
      return {
        ...base,
        eligible: true,
        score: Number(row.score.toFixed(4)),
        components: Object.fromEntries(
          Object.entries(row.terms).map(([key, value]) => [key, Number((value as number).toFixed(4))]),
        ),
      }
    })
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1) || left.resource.localeCompare(right.resource))
}

/**
 * Render a decision for a terminal.
 *
 * Written for the question a user actually asks — "why this one, and why not the
 * other" — so the winner's components are shown as a sum and the losers are shown
 * with the reason they lost.
 */
export function render(record: DecisionRecord): string {
  const lines: string[] = []
  const when = new Date(record.at).toISOString()
  lines.push(`FreeCode routing decision  ${when}`)
  lines.push(`  agent   ${record.agent}`)
  lines.push(`  task    ${record.task || "(empty)"}`)
  lines.push(`  mode    ${record.mode}${record.routing ? `  (router: ${record.routing.source})` : ""}`)
  lines.push(`  tier    ${record.tier}`)
  if (record.routing) {
    lines.push(
      `  router  kind=${record.routing.kind} tier=${record.routing.tier} ` +
        `difficulty=${record.routing.difficulty} confidence=${record.routing.confidence}`,
    )
    lines.push(`  reason  ${record.routingReason ?? record.routing.reason}`)
  }

  lines.push("")
  if (record.selected) {
    lines.push(`Selected  ${record.selected}`)
  } else {
    lines.push("Selected  (none — the caller's default model was used)")
    if (record.fallbackReason) lines.push(`  because ${record.fallbackReason}`)
  }

  const winner = record.candidates.find((candidate) => candidate.resource === record.selected)
  if (winner?.components) {
    lines.push("")
    for (const [name, value] of Object.entries(winner.components)) {
      lines.push(`  + ${name.padEnd(12)} ${value.toFixed(2)}`)
    }
    lines.push(`  = ${"score".padEnd(12)} ${(winner.score ?? 0).toFixed(3)}`)
  }

  const others = record.candidates.filter((candidate) => candidate.resource !== record.selected)
  if (others.length) {
    lines.push("")
    lines.push("Not selected")
    for (const candidate of others) {
      const detail = candidate.eligible
        ? `score ${(candidate.score ?? 0).toFixed(3)} (lower than the winner)`
        : (candidate.excluded ?? "not eligible")
      lines.push(`  ${candidate.resource.padEnd(34)} ${detail}`)
    }
  }

  return lines.join("\n")
}
