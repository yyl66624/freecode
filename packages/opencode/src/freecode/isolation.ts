export * as Isolation from "./isolation"

import * as Effect from "effect/Effect"
import { Worktree } from "./worktree"

/**
 * Decides whether one subagent needs its own worktree, and creates it.
 *
 * Kept separate from the task tool so the decision is testable on its own and so
 * the policy lives in one place. The task tool's only job is to pass the result
 * to `InstanceRef`, which is what makes the isolation real: every file tool
 * resolves its working directory from that reference, so a subagent given a
 * worktree cannot reach the shared checkout even if it tries.
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
}

/**
 * Prepare isolation for one subagent.
 *
 * Every failure path returns `undefined`, which means "run in the shared
 * checkout". A subagent that cannot be isolated must still run: isolation exists
 * to prevent lost work between concurrent writers, and refusing to start is a
 * worse outcome than the risk it avoids.
 */
export const prepare = Effect.fn("FreeCode.Isolation.prepare")(function* (input: PrepareInput) {
  const wanted = Worktree.shouldIsolate({
    mode: input.mode,
    canWrite: Worktree.canWrite(input.rules),
    policy: input.policy,
  })

  if (!wanted) return undefined

  const info = yield* Effect.promise(() => Worktree.create({ repository: input.repository, id: input.sessionID }))

  if (!info) {
    yield* Effect.logWarning("freecode could not isolate this subagent, running in the shared checkout", {
      agent: input.agent,
      repository: input.repository,
      // Almost always "the project is not a git repository", which is worth
      // naming because the fix is obvious once you know.
      reason: "the project is not a git repository, or the worktree could not be created",
    })
    return undefined
  }

  yield* Effect.logInfo("freecode isolated subagent", {
    agent: input.agent,
    directory: info.directory,
    branch: info.branch,
  })
  return info
})

export type { WorktreeInfo } from "./worktree"
