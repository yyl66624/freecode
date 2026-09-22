import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { InstanceState } from "@/effect/instance-state"
import { Worktree } from "@/freecode/worktree"

/**
 * `freecode tasks` — review, merge or discard the work isolated subagents produced.
 *
 * Isolation without a review step would just move the problem: work would pile up
 * in worktrees nobody looks at. This is the other half of the feature.
 *
 *   freecode tasks            list what each task changed
 *   freecode tasks diff <id>  full patch for one task
 *   freecode tasks merge <id> merge one task into the current branch
 *   freecode tasks drop <id>  discard one task's worktree and branch
 */
export const TasksCommand = effectCmd({
  command: "tasks [action] [id]",
  describe: "review, merge or discard isolated subagent work",
  // Worktrees belong to a project, so this command has to be pointed at one the
  // same way `run` is; without it the pool would be resolved against whichever
  // directory the user happened to be standing in.
  directory: (args: unknown) => (args as { dir?: string }).dir ?? process.cwd(),
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "list (default), diff, merge or drop",
        type: "string",
        choices: ["list", "diff", "merge", "drop"],
      })
      .positional("id", {
        describe: "task id, as shown by list; it is the subagent session id",
        type: "string",
      })
      .option("dir", {
        describe: "directory of the project whose tasks to inspect",
        type: "string",
      }),
  handler: Effect.fn("Cli.tasks")(function* (raw: unknown) {
    // yargs types widen once `directory` is a function, so the positional
    // arguments are read at this boundary rather than threaded through generics.
    const args = raw as { action?: string; id?: string }
    const instance = yield* InstanceState.context
    const action = args.action ?? "list"
    const repository = instance.worktree

    const directories = yield* Effect.promise(() => Worktree.list(repository))
    if (directories.length === 0) {
      UI.println("No isolated tasks. Work appears here when a writing subagent runs.")
      return
    }

    // Every task is identified by the id in its path, which is the subagent
    // session id, so `tasks merge <id>` and the log line that created it agree.
    const tasks = directories.map((directory) => ({
      id: directory.split(/[\\/]/).pop() ?? directory,
      directory,
      branch: Worktree.branchName(directory.split(/[\\/]/).pop() ?? ""),
      repository,
    }))

    if (action === "list") {
      UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + "Isolated tasks" + UI.Style.TEXT_NORMAL)
      for (const task of tasks) {
        const changes = yield* Effect.promise(() => Worktree.diff(task))
        const summary = changes.length
          ? changes
              .slice(0, 4)
              .map((change) => `${change.status} ${change.file}`)
              .join(", ") + (changes.length > 4 ? `, +${changes.length - 4} more` : "")
          : "no changes yet"
        UI.println(`  ${task.id}`)
        UI.println(`    ${changes.length} file(s)  ${summary}`)
      }
      UI.println("")
      UI.println("  freecode tasks diff <id>    see the patch")
      UI.println("  freecode tasks merge <id>   merge it into the current branch")
      UI.println("  freecode tasks drop <id>    throw it away")
      return
    }

    const id = args.id
    if (!id) return yield* fail(`\`tasks ${action}\` needs a task id. Run \`freecode tasks\` to list them.`)

    const task = tasks.find((candidate) => candidate.id === id)
    if (!task) return yield* fail(`No isolated task with id ${id}. Run \`freecode tasks\` to list them.`)

    if (action === "diff") {
      const patch = yield* Effect.promise(() => Worktree.patch(task))
      if (!patch.trim()) {
        UI.println(`${id} has made no changes.`)
        return
      }
      process.stdout.write(patch.endsWith("\n") ? patch : patch + "\n")
      return
    }

    if (action === "merge") {
      const result = yield* Effect.promise(() => Worktree.merge(task))
      if (!result.merged) {
        // A refusal is information, not a failure of the command: a dirty
        // repository or a conflict is the user's decision to make.
        UI.println(UI.Style.TEXT_WARNING_BOLD + "Not merged" + UI.Style.TEXT_NORMAL)
        UI.println(`  ${result.reason}`)
        if (result.conflicts?.length) {
          UI.println("  conflicts:")
          for (const file of result.conflicts) UI.println(`    ${file}`)
          UI.println("  Resolve them in the worktree, commit, then merge again:")
          UI.println(`    cd ${task.directory}`)
        }
        return
      }
      UI.println(`Merged ${id} (${task.branch})`)
      const discarded = yield* Effect.promise(() => Worktree.discard(task, { deleteBranch: true }))
      UI.println(discarded ? "  worktree removed" : "  worktree left in place")
      return
    }

    const discarded = yield* Effect.promise(() => Worktree.discard(task, { deleteBranch: true }))
    UI.println(discarded ? `Dropped ${id}, including its branch` : `Could not drop ${id}`)
  }),
})
