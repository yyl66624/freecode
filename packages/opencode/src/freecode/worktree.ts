export * as Worktree from "./worktree"

import path from "path"
import { existsSync, mkdirSync, realpathSync, rmSync } from "fs"
import { $ } from "bun"

/**
 * Git worktrees, so several writing agents can work at once without editing each
 * other's files.
 *
 * OpenCode's permission system is not a sandbox, and two agents editing one
 * checkout is a race no permission rule can arbitrate: whoever writes last wins
 * and the other's work is silently gone. A worktree gives each writer its own
 * files, and a branch means the result is reviewable as a diff rather than
 * already merged.
 *
 * Placement is inside the repository on purpose. `.freecode/worktrees/<id>` is
 * ignored by git automatically — a repository cannot track a worktree of itself —
 * so nothing has to be added to the user's `.gitignore`, and cleanup is a local
 * `rmSync` rather than a walk over a sibling directory.
 */

export interface WorktreeInfo {
  /** Task the worktree belongs to. */
  id: string
  /** Absolute path of the isolated checkout. */
  directory: string
  /** Branch the work carries, so the result can be reviewed before merging. */
  branch: string
  /** Repository the worktree was created from. */
  repository: string
}

export interface CreateInput {
  /** Repository to branch from. */
  repository: string
  /** Stable identifier, normally the subagent session id. */
  id: string
}

/** Where a task's worktree lives, relative to the repository. */
export function location(repository: string, id: string) {
  return path.join(repository, ".freecode", "worktrees", sanitize(id))
}

/**
 * Canonical form of a path, for comparing ours with git's.
 *
 * git reports resolved paths, so on macOS a repository reached through `/tmp`
 * comes back as `/private/tmp`. Comparing the two without resolving first makes
 * every path equality check fail for reasons that have nothing to do with
 * FreeCode.
 */
function canonical(target: string) {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

export function branchName(id: string) {
  return `freecode/${sanitize(id)}`
}

/**
 * Sanitize an id for use as a directory and a git ref.
 *
 * Session ids are safe today, but a branch name that git rejects fails the whole
 * operation at the least convenient moment, so it is normalized here instead.
 */
export function sanitize(id: string) {
  return id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 120) || "task"
}

/**
 * Whether a repository can host worktrees at all.
 *
 * A non-git project cannot, and pretending otherwise would fail much later with
 * a confusing git error. Callers use this to fall back to a shared directory and
 * say so.
 */
export async function available(repository: string): Promise<boolean> {
  const result = await $`git -C ${repository} rev-parse --is-inside-work-tree`.quiet().nothrow()
  return result.exitCode === 0 && result.stdout.toString().trim() === "true"
}

/**
 * Create an isolated checkout for a task.
 *
 * Idempotent: an existing worktree for the same id is reused rather than
 * recreated, because a resumed task must keep the work it already did.
 */
export async function create(input: CreateInput): Promise<WorktreeInfo | undefined> {
  // Resolved on creation so every path this module hands out is in the same form
  // git will report it back in.
  const directory = canonical(location(input.repository, input.id))
  const branch = branchName(input.id)

  if (existsSync(directory)) return { id: input.id, directory, branch, repository: input.repository }
  if (!(await available(input.repository))) return undefined

  mkdirSync(path.dirname(directory), { recursive: true })

  // `-b` creates the branch. It fails if the branch exists, which happens when a
  // previous worktree was removed without its branch; `-B` would silently
  // discard that branch's commits, so the failure is handled instead.
  const created = await $`git -C ${input.repository} worktree add -b ${branch} ${directory} HEAD`.quiet().nothrow()
  if (created.exitCode === 0) return { id: input.id, directory, branch, repository: input.repository }

  const reused = await $`git -C ${input.repository} worktree add ${directory} ${branch}`.quiet().nothrow()
  if (reused.exitCode === 0) return { id: input.id, directory, branch, repository: input.repository }

  return undefined
}

export interface Change {
  /** Repository-relative path. */
  file: string
  /** Single-letter git status: A, M, D, R, and so on. */
  status: string
  /** Lines added and removed, when the change is textual. */
  added?: number
  removed?: number
}

/**
 * What a task changed, relative to the commit it branched from.
 *
 * Untracked files are included, because an agent that creates a new file has
 * changed the repository and a review that omits it is worse than no review.
 */
export async function diff(info: WorktreeInfo): Promise<Change[]> {
  const status = await $`git -C ${info.directory} status --porcelain`.quiet().nothrow()
  if (status.exitCode !== 0) return []

  const entries = status.stdout
    .toString()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim().charAt(0), file: line.slice(3).trim() }))

  const numstat = await $`git -C ${info.directory} diff --numstat HEAD`.quiet().nothrow()
  const counts = new Map<string, { added: number; removed: number }>()
  if (numstat.exitCode === 0) {
    for (const line of numstat.stdout.toString().split("\n")) {
      const [added, removed, file] = line.split("\t")
      if (!file) continue
      counts.set(file.trim(), { added: Number(added) || 0, removed: Number(removed) || 0 })
    }
  }

  return entries.map((entry) => ({ ...entry, ...(counts.get(entry.file) ?? {}) }))
}

/** Unified diff of everything the task changed, for review. */
export async function patch(info: WorktreeInfo): Promise<string> {
  const tracked = await $`git -C ${info.directory} diff HEAD`.quiet().nothrow()
  const text = tracked.exitCode === 0 ? tracked.stdout.toString() : ""

  // Untracked files have no diff until they are staged, so they are added to the
  // index first. `--intent-to-add` records the path without staging content, which
  // is what makes them visible to `diff` without altering the commit.
  await $`git -C ${info.directory} add --intent-to-add --all`.quiet().nothrow()
  const untracked = await $`git -C ${info.directory} diff`.quiet().nothrow()
  return text + (untracked.exitCode === 0 ? untracked.stdout.toString() : "")
}

export interface MergeResult {
  merged: boolean
  /** Why it did not merge, when it did not. */
  reason?: string
  /** Files that conflicted. */
  conflicts?: string[]
}

/**
 * Merge a task's branch into the repository's current branch.
 *
 * `--no-ff` so the merge is a commit even when it could fast-forward: the point of
 * isolating work is to be able to see it as a unit, and a fast-forward erases that
 * boundary from history.
 *
 * A conflict aborts the merge rather than leaving the user's repository in a
 * half-merged state. A conflicted tree is the one situation where "the tool did
 * something clever" is strictly worse than "the tool stopped".
 */
/** The directory FreeCode's worktrees live in, as a git pathspec to exclude. */
export function scratchPath(repository: string) {
  return path.relative(repository, path.join(repository, ".freecode", "worktrees")) || ".freecode/worktrees"
}

export async function merge(info: WorktreeInfo): Promise<MergeResult> {
  // Worktrees live inside the repository, so the parent sees them as untracked
  // and reports itself dirty. Excluding FreeCode's own scratch space is what keeps
  // the dirty check about the user's changes rather than about ours.
  const dirty =
    await $`git -C ${info.repository} status --porcelain -- . ${`:!${scratchPath(info.repository)}`}`.quiet().nothrow()
  if (dirty.exitCode === 0 && dirty.stdout.toString().trim()) {
    return { merged: false, reason: "the repository has uncommitted changes; commit or stash them first" }
  }

  const committed = await $`git -C ${info.directory} add --all`.quiet().nothrow()
  if (committed.exitCode !== 0) return { merged: false, reason: "could not stage the task's changes" }

  // A task that changed nothing has nothing to commit; merging an empty branch
  // would add a noise commit.
  const staged = await $`git -C ${info.directory} diff --cached --quiet`.quiet().nothrow()
  if (staged.exitCode === 0) return { merged: false, reason: "the task made no changes" }

  const commit = await $`git -C ${info.directory} commit -m ${`freecode: ${info.id}`}`.quiet().nothrow()
  if (commit.exitCode !== 0) return { merged: false, reason: "could not commit the task's changes" }

  const merged = await $`git -C ${info.repository} merge --no-ff --no-edit ${info.branch}`.quiet().nothrow()
  if (merged.exitCode === 0) return { merged: true }

  const conflicted = await $`git -C ${info.repository} diff --name-only --diff-filter=U`.quiet().nothrow()
  const conflicts = conflicted.exitCode === 0
    ? conflicted.stdout.toString().split("\n").map((line) => line.trim()).filter(Boolean)
    : []

  await $`git -C ${info.repository} merge --abort`.quiet().nothrow()
  return { merged: false, reason: "the merge conflicted and was aborted", conflicts }
}

export interface DiscardInput {
  /** Also delete the branch, losing the work entirely. */
  deleteBranch?: boolean
}

/**
 * Remove a task's worktree.
 *
 * `--force` because an agent's worktree is routinely dirty — that is the whole
 * point of it — and refusing to clean up would leave the user's repository
 * littered with directories they did not ask for.
 */
export async function discard(info: WorktreeInfo, input: DiscardInput = {}): Promise<boolean> {
  const removed = await $`git -C ${info.repository} worktree remove --force ${info.directory}`.quiet().nothrow()
  if (removed.exitCode !== 0 && existsSync(info.directory)) rmSync(info.directory, { recursive: true, force: true })
  await $`git -C ${info.repository} worktree prune`.quiet().nothrow()

  if (input.deleteBranch) await $`git -C ${info.repository} branch -D ${info.branch}`.quiet().nothrow()
  return true
}

/** Every worktree FreeCode has created for a repository. */
export async function list(repository: string): Promise<string[]> {
  const result = await $`git -C ${repository} worktree list --porcelain`.quiet().nothrow()
  if (result.exitCode !== 0) return []
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((directory) => directory.includes(`${path.sep}.freecode${path.sep}worktrees${path.sep}`))
    .map(canonical)
}

/**
 * A stable id for a task's isolated work.
 *
 * A resumed task must land in the same worktree it used before, or its previous
 * edits become invisible and it starts over. Session ids already have that
 * property, so they are the id rather than something generated here.
 */
export function idFor(sessionID: string) {
  return sanitize(sessionID)
}

/**
 * Permissions that mean an agent can change files.
 *
 * `write` and `patch` are included even though the built-in agents use `edit`:
 * a user-defined agent may deny `edit` and allow `write`, and reading only `edit`
 * would put that agent in the isolated path while it does nothing at all.
 */
const WRITE_PERMISSIONS = ["edit", "write", "patch", "apply_patch", "multiedit"] as const

export interface PermissionRule {
  permission: string
  pattern: string
  action: string
}

/**
 * Whether an agent can modify the repository.
 *
 * Used to decide isolation, so it errs toward "yes": an agent wrongly treated as
 * a writer gets a worktree it did not need, while one wrongly treated as a reader
 * edits the shared checkout alongside other agents. The second mistake is the one
 * that loses work.
 */
export function canWrite(rules: readonly PermissionRule[] | undefined): boolean {
  if (!rules?.length) return true
  return rules.some((rule) => {
    if (rule.action === "deny") return false
    if (rule.permission === "*") return true
    return (WRITE_PERMISSIONS as readonly string[]).includes(rule.permission)
  })
}

export type WorkspaceMode = "shared" | "isolated" | "auto"

/**
 * Decide where one subagent should work.
 *
 * `auto` isolates writers and shares readers, which is the only default that makes
 * concurrent agents safe without paying for a worktree on every read.
 */
export function shouldIsolate(input: {
  mode: WorkspaceMode | undefined
  canWrite: boolean
  policy: "auto" | "always" | "never" | undefined
}): boolean {
  const policy = input.policy ?? "auto"
  if (policy === "never") return false
  if (input.mode === "shared") return false
  if (input.mode === "isolated") return true
  if (policy === "always") return true
  // `auto` with no explicit mode.
  return input.canWrite
}
