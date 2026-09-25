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
          }
          // FREE-25 guard rail: an isolated subagent must not be able to pollute
          // the shared checkout when the model hands back an absolute path that
          // the rewrite missed (e.g. reconstructed from a 401 error message).
          // Refuse with a permission-denial-style error so the trace records it
          // and the verdict says "stopped" instead of "polluted".
          const sharedPath = sharedCheckoutPath(instance, filepath)
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
          if (sharedPath !== undefined) {
            const error = new Error(
              `write refused: path '${sharedPath}' targets the shared checkout, not this task's worktree; isolation is in effect for this subagent`,
            )
            Trace.toolOutcome({
              sessionID: ctx.sessionID,
              callID: ctx.callID,
              tool: "write",
              outcome: "error",
              error: error.message,
            })
            return yield* Effect.fail(error)
          }
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
