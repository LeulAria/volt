# Releasing Volt

Volt ships three channels. Each one is its own app with its own identity, so all three can be
installed side by side without sharing settings:

| Channel | App | Bundle id | Data folder | Tag | GitHub Release |
| --- | --- | --- | --- | --- | --- |
| stable | Volt | `com.leularia.volt` | `~/.volt` | `v0.0.3` | normal, marked latest |
| beta | Volt Beta | `com.leularia.volt.beta` | `~/.volt-beta` | `v0.0.3-beta.1` | prerelease |
| nightly | Volt Nightly | `com.leularia.volt.nightly` | `~/.volt-nightly` | `nightly` (rolling) | prerelease, re-created each night |

The identities live in `build/volt/qualities.json`. `build/volt/mixin-quality.mjs --channel <c> --version <v>`
applies one to a checkout before a build (product.json name, ids, `quality`, update URL; package.json
version; app icons), the way VS Code's distro mixin does. It rewrites tracked files, so run it in CI only.
Development builds keep the `code-oss` identity and never update.

## Versions

`package.json` holds Volt's version (`0.0.3`). `product.json` keeps `vscodeVersion` (`1.105.1`): at build
time it becomes `productService.version`, which extension compatibility (`engines.vscode`) and
`vscode.version` use, while Volt's own version is `productService.voltVersion` (About, `--version`,
updates, release notes).

## Workflows

| Workflow | Trigger | Channel |
| --- | --- | --- |
| `volt-nightly.yml` | daily at 03:00 UTC (skipped when `main` did not change), or Run workflow | nightly, version `0.0.3-nightly.<UTC yyyymmddhhmm>` |
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
   - The mobile app, from the start and in parallel (`volt-mobile-build.yml`, see [Mobile app](#mobile-app)):
     Android `.apk` (and `.aab`), iOS simulator `.zip` (and `.ipa`).
3. **Publish**: uploads the assets to the GitHub Release and writes the update feed. It publishes whatever
   built, then fails the run if any platform failed.

Run one by hand with a subset of targets:

```sh
gh workflow run volt-beta.yml -f version=0.0.3-beta.1 -f platforms=darwin-arm64,linux-x64
gh workflow run volt-stable.yml -f publish=false   # build everything, publish nothing
gh workflow run volt-nightly.yml -f platforms=android-arm64,ios-arm64 -f publish=false   # the mobile app only
```

Targets: `darwin-x64, darwin-arm64, darwin-universal, linux-x64, linux-arm64, linux-armhf, win32-x64, win32-arm64,
android-arm64, ios-arm64`.

Asset names are `volt-<channel>-<version>-<os>-<arch>[-user-setup|-system-setup|-simulator].<ext>`
(`build/volt/release/releaseNaming.mjs`); the docs download page (`apps/docs/src/lib/releases.ts`) parses
the same pattern from the GitHub Releases API, for the desktop assets.

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

## Mobile app

`apps/mobile` (Expo) is built by `.github/workflows/volt-mobile-build.yml`, which runs
`apps/mobile/scripts/releaseBuild.mjs` (`npm run release:android|ios` in `apps/mobile` does the same on a Mac).
`volt-build.yml` calls it for the `android-arm64` and `ios-arm64` targets, so every release run carries the
app; it also runs on pull requests that change `apps/mobile`, `apps/mobile-widgets` or `apps/client-core`,
and by hand (`gh workflow run volt-mobile-build.yml`), where the builds are kept as run artifacts only.

| Target | Runner | Assets |
| --- | --- | --- |
| `android-arm64` | ubuntu-latest, JDK 17 | `volt-<channel>-<version>-android-arm64.apk`; with the upload key also `-android-arm64.aab` for Google Play |
| `ios-arm64` | xcode-27 (Xcode 27.1) | `-ios-arm64-simulator.zip` (Release `.app` for simulators on Apple silicon); with the distribution secrets also `-ios-arm64.ipa` |

Native code is always compiled for a release (no repack from the fingerprint cache). The app keeps its own
version (`version` in `apps/mobile/app.json`); the build number (`CFBundleVersion`, `versionCode`) is the minutes
since 1970, so every build is newer than the last on every channel. Every channel ships the same app identity
(`com.voltadk.volt`), so a nightly build installs over a stable one.

Without the Android secrets the APK is signed with the Expo template's public debug key: it installs, but it can't go
to Google Play, and a later build signed with the upload key can't update it in place. Without the iOS secrets
there is no `.ipa`. The `.ipa` is exported for the method its profiles allow: ad hoc (`release-testing`) when they
list devices, `enterprise` for an in-house profile, otherwise `app-store-connect` (upload it to TestFlight with
Transporter). The repository variable `IOS_EXPORT_METHOD` overrides it.

The iOS profiles need the App Group `group.com.voltadk.volt` (Live Activities and widgets share it), one for
`com.voltadk.volt` and one for its widget extension `com.voltadk.volt.widgets`, both for the distribution
certificate's team.

## npm package (`npx volt-run`)

`apps/volt-run` is the npm package that runs Volt in a browser: it opens the profile's agent server, or
starts it from the installed Volt or a downloaded release archive, and opens the browser workbench (see its
[README](../apps/volt-run/README.md)). Each package version is a Volt version and carries that release's
manifest: one runnable archive per platform (dmg on macOS, tar.gz on Linux, zip on Windows) with its SHA-256
from the GitHub release, so `npx volt-run` starts without reading the feed and only runs a checked download.

After a stable release is published, `volt-stable.yml` calls `volt-npm.yml`, which runs
`apps/volt-run/scripts/release.mjs`: it reads the release's assets, runs the package's tests, builds the one-file
bundle with the manifest in it, checks that it runs, packs it and publishes it as `latest` (with provenance).
A version already on npm is skipped, so the job can run again. Betas and nightlies publish by hand under the
`beta` and `nightly` tags: `gh workflow run volt-npm.yml -f version=0.0.7-beta.1 -f channel=beta`.

From the repo root:

```sh
npm --prefix apps/volt-run ci                          # esbuild, once
npm run volt-run:test
npm run volt-run:release -- --version 0.0.6            # dry run: build, test, pack, print the staged folder
npm run volt-run:release -- --version 0.0.6 --publish  # publish (npm login first, or NODE_AUTH_TOKEN)
```

Publishing needs the `NPM_TOKEN` secret, an npm automation token allowed to publish `volt-run`. Without it the
job builds and tests the package and warns instead of publishing.

## Cutting a release

1. Bump `version` in `package.json` and `package-lock.json` (both places at the top of the lock file).
2. Add the version to [`CHANGELOG.md`](../CHANGELOG.md): what was added, changed and fixed, and any known limitation.
3. Write `docs/release-notes/<version>.md`. `build/volt/release/publish.mjs` puts it at the top of the GitHub Release, and Volt
   shows it on its release notes page after the update. It starts with a summary (a one-sentence headline, a
   `✦ https://github.com/LeulAria/volt` line and short `+ ` lines), then a `---` line, then every detail from the changelog and
   the install steps; [`docs/release-notes/0.0.5.md`](release-notes/0.0.5.md) is an example and the `volt-release` skill
   (`.claude/skills/volt-release/SKILL.md`) has the rules. In a dev build, Help > Show Release Notes previews the file. Image
   links in it must be absolute, pinned to the tag, for example
   `https://raw.githubusercontent.com/LeulAria/volt/v<version>/docs/<folder>/<image>.png`.
4. Merge to `main`, then tag the commit and push the tag. A `v*` tag without a suffix starts `volt-stable.yml`; `v*-beta*` starts the beta:

   ```sh
   git tag -a v0.0.3 -m "Volt 0.0.3"
   git push origin v0.0.3
   ```

5. Watch the run (`gh run watch`). When it finishes, check that the release has every asset, that the notes read well, and that
   `volt-update-feed` has a `stable/latest.json` for the new version.

To rehearse without publishing, run the workflow by hand with `publish=false`, optionally for one platform:
`gh workflow run volt-stable.yml --ref <branch> -f publish=false -f platforms=darwin-arm64`.

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
| `ANDROID_KEYSTORE` | base64 of the Android upload keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | password of that keystore |
| `ANDROID_KEY_ALIAS` | alias of the upload key in it |
| `ANDROID_KEY_PASSWORD` | password of that key (empty = the keystore password) |
| `IOS_DISTRIBUTION_CERTIFICATE` | base64 of the Apple Distribution `.p12` |
| `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `IOS_PROVISIONING_PROFILE` | base64 of the `.mobileprovision` for `com.voltadk.volt` |
| `IOS_WIDGETS_PROVISIONING_PROFILE` | base64 of the `.mobileprovision` for `com.voltadk.volt.widgets` |
| `NPM_TOKEN` | npm automation token that may publish `volt-run` (`volt-npm.yml`) |

A new Android upload key: `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
(keep it safe: Google Play only accepts updates signed with it, unless you ask Google to reset it).

`GITHUB_TOKEN` is provided by Actions (contents: write for releases and the feed branch). Add the rest with
`gh secret set MACOS_CERTIFICATE < cert.p12.b64` and so on. Unsigned macOS builds need **Open Anyway**
in System Settings > Privacy & Security (or `xattr -dr com.apple.quarantine /Applications/Volt.app`) on first launch,
and in-place updates on macOS need the Developer ID signature. The install steps users follow are in
[install/README.md](install/README.md).
