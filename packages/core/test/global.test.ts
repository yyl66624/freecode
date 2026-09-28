import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "freecode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("OpenCode's own roots stay separate, for the read-only fallback", () => {
    // FREE-30 reads these; nothing may ever write them, so they must not
    // collapse onto FreeCode's roots even when the names look similar.
    expect(Global.Path.opencodeConfig).not.toBe(Global.Path.config)
    expect(Global.Path.opencodeData).not.toBe(Global.Path.data)
    expect(path.basename(Global.Path.opencodeConfig)).toBe("opencode")
    expect(path.basename(Global.Path.opencodeData)).toBe("opencode")
    expect(Global.make().opencodeConfig).toBe(Global.Path.opencodeConfig)
    expect(Global.make().opencodeData).toBe(Global.Path.opencodeData)
  })
})
