<img src="apps/desktop/build/icon.svg" width="72" alt="GitHappens logo">

# GitHappens

A cross-platform desktop Git client built around a fast, interactive commit graph: Electron, React and TypeScript, with the Git command line doing the work.

- **Website:** [githappens.dev](https://githappens.dev).

- **Specs:** [`specs/`](specs/README.md). Start with [`00-overview.md`](specs/00-overview.md), then the roadmap in [`15-packaging-testing-roadmap.md`](specs/15-packaging-testing-roadmap.md).
- **Status:** Phase 0 (Foundations) is complete.

## Requirements

- Node 22+
- pnpm 11 (`corepack enable`)
- Git on `PATH`, for tests and fixtures only. The app itself uses its bundled Git.

## Getting started

```bash
pnpm install        # also downloads the bundled portable Git (dugite) and Electron
pnpm dev            # run the app with hot reload
```

| Command                                      | What it does                                                          |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm dev`                                   | Start the desktop app in development mode                             |
| `pnpm build`                                 | Production build of main, preload and renderer (`apps/desktop/out`)   |
| `pnpm typecheck`                             | `tsc` for every package                                               |
| `pnpm lint` / `pnpm format`                  | ESLint / Prettier                                                     |
| `pnpm test`                                  | Unit and integration tests (Vitest) in every package                  |
| `pnpm --filter @githappens/desktop test:e2e` | Playwright smoke tests against the built app (run `pnpm build` first) |
| `pnpm fixtures [name…] [--count=N]`          | Generate fixture repos into `test/fixtures/.repos`                    |
| `pnpm --filter @githappens/desktop dist`     | Package installers with electron-builder                              |

## Downloads & releases

**Download GitHappens from [githappens.dev](https://githappens.dev/#download).** There are installers
for Windows, macOS (Apple Silicon and Intel) and Linux (AppImage, deb, rpm, tar.gz). Installed apps
update themselves from the Stable or Preview channel (_Preferences → Updates_).

Installers and the update feed are hosted on Cloudflare R2 at `https://downloads.githappens.dev`. The
newest stable build always has the same URLs, e.g.
`https://downloads.githappens.dev/latest/GitHappens-Setup-x64.exe`. See
[docs/releases.md](docs/releases.md) for the bucket layout, the fixed file names, `version.json`, the
required GitHub secrets and the one-time Cloudflare setup.

GitHub Actions builds every OS/arch, smoke-tests each package (the packaged app opens a repo, finds
its bundled git and runs a terminal), then uploads to R2:

| Workflow                    | When                                                                      | Result                                          |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| **Nightly** (`nightly.yml`) | 03:00 UTC daily if `main` changed; or Actions → Nightly → Run workflow    | `X.Y.Z-preview.YYYYMMDD` on the Preview channel |
| **Release** (`release.yml`) | Push a tag `vX.Y.Z` matching `apps/desktop/package.json`; or Run workflow | `X.Y.Z` on the Stable channel and in `latest/`  |

Each run also attaches the files to a GitHub release in this private repo and to the run's
**Artifacts** (`dist-<os>`, kept 14 days), for maintainers only.

To cut a release: bump `apps/desktop/package.json` `version`, add a `CHANGELOG.md` entry, commit, then
`git tag v<version> && git push origin v<version>`.

Unsigned builds (no signing secrets configured — see the header of `release.yml`):

- **Windows:** SmartScreen warns "unrecognized app" → _More info_ → _Run anyway_.
- **macOS:** builds are ad-hoc signed, not notarized. After copying to Applications run
  `xattr -cr /Applications/GitHappens.app` (or right-click → _Open_) once.
- **Linux:** `chmod +x GitHappens-*.AppImage` (needs `libfuse2`), or install the `.deb` / `.rpm`. Only
  the AppImage updates itself; deb/rpm/tar.gz installs get a link to the download page.

**Command line:** the Windows installer and the deb/rpm packages put a `githappens` command on the `PATH`
(on macOS, or for the AppImage/zip, use _Help → Install "githappens" Command in PATH_). Then
`githappens .` or `githappens -p <path>` opens a repository.

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

## Layout

```
apps/desktop          Electron app
  src/main            main process: IPC handlers, settings & secret stores, git engine
  src/preload         contextBridge → window.api (allowlisted, typed)
  src/shared          IPC contract + settings registry (shared by main/preload/renderer)
  src/renderer        React UI (no Node access; ESLint-enforced)
  e2e                 Playwright smoke tests
packages/git          git engine: process runner, parsers, operations, undo journal (spec 02/05)
packages/graph        commit graph layout (spec 04)
packages/providers    GitHub / GitLab / Bitbucket / Azure DevOps / Jira clients + OAuth helpers (spec 10)
packages/launchpad    Launchpad grouping rules, filters, snooze (spec 11)
packages/cloud-api    GitHappens Cloud REST contract + Cloud Patch crypto (spec 14)
services/cloud        self-hostable GitHappens Cloud server (spec 14)
services/oauth-broker OAuth code exchange for providers that need a client secret (spec 10)
test/fixtures         deterministic fixture repo generators (spec 15 §7.2)
specs                 product & engineering specs
```

## Phase 0 deliverables (spec 15 §8)

1. **Monorepo:** pnpm workspaces, Turborepo, electron-vite, React, theme tokens (`--kl-*`), ESLint, Prettier, Husky and CI on all three OSes, plus a job that tests against git 2.36.
2. **Typed IPC:** one contract in `src/shared/ipc`. Handler coverage is checked at compile time. Every call returns `IpcResult<T>`. The preload exposes allowlisted channels only, and untrusted senders are rejected.
3. **Git engine:**
   - `GitLocator` picks bundled git, system git or a custom path, falls back when one fails, resolves the login-shell env and detects features from the git version.
   - `GitProcessRunner` sets the env policy and redaction, runs with no shell, cancels by killing the whole process tree, and handles timeouts, the output buffer cap, a priority-based concurrency cap, streaming and progress parsing.
   - Git's error messages are mapped to the typed error list in spec 02.
4. **Stores:**
   - `SettingsStore` reads a typed registry validated with zod. It writes only non-default values, writes files atomically, backs up corrupt files, runs migrations, and creates the Default profile on first run.
   - `EncryptedFileSecretStore` uses Electron `safeStorage` and encrypts the whole map, so account names aren't in plain text either. It refuses to store anything when no keyring is available.
5. **Fixtures:** `linear`, `branchy`, `conflict(-in-progress)`, `empty`, `bare`, `remote-pair`, `unicode-paths`, `submodules`, `worktrees`, `huge` (fast-import) and `lfs`. All are deterministic.
