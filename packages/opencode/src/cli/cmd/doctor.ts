import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { version as freecodeVersion, upstreamVersion } from "@/freecode/freecode"
import { Doctor } from "@/freecode/doctor"

/**
 * `freecode doctor` — one command whose output can be pasted into a bug report.
 *
 * Exits non-zero when something must be fixed, so it is usable from a script as
 * well as by a person.
 */
export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "check that FreeCode's environment is complete",
  builder: (yargs) =>
    yargs.option("json", {
      describe: "emit machine-readable output",
      type: "boolean",
    }),
  handler: Effect.fn("Cli.doctor")(function* (raw: unknown) {
    const args = raw as { json?: boolean }
    const instance = yield* InstanceState.context
    const config = yield* Config.Service
    const cfg = yield* config.get()

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const checks = yield* Effect.promise(() =>
      Doctor.run({
        version: freecodeVersion,
        upstream: upstreamVersion,
        workspace: instance.directory,
        config: cfg,
        providers: Object.keys(providers).sort(),
      }),
    )

    if (args.json) {
      process.stdout.write(JSON.stringify({ checks }, null, 2) + "\n")
    } else {
      const { text, failures } = Doctor.render(checks)
      UI.println(text)
      if (failures > 0) return yield* fail(`${failures} problem(s) must be fixed`)
    }
  }),
})
