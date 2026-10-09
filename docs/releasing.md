# Releasing Volt

Volt ships three channels. Each one is its own app with its own identity, so all three can be
installed side by side without sharing settings:

| Channel | App | Bundle id | Data folder | Tag | GitHub Release |
| --- | --- | --- | --- | --- | --- |
| stable | Volt | `com.leularia.volt` | `~/.volt` | `v0.0.1` | normal, marked latest |
| beta | Volt Beta | `com.leularia.volt.beta` | `~/.volt-beta` | `v0.0.1-beta.1` | prerelease |
| nightly | Volt Nightly | `com.leularia.volt.nightly` | `~/.volt-nightly` | `nightly` (rolling) | prerelease, re-created each night |

The identities live in `build/volt/qualities.json`. `build/volt/mixin-quality.mjs --channel <c> --version <v>`
applies one to a checkout before a build (product.json name, ids, `quality`, update URL; package.json
version; app icons), the way VS Code's distro mixin does. It rewrites tracked files, so run it in CI only.
Development builds keep the `code-oss` identity and never update.

## Versions

`package.json` holds Volt's version (`0.0.1`). `product.json` keeps `vscodeVersion` (`1.105.1`): at build
time it becomes `productService.version`, which extension compatibility (`engines.vscode`) and
`vscode.version` use, while Volt's own version is `productService.voltVersion` (About, `--version`,
updates, release notes).

## Workflows

| Workflow | Trigger | Channel |
| --- | --- | --- |
| `volt-nightly.yml` | daily at 03:00 UTC (skipped when `main` did not change), or Run workflow | nightly, version `0.0.1-nightly.<UTC yyyymmddhhmm>` |
| `volt-beta.yml` | push a `v*-beta*` tag, or Run workflow | beta |
| `volt-stable.yml` | push a `v*` tag without a `-` suffix, or Run workflow | stable |

All three call `volt-build.yml`:

1. **Compile** (ubuntu): `npm ci`, mixin, built-in extensions, `compile-build-with-mangling`, `minify-vscode`,
   `extensions-ci`. The output is shared with every platform job as the `compilation` artifact.
2. **Package** per platform, with native `node_modules` cached per OS/arch:
   - macOS x64 and arm64 (macos-15), plus a universal app stitched from both: `.zip` (what the updater
     installs) and `.dmg`.
   - Linux x64, arm64 and armhf (cross-built against VS Code's sysroots): `.deb`, `.rpm`, `.tar.gz`.
   - Windows x64 and arm64: user setup, system setup, `.zip`.
3. **Publish**: uploads the assets to the GitHub Release and writes the update feed. It publishes whatever
   built, then fails the run if any platform failed.

Run one by hand with a subset of targets:

```sh
gh workflow run volt-beta.yml -f version=0.0.1-beta.2 -f platforms=darwin-arm64,linux-x64
gh workflow run volt-stable.yml -f publish=false   # build everything, publish nothing
```

Targets: `darwin-x64, darwin-arm64, darwin-universal, linux-x64, linux-arm64, linux-armhf, win32-x64, win32-arm64`.

Asset names are `volt-<channel>-<version>-<os>-<arch>[-user-setup|-system-setup].<ext>`
(`build/volt/release/releaseNaming.mjs`); the docs download page (`apps/docs/src/lib/releases.ts`) parses
the same pattern from the GitHub Releases API.

## Update feed

The publish job commits `<channel>/<platform>.json` to the `volt-update-feed` branch, served at
`https://raw.githubusercontent.com/LeulAria/VOLT/volt-update-feed/<channel>/<platform>.json`. Platform ids
follow VS Code's updater: `darwin`, `darwin-arm64`, `darwin-universal`, `win32-<arch>` (system setup),
`win32-<arch>-user`, `win32-<arch>-archive`, `linux-<arch>`. Each entry has the version, commit, publish
time, the asset to install (`url`, `sha256hash`, `size`), the download for people (`downloadUrl`), the
release URL and its notes. macOS also gets `<platform>.squirrel.json` for Squirrel.Mac, and
`<channel>/latest.json` lists every asset.

The app decides locally (`src/vs/platform/update/common/voltUpdateFeed.ts`): a different commit published
after this build is an update; the same commit or an older build is not, so it never downgrades.

- **macOS**: Squirrel.Mac downloads and installs in the background, then the app offers Restart to Update.
  Builds without a Developer ID signature can't use Squirrel, so they offer the `.dmg` download instead.
- **Windows**: setups download in the background and update in place (Inno + `inno_updater`); zip installs
  offer the download.
- **Linux**: the app notifies and opens the download page.

`update.releaseChannel` (Volt Settings > General > Updates) picks the channel to follow. Another channel is
a separate app, so it is offered as a download instead of replacing the running one. Release notes come from
the GitHub Release body and open after the Volt version changes (`update.showReleaseNotes`). While an
update is available, downloading or ready, the agent sidebar footer shows an update button with the notes.

## Signing secrets

Signing is optional: without these secrets the builds are still published, unsigned (macOS ad-hoc), with a
warning in the run.

| Secret | Used for |
| --- | --- |
| `MACOS_CERTIFICATE` | base64 of the Developer ID Application `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MACOS_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password of that Apple ID |
| `APPLE_TEAM_ID` | the team id of the Developer ID certificate |
| `WINDOWS_CERTIFICATE` | base64 of an Authenticode code-signing `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | password of that `.pfx` |

`GITHUB_TOKEN` is provided by Actions (contents: write for releases and the feed branch). Add the rest with
`gh secret set MACOS_CERTIFICATE < cert.p12.b64` and so on. Unsigned macOS builds need right-click > Open
(or `xattr -cr /Applications/Volt.app`) on first launch, and in-place updates on macOS need the Developer ID
signature.
