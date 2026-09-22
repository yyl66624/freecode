#!/usr/bin/env bun
/**
 * Builds the FreeCode binary for the current platform.
 *
 * Separate from upstream's `script/build.ts` because that one builds every
 * platform, renames the output to `opencode`, and runs a release pipeline
 * FreeCode does not have yet. This builds one binary, names it `freecode`, and
 * fails loudly if the result cannot start.
 *
 *   bun run package      # from packages/opencode
 *
 * Output: dist/freecode/bin/freecode, which `install.sh` then places.
 */

import { $ } from "bun"
import path from "path"

const dir = path.resolve(import.meta.dir, "..")
process.chdir(dir)

const pkg = await Bun.file("./package.json").json()
const version = pkg.version as string

const outfile = "dist/freecode/bin/freecode"
await $`rm -rf dist/freecode`
await $`mkdir -p dist/freecode/bin`

// The Solid transform is needed because the TUI is written with it; without the
// plugin the build fails on JSX it cannot parse.
const { createSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")

// Embedded worker paths must match what the runtime expects. Upstream computes
// these from a `$bunfs` root; the same substitution is used here so a compiled
// binary resolves its own bundled files.
const workerPath = "./src/cli/tui/worker.ts"
const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
const bunfsRoot = process.platform === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

console.log(`building freecode ${version} for ${process.platform}/${process.arch}`)

const result = await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [createSolidTransformPlugin()],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` as never,
    outfile,
    execArgv: [`--user-agent=freecode/${version}`, "--use-system-ca", "--"],
    windows: {},
  },
  files: {
    [treeSitterWorkerPath]: await Bun.file(`./src/cli/tui/${treeSitterWorkerPath}`)
      .text()
      .catch(() => ""),
  },
  entrypoints: ["./src/index.ts", workerPath, treeSitterWorkerPath],
  define: {
    OPENCODE_VERSION: `'${version}'`,
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'local'`,
  },
})

if (!result.success) {
  console.error("build failed")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Smoke test. A binary that builds but cannot start is the failure mode that
// reaches a user, so the build checks it here rather than at install time.
console.log(`smoke testing ${outfile} --version`)
try {
  const output = await $`./${outfile} --version`.text()
  console.log(`  ${output.trim()}`)
} catch (error) {
  console.error("smoke test failed: the binary did not run", error)
  process.exit(1)
}

// The name is the acceptance criterion: the whole point of this script is a
// binary called `freecode`, not `opencode`.
// `--help` writes to stderr (yargs with an empty usage string), so capture both
// streams; reading only stdout sees an empty string and fails a good binary.
const help = await $`./${outfile} --help`.nothrow().quiet()
const helpText = help.stdout.toString() + help.stderr.toString()
if (!helpText.includes("freecode")) {
  console.error("smoke test failed: help output does not name freecode")
  console.error(helpText.slice(0, 400))
  process.exit(1)
}

console.log(`ok  dist/freecode/bin/freecode`)
console.log(`next: ./install.sh`)
