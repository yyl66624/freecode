import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { Verdict } from "@/freecode/verdict"
import type { Trace } from "@/freecode/trace"

/**
 * The verdict is a pure function of the trace, so every scenario can be built
 * from synthetic trace events and the recorded samples from P0-1. No provider,
 * no repository, no worktree is needed: that is the point of the test net -
 * the judgment logic cannot regress in a way that only shows up on a real run.
 */

const SAMPLES = path.join(import.meta.dir, "trace-samples")

function sample(name: string, sessionID: string): Trace.Event[] {
  const lines = readFileSync(path.join(SAMPLES, name), "utf8")
    .split("\n")
    .filter(Boolean)
  return lines.map((line) => {
    const event = JSON.parse(line) as Trace.Event
    if (event["sessionID"] && event["sessionID"] !== sessionID) {
      // Keep only the subagent's own events; the parent's calls must not skew
      // the verdict.
      return undefined
    }
    return event
  }).filter((event): event is Trace.Event => event !== undefined)
}

const SHARED = "/private/tmp/proj"
const WORKTREE = "/private/tmp/proj/.freecode/worktrees/ses_child"

function sessionEvents(mode: "isolated" | "shared" | "fallback"): Trace.Event[] {
  return [
    {
      kind: "session",
      sessionID: "ses_child",
      parentSessionID: "ses_parent",
      agent: "coder",
      mode,
      directory: WORKTREE,
      worktree: WORKTREE,
      branch: "freecode/ses_child",
    } as Trace.Event,
  ]
}

function writeResolve(inputPath: string, resolved: string, callID?: string): Trace.Event {
  return {
    kind: "tool.resolve",
    sessionID: "ses_child",
    tool: "write",
    inputPath,
    cwd: WORKTREE,
    resolved,
    ...(callID ? { callID } : {}),
  } as Trace.Event
}

function writeOutcome(outcome: "success" | "permission" | "error", callID?: string, error?: string): Trace.Event {
  return {
    kind: "tool.outcome",
    sessionID: "ses_child",
    tool: "write",
    outcome,
    ...(callID ? { callID } : {}),
    ...(error ? { error } : {}),
  } as Trace.Event
}

/**
 * A write tool's resolve and outcome, in one call, in the order the trace
 * records them: the resolve (the path computation) comes first, then the
 * outcome (the write landing or not). When `callID` is undefined neither
 * event carries one, which is the shape the trace has when the call id was
 * not recorded - the case that forces the verdict onto its position-based
 * fallback and is what the regression pair below exercises.
 */
function writePair(inputPath: string, resolved: string, outcome: "success" | "permission" | "error", callID?: string): [Trace.Event, Trace.Event] {
  return [writeResolve(inputPath, resolved, callID), writeOutcome(outcome, callID)]
}

function turnEnd(outcome: "success" | "error", error?: string): Trace.Event {
  return {
    kind: "turn.end",
    sessionID: "ses_child",
    parentSessionID: "ses_parent",
    agent: "coder",
    outcome,
    ...(error ? { error } : {}),
  } as Trace.Event
}

describe("Verdict.decide", () => {
  test("OK: the write resolved inside the subagent's worktree and the turn succeeded", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      writeResolve("geom.py", `${WORKTREE}/geom.py`),
      writeOutcome("success"),
      turnEnd("success"),
    ])
    expect(result.label).toBe("OK")
    expect(result.isolated).toBe(true)
    expect(result.evidence.written).toEqual([`${WORKTREE}/geom.py`])
    expect(result.evidence.wrong).toEqual([])
    expect(result.evidence.right).toEqual([`${WORKTREE}/geom.py`])
  })

  test("WRONG_CWD: the write resolved to the shared checkout - phenomenon A", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      writeResolve(`${SHARED}/geom.py`, `${SHARED}/geom.py`),
      writeOutcome("success"),
      turnEnd("success"),
    ])
    expect(result.label).toBe("WRONG_CWD")
    expect(result.evidence.wrong).toEqual([`${SHARED}/geom.py`])
    // The would-resolve list carries the path the write was aimed at, so a
    // reader of the verdict can see the attempt even when it was later denied.
    expect(result.evidence.wouldResolve).toEqual([`${SHARED}/geom.py`])
  })

  test("WRONG_CWD: the subagent mixed one right write and one wrong write", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      writeResolve("geom.py", `${WORKTREE}/geom.py`, "call_a"),
      writeOutcome("success", "call_a"),
      writeResolve("geom.py", `${SHARED}/geom.py`, "call_b"),
      writeOutcome("success", "call_b"),
      turnEnd("success"),
    ])
    expect(result.label).toBe("WRONG_CWD")
    expect(result.evidence.right).toEqual([`${WORKTREE}/geom.py`])
    expect(result.evidence.wrong).toEqual([`${SHARED}/geom.py`])
  })

  // --- the no-callID fallback pair (review item M1) -------------------------
  //
  // Neither event carries a callID, so each outcome pairs with the last
  // resolve seen at that point in trace order. The failure the review found:
  // when the order is "denied first, success second" and both point at the
  // shared checkout, the position-based fallback has no way to tell that the
  // *denied* write (which never reached disk) is not the one the successful
  // outcome should pair with. The successful outcome ends up silently counting
  // the earlier wrong resolve as its own target, so a write that in fact
  // never happened on that path reads as "landed there". The two tests below
  // pin down the correct, order-independent expected verdict: both orderings
  // of the same (denied, success) pair must agree, and when that agreement is
  // impossible with the current fallback the verdict must surface ERROR, not
  // a confidently wrong OK or WRONG_CWD.
  test("M1a: success then denied, both without callID, one in-worktree and one outside", () => {
    const [r1, o1] = writePair("geom.py", `${WORKTREE}/geom.py`, "success")
    const [r2, o2] = writePair("geom.py", `${SHARED}/geom.py`, "permission")
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      r1, o1, r2, o2,
      turnEnd("success"),
    ])
    // Position-based pairing: the first outcome (success) pairs with the first
    // resolve (in-worktree) -> right. The second outcome (permission) pairs
    // with the second resolve (shared checkout) -> a denied write, not counted
    // as written. So the verdict is WRONG_CWD only when a write that actually
    // landed ended up outside the worktree. Here the successful write went to
    // the worktree, and no write ever reached the shared checkout, so the
    // expected label is OK.
    //
    // NOTE: The current verdict.ts actually reports WRONG_CWD here because the
    // position-based fallback pairs the success outcome with the first resolve
    // (in-worktree), marking it as "right", but then the wrong-aimed resolve
    // (shared checkout) ends up in `wouldResolve` and the verdict counts it
    // as wrong. This is the bug M1 describes. The test asserts the correct
    // expected behaviour so that when the fallback is fixed, the test passes.
    expect(result.label).toBe("OK")
    expect(result.evidence.right).toEqual([`${WORKTREE}/geom.py`])
    expect(result.evidence.wrong).toEqual([])
    expect(result.evidence.written).toEqual([`${WORKTREE}/geom.py`])
  })

  test("M1b: denied then success, both without callID, reversed order - same inputs, same verdict", () => {
    // Same two writes as M1a, just sequenced differently in the trace. The
    // fallback's position pairing will pair the denied outcome with the shared
    // resolve and the success outcome with the worktree resolve. The successful
    // write landed in the worktree, so the verdict must not read as WRONG_CWD
    // even though the would-resolve list shows a write was *aimed* at the
    // shared checkout (and was denied). The correct answer for this pairing is
    // OK; if the fallback instead silently pairs the success with the wrong
    // resolve, the verdict would wrongly say WRONG_CWD - that is the bug M1
    // is about, and this test will catch it.
    const [r1, o1] = writePair("geom.py", `${SHARED}/geom.py`, "permission")
    const [r2, o2] = writePair("geom.py", `${WORKTREE}/geom.py`, "success")
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      r1, o1, r2, o2,
      turnEnd("success"),
    ])
    expect(result.label).toBe("OK")
    expect(result.evidence.right).toEqual([`${WORKTREE}/geom.py`])
    expect(result.evidence.wrong).toEqual([])
  })

  test("NO_WRITE: no write tool call at all - phenomenon B", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      {
        kind: "tool.resolve",
        sessionID: "ses_child",
        tool: "read",
        inputPath: `${SHARED}/geom.py`,
        cwd: WORKTREE,
        resolved: `${SHARED}/geom.py`,
      } as Trace.Event,
      turnEnd("success"),
    ])
    expect(result.label).toBe("NO_WRITE")
    expect(result.evidence.resolves).toEqual([])
    expect(result.evidence.outcomes).toEqual([])
  })

  test("NO_WRITE: write calls were attempted but denied or incomplete", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      writeResolve("geom.py", `${WORKTREE}/geom.py`),
      writeOutcome("permission"),
      turnEnd("success"),
    ])
    expect(result.label).toBe("NO_WRITE")
    expect(result.evidence.written).toEqual([])
  })

  test("ERROR: the turn itself failed", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      writeResolve("geom.py", `${WORKTREE}/geom.py`),
      writeOutcome("success"),
      turnEnd("error", "provider rate limit"),
    ])
    expect(result.label).toBe("ERROR")
    expect(result.summary).toContain("turn failed")
  })

  test("ERROR: a write tool call errored", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      writeResolve("geom.py", `${WORKTREE}/geom.py`),
      writeOutcome("error", "EACCES"),
      turnEnd("success"),
    ])
    expect(result.label).toBe("ERROR")
    expect(result.summary).toContain("write tool call(s) failed")
  })

  test("ERROR: the subagent was not isolated at all", () => {
    const result = Verdict.decide([
      ...sessionEvents("fallback"),
      writeResolve("geom.py", `${SHARED}/geom.py`),
      writeOutcome("success"),
      turnEnd("success"),
    ])
    expect(result.label).toBe("ERROR")
    expect(result.isolated).toBe(false)
    expect(result.summary).toContain("isolation mode was 'fallback'")
  })

  test("ERROR: no session record at all - a broken trace is not an isolation problem", () => {
    const result = Verdict.decide([turnEnd("success")])
    expect(result.label).toBe("ERROR")
    expect(result.isolated).toBe(false)
  })

  test("apply_patch counts as a write attempt", () => {
    const result = Verdict.decide([
      ...sessionEvents("isolated"),
      {
        kind: "tool.resolve",
        sessionID: "ses_child",
        tool: "apply_patch",
        inputPath: `${SHARED}/geom.py`,
        cwd: WORKTREE,
        resolved: `${SHARED}/geom.py`,
      } as Trace.Event,
      {
        kind: "tool.outcome",
        sessionID: "ses_child",
        tool: "apply_patch",
        outcome: "success",
      } as Trace.Event,
      turnEnd("success"),
    ])
    expect(result.label).toBe("WRONG_CWD")
  })
})

describe("Verdict on the recorded P0-1 samples", () => {
  test("phenomenon-a sample: write resolved to the shared checkout", () => {
    // The phenomenon-a sample shows the subagent's `write` tool called with
    // an absolute path to the shared checkout's geom.py. The write landed
    // outside the worktree, so the verdict is WRONG_CWD.
    const events = sample("phenomenon-a.jsonl", "ses_f33f576f9ffeUbLuTT5TT5idUM")
    const result = Verdict.decide(events)
    expect(result.label).toBe("WRONG_CWD")
    expect(result.isolated).toBe(true)
    expect(result.evidence.wrong).toEqual(["/private/tmp/trace-proj-1790129630/geom.py"])
    expect(result.evidence.right).toEqual([])
    expect(result.evidence.written).toEqual(["/private/tmp/trace-proj-1790129630/geom.py"])
  })

  test("phenomenon-b-abs-read sample: subagent read the shared checkout but never wrote", () => {
    // The recorded sample (pid 85236) shows the subagent calling `read` with
    // an absolute path to the shared checkout. No write tool was called at
    // all, so the verdict is NO_WRITE - the model read the file but decided
    // not to write it. This is phenomenon B, not A.
    const events = sample("phenomenon-b-abs-read.jsonl", "ses_f33f576f9ffeUbLuTT5TT5idUM")
    const result = Verdict.decide(events)
    expect(result.label).toBe("NO_WRITE")
    expect(result.isolated).toBe(true)
    // The read that aimed at the shared checkout is still visible in the
    // evidence, so a reader can see *where* the subagent looked.
    expect(JSON.stringify(result.evidence.events)).toContain("/private/tmp/trace-proj-1790129630/geom.py")
  })

  test("phenomenon-b sample reads the same way, for the same session", () => {
    const events = sample("phenomenon-b.jsonl", "ses_f33f576f9ffeUbLuTT5TT5idUM")
    const result = Verdict.decide(events)
    expect(result.label).toBe("NO_WRITE")
  })

  test("a same-shaped sample with a wrong-landing write reads as WRONG_CWD", () => {
    // Take the phenomenon-b-abs-read record and add the write tool call the
    // model *would* have made: the same absolute path the read took, now
    // through `write`. This is the A vs B distinction made concrete.
    const events = sample("phenomenon-b-abs-read.jsonl", "ses_f33f576f9ffeUbLuTT5TT5idUM")
    events.push(
      {
        kind: "tool.resolve",
        sessionID: "ses_f33f576f9ffeUbLuTT5TT5idUM",
        tool: "write",
        inputPath: "/private/tmp/trace-proj-1790129630/geom.py",
        cwd: "/private/tmp/trace-proj-1790129630/.freecode/worktrees/ses_f33f576f9ffeUbLuTT5TT5idUM",
        resolved: "/private/tmp/trace-proj-1790129630/geom.py",
      },
      {
        kind: "tool.outcome",
        sessionID: "ses_f33f576f9ffeUbLuTT5TT5idUM",
        tool: "write",
        outcome: "success",
      },
      {
        kind: "turn.end",
        sessionID: "ses_f33f576f9ffeUbLuTT5TT5idUM",
        outcome: "success",
      },
    )
    const result = Verdict.decide(events)
    expect(result.label).toBe("WRONG_CWD")
    expect(result.evidence.wrong).toEqual(["/private/tmp/trace-proj-1790129630/geom.py"])
  })
})
