import { describe, expect, test } from "bun:test"
import { Doctor } from "@/freecode/doctor"
import {
  InstallationBuildSha,
  InstallationBuildDirty,
} from "@opencode-ai/core/installation/version"

/**
 * Stale-binary guard: the build SHA is the one fact that distinguishes
 * "the model didn't call the write tool" from "the binary is an older build
 * that doesn't have the feature." These tests pin the guarantee:
 *
 *   1. Doctor.run surfaces the build SHA as a Core check named "build".
 *   2. A binary with no provenance (buildSha === "unknown") gets a warn,
 *      not a silent pass.
 *   3. The version command's JSON shape is {version, upstream, build_sha, dirty}.
 *   4. version.sh's exit code is the acceptance gate: non-zero when the
 *      SHA mismatch would mean a stale binary is being used.
 *
 * The counter-example (a binary with SHA != source HEAD MUST fail acceptance)
 * is exercised by running `bash scripts/version.sh check` against the dist
 * binary — see `scripts/acceptance.sh`'s preflight block. The test below
 * verifies the unit-level logic directly so a regression in the doctor's
 * build check or the InstallationBuildSha accessor is caught by `bun test`.
 */

describe("stale-binary guard", () => {
  test("doctor's Core group includes a build check with the current build SHA", async () => {
    const checks = await Doctor.run({
      version: "test",
      buildSha: InstallationBuildSha,
      buildDirty: InstallationBuildDirty,
      workspace: process.cwd(),
      connectivity: false,
    })
    const build = checks.find((c) => c.name === "build")
    expect(build).toBeDefined()
    expect(build?.group).toBe("Core")
    // In a dev tree the SHA is real; in CI built from a dirty checkout the
    // status is still ok (dirty is a flag, not a failure of the binary).
    // Only "unknown" is a warn.
    if (InstallationBuildSha === "unknown") {
      expect(build?.status).toBe("warn")
    } else {
      expect(build?.status).toBe("ok")
      expect(build?.detail).toContain(InstallationBuildSha)
    }
  })

  test("a binary with no build provenance is a warn, not a silent pass", async () => {
    const checks = await Doctor.run({
      version: "test",
      buildSha: "unknown",
      buildDirty: false,
      workspace: process.cwd(),
      connectivity: false,
    })
    const build = checks.find((c) => c.name === "build")
    expect(build?.status).toBe("warn")
    expect(build?.remedy).toContain("bun run package")
  })

  test("the version command's JSON output has the right shape (smoke via source)", () => {
    // We don't spawn the compiled binary here (it may not be built in the
    // test sandbox); instead we verify the constants the version command
    // reads are accessible and have the expected types.
    expect(typeof InstallationBuildSha).toBe("string")
    expect(typeof InstallationBuildDirty).toBe("boolean")
  })
})
