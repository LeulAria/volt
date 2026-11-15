# Round 6: launch (A1 cold start, A2 relaunch, the composer on screen)

Status: **draft** (2026-11-15). Branch `e6/launch`, worktree `volt-e5-launch`, from `7f07f73d677`. ADEMark method,
unofficial (shared M4 Max laptop, CDP timing, release builds, `--use-mock-keychain`, no `purge`).

## Summary

- **Finding:** round 5's launch window broke the renderer's V8 code cache. `CodeApplication` moved Chromium's code cache to
  the per-commit folder after the launch window's renderer had already started fetching the 20 MB workbench bundle; the
  switch left every launch compiling the bundle in full (277 ms on the renderer's main thread at load 65, plus 128 ms
  producing a cache entry) and writing a 13 MB entry under a new key that no later launch found (eight entries in one
  profile; the normal path, and every installed Volt before round 5, had one entry, reused). Round 5's after numbers
  carried this regression. Fixed in `a4481680b6d` (path set at `ready`, before the launch window); on a patched round-5
  build the bundle's import after its configuration dropped from about 430 ms to 70 ms (load 64).
- The main bundle is imported while Electron finishes starting (English or a configured locale), its entry exporting
  `main()` for the `ready` handler to call; the two vendored libraries (mermaid, device viewer, 2.3 MB) leave the workbench
  bundle and load on first use; the forced canvas warm-up waits for an idle period.
- Before/after timings: pending (minified before build in progress; see below).

## Before / after

Pending.

| Arm | Test | First window | Composer controls on screen | Ready | Real composer |
|---|---|---|---|---|---|
| before (7f07f73d677) | A2 | | | | |
| after | A2 | | | | |
| before | A1 | | | | |
| after | A1 | | | | |

## Method

Round 5's rig (`scripts/launch/run.ts`, `pair.sh`, `setup.sh`, `summarize.mjs`, round-6 paths), arms under
`~/.volt-r6/launch/apps/<arm>/VOLT.app` with their own HOME and profile (a copy of round 5's seeded five-thread profile),
CDP 9974, the ADEMark replay server on 18994. "First window" is ADEMark's window watcher; "Ready" is the first composer
(the snapshot's text area or the real one) that holds a pair of probe keys typed every 50 ms over CDP; "real composer" the
same for Monaco; new this round, "composer controls on screen" is the first poll where the text box and the send control
(and, when the composer has one, the attach control) have a size, drawn by the snapshot or by the real composer. Rows count
only at a 1-minute load of 14 or less, before and after interleaved.

Exploration tools (`scripts/launch/marks.mjs`, `trace.mjs`, `startup-trace.sh`, `analyze-trace.mjs`): perf marks of main and
renderer on one clock, and Chromium startup traces (`--trace-startup`, allowed on an exploration copy only) that showed the
compile.

## Fixes

### 1. The launch window's page keeps its V8 code cache (`a4481680b6d`)

Cause: `src/main.ts` opened the launch window at `ready`; `CodeApplication.startup` later called
`session.defaultSession.setCodeCachePath(<CachedData>/<commit>/chrome)`. Chromium recreates the code cache backend on that
call; the launch window's renderer, already fetching `workbench.desktop.main.js` through the default `Code Cache` folder,
missed, compiled in full, and produced an entry that landed in the new folder under a key the next launch (which again
looked in the default folder first) never matched.

Evidence: `ud/explore` (a copy of round 5's after2p build and profile): `CachedData/<commit>/chrome/js` held eight 13 MB
entries, one per launch (Nov 14 21:36 to Nov 15 01:00); two launches with `launchWindow.json` removed (normal path) added
none, two with it added two. Startup trace of the launch-window path: `v8.compileModule workbench.desktop.main.js 277.5 ms`
on CrRendererMain, `streamed: false` (not http), no `consumedCacheSize`, `v8.produceModuleCache 128 ms`.

Change: the main entry sets the code cache path at `ready` before opening the launch window; `app.ts` skips its own call
when the global `CODE_CACHE_PATH_APPLIED_KEY` is set (setting it again would recreate the cache under the live renderer).

Check: `ud/explore2` (same build, `out/main.js` patched the same way): entries stop growing after the first launch; the
import after the configuration took 68-72 ms instead of about 430 ms (load 64, three launches).

### 2. The main bundle is imported before `ready` (`a4481680b6d`)

Round 5's A2 marks (quiet): ready 279 ms after t0, launch window 326, page files waited for until 440, main bundle imported
by 518, first window's configuration sent at 573. The import (about 80 ms) sat on the critical path between the launch window
and the configuration. The main entry now resolves the NLS configuration before `ready` when it can (a user locale, or an
English OS locale, which needs no language pack) and imports the bundle while Electron starts; the bundle's entry exports
`main()` instead of running it at import time, and the ready handler calls it. Other locales keep the old order (they need
`app.getLocale()`). Dev-verified on both the normal and the launch-window path.

### 3. Vendored libraries leave the workbench bundle (`595837b335d`)

`agentMermaid.ts` and `deviceLiveStream.ts` import beautiful-mermaid (with elkjs, 1.5 MB) and the device viewer (0.75 MB)
with `import()` on first use, but esbuild (no code splitting) inlined them into `workbench.desktop.main.js`, so their
start-up code ran at every window start: 49 ms inclusive in a renderer startup profile (load 45). They are entry points of
their own now and the desktop bundle keeps them external (`keepSeparate` writes the import relative to the bundle's output
file; checked with esbuild on the dev tree: `import("./contrib/voltAgent/browser/blocks/vendor/beautifulMermaid.js")`, no
elkjs in the bundle). The web bundle is unchanged.

### 4. Canvas warm-up when idle (`ef91e020db6`)

The startup script's `requestIdleCallback` canvas warm-up had a 50 ms timeout; with the workbench bundle coming from the
code cache it fired in the middle of the workbench start (90 ms inclusive in the same profile). Timeout 5 s.

### 5. Dev-only: frame wait fallback (`7caac8cbf8a`)

A dev window covered at start waited 43 s for an animation frame after painting the snapshot; a 50 ms fallback ends it.

### 6. Marks (`3a912ebb52a`)

`code/voltWillStartApp`, `code/voltDidInitAppServices`, `code/voltWillOpenFirstWindow` in `CodeApplication.startup`;
`code/voltWillImportMainBundle` / `code/voltDidImportMainBundle` in the main entry.

## Not done

Pending.

Data: `data/launch/`. Scripts: `scripts/launch/`.
