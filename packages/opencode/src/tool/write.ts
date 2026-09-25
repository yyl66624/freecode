import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import { containsPath } from "../project/instance-context"
import { Trace } from "@/freecode/trace"
import { rewriteAbsolutePath, inIsolationWorktree, sharedCheckoutPath } from "@/freecode/isolation"
import * as Bom from "@/util/bom"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // P0-4: an isolated subagent's InstanceRef points at its worktree,
          // but the LLM still hands out the parent's absolute paths. Rewriting
          // paths that point into the shared checkout keeps the write inside
          // the worktree instead of escaping it (phenomenon A).
          const inputPath = params.filePath
          let filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(instance.directory, params.filePath)
          let rewritten = false
          if (path.isAbsolute(filepath) && filepath !== instance.directory) {
            const target = rewriteAbsolutePath(instance.worktree, instance.directory, filepath)
            if (target !== filepath) {
              filepath = target
              rewritten = true
            }
          } else if (!path.isAbsolute(params.filePath) && !containsPath(filepath, instance)) {
            // P0-8 §7: P0-4's rewriteAbsolutePath is a pure string substitution
            // that silently passes through when a path already begins with the
            // instance's own worktree.  But a relative path the model hands in
            // is resolved against the instance's shared-checkout cwd (the parent
            // worktree's original directory), NOT the subagent's worktree.  If
            // the join lands back in the shared checkout it needs the same
            // rewrite as the absolute form, otherwise the guard rail below
            // sees a shared-checkout path and refuses a write the model meant
            // for its own worktree.  (Relative form of the P0-4 rewrite miss.)
            const target = rewriteAbsolutePath(instance.worktree, instance.directory, filepath)
            if (target !== filepath) {
              filepath = target
              rewritten = true
            }
          }
          // FREE-25 guard rail: an isolated subagent must not be able to pollute
          // the shared checkout when the model hands back an absolute path that
          // the rewrite missed (e.g. reconstructed from a 401 error message).
          // Refuse with a permission-denial-style error so the trace records it
          // and the verdict says "stopped" instead of "polluted".
          // FREE-25 guard rail: when the model hands back an absolute path that
          // still points at the shared checkout (the rewrite missed it, e.g. the
          // model reconstructed it from a 401 error message), refuse the write
          // before any disk I/O. The refusal is recorded in the trace as a
          // tool.outcome so the verdict can say "the write was stopped at the
          // door", not "the write polluted the shared checkout".
          const sharedPath = sharedCheckoutPath(instance, filepath)
          // Record the resolve BEFORE the refusal (aligned with apply_patch,
          // which traces every hunk up front). A refused write still carries
          // its resolved path in the trace, so Verdict.decide's wouldResolve
          // sees "a write would have landed outside the worktree" and a 401
          // turn verdicts AUTH_FAILED instead of a bare ERROR.
          if (sharedPath !== undefined) {
            const error = new Error(
              `write refused: path '${sharedPath}' targets the shared checkout, not this task's worktree; isolation is in effect for this subagent`,
            )
            Trace.toolResolve({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              tool: "write",
              inputPath,
              cwd: instance.directory,
              resolved: sharedPath,
              external: !containsPath(sharedPath, instance),
              rewritten,
            })
            Trace.toolOutcome({
              sessionID: ctx.sessionID,
              callID: ctx.callID,
              tool: "write",
              outcome: "permission",
              error: error.message,
            })
            return yield* Effect.fail(error)
          }
          Trace.toolResolve({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            tool: "write",
            inputPath,
            cwd: instance.directory,
            resolved: filepath,
            external: !containsPath(filepath, instance),
            rewritten,
          })
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })
          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          // Trace: record success only after the bytes are actually on disk.
          Trace.toolOutcome({
            sessionID: ctx.sessionID,
            callID: ctx.callID,
            tool: "write",
            outcome: "success",
          })
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
