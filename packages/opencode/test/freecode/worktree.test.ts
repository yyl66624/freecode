import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from "fs"
import path from "path"
import { $ } from "bun"
import { Worktree } from "@/freecode/worktree"
import { Isolation } from "@/freecode/isolation"
import { Effect } from "effect"

/**
 * These tests drive real `git worktree` on a real temporary repository, because
 * every interesting failure here is a git behaviour rather than a logic bug:
 * whether an untracked file appears in a diff, whether an empty task creates a
 * noise commit, whether a conflicted merge leaves the repository broken.
 */

const ROOT = path.join(process.env["TMPDIR"] ?? "/tmp", `freecode-worktree-${process.pid}`)

async function repo(name: string): Promise<string> {
  const directory = path.join(ROOT, name)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  await $`git -C ${directory} init -q`.quiet()
  await $`git -C ${directory} config user.email test@freecode.local`.quiet()
  await $`git -C ${directory} config user.name FreeCode`.quiet()
  writeFileSync(path.join(directory, "README.md"), "# project\n")
  await $`git -C ${directory} add -A`.quiet()
  await $`git -C ${directory} commit -qm init`.quiet()
  return directory
}

async function withRepo<T>(name: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await repo(name)
  try {
    return await run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("worktree lifecycle", () => {
  test("creates an isolated checkout on its own branch", async () => {
    await withRepo("create", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_test1" })
      expect(info).toBeDefined()
      expect(existsSync(path.join(info!.directory, "README.md"))).toBe(true)
      expect(info!.branch).toBe("freecode/ses_test1")
      expect(info!.directory).toContain(path.join(".freecode", "worktrees"))

      const branches = await $`git -C ${repository} branch --list`.quiet()
      expect(branches.stdout.toString()).toContain("freecode/ses_test1")
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })

  test("reuses the same worktree for the same task, so resumed work is still there", async () => {
    await withRepo("reuse", async (repository) => {
      const first = await Worktree.create({ repository, id: "ses_resume" })
      writeFileSync(path.join(first!.directory, "resumed.txt"), "work in progress\n")

      const second = await Worktree.create({ repository, id: "ses_resume" })
      // `create` hands out resolved paths, which on macOS differ from the logical
      // path when the temp directory is reached through `/tmp`.
      expect(second!.directory).toBe(realpathSync(first!.directory))
      expect(existsSync(path.join(second!.directory, "resumed.txt"))).toBe(true)
      await Worktree.discard(first!, { deleteBranch: true })
    })
  })

  test("gives concurrent tasks separate directories", async () => {
    await withRepo("concurrent", async (repository) => {
      const a = await Worktree.create({ repository, id: "ses_a" })
      const b = await Worktree.create({ repository, id: "ses_b" })
      expect(a!.directory).not.toBe(b!.directory)

      // The point of the whole feature: one task's write is invisible to the other.
      writeFileSync(path.join(a!.directory, "only-a.txt"), "a\n")
      expect(existsSync(path.join(b!.directory, "only-a.txt"))).toBe(false)
      expect(existsSync(path.join(repository, "only-a.txt"))).toBe(false)

      await Worktree.discard(a!, { deleteBranch: true })
      await Worktree.discard(b!, { deleteBranch: true })
    })
  })

  test("refuses to create one outside a git repository", async () => {
    const plain = path.join(ROOT, "plain")
    rmSync(plain, { recursive: true, force: true })
    mkdirSync(plain, { recursive: true })
    try {
      expect(await Worktree.available(plain)).toBe(false)
      expect(await Worktree.create({ repository: plain, id: "ses" })).toBeUndefined()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test("removes a dirty worktree, because a task's worktree is routinely dirty", async () => {
    await withRepo("discard", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_dirty" })
      writeFileSync(path.join(info!.directory, "uncommitted.txt"), "dirty\n")
      expect(await Worktree.discard(info!)).toBe(true)
      expect(existsSync(info!.directory)).toBe(false)
      expect(await Worktree.list(repository)).toEqual([])
    })
  })

  test("lists only the worktrees it created", async () => {
    await withRepo("list", async (repository) => {
      expect(await Worktree.list(repository)).toEqual([])
      const info = await Worktree.create({ repository, id: "ses_listed" })
      expect(await Worktree.list(repository)).toEqual([realpathSync(info!.directory)])
      // A worktree the user created by hand is not FreeCode's to report.
      const manual = path.join(repository, "manual-wt")
      await $`git -C ${repository} worktree add -q -b manual ${manual} HEAD`.quiet()
      expect(await Worktree.list(repository)).toEqual([realpathSync(info!.directory)])
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })
})

describe("reviewing a task's work", () => {
  test("reports modified and newly created files, including untracked ones", async () => {
    await withRepo("diff", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_diff" })
      writeFileSync(path.join(info!.directory, "README.md"), "# project\nmore\n")
      writeFileSync(path.join(info!.directory, "brand-new.txt"), "new\n")

      const changes = await Worktree.diff(info!)
      const files = changes.map((change) => change.file).sort()
      // A review that omitted the new file would be worse than no review.
      expect(files).toContain("README.md")
      expect(files).toContain("brand-new.txt")

      const readme = changes.find((change) => change.file === "README.md")
      expect(readme?.added).toBe(1)
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })

  test("reports no changes for a task that did nothing", async () => {
    await withRepo("noop", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_noop" })
      expect(await Worktree.diff(info!)).toEqual([])
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })

  test("produces a patch that includes untracked files", async () => {
    await withRepo("patch", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_patch" })
      writeFileSync(path.join(info!.directory, "added.txt"), "hello\n")
      const patch = await Worktree.patch(info!)
      expect(patch).toContain("added.txt")
      expect(patch).toContain("+hello")
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })
})

describe("merging a task's work", () => {
  test("merges a task's changes into the repository", async () => {
    await withRepo("merge", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_merge" })
      writeFileSync(path.join(info!.directory, "feature.txt"), "feature\n")

      const result = await Worktree.merge(info!)
      expect(result.merged).toBe(true)
      expect(existsSync(path.join(repository, "feature.txt"))).toBe(true)

      // `--no-ff` so the isolated work keeps its own commit in history.
      const log = await $`git -C ${repository} log --oneline`.quiet()
      expect(log.stdout.toString()).toContain("freecode: ses_merge")
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })

  test("refuses to merge without committing, because that is the user's call", async () => {
    await withRepo("dirty", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_dirtyrepo" })
      writeFileSync(path.join(info!.directory, "task.txt"), "task\n")
      writeFileSync(path.join(repository, "uncommitted-by-user.txt"), "user\n")

      const result = await Worktree.merge(info!)
      expect(result.merged).toBe(false)
      expect(result.reason).toContain("uncommitted changes")
      // The user's own uncommitted file must survive untouched.
      expect(existsSync(path.join(repository, "uncommitted-by-user.txt"))).toBe(true)
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })

  test("aborts a conflicting merge instead of leaving the repository half-merged", async () => {
    await withRepo("conflict", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_conflict" })
      writeFileSync(path.join(info!.directory, "README.md"), "# task version\n")
      // The same line changes in the parent, which is what makes the merge conflict.
      writeFileSync(path.join(repository, "README.md"), "# parent version\n")
      await $`git -C ${repository} commit -qam parent-change`.quiet()

      const result = await Worktree.merge(info!)
      expect(result.merged).toBe(false)
      expect(result.reason).toContain("conflicted")
      expect(result.conflicts).toContain("README.md")

      // No merge in progress, and the user's version intact.
      const status = await $`git -C ${repository} status --porcelain`.quiet()
      expect(status.stdout.toString()).not.toContain("UU")
      expect(await Bun.file(path.join(repository, "README.md")).text()).toBe("# parent version\n")
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })

  test("does not create a noise commit for a task that changed nothing", async () => {
    await withRepo("emptymerge", async (repository) => {
      const info = await Worktree.create({ repository, id: "ses_empty" })
      const before = (await $`git -C ${repository} rev-list --count HEAD`.quiet()).stdout.toString().trim()

      const result = await Worktree.merge(info!)
      expect(result.merged).toBe(false)
      expect(result.reason).toContain("no changes")

      const after = (await $`git -C ${repository} rev-list --count HEAD`.quiet()).stdout.toString().trim()
      expect(after).toBe(before)
      await Worktree.discard(info!, { deleteBranch: true })
    })
  })
})

describe("isolation policy", () => {
  const writable = [{ permission: "*", pattern: "*", action: "allow" }]
  const readOnly = [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ]

  test("a write agent is detected from its permission rules", () => {
    expect(Worktree.canWrite(writable)).toBe(true)
    expect(Worktree.canWrite(readOnly)).toBe(false)
    expect(Worktree.canWrite(undefined)).toBe(true)
  })

  test("an agent that denies everything is treated as a reader", () => {
    expect(Worktree.canWrite([{ permission: "*", pattern: "*", action: "deny" }])).toBe(false)
  })

  test("auto isolates writers and shares readers", () => {
    expect(Worktree.shouldIsolate({ mode: undefined, canWrite: true, policy: "auto" })).toBe(true)
    expect(Worktree.shouldIsolate({ mode: undefined, canWrite: false, policy: "auto" })).toBe(false)
  })

  test("an explicit agent preference wins over the policy's inference", () => {
    expect(Worktree.shouldIsolate({ mode: "shared", canWrite: true, policy: "auto" })).toBe(false)
    expect(Worktree.shouldIsolate({ mode: "isolated", canWrite: false, policy: "auto" })).toBe(true)
    // `never` is a user override and outranks the agent's own request.
    expect(Worktree.shouldIsolate({ mode: "isolated", canWrite: true, policy: "never" })).toBe(false)
  })

  test("always isolates even a reader", () => {
    expect(Worktree.shouldIsolate({ mode: undefined, canWrite: false, policy: "always" })).toBe(true)
  })

  test("defaults to auto when no policy is configured", () => {
    expect(Worktree.shouldIsolate({ mode: undefined, canWrite: true, policy: undefined })).toBe(true)
    expect(Worktree.shouldIsolate({ mode: undefined, canWrite: false, policy: undefined })).toBe(false)
  })

  test("prepare returns a shared Result rather than failing when isolation is not wanted", async () => {
    const result = await Effect.runPromise(
      Isolation.prepare({
        repository: "/nonexistent",
        sessionID: "ses_skip",
        agent: "explore",
        rules: readOnly,
        policy: "auto",
      }),
    )
    expect(result.mode).toBe("shared")
    expect(result.directory).toBeUndefined()
  })

  test("prepare falls back to the shared checkout when the project is not a git repository", async () => {
    // The subagent must still run. Refusing to start would be a worse outcome
    // than the concurrency risk isolation exists to avoid.
    const plain = path.join(ROOT, "nogit")
    rmSync(plain, { recursive: true, force: true })
    mkdirSync(plain, { recursive: true })
    try {
      const result = await Effect.runPromise(
        Isolation.prepare({
          repository: plain,
          sessionID: "ses_nogit",
          agent: "coder",
          rules: writable,
          policy: "auto",
        }),
      )
      expect(result.mode).toBe("fallback")
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test("prepare creates a worktree for a writer", async () => {
    await withRepo("prepare", async (repository) => {
      const result = await Effect.runPromise(
        Isolation.prepare({
          repository,
          sessionID: "ses_prepare",
          agent: "coder",
          rules: writable,
          policy: "auto",
        }),
      )
      expect(result.mode).toBe("isolated")
      expect(result.directory).toBeDefined()
      expect(existsSync(result.directory!)).toBe(true)
      await Worktree.discard(
        { id: "ses_prepare", directory: result.directory!, branch: result.branch!, repository },
        { deleteBranch: true },
      )
    })
  })
})

describe("identifier handling", () => {
  test("sanitizes an id into something git accepts as a ref", () => {
    expect(Worktree.sanitize("ses_abc123")).toBe("ses_abc123")
    expect(Worktree.sanitize("a b/c")).toBe("a-b-c")
    expect(Worktree.sanitize("..")).toBe("task")
    expect(Worktree.sanitize("")).toBe("task")
  })

  test("location and branch agree on the same id", () => {
    const directory = Worktree.location("/repo", "ses_x")
    expect(directory).toBe(path.join("/repo", ".freecode", "worktrees", "ses_x"))
    expect(Worktree.branchName("ses_x")).toBe("freecode/ses_x")
    expect(Worktree.idFor("ses_x")).toBe("ses_x")
  })
})
