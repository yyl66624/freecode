export * as FreeCode from "./freecode"

/**
 * Single source of truth for FreeCode's user-visible product identity.
 *
 * Every rebranding seam reads from here instead of hardcoding strings, so the
 * fork's surface stays auditable as one small diff against upstream.
 */
export const Product = {
  /** Executable name shown in help, usage, and shell completion. */
  binary: "freecode",
  /** Human-readable product name used in banners and prompts. */
  name: "FreeCode",
  /** Directory name for the global config root: `~/.config/freecode`. */
  globalConfigDir: "freecode",
  /** Project-local config directory name. */
  projectConfigDir: ".freecode",
} as const

/**
 * Config entry names searched inside a config directory, earliest first.
 *
 * `.opencode` directories answer only to their own name; `.freecode` (and the
 * global root) read all three, so a project can migrate file by file. `config`
 * stays last because upstream also accepts it as a bare legacy filename.
 */
export const configFileNames = ["freecode", "opencode", "config"] as const

/**
 * Project config directory names recognized while walking up from the working
 * directory. `.opencode` remains supported for backward compatibility.
 */
export const projectConfigDirs = [Product.projectConfigDir, ".opencode"] as const

/**
 * FreeCode's release version.
 *
 * The compiled binary carries this in `InstallationVersion`, which is what a user
 * sees from `--version`, `doctor` and bug reports. The upstream OpenCode base is
 * recorded separately in `UPSTREAM.md` and `packages/opencode/package.json`, so the
 * product version does not have to encode the fork's lineage.
 *
 * Must stay in step with `packages/opencode/package.json`.
 */
export const version = "0.4.0"

/** Upstream OpenCode release this fork is based on. Recorded in UPSTREAM.md. */
export const upstreamVersion = "1.18.32"
