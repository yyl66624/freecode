export * as Verdict from "./verdict"

import { Trace } from "./trace"
import { contains as pathContains } from "@/util/filesystem"

/**
 * The acceptance verdict for one isolated-subagent run.
 *
 * Answers the question P0-2 exists for: when an acceptance check fails, is it
 * "the model never wrote" (a model behaviour) or "the model wrote, but to the
 * wrong place" (an isolation defect)? The two have different owners and
 * different fixes, so the acceptance run must say which one happened instead of
 * a bare "isolation check failed".
 *
 * The verdict is derived from the trace record (P0-1), not from the log lines
 * or the filesystem:
 *
 *   - `NO_WRITE`    no write tool was attempted by the subagent.
 *   - `WRONG_CWD`   a write was attempted, but the tool resolved it to a path
 *                   outside the subagent's worktree - it landed in the shared
 *                   checkout.
 *   - `OK`          every write attempt resolved inside the subagent's own
 *                   worktree and the turn ended successfully.
 *   - `ERROR`       the turn ended in an error, or a tool call failed.
 *   - `AUTH_FAILED` the turn ended in an error AND at least one write attempt
 *                   resolved outside the subagent's worktree (or was stopped
 *                   at the door by the guard rail). Distinguishes "the
 *                   provider refused the request and the model tried to
 *                   pollute the shared checkout" from a plain ERROR.
 *
 * The verdict is a function of the trace events only, so it can be driven by
 * recorded traces in tests without a provider and without a repository.
 */

export type Label = "OK" | "WRONG_CWD" | "NO_WRITE" | "ERROR" | "AUTH_FAILED"

export interface Evidence {
  /** The events that the verdict is built from, in trace order. */
  events: Trace.Event[]
  /** The subagent session's isolation record: mode, worktree, reason. */
  session?: Extract<Trace.Event, { kind: "session" }>
  /** Every write-tool resolution in the run, with the path each one took. */
  resolves: Extract<Trace.Event, { kind: "tool.resolve" }>[]
  /** Every write-tool outcome in the run. */
  outcomes: Extract<Trace.Event, { kind: "tool.outcome" }>[]
  /** The turn's end record, when one exists. */
  turn?: Extract<Trace.Event, { kind: "turn.end" }>
  /** The paths the write tool resolved to, from the trace. */
  resolved: string[]
  /** The paths a write would have resolved to if the model had written. */
  wouldResolve: string[]
  /** The paths the trace shows were actually written, when known. */
  written: string[]
  /** The paths that landed in the shared checkout, i.e. wrong. */
  wrong: string[]
  /** The paths that landed in the subagent's own worktree, i.e. right. */
  right: string[]
}

export interface Result {
  label: Label
  /** One line, for the acceptance log: the label and the reason, human-readable. */
  summary: string
  /** The full evidence, for the "why" that ships with every verdict. */
  evidence: Evidence
  /**
   * Whether the subagent was isolated at all. When the session record is
   * missing, the verdict degrades to `ERROR` with this set.
   */
  isolated: boolean
}

/**
 * The tools that can put bytes on disk. `apply_patch` counts even when its
 * hunks are rejected later: the attempt is what the subagent decided to do,
 * and a rejected patch is still a write attempt at that path.
 */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"])

export function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.has(tool)
}

/**
 * Decide the verdict for one subagent session from its trace events.
 *
 * `events` should be the trace lines that mention the session (as
 * `Trace.read(sessionID)` returns), not the whole file: joining by session id
 * is what keeps a parent's own tool calls from skewing the verdict.
 */
export function decide(events: Trace.Event[]): Result {
  // P0-4 / P0-3 contract A1+C1: a multi-turn session (a task_id resume or a
  // background extension) has one `session` record and one `turn.end` record
  // per turn. The verdict must judge the LAST turn — it is the one that says
  // where the write most recently landed. A `resumed` flag on the trace
  // distinguishes first-creation from resume-reuse.
  const sessions = events.filter((event): event is Extract<Trace.Event, { kind: "session" }> =>
    event.kind === "session",
  )
  const turns = events.filter((event): event is Extract<Trace.Event, { kind: "turn.end" }> =>
    event.kind === "turn.end",
  )
  const session = sessions.length > 0 ? sessions[sessions.length - 1] : undefined
  const isolates: Extract<Trace.Event, { kind: "tool.resolve" }>[] = []
  const outcomes: Extract<Trace.Event, { kind: "tool.outcome" }>[] = []
  for (const event of events) {
    if (event.kind === "tool.resolve" && isWriteTool(String(event["tool"]))) {
      isolates.push(event as Extract<Trace.Event, { kind: "tool.resolve" }>)
    }
    if (event.kind === "tool.outcome" && isWriteTool(String(event["tool"]))) {
      outcomes.push(event as Extract<Trace.Event, { kind: "tool.outcome" }>)
    }
  }
  const turn = turns.length > 0 ? turns[turns.length - 1] : undefined

  // The subagent's own worktree, straight out of the trace record. The trace
  // is the single source of truth: the verdict says where a write landed
  // relative to where it *should* have landed, and both of those come from
  // the same recording. A filesystem cross-check (does the file actually
  // exist there?) is the runner's job, not the verdict's.
  const worktree = session?.["worktree"] as string | undefined

  const resolved = isolates.map((event) => String(event["resolved"]))
  const written: string[] = []
  const wrong: string[] = []
  const right: string[] = []
  // Positional pairing: when events carry no callID the resolve and its
  // outcome sit adjacent in trace order, so walk them as pairs.  The outcome
  // that belongs to the *n*‑th resolve is the *n*‑th outcome (counting only
  // outcomes for write tools) seen so far.  This gives each outcome a 1‑to‑1
  // mapping to the resolve it actually produced, which is the correct
  // fallback when the trace did not record a callID.
  //
  // Track which resolves have been claimed by an outcome so far.  In the
  // common interleaving (r0,o0,r1,o1,…) the i‑th outcome claims the i‑th
  // resolve; in the non‑interleaved case (r0,r1,o0,o1,…) it also works
  // because the first unclaimed resolve is the natural match.
  const claimed = new Array(isolates.length).fill(false)
  for (const outcome of outcomes) {
    const callId = outcome["callID"]
    let source: (typeof isolates)[number] | undefined
    if (callId !== undefined) {
      source = isolates.find((event) => event["callID"] === callId)
    } else {
      // Fall back to the first unclaimed resolve.  In sequential traces the
      // outcomes and resolves appear in the same order, so the first one not
      // yet paired is the correct match.  This is strictly better than
      // "the last resolve" which over‑counts when there is more than one
      // write‑tool call.
      const idx = claimed.indexOf(false)
      if (idx !== -1) {
        source = isolates[idx]
        claimed[idx] = true
      }
    }
    if (!source) continue
    if (outcome["outcome"] !== "success") continue
    const target = String(source["resolved"])
    written.push(target)
    if (worktree && containsPath(target, worktree)) {
      right.push(target)
    } else {
      wrong.push(target)
    }
  }
  // What the model would have resolved its paths to, had it written them.
  const wouldResolve = resolved.filter((path) => !(worktree ? containsPath(path, worktree) : false))

  const evidence: Evidence = {
    events: [...events],
    session,
    resolves: isolates,
    outcomes,
    turn,
    resolved,
    wouldResolve,
    written,
    wrong,
    right,
  }

  // The isolation record is the reference for every other verdict: without it
  // there is no "where the write should have gone", so the run is a trace
  // problem, not an isolation problem.
  if (!session || session["mode"] !== "isolated") {
    const reason = session ? `isolation mode was '${session["mode"]}'${session["reason"] ? ` (${session["reason"]})` : ""}` : "no isolation record in the trace"
    return finish("ERROR", `no write was expected (${reason})`, evidence)
  }

  // Turn failed: the failure is the story. When a write attempt already
  // resolved outside the subagent's worktree (the wrong[] / wouldResolve[]
  // evidence is non-empty) even though the turn errored, the failure is not
  // just "the turn died" — the turn died AND the write went to the wrong
  // place (or was stopped at the door). Report AUTH_FAILED, not ERROR, so
  // the runner can distinguish "the provider refused the request and the
  // model tried to write through the shared checkout" from "the model never
  // attempted a write" (NO_WRITE) or "the write landed in the worktree" (OK).
  if (turn && turn["outcome"] === "error") {
    if (wrong.length > 0) {
      return finish(
        "AUTH_FAILED",
        `turn failed with auth error AND ${wrong.length} write(s) targeted outside the worktree: ${wrong.join(", ")}`,
        evidence,
      )
    }
    if (wouldResolve.length > 0) {
      return finish(
        "AUTH_FAILED",
        `turn failed with auth error; ${wouldResolve.length} write(s) would have resolved outside the worktree (all stopped before landing): ${wouldResolve.join(", ")}`,
        evidence,
      )
    }
    return finish(
      "ERROR",
      `turn failed${turn["error"] ? `: ${String(turn["error"])}` : ""}`,
      evidence,
    )
  }

  // A tool call that errored. Same: the error is the story.
  const failed = outcomes.filter((event) => event["outcome"] === "error")
  if (failed.length > 0) {
    return finish(
      "ERROR",
      `${failed.length} write tool call(s) failed: ${failed
        .map((event) => String(event["tool"]))
        .join(", ")}${failed[0]["error"] ? ` (${String(failed[0]["error"])})` : ""}`,
      evidence,
    )
  }

  // No write tool was ever attempted. This is "the model did not call a write
  // tool" - phenomenon B - and it must not be read as an isolation failure.
  if (isolates.length === 0) {
    return finish("NO_WRITE", "no write tool call was made by the subagent", evidence)
  }

  // Write tool calls exist but none succeeded (e.g. all were denied by
  // permission). The model wanted to write; the write never reached disk.
  if (written.length === 0) {
    return finish(
      "NO_WRITE",
      `${isolates.length} write tool call(s) made, but none reached disk (all denied or not completed)`,
      evidence,
    )
  }

  // At least one write reached disk. Where did it land?
  if (wrong.length > 0) {
    return finish(
      "WRONG_CWD",
      `${wrong.length} write(s) landed outside the subagent's worktree: ${wrong.join(", ")}`,
      evidence,
    )
  }

  return finish("OK", `${written.length} write(s) landed in the subagent's worktree: ${right.join(", ")}`, evidence)
}

function finish(label: Label, summary: string, evidence: Evidence): Result {
  const isolated = evidence.session?.["mode"] === "isolated"
  return { label, summary, evidence, isolated }
}

function containsPath(target: string, directory: string): boolean {
  // Mirror `@/project/instance-context`'s boundary rule, using the same
  // helper the file tools use, so the verdict and the tools disagree on
  // nothing: a path is inside when it is contained by the directory.
  if (!target || !directory) return false
  return pathContains(directory, target)
}
