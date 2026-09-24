declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_BUILD_SHA: string
  const OPENCODE_BUILD_DIRTY: number
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

/**
 * Build provenance, injected by script/package.ts at compile time: the short
 * source HEAD SHA this binary was built from, plus the dirty flag of that
 * tree. "unknown" means the tree was not a git checkout at build time, or the
 * binary predates this field (every old binary must be rebuilt exactly once
 * to gain provenance).
 */
export const InstallationBuildSha =
  typeof OPENCODE_BUILD_SHA === "string" && OPENCODE_BUILD_SHA !== "" ? OPENCODE_BUILD_SHA : "unknown"
export const InstallationBuildDirty = typeof OPENCODE_BUILD_DIRTY === "number" ? OPENCODE_BUILD_DIRTY === 1 : false
