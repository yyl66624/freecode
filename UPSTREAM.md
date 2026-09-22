# FreeCode — Upstream Record

FreeCode is a **minimally invasive fork of OpenCode**, not a reimplementation of a
coding agent. This file is the authoritative record of what we forked, when, and
what we deliberately do *not* change.

## Upstream

| Field | Value |
| --- | --- |
| Upstream project | OpenCode (`anomalyco/opencode`) |
| Upstream version | `1.18.32` (`packages/opencode/package.json`) |
| Base commit SHA | `e027eb570ba2b6d4affa1e4da59af4701d89dac9` |
| Base tag (local) | `freecode-upstream-base` |
| Base branch (local) | `freecode-upstream` |
| Working branch | `freecode-main` |
| Local checkout | `opencode-dev/` |
| License | MIT (`opencode-dev/LICENSE`) |

> The checkout in this workspace was obtained as a source archive, not a git
> clone. `git init` was therefore run locally and the entire tree was committed
> as one baseline commit so that every FreeCode change is an auditable diff
> against a frozen upstream. The base commit SHA above identifies **our** freeze
> commit; it is not an upstream commit id.

## Re-syncing with upstream

Because the base is a local commit, upstream updates are pulled in by diffing
against a freshly fetched upstream tree rather than by `git pull`:

```sh
cd opencode-dev
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream
git diff --stat upstream/dev -- packages/opencode/src/freecode   # our additions
```

FreeCode keeps all of its own logic under `packages/opencode/src/freecode/` and a
small number of clearly marked seam edits elsewhere, so an upstream rebase is a
review of those seams plus a directory copy.

## What FreeCode owns

- Automatic model resolution (`model: auto` → capability tier → concrete model)
- Laya routing bridge (local MLX/PyTorch System-1 decision model)
- Provider account profiles (one provider → many accounts)
- Quota / health tracking, circuit breaking
- Resource scheduling and scoring
- Failure classification and automatic fallback

## What upstream keeps owning (do not reimplement)

- Agent harness, agent/subagent definitions, Task tool
- Session, context assembly, compaction
- Tool registry, permissions
- MCP, LSP
- CLI / TUI / server / SDK

## Rebranding scope (deliberately narrow)

The first release changes only the user-visible surface:

- binary name → `freecode`
- product name and TUI branding
- global config path → `~/.config/freecode`
- project config dir → `.freecode/`

Internal package names (`@opencode-ai/*`) are **intentionally left unchanged**.
Renaming them would produce thousands of lines of diff for zero functional gain
and would make every future upstream rebase painful.

## License obligations

Upstream is MIT. FreeCode retains the original `LICENSE` and copyright notices,
and this file plus `NOTICE` record the provenance of the fork.

## Where to look for what

| File | Contents |
| --- | --- |
| `UPSTREAM.md` | provenance, rebase procedure, rebranding scope |
| `DEVELOPMENT.md` | measurements, traps, and verified results from building the fork |
| `packages/opencode/src/freecode/` | every FreeCode-owned module |
| `packages/opencode/src/freecode/router/` | the Python Laya bridge and the TS client |

