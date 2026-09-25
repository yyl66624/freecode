export * as Isolation from "./isolation"

import * as Effect from "effect/Effect"
import * as path from "path"
import { Worktree } from "./worktree"
import { Trace } from "./trace"

/**
 * Rewrite an absolute path from the shared checkout into the subagent's
 * worktree, when it points at a file inside the repository.
 *
 * This is the fix for P0-1 root cause #1 (phenomenon A): a subagent's LLM
 * frequently sees the parent's absolute file paths (from the task
 * description, from parent-session tool results, or from its own reads)
 * and passes them straight to a write tool. The write tool's
 * `path.isAbsolute(params.filePath) ? params.filePath : join(...)` logic
 * honours absolute paths as-is, so the write lands in the shared
 * checkout even though the subagent is isolated.
 *
 * The rewrite maps `/repo/<relative>` -> `/repo/.freecode/worktrees/<id>/<relative>`
 * (the worktree layout this very module creates) and is a no-op for any
 * path that is not under the repository — those stay "external" and fall
 * through to the `external_directory` permission ask, which is the
 * pre-existing behaviour.
 *
 * Kept here, next to the isolation decision, because the repository and the
 * worktree layout are the two facts that make the rewrite correct; the file
 * tools call it without knowing either.
 */
export function rewriteAbsolutePath(repository: string, worktree: string, absolutePath: string): string {
  const prefix = repository.endsWith(path.sep) ? repository : repository + path.sep
  if (!absolutePath.startsWith(prefix)) return absolutePath
  const relative = absolutePath.slice(prefix.length)
  // Guard against escaping via `..` — a path that starts with `..` after the
  // prefix is not a file inside the repository and is left external.
  if (relative.startsWith("..")) return absolutePath
  return path.join(worktree, relative)
}

/**
 * True when this InstanceRef points at a FreeCode isolation worktree: the
 * subagent's directory and worktree are the same path, and that path sits
 * inside the repository's `.freecode/worktrees/` scratch space.
 *
 * Used by the write tools' guard rail (FREE-25): when an isolated subagent
 * hands a write tool a path that still resolves into the *shared* checkout
 * — i.e. the rewrite failed to catch it — the write is refused rather than
 * allowed to pollute the shared checkout. The refusal is a permission error,
 * so the trace records it and the verdict can say "the write was stopped",
 * not "the write polluted the shared checkout".
 *
 * The check is purely lexical (no fs access) so it can run inside the write
 * tool's hot path: directory === worktree is the shape the task tool gives
 * an isolated subagent, and the marker below is where the worktrees are
 * created. The `sep`-joined form catches both `/...` and `\...`.
 */
export function inIsolationWorktree(instance: { directory: string; worktree: string }): boolean {
  if (instance.directory !== instance.worktree) return false
  const marker = `${path.sep}.freecode${path.sep}worktrees${path.sep}`
  const norm = instance.directory.replace(/^\/private(?=\/)/, "")
  return norm.includes(marker)
}

/**
 * True when `target` resolves into the shared repository that owns the
 * subagent's isolation worktree, rather than into the worktree itself.
 *
 * This is the second half of the FREE-25 guard rail: an isolated subagent's
 * InstanceRef points directory and worktree at the worktree, so the write
 * tools cannot ask the instance "where is the shared checkout" directly. The
 * shared repository is the parent directory of the `.freecode/worktrees/<id>`
 * component in the worktree path, and any path under it that is NOT under
 * the subagent's own worktree is shared-checkout territory. The write tool
 * refuses such paths (a permission error) so that, even if the model
 * reconstructs a shared-checkout absolute path from an error message, it
 * cannot pollute the shared checkout from inside an isolated task.
 *
 * `undefined` when the instance is not an isolation worktree, or when the
 * target does not sit under the shared repository — in which case the write
 * is an external write and goes through the existing permission ask.
 */
export function sharedCheckoutPath(
  instance: { directory: string; worktree: string },
  target: string,
): string | undefined {
  if (!inIsolationWorktree(instance)) return undefined
  const sep = path.sep
  const marker = `${sep}.freecode${sep}worktrees${sep}`
  const norm = (p: string) => p.replace(/^\/private(?=\/)/, "")
  const worktree = norm(instance.directory)
  const idx = worktree.lastIndexOf(marker)
  if (idx === -1) return undefined
  const repository = norm(worktree.slice(0, idx))
  const normTarget = norm(target)
  const insideWorktree =
    normTarget === worktree || normTarget.startsWith(worktree + sep)
  if (insideWorktree) return undefined
  if (normTarget === repository || normTarget.startsWith(repository + sep)) return target
  return undefined
}

/**
 * Decides whether one subagent needs its own worktree, and creates it.
 *
 * Kept separate from the task tool so the decision is testable on its own and so
 * the policy lives in one place. The task tool's only job is to pass the result
 * to `InstanceRef`, which is what makes the isolation real: every file tool
 * resolves its working directory from that reference, so a subagent given a
 * worktree cannot reach the shared checkout even if it tries.
 *
 * The trace record is written here, at the seam between the decision and the
 * `InstanceRef` hand-off, so that "shared by policy" is distinguishable from
 * "shared because the worktree could not be created": the two have different
 * consequences and different fix paths, and `undefined` blurred that line.
 */

export interface PrepareInput {
  /** Repository the subagent would otherwise write to. */
  repository: string
  /** Session id, used as the stable worktree identity. */
  sessionID: string
  agent: string
  /** The agent's permission rules, used to infer whether it can write. */
  rules: readonly Worktree.PermissionRule[] | undefined
  /** Configured policy: auto (default), always or never. */
  policy: "auto" | "always" | "never" | undefined
  /** Explicit agent preference from frontmatter. */
  mode?: Worktree.WorkspaceMode
  /**
   * The subagent session's model, for the trace record. Optional: the trace
   * omits the field when it is not supplied rather than inventing a value.
   */
  model?: { providerID: string; modelID: string }
  /**
   * The subagent session's parent session id, for the trace record. The task
   * tool knows both ids; passing the parent explicitly keeps the trace record
   * independent of any session-store lookup.
   */
  parentSessionID?: string
  /**
   * True when this run resumes an existing subagent session (`task_id` or a
   * background extension) rather than starting a fresh one. Recorded on the
   * trace `session` event so a reader can tell first-creation from resume
   * reuse (P0-3 contract A2: `resumed` must come from the isolation
   * decision, not default to false forever).
   */
  resumed?: boolean
  /**
   * 1-based turn ordinal within the subagent session, for the trace record.
   * A resumed task is a new turn; the verdict joins turns by session id and
   * uses the last `session` record's `worktree` for its judgment, so this
   * ordinal is what keeps multi-turn sessions readable (P0-3 contract C1).
   */
  turnNumber?: number
  /**
   * The parent session's resolved directory and worktree, for the trace
   * record. The parent's `InstanceRef` is what the subagent's file tools
   * resolve against when the subagent is NOT isolated; recording it on the
   * `session` event makes "the subagent ran in the shared checkout because
   * of the parent instance" a one-line lookup in the trace.
   */
  parentDirectory?: string
  parentWorktree?: string
}

/**
 * The result of an isolation decision.
 *
 * `isolated` - a worktree was created; the subagent's file tools will resolve
 *              against `directory`.
 * `shared`   - the subagent runs in the shared checkout by policy (it does
 *              not write, or the policy is `never` / `shared`).
 * `fallback` - the subagent wanted isolation but could not get it (the
 *              project is not a git repository, or the worktree could not be
 *              created); it runs in the shared checkout and the reason is
 *              recorded.
 */
export interface Result {
  mode: "isolated" | "shared" | "fallback"
  directory?: string
  worktree?: string
  branch?: string
  reason?: string
  /**
   * Set when the subagent was resumed (`task_id` or background extension):
   * the worktree already exists and is reused, so the isolation decision is
   * "reused the existing worktree" rather than "created a new one". The
   * trace record carries the same flag on its `session` event.
   */
  resumed?: boolean
}

/**
 * The pure isolation decision, split out so the trace (which only needs the
 * decision, not the git I/O) can be driven by tests without a repository.
 */
export function decide(input: PrepareInput): { wanted: boolean; reason: string | undefined } {
  const wanted = Worktree.shouldIsolate({
    mode: input.mode,
    canWrite: Worktree.canWrite(input.rules),
    policy: input.policy,
  })
  if (wanted) return { wanted: true, reason: undefined }
  const policy = input.policy ?? "auto"
  const reason =
    policy === "never"
      ? "isolation policy is 'never'"
      : input.mode === "shared"
        ? "the agent declared workspace_mode 'shared'"
        : "the agent does not have write permission, so it runs shared"
  return { wanted: false, reason }
}

/**
 * Prepare isolation for one subagent.
 *
 * Every failure path returns a `Result` rather than `undefined`, so the
 * caller can distinguish the three outcomes and hand the right one to both the
 * trace and to `InstanceRef`. The subagent always runs: `isolated` redirects
 * its file tools to the worktree, `shared` leaves them in the shared
 * checkout, and `fallback` is the last-resort shared checkout with a reason
 * logged. A subagent that cannot be isolated must still run: isolation exists
 * to prevent lost work between concurrent writers, and refusing to start is a
 * worse outcome than the risk it avoids.
 */
export const prepare = Effect.fn("FreeCode.Isolation.prepare")(function* (input: PrepareInput) {
  const { wanted, reason } = decide(input)

  if (!wanted) {
    Trace.session({
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      resumed: input.resumed ?? false,
      turnNumber: input.turnNumber,
      mode: "shared",
      reason,
      model: input.model,
      parentDirectory: input.parentDirectory,
      parentWorktree: input.parentWorktree,
    })
    return { mode: "shared" as const, reason, resumed: input.resumed }
  }

  const info = yield* Effect.promise(() => Worktree.create({ repository: input.repository, id: input.sessionID }))

  if (!info) {
    const fallbackReason =
      reason ?? "the project is not a git repository, or the worktree could not be created"
    yield* Effect.logWarning("freecode could not isolate this subagent, running in the shared checkout", {
      agent: input.agent,
      repository: input.repository,
      // Almost always "the project is not a git repository", which is worth
      // naming because the fix is obvious once you know.
      reason: fallbackReason,
    })
    Trace.session({
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      resumed: input.resumed ?? false,
      turnNumber: input.turnNumber,
      mode: "fallback",
      reason: fallbackReason,
      model: input.model,
      parentDirectory: input.parentDirectory,
      parentWorktree: input.parentWorktree,
    })
    return { mode: "fallback" as const, reason: fallbackReason, resumed: input.resumed }
  }

  yield* Effect.logInfo("freecode isolated subagent", {
    agent: input.agent,
    directory: info.directory,
    branch: info.branch,
  })
  Trace.session({
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    agent: input.agent,
    resumed: input.resumed ?? false,
    turnNumber: input.turnNumber,
    mode: "isolated",
    directory: info.directory,
    worktree: info.directory,
    branch: info.branch,
    model: input.model,
    parentDirectory: input.parentDirectory,
    parentWorktree: input.parentWorktree,
  })
  return {
    mode: "isolated" as const,
    directory: info.directory,
    worktree: info.directory,
    branch: info.branch,
    resumed: input.resumed,
  }
})

export type { WorktreeInfo } from "./worktree"
