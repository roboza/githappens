# Releases and downloads

The source repository is private, so GitHub Releases can't serve public downloads or auto-updates.
Installers and the auto-update feed are hosted on **Cloudflare R2** instead and served at
**`https://downloads.githappens.dev`** (an R2 custom domain). The website
([githappens.dev](https://githappens.dev/#download)) links the fixed-name files below.

GitHub Actions still attaches every build to a GitHub release in the private repo. That release is
only an internal record; nothing user-facing depends on it.

## Bucket layout

```
releases/                          electron-updater generic feed (stable + preview)
  GitHappens-Setup-<v>-x64.exe       Windows installer (+ .exe.blockmap for differential updates)
  GitHappens-Setup-<v>-arm64.exe     (only when Windows arm64 is built, see GH_ARM_RUNNERS)
  GitHappens-<v>-win-<arch>.zip      Windows portable zip
  GitHappens-<v>-mac-<arch>.dmg      macOS disk image, x64 + arm64 (+ .dmg.blockmap)
  GitHappens-<v>-mac-<arch>.zip      macOS zip, used by the updater (+ .zip.blockmap)
  GitHappens-<v>-linux-x86_64.AppImage
  GitHappens-<v>-linux-amd64.deb
  GitHappens-<v>-linux-x86_64.rpm
  GitHappens-<v>-linux-x64.tar.gz
  GitHappens-<v>-linux-arm64.AppImage / -arm64.deb / -aarch64.rpm / -arm64.tar.gz   (Linux arm64)
  latest.yml  latest-mac.yml  latest-linux.yml  latest-linux-arm64.yml      stable channel manifests
  preview.yml preview-mac.yml preview-linux.yml preview-linux-arm64.yml     preview channel manifests
latest/                            fixed-name copies of the newest STABLE build
  GitHappens-Setup-x64.exe   GitHappens-Setup-arm64.exe
  GitHappens-win-x64.zip     GitHappens-win-arm64.zip
  GitHappens-mac-arm64.dmg   GitHappens-mac-x64.dmg
  GitHappens-mac-arm64.zip   GitHappens-mac-x64.zip
  GitHappens-linux-x86_64.AppImage   GitHappens-linux-arm64.AppImage
  GitHappens-linux-amd64.deb         GitHappens-linux-arm64.deb
  GitHappens-linux-x86_64.rpm        GitHappens-linux-aarch64.rpm
  GitHappens-linux-x64.tar.gz        GitHappens-linux-arm64.tar.gz
  version.json
preview/                           the same fixed names for the newest nightly (preview) build
```

`<v>` is the version (`0.2.0`, or `0.2.1-preview.20261010` for nightlies). The fixed name is the
versioned name with `-<v>` removed, so the arch spelling is whatever electron-builder uses for that
format (`x86_64`/`amd64`/`x64`, `arm64`/`aarch64`). arm64 Windows and Linux files only exist when the
`GH_ARM_RUNNERS` repository variable enables those runners.

Both channels share `releases/`. electron-updater reads `<channel>[-mac|-linux|-linux-arm64].yml` from
the feed URL in `apps/desktop/electron-builder.yml` (`publish.url`, baked into the app as
`app-update.yml`); the app's Stable/Preview setting picks `latest` or `preview`. Preview users read
only `preview*.yml`. Each nightly is versioned one patch above `apps/desktop/package.json`, so it is
always newer than the last stable release.

### version.json

`latest/version.json` (and `preview/version.json`) describe the files in that folder, for a website
that wants to show the version or build its buttons:

```json
{
  "version": "0.2.0",
  "channel": "latest",
  "date": "2026-10-10T03:00:00.000Z",
  "files": {
    "linux-x64-appimage": "https://downloads.githappens.dev/latest/GitHappens-linux-x86_64.AppImage",
    "linux-x64-deb": "https://downloads.githappens.dev/latest/GitHappens-linux-amd64.deb",
    "linux-x64-rpm": "https://downloads.githappens.dev/latest/GitHappens-linux-x86_64.rpm",
    "linux-x64-tar.gz": "https://downloads.githappens.dev/latest/GitHappens-linux-x64.tar.gz",
    "mac-arm64-dmg": "https://downloads.githappens.dev/latest/GitHappens-mac-arm64.dmg",
    "mac-arm64-zip": "https://downloads.githappens.dev/latest/GitHappens-mac-arm64.zip",
    "mac-x64-dmg": "https://downloads.githappens.dev/latest/GitHappens-mac-x64.dmg",
    "mac-x64-zip": "https://downloads.githappens.dev/latest/GitHappens-mac-x64.zip",
    "windows-x64-exe": "https://downloads.githappens.dev/latest/GitHappens-Setup-x64.exe",
    "windows-x64-zip": "https://downloads.githappens.dev/latest/GitHappens-win-x64.zip"
  }
}
```

Keys are `<windows|mac|linux>-<x64|arm64>-<exe|zip|dmg|appimage|deb|rpm|tar.gz>`. Only files that were
built are listed: with arm64 runners enabled, `windows-arm64-exe`, `linux-arm64-deb` and the rest
appear too. A stale fixed-name file from an older release (for example after arm64 builds are turned
off) stays in the bucket but drops out of `version.json`.

### Upload order and caching

`.github/scripts/upload-r2.mjs` (the `r2` job of `release.yml`) checks that every file a manifest
points at was built, then uploads in this order so a client never reads a manifest that points at a
missing file:

| Order | Objects                                        | `Cache-Control`                       |
| ----- | ---------------------------------------------- | ------------------------------------- |
| 1     | `releases/` versioned artifacts + `.blockmap`  | `public, max-age=31536000, immutable` |
| 2     | `latest/` or `preview/` fixed-name copies      | `public, max-age=300`                 |
| 3     | `latest/version.json` / `preview/version.json` | `no-cache, max-age=0`                 |
| 4     | `releases/` channel manifests (`*.yml`)        | `no-cache, max-age=0`                 |

Run it locally with `--dry-run` to print the `aws s3 cp` commands without uploading:

```bash
node .github/scripts/upload-r2.mjs --version 0.2.0 --channel latest \
  --dist <dir with installers> --manifests <dir with merged *.yml> --dry-run
```

## Release pipeline

- **Release** (`release.yml`): pushing a tag `vX.Y.Z` builds every OS/arch with `--publish never`,
  checks the arch of native modules and bundled git, smoke-tests the packaged app, merges the per-arch
  update manifests (`merge-update-manifests.mjs`), publishes the internal GitHub release, then
  uploads to R2 (stable channel, `latest/`).
- **Nightly** (`nightly.yml`): builds `X.Y.(Z+1)-preview.YYYYMMDD` from `main` through `release.yml`
  with `-c.publish.channel=preview`, giving `preview*.yml` manifests and the `preview/` folder.

The channel comes from the version: any prerelease version (`x.y.z-…`) goes to `preview`, anything
else to `latest`. electron-builder.yml sets `channel: latest`, and `release.yml` passes
`-c.publish.channel=<channel>` for every build (an explicit channel turns off electron-builder's
`detectUpdateChannel`).

### GitHub secrets and variables

Settings → Secrets and variables → Actions:

| Name                       | Kind               | Value                                                                           |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `R2_ACCOUNT_ID`            | secret             | Cloudflare account ID (the endpoint is `https://<id>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY_ID`         | secret             | Access Key ID of the R2 API token                                               |
| `R2_SECRET_ACCESS_KEY`     | secret             | Secret Access Key of the R2 API token                                           |
| `R2_BUCKET`                | variable or secret | Bucket name, e.g. `githappens-downloads`                                        |
| `GITHAPPENS_DOWNLOADS_URL` | variable, optional | Public base URL. Default: `https://downloads.githappens.dev`                    |

Without the four `R2_*` values the `r2` job prints a notice and uploads nothing; the rest of the
release still runs, so forks and CI without secrets build normally. The signing secrets are listed at
the top of `release.yml`.

**Changing the download domain:** set `GITHAPPENS_DOWNLOADS_URL` (for example
`https://dl.example.com`). CI then builds with `-c.publish.url=<that>/releases` and `version.json` uses
it. No code change is needed. The default lives in one place: `publish.url` in
`apps/desktop/electron-builder.yml`. Installed apps keep checking the feed URL they were built with,
so keep the old domain serving `releases/` until users have updated.

## One-time Cloudflare setup

1. **Create the bucket.** Cloudflare dashboard → R2 Object Storage → _Create bucket_. Name it (for
   example `githappens-downloads`) and leave the location on Automatic.
2. **Connect the public domain.** Open the bucket → _Settings_ → _Public access_ → _Custom Domains_ →
   _Connect Domain_ → `downloads.githappens.dev`. The `githappens.dev` zone must be on Cloudflare; the
   dashboard creates the DNS record. Wait for the status to show _Active_. Leave the `r2.dev`
   subdomain disabled.
3. **Optional: CORS**, only if the website fetches `version.json` from the browser: bucket →
   _Settings_ → _CORS policy_, allow `GET` from `https://githappens.dev`.
4. **Create an API token.** R2 Object Storage → _Manage R2 API Tokens_ (API → _Manage API tokens_) →
   _Create API token_: permission **Object Read & Write**, _Apply to specific buckets only_ → your
   bucket, no expiry or one you'll rotate. Copy the **Access Key ID** and **Secret Access Key** (shown
   once) and note your **Account ID**.
5. **Add the GitHub secrets and variables** from the table above to the `githappens` repository.
6. **Test it.** Run _Actions → Nightly → Run workflow_ with _force_. Then check that
   `https://downloads.githappens.dev/releases/preview.yml` and
   `https://downloads.githappens.dev/preview/version.json` load.

The R2 custom domain serves objects with the `Cache-Control` set at upload. Cloudflare's edge cache
honours it, so replaced manifests and `version.json` are re-validated on every request and fixed-name
installers refresh within 5 minutes. You don't need a cache rule. If you add one, don't let it
override origin cache headers for `*.yml` and `version.json`.
