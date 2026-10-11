# Releases and downloads

Installers and the auto-update feed are hosted on **GitHub Releases** of
[`roboza/githappens`](https://github.com/roboza/githappens/releases). The website
([githappens.dev](https://githappens.dev/#download)) links the newest stable files through
`https://github.com/roboza/githappens/releases/latest/download/<file>`, which works because every
release uses the same, version-less file names.

> **While the repository is private**, release assets are only visible to signed-in users with access
> to the repository. The website buttons return 404 for everyone else, and installed apps can't check
> for or download updates (the check ends in an error status in _Preferences → Updates_). Everything works once the repository is public; no
> config change is needed.

## Release layout

Each release is tagged `v<version>` (`v0.2.0`, or `v0.2.1-preview.20261010` for nightlies) and
carries:

```
GitHappens-Setup-x64.exe   GitHappens-Setup-arm64.exe     Windows installer (+ .exe.blockmap)
GitHappens-win-x64.zip     GitHappens-win-arm64.zip       Windows portable zip
GitHappens-mac-arm64.dmg   GitHappens-mac-x64.dmg         macOS disk image (+ .dmg.blockmap)
GitHappens-mac-arm64.zip   GitHappens-mac-x64.zip         macOS zip, used by the updater (+ .zip.blockmap)
GitHappens-linux-x86_64.AppImage   GitHappens-linux-arm64.AppImage
GitHappens-linux-amd64.deb         GitHappens-linux-arm64.deb
GitHappens-linux-x86_64.rpm        GitHappens-linux-aarch64.rpm
GitHappens-linux-x64.tar.gz        GitHappens-linux-arm64.tar.gz
latest.yml  latest-mac.yml  latest-linux.yml  latest-linux-arm64.yml      stable releases
preview.yml preview-mac.yml preview-linux.yml preview-linux-arm64.yml     preview (pre)releases
```

The names come from `artifactName` in `apps/desktop/electron-builder.yml`. They contain no version,
and the arch spelling is whatever electron-builder uses for that format (`x86_64`/`amd64`/`x64`,
`arm64`/`aarch64`). arm64 Windows and Linux files only exist when the `GH_ARM_RUNNERS` repository
variable enables those runners.

Stable download links (what the website uses):

| File                | URL                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Windows installer   | `https://github.com/roboza/githappens/releases/latest/download/GitHappens-Setup-x64.exe`         |
| macOS Apple Silicon | `https://github.com/roboza/githappens/releases/latest/download/GitHappens-mac-arm64.dmg`         |
| macOS Intel         | `https://github.com/roboza/githappens/releases/latest/download/GitHappens-mac-x64.dmg`           |
| Linux AppImage      | `https://github.com/roboza/githappens/releases/latest/download/GitHappens-linux-x86_64.AppImage` |
| Linux deb           | `https://github.com/roboza/githappens/releases/latest/download/GitHappens-linux-amd64.deb`       |
| Linux rpm           | `https://github.com/roboza/githappens/releases/latest/download/GitHappens-linux-x86_64.rpm`      |
| Linux tar.gz        | `https://github.com/roboza/githappens/releases/latest/download/GitHappens-linux-x64.tar.gz`      |

`/releases/latest` is the newest release that is neither a draft nor a prerelease, so nightlies never
replace these files. A specific version is at `/releases/download/v<version>/<file>`.

## Stable vs preview

|                  | Stable                           | Preview                                           |
| ---------------- | -------------------------------- | ------------------------------------------------- |
| Version          | `X.Y.Z`                          | `X.Y.Z-preview.YYYYMMDD` (any version with a `-`) |
| GitHub release   | normal release, marked _latest_  | prerelease                                        |
| Update manifests | `latest*.yml`                    | `preview*.yml`                                    |
| Built by         | `release.yml` on a `vX.Y.Z` tag  | `nightly.yml` (through `release.yml`)             |
| App setting      | _Preferences → Updates → Stable_ | _Preferences → Updates → Preview_                 |

The app uses electron-updater's GitHub provider (`publish` in `electron-builder.yml`, baked into the
app as `resources/app-update.yml`). `UpdaterService` (`apps/desktop/src/main/services/updater.ts`)
sets it up per channel:

- **Stable:** `channel = 'latest'`, `allowPrerelease = false`. The updater asks GitHub for
  `/releases/latest` and reads that release's `latest.yml` / `latest-mac.yml` / `latest-linux*.yml`.
  Prereleases are never offered.
- **Preview:** `channel = 'preview'`, `allowPrerelease = true`. The updater reads the releases Atom feed
  and takes the newest release whose tag is a `-preview.N` version, then reads its `preview*.yml`.
  Preview users follow nightlies only. Each nightly is versioned one patch above
  `apps/desktop/package.json`, so it is always newer than the last stable release.
- `allowDowngrade` stays off, so switching from Preview back to Stable waits for a stable version newer
  than the installed preview.

deb/rpm/tar.gz installs can't update themselves. When a new version is out, the app links
`https://github.com/roboza/githappens/releases/latest`, which lists every file.

**Differential updates** (Windows installer, macOS zip, AppImage) still work with version-less names.
electron-updater downloads the new `<file>.blockmap` from the new release and finds the installed
version's blockmap by swapping the version in the tag part of the URL
(`/releases/download/v0.1.0/GitHappens-Setup-x64.exe.blockmap`). It caches it locally after the first
update.

## Release pipeline

`release.yml` (tags `v*`, manual runs, and nightly builds via `workflow_call`):

1. **prepare:** resolves the version and channel (`preview` if the version contains `-`, else
   `latest`) and creates a **draft** release `v<version>` (`--prerelease` for previews).
2. **build** (one job per OS/arch): packages with `--publish never -c.publish.channel=<channel>`,
   checks native modules and bundled git for the target arch, smoke-tests the packaged app, then
   uploads the installers and `.blockmap` files to the draft (`gh release upload --clobber`). Names are
   unique per OS/arch, so parallel jobs never collide. The per-arch `*.yml` manifests go to a workflow
   artifact instead.
3. **publish:** merges the per-arch manifests (`.github/scripts/merge-update-manifests.mjs`: Windows
   x64 + arm64 share `latest.yml`, both macOS builds share `latest-mac.yml`), uploads them, then
   publishes the draft: stable as a normal release marked _latest_, preview as a prerelease. Clients
   never see a release before all its files and manifests are there.

The channel is passed explicitly because electron-builder's GitHub provider ignores
`detectUpdateChannel`. A local `pnpm --filter @githappens/desktop dist` writes `latest*.yml`.

`nightly.yml` builds `X.Y.(Z+1)-preview.YYYYMMDD` from `main` once a day when `main` changed (or on
demand with _force_) by calling `release.yml`.

### Permissions and secrets

Publishing needs only the workflow's own `GITHUB_TOKEN` with `contents: write` (set at the top of
`release.yml` and `nightly.yml`). No other token or download host is involved. The optional signing
and notarization secrets are listed at the top of `release.yml`; without them builds are unsigned.

To cut a release: bump `apps/desktop/package.json` `version`, add a `CHANGELOG.md` entry, commit, then
`git tag v<version> && git push origin v<version>`.
