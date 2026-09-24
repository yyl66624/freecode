export * as Trace from "./trace"



import path from "path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"

/**
 * End-to-end trace for the isolation write path.
 *
 * Answers one question: when an isolated subagent writes a file, where did the
 * write actually land? A trace run records every link of the chain
 *
 *   instance (InstanceRef: directory / worktree / project)
 *     -> subagent session (parent link + isolation resolution)
 *       -> tool call (tool name, input path, resolved cwd, resolved path)
 *         -> tool outcome (success / permission / error)
 *           -> turn end (success / error)
 *
 * so that `InstanceRef -> child session -> tool call -> resolved cwd -> actual
 * file path` can be followed from one log line to the next without guessing.
 *
 * Two independent switches, both default off, so normal output is untouched:
 *
 *   FREECODE_TRACE=1                writes a JSONL file to
 *                                   $XDG_DATA_HOME/freecode/trace/<pid>.jsonl
 *   FREECODE_TRACE_STDOUT=1         mirrors every event to stdout, prefixed
 *                                   with `freecode trace`, so an acceptance
 *                                   run can grep the trace out of its log
 *   freecode.trace = true in the    turns the file sink on without any
 *   config file                       environment variable; called from the
 *                                     config load so a run can be traced in
 *                                     place
 *
 * The JSONL file is the canonical record; the stdout mirror is for the console
 * and for `run --print-logs` style capture. The file is truncated at start,
 * because a trace run is one process: appending across runs would mix events
 * from different sessions into one record.
 *
 * Every event carries a session id where it has one, which is what lets a
 * later report join the chain: `instance` (the parent's context, no session
 * yet) -> `session` (child's id + parent's id) -> `tool.resolve` /
 * `tool.outcome` (child's session id) -> `turn.end` (child's session id).
 */

const ENABLED = process.env.FREECODE_TRACE === "1"
const STDOUT = process.env.FREECODE_TRACE_STDOUT === "1"
let configEnabled = false

type Kind = "instance" | "session" | "tool.resolve" | "tool.outcome" | "turn.end"

export interface Event {
  kind: Kind
  [field: string]: unknown
}

type StampedEvent = Event & { ts: number; pid: number }

let currentFile: string | undefined
let started = false
let _currentFileOverride: string | undefined = undefined

/**
 * Test-only: point the trace at a specific file without depending on
 * `XDG_DATA_HOME` (which the trace module caches on first write). Must be
 * called before any `Trace.write()` in the process.
 */
export function _setCurrentFile(file: string | undefined) {
  _currentFileOverride = file
  if (file !== undefined) {
    currentFile = file
    started = false
  }
}

/**
 * Test-only: force the trace on for the rest of the process without needing
 * to set the env var before module load.
 */
export function _setConfigEnabled(value: boolean) {
  configEnabled = value
}

function file(): string | undefined {
  if (currentFile) return currentFile
  if (_currentFileOverride) return _currentFileOverride
  // Use XDG_DATA_HOME directly rather than Global.Path.data, so the trace
  // is written to the same location as the FreeCode state file (resources.json)
  // and the test harness can point both at its own prefix without a race.
  const dataHome = process.env.XDG_DATA_HOME
  if (!dataHome) return
  currentFile = path.join(dataHome, "freecode", "trace", `${process.pid}.jsonl`)
  mkdirSync(path.dirname(currentFile), { recursive: true })
  return currentFile
}

function write(event: Event) {
  if (!enabled()) return
  const target = file()
  if (!target) return
  const stamp: StampedEvent = { ...event, ts: Date.now(), pid: process.pid }
  if (!started) {
    started = true
    writeFileSync(target, "", { flag: "w" })
  }
  try {
    appendFileSync(target, JSON.stringify(stamp) + "\n")
  } catch {
    // A trace must never break the thing it is tracing.
  }
  if (STDOUT) console.log(`freecode trace ${stamp.kind} ${JSON.stringify(stamp)}`)
}

/**
 * Turn the trace on from a config load. The environment variable is read at
 * module start; this is the config-file path, called once when the config is
 * loaded, and is what keeps the file switch and the env switch equivalent.
 */
export function enableFromConfig(value: boolean | undefined) {
  if (value) configEnabled = true
}

/**
 * Whether the trace sink is on, for callers that want to branch on it.
 */
export function enabled(): boolean {
  return ENABLED || configEnabled
}

/** The instance a file tool resolves against, straight out of `InstanceRef`. */
export function instance(directory: string, worktree: string, project: string) {
  write({ kind: "instance", directory, worktree, project })
}

/**
 * A subagent session and how it resolves against its parent's instance.
 *
 * `mode` is the outcome of the isolation decision:
 *   isolated   - the subagent got a worktree; its file tools will resolve
 *                against the worktree directory
 *   shared     - it runs in the shared checkout by policy
 *   fallback   - it wanted isolation but could not get it, and runs shared
 * `directory` / `worktree` are what the subagent's file tools actually
 * resolve against when `mode` is `isolated`.
 */
export function session(input: {
  sessionID: string
  parentSessionID?: string
  agent: string
  resumed?: boolean
  /** 1-based turn ordinal within this subagent session. */
  turnNumber?: number
  model?: { providerID: string; modelID: string }
  mode: "isolated" | "shared" | "fallback"
  directory?: string
  worktree?: string
  branch?: string
  reason?: string
  /** The parent session's resolved directory, for reference. */
  parentDirectory?: string
  parentWorktree?: string
}) {
  write({
    kind: "session",
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    agent: input.agent,
    resumed: input.resumed ?? false,
    turnNumber: input.turnNumber,
    model: input.model,
    mode: input.mode,
    directory: input.directory,
    worktree: input.worktree,
    branch: input.branch,
    reason: input.reason,
    parentDirectory: input.parentDirectory,
    parentWorktree: input.parentWorktree,
  })
}

/**
 * One file tool resolving its target path.
 *
 * `inputPath` is what the model passed, `cwd` is what the instance resolves it
 * against (the resolved cwd), and `resolved` is the final absolute path.
 * `external` records whether the path is outside both the instance directory
 * and its worktree - an `external_directory` permission ask follows.
 *
 * `rewritten` is set when the isolation layer redirected an absolute path
 * that pointed at the shared checkout to the corresponding path inside the
 * subagent's worktree (phenomenon A, P0-1 root cause #1): the write lands in
 * the worktree instead of silently escaping it. `inputPath` still records
 * what the model asked for, so the trace shows both sides of the rewrite.
 */
export function toolResolve(input: {
  sessionID: string
  messageID?: string
  callID?: string
  tool: string
  inputPath: string
  cwd: string
  resolved: string
  external?: boolean
  /** Set when an isolated subagent's absolute path was rewritten into its worktree. */
  rewritten?: boolean
}) {
  write({
    kind: "tool.resolve",
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: input.callID,
    tool: input.tool,
    inputPath: input.inputPath,
    cwd: input.cwd,
    resolved: input.resolved,
    external: input.external,
    rewritten: input.rewritten,
  })
}

/**
 * The outcome of a tool call: `success`, `permission` (denied or asked) or
 * `error`, with the error text when there is one.
 */
export function toolOutcome(input: {
  sessionID: string
  callID?: string
  tool: string
  outcome: "success" | "permission" | "error"
  error?: string
}) {
  write({
    kind: "tool.outcome",
    sessionID: input.sessionID,
    callID: input.callID,
    tool: input.tool,
    outcome: input.outcome,
    error: input.error,
  })
}

/**
 * End of a subagent turn.
 *
 * `outcome` is `success` when the turn returned, `error` when it failed.
 * The trace file is the authoritative record for whether the turn wrote
 * anything: a turn can end `success` and still never have written, which is
 * phenomenon B ("the subagent did not write at all") as opposed to
 * phenomenon A ("it wrote, to the wrong place").
 *
 * `turnNumber` is the 1-based ordinal of this turn within the subagent
 * session (a resumed task is a new turn) and `resumed` records whether this
 * turn resumed an existing subagent session (via `task_id` or a background
 * extension) rather than starting a fresh one. Both come from P0-3 contract
 * C1: a session can carry several `turn.end` records and the verdict must be
 * able to tell which one is the last.
 */
export function turnEnd(input: {
  sessionID: string
  parentSessionID?: string
  agent?: string
  outcome: "success" | "error"
  error?: string
  /** 1-based turn ordinal within this subagent session. */
  turnNumber?: number
  /** True when this turn resumed an existing subagent session. */
  resumed?: boolean
}) {
  write({
    kind: "turn.end",
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    agent: input.agent,
    outcome: input.outcome,
    error: input.error,
    turnNumber: input.turnNumber,
    resumed: input.resumed,
  })
}

/**
 * Read back the trace for one session, for reporting.
 *
 * Returns the events that mention the session: its `session` record, its tool
 * calls and their outcomes, and its `turn.end`. Returns an empty list when
 * no trace file exists yet for this process.
 */
export function read(sessionID?: string): StampedEvent[] {
  if (!currentFile || !existsSync(currentFile)) return []
  const lines = readFileSync(currentFile, "utf8").split("\n").filter(Boolean)
  const events = lines.map((line) => {
    try {
      return JSON.parse(line) as StampedEvent
    } catch {
      return undefined
    }
  }).filter((event): event is StampedEvent => event !== undefined)
  if (!sessionID) return events
  return events.filter((event) => event.sessionID === sessionID)
}
