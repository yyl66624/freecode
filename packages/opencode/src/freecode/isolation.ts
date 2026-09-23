export * as Isolation from "./isolation"

import * as Effect from "effect/Effect"
import { Worktree } from "./worktree"
import { Trace } from "./trace"

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
      mode: "shared",
      reason,
      model: input.model,
    })
    return { mode: "shared" as const, reason }
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
      mode: "fallback",
      reason: fallbackReason,
      model: input.model,
    })
    return { mode: "fallback" as const, reason: fallbackReason }
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
    mode: "isolated",
    directory: info.directory,
    worktree: info.directory,
    branch: info.branch,
    model: input.model,
  })
  return {
    mode: "isolated" as const,
    directory: info.directory,
    worktree: info.directory,
    branch: info.branch,
  }
})

export type { WorktreeInfo } from "./worktree"
