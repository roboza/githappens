<img src="apps/desktop/build/icon.svg" width="72" alt="GitHappens logo">

# GitHappens

[![CI](https://github.com/roboza/githappens/actions/workflows/ci.yml/badge.svg)](https://github.com/roboza/githappens/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/roboza/githappens?include_prereleases&label=release)](https://github.com/roboza/githappens/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A cross-platform desktop Git client built around a fast, interactive commit graph. Electron, React and
TypeScript on the outside, the real Git command line doing the work underneath.

**[Download](https://githappens.dev/#download)** · **[Website](https://githappens.dev)** ·
**[Changelog](apps/desktop/CHANGELOG.md)** · **[Specs](specs/README.md)**

## Contents

- [Features](#features)
- [Status](#status)
- [Install](#install)
- [Development](#development)
- [Testing](#testing)
- [Releases](#releases)
- [Cloud features (optional)](#cloud-features-optional)
- [Project layout](#project-layout)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Commit graph:** lanes, ref labels, search and filters, _Jump to HEAD_. Virtualized and canvas
  drawn, so it stays fast on very large histories.
- **Everyday Git:** stage, unstage and discard by file, hunk or line; commit and amend; branches and
  tags; fetch, pull and push with credential prompts and SSH agent support; stashes; clone and init.
- **Undo / redo** for the core actions, backed by a journal.
- **Power operations:** drag and drop to merge, rebase, fast-forward or push; cherry-pick, revert and
  reset; interactive rebase editor; built-in 3-way merge tool or your external one; conflict prediction
  against the target branch with `git merge-tree`.
- **Files:** Monaco diff viewer (unified or split), file history, blame and an in-app editor.
- **Submodules, worktrees and Git LFS.**
- **Integrated terminal** with git autocomplete.
- **Command palette,** keyboard shortcuts, custom keybindings, themes and settings profiles.
- **Bundled Git:** works with no Git installed. It can also use your system Git (2.36+) or a custom path.
- **Secrets stay encrypted** in the OS keychain. Nothing is stored in plain text.

On `main`, not yet in a release: provider integrations (GitHub, GitLab, Bitbucket, Azure DevOps, Jira),
workspaces and the Launchpad, AI features with your own API key, Git Flow, and the optional
[self-hosted cloud](#cloud-features-optional).

## Status

**Beta.** [0.1.0](apps/desktop/CHANGELOG.md) is the first beta and contains Phases 0–3 of the
[roadmap](specs/15-packaging-testing-roadmap.md#8-phased-roadmap) (foundations, read-only viewer,
everyday Git, power operations). Phases 4–6 (integrations, productivity, cloud) are in development on
`main`.

Supported platforms: Windows 10+, macOS 12+ (Apple Silicon and Intel) and Linux (Ubuntu 22.04+ or
equivalent).

## Install

Download an installer from **[githappens.dev](https://githappens.dev/#download)** or
[GitHub Releases](https://github.com/roboza/githappens/releases). There are builds for Windows, macOS
and Linux (AppImage, deb, rpm, tar.gz), each for x64 and arm64 (Apple Silicon). Installed apps update
themselves from the **Stable** or **Preview** channel (_Preferences → Updates_). Only the AppImage
updates itself on Linux; deb, rpm and tar.gz installs show a link to the download page instead.

Builds made without signing secrets are unsigned:

- **Windows:** SmartScreen warns "unrecognized app" → _More info_ → _Run anyway_.
- **macOS:** ad-hoc signed, not notarized. After copying to Applications, run
  `xattr -cr /Applications/GitHappens.app` (or right-click → _Open_) once.
- **Linux:** `chmod +x GitHappens-*.AppImage` (needs `libfuse2`), or install the `.deb` / `.rpm`.

**Command line:** the Windows installer and the deb/rpm packages put a `githappens` command on the
`PATH`. On macOS, or for the AppImage and zip builds, use _Help → Install "githappens" Command in PATH_.
Then `githappens .` or `githappens -p <path>` opens a repository.

## Development

### Requirements

- Node 22+
- pnpm 11 (`corepack enable`)
- Git on `PATH`, for tests and fixtures only. The app itself uses its bundled Git.

### Getting started

```bash
pnpm install        # also downloads the bundled portable Git (dugite) and Electron
pnpm dev            # run the app with hot reload
```

| Command                                  | What it does                                                        |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `pnpm dev`                               | Start the desktop app in development mode                           |
| `pnpm build`                             | Production build of main, preload and renderer (`apps/desktop/out`) |
| `pnpm typecheck`                         | `tsc` for every package                                             |
| `pnpm lint` / `pnpm format`              | ESLint / Prettier (`pnpm format:check` to verify only)              |
| `pnpm test`                              | Unit and integration tests (Vitest) in every package                |
| `pnpm test:coverage`                     | Tests with each package's coverage thresholds (the CI gate)         |
| `pnpm fixtures [name…] [--count=N]`      | Generate fixture repos into `test/fixtures/.repos`                  |
| `pnpm bench`                             | Git engine benchmarks ([docs/performance.md](docs/performance.md))  |
| `pnpm --filter @githappens/desktop dist` | Package installers with electron-builder                            |

The repo is a pnpm workspace driven by [Turborepo](https://turbo.build/). The renderer has no Node
access: everything goes through one typed IPC contract in `apps/desktop/src/shared/ipc`, exposed by the
preload as an allowlisted `window.api`.

## Testing

```bash
pnpm test                                     # Vitest, all packages
pnpm build                                    # e2e runs against the built app
pnpm --filter @githappens/desktop test:e2e    # Playwright end-to-end tests
```

- **Unit and integration tests** run against real Git processes and deterministic fixture repos
  (`linear`, `branchy`, `conflict`, `submodules`, `worktrees`, `lfs`, `huge`, …). Some property tests
  run thousands of random cases; timeouts are longer on CI, where runners are slower.
- **End-to-end tests** launch the Electron app with Playwright. On Linux they need a display and an
  unlocked keyring for the secret-store tests:

  ```bash
  dbus-run-session -- sh -c 'echo -n pw | gnome-keyring-daemon --unlock --components=secrets &&
    GITHAPPENS_PASSWORD_STORE=gnome-libsecret xvfb-run --auto-servernum pnpm --filter @githappens/desktop test:e2e'
  ```

  `GITHAPPENS_PASSWORD_STORE` is needed because Playwright launches Electron with
  `--password-store=basic`, which the secret store (correctly) refuses to use.

- **CI** ([`ci.yml`](.github/workflows/ci.yml)) runs typecheck, lint, format, tests, build and e2e on
  Windows, macOS and Linux, plus a job against the minimum supported Git (2.36). Nightly benchmarks run
  in [`perf.yml`](.github/workflows/perf.yml).

## Releases

GitHub Actions builds every OS and architecture, smoke-tests each package (the packaged app opens a
repo, finds its bundled Git and runs a terminal), then publishes a GitHub release:

| Workflow                    | When                                                                      | Result                                               |
| --------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Nightly** (`nightly.yml`) | 03:00 UTC daily if `main` changed; or Actions → Nightly → Run workflow    | `X.Y.Z-preview.YYYYMMDD` prerelease, Preview channel |
| **Release** (`release.yml`) | Push a tag `vX.Y.Z` matching `apps/desktop/package.json`; or Run workflow | `X.Y.Z` release marked latest, Stable channel        |

Asset names carry no version, so the newest stable build always has the same URL, e.g.
`https://github.com/roboza/githappens/releases/latest/download/GitHappens-Setup-x64.exe`. See
[docs/releases.md](docs/releases.md) for file names, channels and the pipeline.

To cut a release: bump `version` in `apps/desktop/package.json`, add a section to
[`CHANGELOG.md`](apps/desktop/CHANGELOG.md) (shown in-app as "What's new"), commit, then
`git tag v<version> && git push origin v<version>`. Code signing secrets are listed in the header of
`release.yml`.

## Cloud features (optional)

Sign-in, end-to-end encrypted settings sync, organizations, Cloud Patches and team overlap warnings
need a **GitHappens Cloud** server that you host yourself (`services/cloud`). Without one the app is
fully functional and makes no cloud network calls. Conflict warnings against the target branch work
without a server.

### Try it locally

```bash
pnpm install
pnpm --filter @githappens/cloud dev
```

This starts the server on `http://localhost:8787` with an in-memory store (data is lost on restart)
and a development sign-in where any email works without a password. In GitHappens open
**Preferences → Account**, enter `http://localhost:8787`, click **Validate**, save, then sign in with
the developer login.

### Self-host with Docker Compose

1. Copy the example config and edit it:

   ```bash
   cd services/cloud && cp .env.example .env
   ```

   - `GH_DB_PASSWORD`: a long random string for Postgres.
   - `GH_CLOUD_PUBLIC_URL`: the public `https://` address of the server.
   - At least one sign-in method:
     - GitHub, GitLab or Google: create an OAuth app with the callback URL
       `<GH_CLOUD_PUBLIC_URL>/oauth/callback/github` (or `/gitlab`, `/google`), then fill in the
       matching client ID and secret.
     - Email magic links: `GH_CLOUD_MAIL_TRANSPORT=webhook` plus `GH_CLOUD_MAIL_WEBHOOK`.

2. Start Postgres and the server:

   ```bash
   docker compose up -d --build
   ```

3. Put it behind HTTPS. The server speaks plain HTTP, so terminate TLS in a reverse proxy (Caddy,
   nginx, Traefik) and keep `GH_CLOUD_TRUST_PROXY=true`. Plain `http://` is only accepted for
   `localhost`.

4. Back up the database **and** the `/data` volume. `/data` holds the signing keys and the server
   secret that encrypts stored patches; losing it makes them unreadable.

5. In GitHappens open **Preferences → Account**, enter the server URL and sign in. Then you can:
   - turn on **Sync settings** and set a sync passphrase (keep the recovery key it shows);
   - create or join an **Organization** for shared patches and team features;
   - opt in to **Share work footprints** for teammate overlap warnings.

The full environment variable list, key rotation and Postgres-only setup are in
[services/cloud/README.md](services/cloud/README.md).

## Project layout

```
apps/desktop          Electron app
  src/main            main process: IPC handlers, settings & secret stores, git engine
  src/preload         contextBridge → window.api (allowlisted, typed)
  src/shared          IPC contract + settings registry (shared by main/preload/renderer)
  src/renderer        React UI (no Node access; ESLint-enforced)
  e2e                 Playwright end-to-end tests
packages/git          git engine: process runner, parsers, operations, undo journal (spec 02/05)
packages/graph        commit graph layout (spec 04)
packages/providers    GitHub / GitLab / Bitbucket / Azure DevOps / Jira clients + OAuth helpers (spec 10)
packages/launchpad    Launchpad grouping rules, filters, snooze (spec 11)
packages/cloud-api    GitHappens Cloud REST contract + Cloud Patch crypto (spec 14)
services/cloud        self-hostable GitHappens Cloud server (spec 14)
services/oauth-broker OAuth code exchange for providers that need a client secret (spec 10)
test/fixtures         deterministic fixture repo generators (spec 15 §7.2)
specs                 product & engineering specs
docs                  release pipeline and performance notes
website               githappens.dev static site, deployed to GitHub Pages by .github/workflows/pages.yml
```

The [specs](specs/README.md) describe each area in detail. Start with
[`00-overview.md`](specs/00-overview.md).

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/roboza/githappens).

1. Fork and create a branch from `main`.
2. `pnpm install` sets up a Husky pre-commit hook that runs ESLint and Prettier on staged files.
3. Before opening a PR, run `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test`.
4. Add or update tests for behaviour changes. User-visible changes get an entry under
   `## [Unreleased]` in [`CHANGELOG.md`](apps/desktop/CHANGELOG.md).

CI must pass on all three operating systems before merging.

## License

[MIT](LICENSE) © 2026 Robert Oswald and GitHappens contributors.
