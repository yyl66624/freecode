import { describe, expect, test } from "bun:test"
import { isVanillaDisabled, FREECODE_COMMAND_NAMES } from "../../src/feature-plugins/system/freecode"

/**
 * The vanilla kill switch: `freecode.commands.disable` (and its documented
 * aliases `freecode.harness=vanilla` / `freecode.scheduler.disable`) each
 * turn the plugin's registered command list from four to zero, with no
 * partial state in between.
 */

describe("freecode TUI plugin, vanilla kill switch", () => {
  test("no freecode block in config: commands are registered", () => {
    expect(isVanillaDisabled({})).toBe(false)
    expect(isVanillaDisabled(undefined)).toBe(false)
    expect(FREECODE_COMMAND_NAMES).toHaveLength(4)
  })

  test("freecode.commands.disable removes all four commands", () => {
    expect(isVanillaDisabled({ freecode: { commands: { disable: true } } })).toBe(true)
  })

  test("freecode.harness=vanilla (the other documented spelling) also disables", () => {
    expect(isVanillaDisabled({ freecode: { harness: "vanilla" } })).toBe(true)
  })

  test("freecode.scheduler.disable is accepted too, for consistency with the scheduler's own kill switch", () => {
    expect(isVanillaDisabled({ freecode: { scheduler: { disable: true } } })).toBe(true)
  })

  test("any false-ish value leaves the commands in place", () => {
    expect(isVanillaDisabled({ freecode: { commands: { disable: false } } })).toBe(false)
    expect(isVanillaDisabled({ freecode: { commands: {} } })).toBe(false)
  })
})
