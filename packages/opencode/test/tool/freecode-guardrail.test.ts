import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs"
import { $ } from "bun"
import { Cause, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Trace } from "@/freecode/trace"
import { sharedCheckoutPath, inIsolationWorktree } from "@/freecode/isolation"

/**
 * FREE-25 production-form regression (Mika ruling 01a0d827 / 01a0d834):
 *
 * Drive the REAL tool execution path (WriteTool.execute / EditTool.execute)
 * against a real git worktree layout and assert the trace-ordering contract:
 * when the guard rail refuses a shared-checkout write, the trace JSONL must
 * contain `tool.resolve(resolved=<shared-checkout path>, external=true)`
 * ordered BEFORE `tool.outcome(outcome=permission)`.
 *
 * Acceptance criterion (issue FREE-25): this test FAILS on `b9efb86`
 * (refuse-branch recorded only `tool.outcome=permission`, no
 * `tool.resolve`) and PASSES on `3b2eb3a` / `ced407e` (refuse-branch
 * records resolve first, via `refuseSharedCheckout`).  The test only
 * imports symbols that exist on `b9efb86` so it is runnable on either
 * commit.
 *
 * Note: the pre-existing `TestInstance` tmpdir infra in this workspace has
 * an environment-level ENOENT failure (verified on clean `ced407e`), so
 * the tests here build their own real git worktree layout under a temp dir
 * instead of relying on `tmpdirScoped`.
 */

const ROOT = path.join("/tmp", `f25-guardrail-${process.pid}`)

const ctx = {
  sessionID: SessionID.make("ses_f25_guardrail"),
  messageID: MessageID.make("msg_f25"),
  callID: "call_f25",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
  Trace._setCurrentFile(undefined)
  Trace._setConfigEnabled(false)
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, EventV2Bridge.node, Format.node, Truncate.node, Agent.node]),
  ),
)

async function setupWorktree(name: string) {
  const repo = path.join(ROOT, name)
  fs.rmSync(repo, { recursive: true, force: true })
  fs.mkdirSync(repo, { recursive: true })
  // Canonicalise first: on macOS /tmp -> /private/tmp; git and the lexical
  // guard rail both need canonical paths.
  const canonicalRepo = fs.realpathSync(repo)
  await $`git -C ${canonicalRepo} init -q`.quiet()
  await $`git -C ${canonicalRepo} config user.email test@freecode.local`.quiet()
  await $`git -C ${canonicalRepo} config user.name FreeCode`.quiet()
  fs.writeFileSync(path.join(canonicalRepo, "geom.py"), "import math\ndef area(r): return math.pi * r * r\n")
  await $`git -C ${canonicalRepo} add -A`.quiet()
  await $`git -C ${canonicalRepo} commit -qm init`.quiet()
  // Real git worktree at the FreeCode layout: <repo>/.freecode/worktrees/<id>
  const worktreeDir = path.join(canonicalRepo, ".freecode", "worktrees", "ses_child")
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true })
  const wtResult = await $`git -C ${canonicalRepo} worktree add -b freecode/ses_child ${worktreeDir} HEAD`
  if (wtResult.exitCode !== 0) {
    throw new Error(`git worktree add failed (exit ${wtResult.exitCode}): ${wtResult.stderr.toString().trim()}`)
  }
  return {
    repo: canonicalRepo,
    worktreeDir,
    sharedTarget: fs.realpathSync(path.join(canonicalRepo, "geom.py")),
  }
}

function teardown(repo: string) {
  fs.rmSync(repo, { recursive: true, force: true })
}

/**
 * Assert the trace-ordering contract on the JSONL the tool actually wrote:
 *   tool.resolve(resolved=sharedTarget, external=true)  ← BEFORE
 *   tool.outcome(outcome=permission, tool=<tool>)
 * On `b9efb86` the refuse-branch emitted no `tool.resolve`, so this fails.
 */
function assertRefusalTrace(tool: "write" | "edit", subagentDir: string, sharedTarget: string) {
  // Sanity: the instance shape must satisfy `inIsolationWorktree` and the
  // shared-checkout target must be detectable by `sharedCheckoutPath`.
  expect(inIsolationWorktree({ directory: subagentDir, worktree: subagentDir })).toBe(true)
  expect(sharedCheckoutPath({ directory: subagentDir, worktree: subagentDir }, sharedTarget)).toBe(sharedTarget)

  // Read the trace file that was set up before the tool ran.
  const events = Trace.read().filter((e) => e.kind === "tool.resolve" || e.kind === "tool.outcome")
  const resolves = events.filter((e) => e.kind === "tool.resolve")
  const permissions = events.filter((e) => e.kind === "tool.outcome" && e["outcome"] === "permission")
  // The guard-rail refusal must have recorded the write target before
  // refusing.  On b9efb86 the refuse-branch skipped tool.resolve → fail.
  expect(resolves.length).toBeGreaterThanOrEqual(1)
  const resolve = resolves.find((e) => e["resolved"] === sharedTarget)
  expect(resolve, "trace must contain tool.resolve for the shared-checkout target").toBeDefined()
  expect(resolve!["external"]).toBe(true)
  expect(permissions.length).toBeGreaterThanOrEqual(1)
  const permission = permissions.find((e) => e["tool"] === tool)
  expect(permission, "trace must contain tool.outcome=permission for the refused tool call").toBeDefined()
  // Ordering: resolve recorded no later than the permission outcome.
  expect(resolve!["ts"]).toBeLessThanOrEqual(permission!["ts"])
}

describe("FREE-25: guard-rail refusal records resolve before outcome (production tool path)", () => {
  it.instance("write tool: shared-checkout target refused with resolve recorded first", () =>
    Effect.gen(function* () {
      const layout = yield* Effect.promise(() => setupWorktree("f25-write"))
      const { repo, worktreeDir, sharedTarget } = layout
      try {
        // Enable trace capture BEFORE running the tool so the tool's own
        // trace writes land in a file we can read back.
        const traceFile = path.join(worktreeDir, `f25-trace-write-${process.pid}.jsonl`)
        Trace._setConfigEnabled(true)
        Trace._setCurrentFile(traceFile)

        const store = yield* InstanceStore.Service
        yield* store.provide({ directory: worktreeDir, worktree: worktreeDir }, Effect.gen(function* () {
          const info = yield* WriteTool
          const tool = yield* info.init()
          const exit = yield* tool.execute({ filePath: sharedTarget, content: "rewritten\n" }, ctx).pipe(Effect.exit)
          // The tool may fail with the guard-rail refusal or with a
          // downstream ENOENT (the worktree has no geom.py yet).  Either way
          // the trace must carry the resolve-before-permission ordering.
          if (exit._tag === "Success") {
            // P0-4 rewrite landed in the worktree: trace still records
            // a tool.resolve; no assertion on permission outcome needed.
            return
          }
          const err = Cause.squash(exit.cause)
          if (!(err instanceof Error) || !/refused|not found/i.test(err.message)) {
            throw new Error(`unexpected failure: ${String(err)}`)
          }
        }))

        assertRefusalTrace("write", worktreeDir, sharedTarget)
        fs.rmSync(traceFile, { force: true })
      } finally {
        teardown(repo)
      }
    }),
  )

  it.instance("edit tool: shared-checkout target refused with resolve recorded first", () =>
    Effect.gen(function* () {
      const layout = yield* Effect.promise(() => setupWorktree("f25-edit"))
      const { repo, worktreeDir, sharedTarget } = layout
      try {
        const traceFile = path.join(worktreeDir, `f25-trace-edit-${process.pid}.jsonl`)
        Trace._setConfigEnabled(true)
        Trace._setCurrentFile(traceFile)

        const store = yield* InstanceStore.Service
        yield* store.provide({ directory: worktreeDir, worktree: worktreeDir }, Effect.gen(function* () {
          const info = yield* EditTool
          const tool = yield* info.init()
          const exit = yield* tool
            .execute(
              {
                filePath: sharedTarget,
                oldString: "def area(r): return math.pi * r * r",
                newString: "def area(r): return r ** 2",
              },
              ctx,
            )
            .pipe(Effect.exit)
          if (exit._tag === "Success") {
            return
          }
          const err = Cause.squash(exit.cause)
          if (!(err instanceof Error) || !/refused|not found|No changes/i.test(err.message)) {
            throw new Error(`unexpected failure: ${String(err)}`)
          }
        }))

        assertRefusalTrace("edit", worktreeDir, sharedTarget)
        fs.rmSync(traceFile, { force: true })
      } finally {
        teardown(repo)
      }
    }),
  )
})
