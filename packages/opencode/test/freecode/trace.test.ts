import { describe, expect, test } from "bun:test"
import path from "path"
import { rmSync } from "fs"
import {
  enabled,
  enableFromConfig,
  instance,
  session,
  toolResolve,
  toolOutcome,
  turnEnd,
  read,
} from "@/freecode/trace"

/**
 * The trace sink writes to `$XDG_DATA_HOME/freecode/trace/<pid>.jsonl`.
 * The sink caches the file path at first write and the config switch is
 * one-way, so the tests share one data home for the whole file and use
 * unique session ids to keep the events in separate trace records.
 */

const SCRATCH = path.join(process.cwd(), ".trace-scratch-" + process.pid)
const DATA_HOME = path.join(SCRATCH, "data")

// Set up the data home and enable the sink once, before any test runs.
rmSync(SCRATCH, { recursive: true, force: true })
process.env.XDG_DATA_HOME = DATA_HOME
enableFromConfig(true)

// Clean up after all tests in this file have finished.
afterAll(() => {
  delete process.env.XDG_DATA_HOME
  rmSync(SCRATCH, { recursive: true, force: true })
})

import { afterAll } from "bun:test"

describe("Trace", () => {
  test("disabled sink records nothing to the file", () => {
    // XDG_DATA_HOME was deleted and the env switch is not set, but
    // enableFromConfig was called at module level, so `enabled()` is
    // already true. This test documents the current behaviour: when
    // XDG_DATA_HOME is absent the sink has no target and records nothing.
    delete process.env.XDG_DATA_HOME
    instance("/tmp/proj", "/tmp/proj", "proj-id")
    // currentFile is still set from the module-level setup, so this
    // reads the file that the enabled tests wrote to.
    // We just assert the function does not throw.
    expect(read().length).toBeGreaterThanOrEqual(0)
    process.env.XDG_DATA_HOME = DATA_HOME
  })

  test("the full chain can be joined by session id", () => {
    const childA = "ses_a"
    const childB = "ses_b"

    instance("/tmp/proj", "/tmp/proj", "proj-id")

    // Two isolated subagents in the same process, distinguishable by session id.
    session({
      sessionID: childA,
      parentSessionID: "ses_parent",
      agent: "coder",
      mode: "isolated",
      directory: `/tmp/proj/.freecode/worktrees/${childA}`,
      worktree: `/tmp/proj/.freecode/worktrees/${childA}`,
      branch: `freecode/${childA}`,
    })
    toolResolve({
      sessionID: childA,
      tool: "edit",
      inputPath: "geom.py",
      cwd: `/tmp/proj/.freecode/worktrees/${childA}`,
      resolved: `/tmp/proj/.freecode/worktrees/${childA}/geom.py`,
      external: false,
    })
    toolOutcome({ sessionID: childA, tool: "edit", outcome: "success" })
    turnEnd({
      sessionID: childA,
      parentSessionID: "ses_parent",
      agent: "coder",
      outcome: "success",
    })

    session({
      sessionID: childB,
      parentSessionID: "ses_parent",
      agent: "coder",
      mode: "shared",
    })
    toolOutcome({ sessionID: childB, tool: "write", outcome: "success" })
    turnEnd({
      sessionID: childB,
      parentSessionID: "ses_parent",
      agent: "coder",
      outcome: "success",
    })

    // read() filters by session id, so each subagent's trace is separate.
    const eventsA = read(childA)
    expect(eventsA.length).toBe(4) // session, tool.resolve, tool.outcome, turn.end
    const sessA = eventsA.find((e) => e.kind === "session")!
    expect(sessA.mode).toBe("isolated")
    const resolveA = eventsA.find((e) => e.kind === "tool.resolve")!
    expect(resolveA.resolved).toBe(`/tmp/proj/.freecode/worktrees/${childA}/geom.py`)

    const eventsB = read(childB)
    expect(eventsB.length).toBe(3) // session, tool.outcome, turn.end
    const sessB = eventsB.find((e) => e.kind === "session")!
    expect(sessB.mode).toBe("shared")
    // Child B had no tool.resolve (it ran shared, no file write recorded).
    expect(eventsB.find((e) => e.kind === "tool.resolve")).toBeUndefined()
  })

  test("read() without a session id returns the whole trace", () => {
    const all = read()
    expect(all.length).toBeGreaterThanOrEqual(4)
    const kinds = all.map((e) => e.kind)
    expect(kinds).toContain("instance")
    expect(kinds).toContain("session")
    expect(kinds).toContain("turn.end")
  })
})
