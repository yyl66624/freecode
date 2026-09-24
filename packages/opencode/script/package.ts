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
// `pkg.version` is FreeCode's own release version. The upstream OpenCode base is
// recorded separately in UPSTREAM.md, so this string stays a product version rather
// than an encoding of the fork's lineage.
const version = pkg.version as string

const target = `freecode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const outdir = `dist/${target}`
const outfile = `${outdir}/bin/freecode`
await $`rm -rf ${outdir}`
await $`mkdir -p ${outdir}/bin`

// Build provenance: the short HEAD SHA and dirty flag of the source tree this
// binary was compiled from are baked in at compile time so the binary can prove
// its own lineage. `scripts/version.sh check` and `freecode version --json`
// read these back; `scripts/acceptance.sh` refuses to run a binary whose
// build SHA does not match the current source HEAD. This is the stale-binary
// trap from DEVELOPMENT.md, closed at the source rather than detected after
// a confusing failure.
const { execSync } = await import("node:child_process")
let buildSha = "unknown"
let buildDirty = "0"
try {
  const toplevel = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim()
  const sha = execSync(`git -C ${toplevel} rev-parse --short HEAD`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
  buildSha = sha
  const status = execSync(`git -C ${toplevel} status --porcelain`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
  if (status.length > 0) buildDirty = "1"
} catch {
  // not a git checkout or git unavailable — record "unknown"
}

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
    OPENCODE_BUILD_SHA: `'${buildSha}'`,
    OPENCODE_BUILD_DIRTY: buildDirty,
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

console.log(`ok  ${outfile}`)
console.log(`next: ./install.sh`)
