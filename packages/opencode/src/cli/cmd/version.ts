import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import {
  InstallationVersion,
  InstallationBuildSha,
  InstallationBuildDirty,
} from "@opencode-ai/core/installation/version"
import { version as freecodeVersion, upstreamVersion } from "@/freecode/freecode"

/**
 * `freecode version` — print the binary's identity and build provenance.
 *
 * Without flags, emits the same one-liner as `--version` / `-v` plus the
 * build SHA on a second line. With `--json`, emits a machine-readable object
 * that `scripts/version.sh check` and CI parse:
 *
 *   { "version": "0.4.0", "upstream": "1.18.32", "build_sha": "934475c", "dirty": false }
 *
 * `build_sha` is "unknown" when the binary was built before provenance was
 * introduced; `scripts/acceptance.sh` treats that as a hard failure and tells
 * the user to rebuild. This is the user-facing half of the stale-binary guard
 * (the build-time half is the `OPENCODE_BUILD_SHA` injection in
 * `script/package.ts`).
 */
export const VersionCommand = effectCmd({
  command: "version",
  aliases: ["v"],
  describe: "show FreeCode version and build provenance",
  instance: false,
  builder: (yargs) =>
    yargs.option("json", {
      describe: "emit machine-readable output: {version, upstream, build_sha, dirty}",
      type: "boolean",
    }),
  handler: Effect.fn("Cli.version")(function* (raw: unknown) {
    const args = raw as { json?: boolean }
    const provenance = {
      version: InstallationVersion === "local" ? freecodeVersion : InstallationVersion,
      upstream: upstreamVersion,
      build_sha: InstallationBuildSha,
      dirty: InstallationBuildDirty,
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(provenance, null, 2) + "\n")
    } else {
      UI.println(provenance.version)
      if (provenance.build_sha !== "unknown") {
        UI.println(`build ${provenance.build_sha}${provenance.dirty ? " (dirty)" : " (clean)"}`)
      }
    }
  }),
})
