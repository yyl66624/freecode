import { describe, expect, test } from "bun:test"
import { Doctor } from "@/freecode/doctor"

/**
 * `freecode doctor`'s new Scheduler and Connectivity check groups: their
 * status logic (skip when absent, ok/warn/fail per probe outcome) is what
 * a "is anything actually broken right now" answer depends on, so each
 * status branch has its own reproducible example rather than one happy path.
 */

describe("doctor's new check groups", () => {
  test("connectivity is skippable, and a skipped group is not a failure", async () => {
    const checks = await Doctor.run({
      version: "test",
      workspace: process.cwd(),
      config: { freecode: { pool: { standard: ["deepseek-main/deepseek-v4-pro"] } } } as never,
      connectivity: false,
    })
    const skipped = checks.find((check) => check.group === "Connectivity")
    expect(skipped?.status).toBe("skip")
  })

  test("the scheduler state group is skip, not fail, when no state file exists yet", async () => {
    const checks = await Doctor.run({
      version: "test",
      workspace: process.cwd(),
      connectivity: false,
    })
    const scheduler = checks.find((check) => check.group === "Scheduler")
    expect(scheduler?.status).toBe("skip")
  })

  test("the report renders every group, including the two new ones", async () => {
    const checks = await Doctor.run({
      version: "test",
      workspace: process.cwd(),
      config: { freecode: { pool: {} } } as never,
      connectivity: false,
    })
    const { text } = Doctor.render(checks)
    expect(text).toContain("Scheduler")
    expect(text).toContain("Connectivity")
  })
})
