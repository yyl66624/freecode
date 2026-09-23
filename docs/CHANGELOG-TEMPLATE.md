# Changelog — FreeCode

<!--
One file per release, named `CHANGELOG-v<semver>.md` at the repository
root. This is the template; copy it, fill the sections, and rename it for
the release. The `release` GitHub release body is generated from this
file, so the content here IS the release notes a user sees — write it for
a user, not a committer.

The sections follow a deliberate order: what changed, what it means for
you, how to get it, how to undo it. The last section is not optional:
every FreeCode release ships a rollback path, and a release note that
does not tell a user how to get back to the previous version is
incomplete.
-->

## What changed

<!-- Bullet list, one line each. Each bullet names the user-visible
     behaviour or capability that moved, not the commit that moved it.
     Group by area when there are more than a handful:

     - **Routing** …
     - **Isolation** …
     - **Providers** …
     - **CLI** …

     A bullet that says "improved performance" is not a bullet; it names
     no behaviour a user can check for, so it goes in a performance
     note or not at all. -->

## What it means for you

<!-- One paragraph. The honest answer is often short: "nothing changes
     unless you were using X, in which case Y now happens instead."
     The reader should be able to finish this section and know whether
     the release is worth taking. -->

## How to get it

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/yyl66624/freecode/main/scripts/install.sh \
  | bash -s -- --from-release
```

Requires: macOS Apple Silicon or Linux x86_64/ARM64, a recent `git`, and
a provider account. `freecode doctor` after installing reports what your
environment has and what is missing.

## How to undo it

<!-- The previous release is retained on the GitHub release page
     permanently; a user who broke on this release downloads the
     previous `freecode-<platform>.tar.gz` and re-runs the installer.
     Write the exact previous version here. -->

Previous version: `v0.x.y` (see the [releases page](https://github.com/yyl66624/freecode/releases) —
previous versions remain downloadable).

To roll back, download the previous archive, verify its `SHA256SUMS`, and
re-run `scripts/install.sh --from-release` — the installer replaces the
binary in place. FreeCode's configuration in `~/.config/freecode` and
data in `~/.local/share/freecode` are independent of the binary, so a
rollback does not touch them.
