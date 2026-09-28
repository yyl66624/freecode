export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FreeCode } from "@/freecode/freecode"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

/**
 * Project config files for the product names FreeCode answers to, lowest
 * precedence first, because `config.ts` merges the list left to right and a
 * later entry wins.
 *
 * Two orderings compose here, and both must agree with the documented rule that
 * a FreeCode file overrides the OpenCode file it sits beside:
 *
 * - filename precedence, lowest first: `config.*`, `opencode.*`, `freecode.*`.
 *   `config` is upstream's bare legacy name, `freecode` is this product's;
 * - position, farthest first: within one product name the walk is reversed so
 *   the nearest directory wins and `.jsonc` wins over the `.json` beside it —
 *   the same rule `files()` applies for a single name.
 *
 * An existing OpenCode project keeps working untouched, and adding a FreeCode
 * file on top overrides it instead of the other way round.
 */
export const projectFiles = Effect.fn("ConfigPaths.projectFilesForProduct")(function* (
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const stop = worktree && worktree !== "/" ? worktree : directory
  const found = yield* afs.up({
    targets: FreeCode.configFileNames.flatMap((name) => [`${name}.jsonc`, `${name}.json`]),
    start: directory,
    stop,
  })
  return FreeCode.configFileNames.toReversed().flatMap((name) =>
    found
      .filter((file) => path.basename(file).startsWith(`${name}.`))
      .toReversed(),
  )
})

/**
 * Config directories that apply to the active project, nearest last.
 *
 * Non-git projects report a worktree of `/`, which would otherwise make the
 * upward walk climb past the project to the filesystem root and pick up
 * unrelated config directories belonging to ancestors. Treating that as "no
 * boundary" keeps the walk inside the project.
 */
export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  const stop = worktree && worktree !== "/" ? worktree : directory
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [...FreeCode.projectConfigDirs],
          start: directory,
          stop,
        })
      : []),
    ...(yield* afs.up({
      targets: [FreeCode.Product.projectConfigDir],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
