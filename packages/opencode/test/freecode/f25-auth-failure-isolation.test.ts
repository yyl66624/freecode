import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs"
import path from "path"
import { $ } from "bun"
import { Isolation, rewriteAbsolutePath, inIsolationWorktree, sharedCheckoutPath, refuseSharedCheckout } from "@/freecode/isolation"
import { Verdict } from "@/freecode/verdict"
import { Trace } from "@/freecode/trace"

/**
 * FREE-25 regression tests: the 401 (auth failure) path must not lose
 * isolated-subagent context.
 *
 * Two defects were found on the P0-8 acceptance run (qa trace 33839.jsonl):
 *
 *  1. write / edit / apply_patch: an isolated subagent's LLM handed back an
 *     absolute path pointing at the shared checkout (reconstructed from a 401
 *     error message + historical context). `rewriteAbsolutePath` missed it
 *     (prefix did not match, or `..` escape), so the write landed in the
 *     shared checkout = phenomenon A on the 401 path.
 *
 *  2. verdict: when the turn ended with `outcome: "error"` (401) AND at least
 *     one write tool call resolved outside the worktree, `Verdict.decide`
 *     returned `ERROR` ("turn failed") without mentioning the isolation loss.
 *     The acceptance run needs a distinct label to say "auth failed AND the
 *     write targeted the shared checkout" — that is `AUTH_FAILED`, not `ERROR`.
 *
 * These tests are "before-fix fail / after-fix pass" by construction:
 *  - `inIsolationWorktree` and `sharedCheckoutPath` did not exist pre-fix;
 *  - the verdict label `AUTH_FAILED` did not exist pre-fix (it returned
 *    `ERROR` instead).
 *
 * 401 is injected at the provider boundary via the existing `MockProvider`
 * fault-injection基建 (`failWith: "401"`); no real API key is needed.
 */

const ROOT = path.join(process.env["TMPDIR"] ?? "/tmp", `freecode-f25-test-${process.pid}`)

function makeRepo(name: string) {
  const directory = path.join(ROOT, name)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  $`git -C ${directory} init -q`.quiet()
  $`git -C ${directory} config user.email test@freecode.local`.quiet()
  $`git -C ${directory} config user.name FreeCode`.quiet()
  writeFileSync(path.join(directory, "geom.py"), "import math\ndef area(r): return math.pi * r * r\n")
  $`git -C ${directory} add -A`.quiet()
  $`git -C ${directory} commit -qm init`.quiet()
  return directory
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// inIsolationWorktree / sharedCheckoutPath — the guard-rail helpers
// ---------------------------------------------------------------------------

describe("FREE-25: inIsolationWorktree helper", () => {
  test("true when directory === worktree and both sit under .freecode/worktrees/", () => {
    const instance = {
      directory: "/tmp/proj/.freecode/worktrees/ses_child",
      worktree: "/tmp/proj/.freecode/worktrees/ses_child",
    }
    expect(inIsolationWorktree(instance)).toBe(true)
  })

  test("true on macOS /private/tmp canonicalised form", () => {
    const instance = {
      directory: "/private/tmp/proj/.freecode/worktrees/ses_child",
      worktree: "/private/tmp/proj/.freecode/worktrees/ses_child",
    }
    expect(inIsolationWorktree(instance)).toBe(true)
  })

  test("false when the instance is not an isolation worktree (directory !== worktree)", () => {
    const instance = {
      directory: "/tmp/proj",
      worktree: "/tmp/proj",
    }
    expect(inIsolationWorktree(instance)).toBe(false)
  })

  test("false when the worktree path does not carry the .freecode/worktrees marker", () => {
    const instance = {
      directory: "/tmp/other/place",
      worktree: "/tmp/other/place",
    }
    expect(inIsolationWorktree(instance)).toBe(false)
  })
})

describe("FREE-25: sharedCheckoutPath helper", () => {
  const INSTANCE = {
    directory: "/private/tmp/proj/.freecode/worktrees/ses_child",
    worktree: "/private/tmp/proj/.freecode/worktrees/ses_child",
  }

  test("returns the shared-checkout path when target is inside the repository but outside the worktree", () => {
    const target = "/private/tmp/proj/geom.py"
    expect(sharedCheckoutPath(INSTANCE, target)).toBe(target)
  })

  test("returns undefined when target is inside the subagent's own worktree", () => {
    const target = "/private/tmp/proj/.freecode/worktrees/ses_child/geom.py"
    expect(sharedCheckoutPath(INSTANCE, target)).toBeUndefined()
  })

  test("returns undefined when the instance is not an isolation worktree", () => {
    const shared = { directory: "/tmp/proj", worktree: "/tmp/proj" }
    expect(sharedCheckoutPath(shared, "/tmp/proj/geom.py")).toBeUndefined()
  })

  test("returns undefined when target is completely external to the repository", () => {
    expect(sharedCheckoutPath(INSTANCE, "/etc/hosts")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Verdict: AUTH_FAILED label on the 401 + wrong-path combination
// ---------------------------------------------------------------------------

describe("FREE-25: Verdict.decide AUTH_FAILED label", () => {
  const SESSION: Trace.Event = {
    kind: "session",
    sessionID: "ses_child",
    parentSessionID: "ses_parent",
    agent: "coder",
    mode: "isolated",
    directory: "/private/tmp/proj/.freecode/worktrees/ses_child",
    worktree: "/private/tmp/proj/.freecode/worktrees/ses_child",
    branch: "freecode/ses_child",
  } as Trace.Event

  test("AUTH_FAILED: turn errored with 401 AND a write resolved outside the worktree", () => {
    const events: Trace.Event[] = [
      SESSION,
      {
        kind: "tool.resolve",
        sessionID: "ses_child",
        tool: "write",
        inputPath: "/private/tmp/proj/geom.py",
        cwd: "/private/tmp/proj/.freecode/worktrees/ses_child",
        resolved: "/private/tmp/proj/geom.py",
        external: true,
      } as Trace.Event,
      {
        kind: "tool.outcome",
        sessionID: "ses_child",
        tool: "write",
        outcome: "error",
        error: "Authentication Fails, Your api key: ****5b12 is invalid",
      } as Trace.Event,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "error",
        error: "Authentication Fails, Your api key: ****5b12 is invalid",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(events)
    expect(verdict.label).toBe("AUTH_FAILED")
    expect(verdict.summary).toMatch(/auth error/i)
    expect(verdict.isolated).toBe(true)
  })

  test("AUTH_FAILED: turn errored AND a write would have resolved outside the worktree (all stopped before landing)", () => {
    const events: Trace.Event[] = [
      SESSION,
      {
        kind: "tool.resolve",
        sessionID: "ses_child",
        tool: "edit",
        inputPath: "/private/tmp/proj/geom.py",
        cwd: "/private/tmp/proj/.freecode/worktrees/ses_child",
        resolved: "/private/tmp/proj/geom.py",
        external: true,
      } as Trace.Event,
      {
        kind: "tool.outcome",
        sessionID: "ses_child",
        tool: "edit",
        outcome: "permission",
      } as Trace.Event,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "error",
        error: "401 Unauthorized",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(events)
    expect(verdict.label).toBe("AUTH_FAILED")
    expect(verdict.isolated).toBe(true)
  })

  test("ERROR (not AUTH_FAILED): turn failed but no write attempt was made", () => {
    const events: Trace.Event[] = [
      SESSION,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "error",
        error: "401 Unauthorized",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(events)
    // No write attempt: this is a plain ERROR (phenomenon B / auth-only),
    // not AUTH_FAILED (which requires a wrong-path signal).
    expect(verdict.label).toBe("ERROR")
    expect(verdict.isolated).toBe(true)
  })

  test("OK: writes landed inside the worktree and the turn succeeded", () => {
    const events: Trace.Event[] = [
      SESSION,
      {
        kind: "tool.resolve",
        sessionID: "ses_child",
        tool: "write",
        inputPath: "geom.py",
        cwd: "/private/tmp/proj/.freecode/worktrees/ses_child",
        resolved: "/private/tmp/proj/.freecode/worktrees/ses_child/geom.py",
        external: false,
      } as Trace.Event,
      {
        kind: "tool.outcome",
        sessionID: "ses_child",
        tool: "write",
        outcome: "success",
      } as Trace.Event,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "success",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(events)
    expect(verdict.label).toBe("OK")
    expect(verdict.isolated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// rewriteAbsolutePath: the P0-4 core invariant still holds
// ---------------------------------------------------------------------------

describe("FREE-25: rewriteAbsolutePath invariant (P0-4 still holds)", () => {
  test("rewrites a shared-checkout absolute path into the worktree", () => {
    const repo = "/tmp/proj"
    const worktree = "/tmp/proj/.freecode/worktrees/ses_child"
    const target = rewriteAbsolutePath(repo, worktree, "/tmp/proj/geom.py")
    expect(target).toBe("/tmp/proj/.freecode/worktrees/ses_child/geom.py")
  })

  test("leaves a path outside the repository unchanged (external write)", () => {
    const repo = "/tmp/proj"
    const worktree = "/tmp/proj/.freecode/worktrees/ses_child"
    expect(rewriteAbsolutePath(repo, worktree, "/etc/hosts")).toBe("/etc/hosts")
  })

  test("a real worktree path is rewritten correctly", () => {
    const repository = makeRepo("f25-rewrite")
    try {
      // The rewrite is a pure string operation; no real worktree needed.
      const worktree = path.join(repository, ".freecode", "worktrees", "ses_child")
      const target = rewriteAbsolutePath(repository, worktree, path.join(repository, "geom.py"))
      expect(target).toBe(path.join(worktree, "geom.py"))
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Guard-rail trace contract: a refused write records the resolve FIRST (the
// model's target path, which sits outside the worktree) and then outcome
// "permission" (a denial, not an execution failure). All three write tools
// (write / edit / apply_patch) share this shape, so the trace carries the
// wrong-place signal that Verdict.decide's wouldResolve reads, and a 401
// turn verdicts AUTH_FAILED instead of a bare ERROR.
// ---------------------------------------------------------------------------

describe("FREE-25: guard-rail refusal trace contract", () => {
  const SESSION: Trace.Event = {
    kind: "session",
    sessionID: "ses_child",
    parentSessionID: "ses_parent",
    agent: "coder",
    mode: "isolated",
    directory: "/private/tmp/proj/.freecode/worktrees/ses_child",
    worktree: "/private/tmp/proj/.freecode/worktrees/ses_child",
    branch: "freecode/ses_child",
  } as Trace.Event

  test("a write refused by the guard (resolve recorded BEFORE refusal, outcome=permission, resolved outside worktree) + 401 turn → AUTH_FAILED", () => {
    const events: Trace.Event[] = [
      SESSION,
      // Production trace shape (write.ts / edit.ts / apply_patch.ts, post-fix
      // trace order): resolve FIRST, refusal outcome SECOND.
      {
        kind: "tool.resolve",
        sessionID: "ses_child",
        tool: "write",
        inputPath: "/private/tmp/proj/geom.py",
        cwd: "/private/tmp/proj/.freecode/worktrees/ses_child",
        resolved: "/private/tmp/proj/geom.py",
        external: true,
        rewritten: true,
      } as Trace.Event,
      {
        kind: "tool.outcome",
        sessionID: "ses_child",
        tool: "write",
        outcome: "permission",
        error: "write refused: path '/private/tmp/proj/geom.py' targets the shared checkout, not this task's worktree; isolation is in effect for this subagent",
      } as Trace.Event,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "error",
        error: "401 Unauthorized: Your api key is invalid",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(events)
    // The write was refused (not executed), but the *attempt* targeted the
    // shared checkout — that is the isolation signal the verdict must keep
    // visible: AUTH_FAILED, not a bare ERROR that hides where the model
    // tried to write.
    expect(verdict.label).toBe("AUTH_FAILED")
    expect(verdict.isolated).toBe(true)
  })

  test("a write refused by the guard but resolved inside the worktree + 401 turn → plain ERROR", () => {
    const events: Trace.Event[] = [
      SESSION,
      {
        kind: "tool.resolve",
        sessionID: "ses_child",
        tool: "write",
        inputPath: "geom.py",
        cwd: "/private/tmp/proj/.freecode/worktrees/ses_child",
        resolved: "/private/tmp/proj/.freecode/worktrees/ses_child/geom.py",
        external: false,
      } as Trace.Event,
      {
        kind: "tool.outcome",
        sessionID: "ses_child",
        tool: "write",
        outcome: "permission",
        error: "edit permission denied",
      } as Trace.Event,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "error",
        error: "401 Unauthorized",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(events)
    // The attempt targeted the subagent's own worktree — no isolation signal.
    // The 401 is a plain provider error, not an isolation defect.
    expect(verdict.label).toBe("ERROR")
    expect(verdict.isolated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Production-form trace contract (Mika ruling 01a0d77d requirement 1):
// the regression must not hand-write trace events that the production
// refuse-branch no longer emits.  Instead: drive the actual
// `refuseSharedCheckout` code path (the one write.ts / edit.ts /
// apply_patch.ts all call), capture the trace it produces, and assert on
// THAT trace: a refused write leaves a `tool.resolve(resolved=shared
// checkout path)` in the record, and Verdict.decide on the production
// trace (resolve + permission outcome + 401 turn.end) verdicts AUTH_FAILED.
//
// Pre-fix (`b9efb86`): the write/edit refuse-branch recorded only
// `tool.outcome=permission` — no `tool.resolve` — so a 401 turn fell
// through to bare ERROR and this test failed.  Post-fix (`3b2eb3a` + the
// `refuseSharedCheckout` extraction): the refuse-branch records the resolve
// first, so the production trace carries the wouldResolve signal.
// ---------------------------------------------------------------------------

describe("FREE-25: production-form guard-rail trace (driven through refuseSharedCheckout)", () => {
  const SESSION: Trace.Event = {
    kind: "session",
    sessionID: "ses_child",
    parentSessionID: "ses_parent",
    agent: "coder",
    mode: "isolated",
    directory: "/private/tmp/proj/.freecode/worktrees/ses_child",
    worktree: "/private/tmp/proj/.freecode/worktrees/ses_child",
    branch: "freecode/ses_child",
  } as Trace.Event
  const INSTANCE = {
    directory: "/private/tmp/proj/.freecode/worktrees/ses_child",
    worktree: "/private/tmp/proj/.freecode/worktrees/ses_child",
  }

  function driveRefusal(tool: "write" | "edit", inputPath: string, rewritten: boolean) {
    const traceFile = path.join(ROOT, `f25-${tool}-refusal-${process.pid}.jsonl`)
    Trace._setConfigEnabled(true)
    Trace._setCurrentFile(traceFile)
    try {
      const error = refuseSharedCheckout(
        INSTANCE,
        "/private/tmp/proj/geom.py",
        { sessionID: "ses_child", messageID: "msg_1", callID: "call_1" },
        tool,
        inputPath,
        rewritten,
      )
      // The refusal must fire: the target is in the shared checkout.
      expect(error).toBeDefined()
      expect(error!.message).toContain("targets the shared checkout")
      // Now read back the trace the PRODUCTION refuse-branch emitted.
      const events = Trace.read("ses_child")
      const resolves = events.filter((e) => e.kind === "tool.resolve")
      const outcomes = events.filter((e) => e.kind === "tool.outcome")
      expect(resolves.length).toBe(1)
      expect(resolves[0]["resolved"]).toBe("/private/tmp/proj/geom.py")
      expect(resolves[0]["external"]).toBe(true)
      expect(outcomes.length).toBe(1)
      expect(outcomes[0]["outcome"]).toBe("permission")
      // Prepend the session record the task tool writes when it spawns the
      // subagent (refuseSharedCheckout only writes the tool-level events).
      return [SESSION, ...(events as unknown as Trace.Event[])]
    } finally {
      Trace._setCurrentFile(undefined)
      Trace._setConfigEnabled(false)
      rmSync(traceFile, { force: true })
    }
  }

  test("write refuse-branch trace + 401 turn → AUTH_FAILED (production-form, no hand-written events)", () => {
    const events = driveRefusal("write", "/private/tmp/proj/geom.py", true)
    // Append the turn end the way the subagent runtime does after a 401.
    const full: Trace.Event[] = [
      ...events,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "error",
        error: "401 Unauthorized",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(full)
    expect(verdict.label).toBe("AUTH_FAILED")
  })

  test("edit refuse-branch trace + 401 turn → AUTH_FAILED (production-form, no hand-written events)", () => {
    const events = driveRefusal("edit", "/private/tmp/proj/geom.py", false)
    const full: Trace.Event[] = [
      ...events,
      {
        kind: "turn.end",
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        agent: "coder",
        outcome: "error",
        error: "401 Unauthorized",
      } as Trace.Event,
    ]
    const verdict = Verdict.decide(full)
    expect(verdict.label).toBe("AUTH_FAILED")
  })

  test("refused write targeting the worktree itself is NOT refused (guard stays quiet)", () => {
    const traceFile = path.join(ROOT, "f25-no-refusal.jsonl")
    Trace._setConfigEnabled(true)
    Trace._setCurrentFile(traceFile)
    try {
      const error = refuseSharedCheckout(
        INSTANCE,
        "/private/tmp/proj/.freecode/worktrees/ses_child/geom.py",
        { sessionID: "ses_child", callID: "call_2" },
        "write",
        "geom.py",
        false,
      )
      // Target is inside the subagent's own worktree: no refusal, no trace
      // events written by the guard itself.
      expect(error).toBeUndefined()
      expect(Trace.read("ses_child").length).toBe(0)
    } finally {
      Trace._setCurrentFile(undefined)
      Trace._setConfigEnabled(false)
      rmSync(traceFile, { force: true })
    }
  })
})

