import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs"
import path from "path"
import { $ } from "bun"
import { Isolation, rewriteAbsolutePath } from "@/freecode/isolation"
import { Worktree } from "@/freecode/worktree"
import { Verdict } from "@/freecode/verdict"
import { Trace } from "@/freecode/trace"
import { Effect } from "effect"

/**
 * P0-4 regression tests:
 *
 * 1. `rewriteAbsolutePath` — the phenomenon-A fix. An isolated subagent's LLM
 *    can pass absolute paths pointing at the shared checkout; the fix rewrites
 *    those paths into the worktree so the write lands in the worktree, not
 *    the shared checkout. This test fails if the function does not exist or
 *    does not rewrite correctly.
 *
 * 2. Verdict multi-turn support. `Verdict.decide` must judge the LAST
 *    `turn.end`, not the first, for a session that has been resumed
 *    (task_id) or extended (background extension). This test constructs a
 *    synthetic trace with two turns and verifies the verdict uses the last
 *    turn's outcome.
 *
 * 3. Isolation trace fields. `Isolation.prepare` must record `resumed` and
 *    `turnNumber` on the trace `session` event, so a reader can distinguish
 *    first-creation from resume-reuse.
 *
 * These tests are "before-fix fail / after-fix pass" by construction: they
 * test the new function and the new fields that did not exist in the
 * pre-fix codebase.
 */

const ROOT = path.join(process.env["TMPDIR"] ?? "/tmp", `freecode-p04-test-${process.pid}`)

async function makeRepo(name: string): Promise<string> {
  const directory = path.join(ROOT, name)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  await $`git -C ${directory} init -q`.quiet()
  await $`git -C ${directory} config user.email test@freecode.local`.quiet()
  await $`git -C ${directory} config user.name FreeCode`.quiet()
  writeFileSync(path.join(directory, "geom.py"), "import math\ndef area(r): return math.pi * r * r\n")
  await $`git -C ${directory} add -A`.quiet()
  await $`git -C ${directory} commit -qm init`.quiet()
  return directory
}

describe("P0-4 regression: rewriteAbsolutePath (phenomenon A)", () => {
  test("rewrites an absolute path inside the repository into the worktree", () => {
    const repo = "/home/user/project"
    const worktree = "/home/user/project/.freecode/worktrees/ses_1"
    // A write tool is called with the parent's absolute path
    const parentPath = "/home/user/project/geom.py"
    const result = rewriteAbsolutePath(repo, worktree, parentPath)
    expect(result).toBe("/home/user/project/.freecode/worktrees/ses_1/geom.py")
  })

  test("does not rewrite a path outside the repository", () => {
    const repo = "/home/user/project"
    const worktree = "/home/user/project/.freecode/worktrees/ses_1"
    const external = "/etc/hosts"
    const result = rewriteAbsolutePath(repo, worktree, external)
    expect(result).toBe("/etc/hosts") // unchanged — external, not a rewrite
  })

  test("does not rewrite a path that escapes via `..`", () => {
    const repo = "/home/user/project"
    const worktree = "/home/user/project/.freecode/worktrees/ses_1"
    // A `..`-prefixed relative that escapes the repo prefix stays external
    const escaped = "/home/user/project/../../etc/hosts"
    const result = rewriteAbsolutePath(repo, worktree, escaped)
    // `..` escapes → no rewrite
    expect(result).toBe(escaped)
  })

  test("handles trailing-slash repository path", () => {
    const repo = "/home/user/project/"
    const worktree = "/home/user/project/.freecode/worktrees/ses_1"
    const parentPath = "/home/user/project/geom.py"
    const result = rewriteAbsolutePath(repo, worktree, parentPath)
    expect(result).toBe("/home/user/project/.freecode/worktrees/ses_1/geom.py")
  })

  test("a real worktree rewrite resolves to a path that exists in the worktree", async () => {
    const repository = await makeRepo("rewrite-real")
    try {
      const info = await Worktree.create({ repository, id: "ses_real" })
      expect(info).toBeDefined()
      const worktree = info!.directory
      // The subagent's LLM passes the parent's absolute path
      const parentPath = path.join(repository, "geom.py")
      const rewritten = rewriteAbsolutePath(repository, worktree, parentPath)
      // The rewritten path must be inside the worktree and correspond to geom.py
      expect(rewritten.startsWith(worktree)).toBe(true)
      expect(rewritten.endsWith("geom.py")).toBe(true)
      // The file should exist in the worktree (git worktree add copies files)
      expect(existsSync(rewritten)).toBe(true)
      await Worktree.discard(info!, { deleteBranch: true })
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })
})

describe("P0-4 regression: verdict multi-turn support", () => {
  test("judges the LAST turn's outcome — an ERROR in turn 2 overrides the OK in turn 1", () => {
    // Synthetic trace: two turns on the same session.
    // Turn 1: isolated, writes OK, turn ends success.
    // Turn 2 (resumed): turn ends in error.
    // The verdict must use the LAST turn.end — i.e. ERROR, not OK.
    const events = [
      {
        kind: "session" as const,
        sessionID: "ses_1",
        agent: "coder",
        mode: "isolated" as const,
        directory: "/repo/.freecode/worktrees/ses_1",
        worktree: "/repo/.freecode/worktrees/ses_1",
        branch: "freecode/ses_1",
        resumed: false,
        turnNumber: 1,
      },
      {
        kind: "tool.resolve" as const,
        sessionID: "ses_1",
        tool: "write" as const,
        inputPath: "geom.py",
        cwd: "/repo/.freecode/worktrees/ses_1",
        resolved: "/repo/.freecode/worktrees/ses_1/geom.py",
        external: false,
        callID: "call_1",
      },
      {
        kind: "tool.outcome" as const,
        sessionID: "ses_1",
        tool: "write" as const,
        callID: "call_1",
        outcome: "success" as const,
      },
      {
        kind: "turn.end" as const,
        sessionID: "ses_1",
        outcome: "success" as const,
        turnNumber: 1,
        resumed: false,
      },
      // Turn 2 (resumed): errors out
      {
        kind: "session" as const,
        sessionID: "ses_1",
        agent: "coder",
        mode: "isolated" as const,
        directory: "/repo/.freecode/worktrees/ses_1",
        worktree: "/repo/.freecode/worktrees/ses_1",
        branch: "freecode/ses_1",
        resumed: true,
        turnNumber: 2,
      },
      {
        kind: "turn.end" as const,
        sessionID: "ses_1",
        outcome: "error" as const,
        error: "turn 2 failed",
        turnNumber: 2,
        resumed: true,
      },
    ]
    const result = Verdict.decide(events as any[])
    // The last turn ended in error → ERROR (not OK, which the first turn would have given)
    expect(result.label).toBe("ERROR")
  })

  test("a WRONG_CWD in turn 2 overrides the OK in turn 1", () => {
    const events = [
      {
        kind: "session" as const,
        sessionID: "ses_2",
        agent: "coder",
        mode: "isolated" as const,
        directory: "/repo/.freecode/worktrees/ses_2",
        worktree: "/repo/.freecode/worktrees/ses_2",
        branch: "freecode/ses_2",
        resumed: false,
        turnNumber: 1,
      },
      {
        kind: "tool.resolve" as const,
        sessionID: "ses_2",
        tool: "write" as const,
        inputPath: "a.txt",
        cwd: "/repo/.freecode/worktrees/ses_2",
        resolved: "/repo/.freecode/worktrees/ses_2/a.txt",
        external: false,
        callID: "c1",
      },
      {
        kind: "tool.outcome" as const,
        sessionID: "ses_2",
        tool: "write" as const,
        callID: "c1",
        outcome: "success" as const,
      },
      {
        kind: "turn.end" as const,
        sessionID: "ses_2",
        outcome: "success" as const,
        turnNumber: 1,
      },
      {
        kind: "session" as const,
        sessionID: "ses_2",
        agent: "coder",
        mode: "isolated" as const,
        directory: "/repo/.freecode/worktrees/ses_2",
        worktree: "/repo/.freecode/worktrees/ses_2",
        branch: "freecode/ses_2",
        resumed: true,
        turnNumber: 2,
      },
      // Turn 2: writes to the shared checkout — WRONG_CWD
      {
        kind: "tool.resolve" as const,
        sessionID: "ses_2",
        tool: "write" as const,
        inputPath: "/repo/geom.py",
        cwd: "/repo/.freecode/worktrees/ses_2",
        resolved: "/repo/geom.py",
        external: true,
        callID: "c2",
      },
      {
        kind: "tool.outcome" as const,
        sessionID: "ses_2",
        tool: "write" as const,
        callID: "c2",
        outcome: "success" as const,
      },
      {
        kind: "turn.end" as const,
        sessionID: "ses_2",
        outcome: "success" as const,
        turnNumber: 2,
        resumed: true,
      },
    ]
    const result = Verdict.decide(events as any[])
    expect(result.label).toBe("WRONG_CWD")
  })
})

describe("P0-4 regression: isolation trace fields (resumed + turnNumber)", () => {
  test("prepare records resumed=true and turnNumber on the trace session event", async () => {
    const repository = await makeRepo("trace-fields")
    const traceFile = path.join(ROOT, "trace-fields", "freecode", "trace", `${process.pid}.jsonl`)
    mkdirSync(path.dirname(traceFile), { recursive: true })
    try {
      // Point the trace at a known file and force it on (bypasses XDG_DATA_HOME caching)
      Trace._setCurrentFile(traceFile)
      Trace._setConfigEnabled(true)
      const writable = [{ permission: "edit", pattern: "*", action: "allow" }] as const

      const result = await Effect.runPromise(
        Isolation.prepare({
          repository,
          sessionID: "ses_trace",
          agent: "coder",
          rules: writable,
          policy: "auto",
          resumed: true,
          turnNumber: 3,
          parentSessionID: "ses_parent",
        }),
      )
      expect(result.mode).toBe("isolated")
      expect(result.resumed).toBe(true)

      const lines = readFileSync(traceFile, "utf8").split("\n").filter(Boolean)
      const sessionEvents = lines
        .map((l) => JSON.parse(l))
        .filter((e: any) => e.kind === "session" && e.sessionID === "ses_trace")
      expect(sessionEvents.length).toBeGreaterThan(0)
      const lastSession = sessionEvents[sessionEvents.length - 1]
      expect(lastSession.resumed).toBe(true)
      expect(lastSession.turnNumber).toBe(3)
      expect(lastSession.parentSessionID).toBe("ses_parent")

      await Worktree.discard(
        { id: "ses_trace", directory: result.directory!, branch: result.branch!, repository },
        { deleteBranch: true },
      )
    } finally {
      Trace._setCurrentFile(undefined)
      Trace._setConfigEnabled(false)
      rmSync(repository, { recursive: true, force: true })
      rmSync(ROOT, { recursive: true, force: true })
    }
  })
})
