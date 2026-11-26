# volt-mobile

Volt for iPhone, iPad and Android (Expo SDK 57): a thin native shell around the Volt workbench
your computer serves. The agent server on the computer serves the same VS Code workbench the
browser gets at `/code/`; the app pairs with the computer, signs a WebView in there and stays out
of the way. Everything you see after pairing (chats, files, terminals, source control, settings)
is the workbench itself, so the phone always matches Volt on the desktop and in the browser.

```sh
npm install                 # also installs ../mobile-widgets' build dependency
npm run ios                 # a debug build + Metro (port 8081)
npm run android
npm run typecheck
npm run build:ios           # standalone simulator .app (JS embedded) in dist/ios
npm run build:android       # standalone .apk (arm64, debug-signed) in dist/android
npm run release:ios         # what CI ships: native build from scratch, in dist/release
npm run release:android
```

Releases build the app in GitHub Actions (`.github/workflows/volt-mobile-build.yml`, signing
secrets and assets in [docs/releasing.md](../../docs/releasing.md#mobile-app)).

## What the shell does

- **Connect screen** (`src/shell/ConnectScreen.tsx`): scan the pairing QR code (the system
  scanner, see below), or type the pairing link, or the address and the one-time code. A
  `volt://pair?url=<pairing link>` deep link opens it with a "Pair with <host>?" confirmation:
  a link from elsewhere never pairs the phone on its own.
- **Workbench** (`src/shell/WorkbenchScreen.tsx`): one `react-native-webview` edge to edge,
  mounted at launch behind the splash and never remounted (only Android's renderer dying
  replaces it). It is painted with the workbench's last background (`volt.shell.theme` in
  AsyncStorage), so there is no white flash; on iOS it stays transparent until the page is
  ready. The page does not pan or zoom; its own panes scroll. When the keyboard shows, the
  WebView ends above it (the page sees a shorter viewport, like a native resize) and the page
  gets a `keyboard` message.
- **Computers sheet** (`src/shell/ComputersSheet.tsx`): every paired computer; switch (the same
  WebView signs in to the other one), pair another, or forget one (its token and catalog entry
  go, and its session cookie is dropped).
- Overlays when the page can't be shown: can't reach the computer (Retry, and again whenever
  the app returns to the foreground), the phone was removed from it (Pair Again), or the
  computer's Volt is too old to serve the workbench.
- **Live Activities and the Dynamic Island** (iOS): `src/state/liveClient.ts` runs a client-core
  `VoltClient` for the active computer once the workbench is ready, and feeds
  `src/state/liveActivities.ts` (the planner from `../mobile-widgets`). Stop on the Lock Screen
  stops the chat. Android never starts it.

## Pairing and signing in

1. On the computer: **Volt Settings › Devices › Pair a Device** (or **Volt: Pair a Phone or
   Browser…**) shows a QR code and a one-time code (10 minutes, one device). Tools on the computer
   can make one too: `POST /api/auth/code` with the agent server's own token
   (`<user data dir>/agentServer/token`) as a bearer, from loopback.
2. The app checks the address with `GET /.well-known/volt/environment`, trades the code for its
   own device token (`POST /api/auth/pair`, kind `mobile` or `tablet`) and keeps it in the keychain
   / keystore (`volt.token.<environmentId>`; the rest of the catalog is `volt.catalog.v1` in
   AsyncStorage). A computer keeps every address it was paired over (LAN, Tailscale).
3. Each launch, every saved address is asked which machine it is (no token sent); the best kind
   that answers with the saved environment id is used, so a token never goes to another machine.
4. No credential goes into a URL the page keeps. When the descriptor says
   `capabilities.shellSignIn`, the WebView loads `GET /api/workbench/session?next=/code/` with
   `Authorization: Bearer <token>`; the server sets the session cookie and redirects to `/code/`.
   Older servers get `/?next=/code/#token=<token>`: the fragment never reaches the network, and
   the sign-in page reads and strips it before posting it to the session route. A 401 there
   means the phone was removed. `capabilities.workbench` false means "update Volt".
5. A page that loses its session is sent to the sign-in page by the server; the shell cancels
   that navigation and signs in again (at most three times a minute).

Navigation: sub-frames load freely; top-frame loads stay on the computer's origin (plus
`about:`, `data:`, `blob:`); any other http, https, mailto or tel link opens in the system
browser, and so do new windows.

## The bridge

`src/shell/bridge.ts` holds the protocol types and the validator; the workbench side is
`src/vs/workbench/contrib/voltAgent/browser/web/voltShellBridge.ts`. Keep the two in step.

Before any of the page's scripts run, the shell sets:

```js
window.__voltShell = { version: 1, platform: 'ios' | 'android', appVersion, insets: { top, right, bottom, left }, computer: { id, label } };
```

Page → shell, `window.ReactNativeWebView.postMessage(JSON.stringify(msg))`:

| `type` | fields | the shell |
| --- | --- | --- |
| `ready` | | hides the splash, starts Live Activities |
| `theme` | `background: '#rrggbb'`, `dark` | paints behind the page, sets the status bar, remembers it |
| `haptic` | `style`: `selection` `light` `medium` `success` `warning` `error` | plays it |
| `openExternal` | `url` (http, https, mailto, tel) | opens the system browser |
| `computers` | | opens the computers sheet |
| `back` | `handled` | answers a native back: unhandled (or no answer in 300 ms) sends the app to the background |
| `signedOut` | | opens the computers sheet (Forget, or tap to sign in again) |

Every message is parsed in a try/catch, must come from the active computer's origin and must
match one of these exactly; anything else is dropped.

Shell → page, `window.__voltShellReceive(msg)`: `insets` (`insets`), `keyboard` (`visible`,
`height`), `back` (Android's back button) and `appState` (`active`).

## The scanner

`modules/volt-scanner` is a local Expo module (autolinked from `./modules`) instead of
expo-camera: `isAvailable()` and `scan()` (the text, or null when cancelled). iOS uses VisionKit's
`DataScannerViewController` (full screen with Cancel; asks for the camera on first use), Android
Google's code scanner from Play services (no camera permission, nothing bundled). Simulators and
devices without Play services have no scanner, and the connect screen hides the button.

## Size

The shell keeps only what it needs: react-native-webview, safe-area-context, SecureStore,
AsyncStorage, splash screen, system UI, haptics, device, constants and the widgets module.
`package.json` keeps Expo's own optional modules out of the binary (`expo.autolinking.exclude`:
DOM components' webview, file system, fonts, keep-awake). Android release builds run R8 and
resource shrinking (`expo-build-properties`), for arm64 only.

## Native builds

Native code is only compiled once per machine for each native fingerprint, a hash of the native
modules, config plugins and `app.json` (`.fingerprintignore` skips the generated `ios/` and
`android/`). Builds are kept in `~/Library/Caches/volt-mobile` (`VOLT_MOBILE_CACHE` moves it) and
shared by every checkout and worktree:

- `npm run ios|android` installs the cached debug build, starts Metro and launches the app, with
  no prebuild, CocoaPods or compile. Without one it builds it and files it; plain
  `npx expo run:ios|android` uses the same cache (`buildCacheProvider` in `app.json`).
  `--rebuild` drops the cached build first; other options (`--device`, …) go to `expo run`.
- `npm run build:ios|android` repacks the cached release build with the current JS
  (`@expo/repack-app`). `--native` forces a native build; `--install` puts the result on the
  booted simulator or the connected device, e.g. `npm run build:ios -- --install`.

A new fingerprint (a native module, a config plugin or `app.json` changed) builds natively. Prebuild
updates `ios/` and `android/` in place (`--no-clean`), so CocoaPods, DerivedData (`ios/build`) and
Gradle's outputs survive; `--rebuild` and `--native` regenerate them from scratch. The compiler
caches are shared too, with the checkout's path mapped out of their keys: Xcode's compilation
cache on iOS, ccache (`brew install ccache`; the NDK picks it up) and Gradle's build cache on
Android.

## Debugging

Debug builds make the WebView inspectable (Safari › Develop on iOS, `chrome://inspect` on
Android) and expose `globalThis.__voltShellDev` in the app's JS runtime (React Native DevTools,
or any CDP client on Metro's `/json/list`): `inject(script)` runs a script in the page,
`messages` lists what the page posted, `state()` shows the address, sign-in attempt, overlay,
keyboard height and insets. To try a message, run
`__voltShellDev.inject("ReactNativeWebView.postMessage(JSON.stringify({type:'computers'}));true;")`.

## How it is built

- `index.ts` / `App.tsx`: the entry and the root (no router): the connect screen, or the
  workbench with the computers sheet and the connect screen over it.
- `src/shell`: the screens, the bridge, sign-in and route choice (`signIn.ts`), the splash and the
  theme.
- `src/state`: the catalog of paired computers (`environments.ts`), Live Activities.
- `../client-core`: pairing links, the pairing call, the catalog and the agent server client
  (shared with the workbench's agent UI). Imported by file so the bundle carries only what the
  shell uses.
