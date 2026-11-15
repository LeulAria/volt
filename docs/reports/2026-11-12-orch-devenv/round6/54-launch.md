# Round 6: launch (A1 cold start, A2 relaunch, the composer on screen)

Status: **final** (2026-11-15). Branch `e6/launch`, worktree `volt-e5-launch`, from `7f07f73d677`. ADEMark method,
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
- Measured (r6b, three release builds interleaved, n 6 each, loads 4.0-7.5): the final build (`52965cababa`) takes A2
  Ready from 852 to 701 ms, the real composer from 1186 to 877 ms, and keeps the composer controls on screen where they
  were (573 -> 576 ms). A1 Ready 758 -> 669 ms, real composer 1011 -> 843 ms, controls 548 -> 518 ms.
- The intermediate build (`f037d0a63cb`) had made the controls appear later (A2 573 -> 750 ms in r6b, 467 -> 606 in r6a):
  the early main-bundle import let `main()` run at once after `ready` and starve the launch page. `52965cababa` (main()
  waits for the launch page first) **fixed that regression**: controls back to the before level, Ready and real composer
  gains kept.
- A2 Ready (701 ms) is still just above Diri's 0.67 s: round 7's job.

## Before / after

r6b (10:04-10:12, three arms interleaved per rep, 6 A2 then 6 A1, every row at load 4.0-7.5): median ms (n, range).

| Arm | Test | First window | Composer controls on screen | Ready | Real composer |
|---|---|---|---|---|---|
| before (`7f07f73d677`) | A2 | 368 (6, 337-682) | 573 (6, 442-991) | 852 (6, 716-1343) | 1186 (6, 992-1611) |
| after (`f037d0a63cb`) | A2 | 376 (6, 328-697) | 750 (6, 652-1032) | 940 (6, 744-1320) | 1009 (6, 930-1320) |
| **after2 (`52965cababa`, final)** | A2 | 361 (6, 330-551) | **576** (6, 527-861) | **701** (6, 670-1027) | **877** (6, 824-1175) |
| before | A1 | 364 (6, 341-649) | 548 (6, 398-854) | 758 (6, 726-1189) | 1011 (6, 967-1458) |
| after | A1 | 359 (6, 346-416) | 643 (6, 522-839) | 790 (6, 700-1103) | 904 (6, 780-1103) |
| **after2 (final)** | A1 | 356 (6, 346-706) | **518** (6, 489-1174) | **669** (6, 615-1295) | **843** (6, 788-1492) |

r6a (09:16-09:22, before vs `f037d0a63cb` only, loads 4.8-13.7, one after-A1 row over 14 left out): A2 before 348 / 467 /
766 / 1045, after 352 / 606 / 700 / 888; A1 before 356 / 469 / 842 / 1075, after 354 / 624 / 726 / 903 (same columns).
Pooling r6a and r6b, before A2 Ready is 812 ms (n 12, 568-1343): run-to-run spread on this machine is about 50-90 ms
between sessions, which is why only interleaved arms are compared.

Marks (A2 medians, ms from process start): the final build imports the main bundle by 419, the launch page's renderer
starts at 553 (before: 494; `f037d0a63cb`: 728) and paints its snapshot at 576, `main()` runs at 553 (after the page),
the first window's configuration reaches the renderer at 664 (before: 782), workbench started at 984 (before: 1294).

Controls are first drawn by the snapshot picture in every row (text box and send; the snapshot has no attach control, and
no poll saw the real composer's attach control before the real composer itself).

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

### 6. The launch page's preload is not blocked while the app starts (`f037d0a63cb`)

Cause: with the main bundle imported before `ready`, the session's request filter (`app.ts`, `onBeforeRequest`) was
installed while `windowsMainService` did not exist yet; it cancelled the launch page's `modulepreload` of
`workbench.desktop.main.js` (`main.log`: "Blocked vscode-file request"), and the window stayed on its snapshot: two of three
launches of the first after build (`966261e6ba7`) hung. Change: the filter trusts the launch page's renderer
(`isEarlyWindowProcess` in `electron-main/earlyWindow.ts`), before and after a code window adopts it. Unit test
`earlyWindow.test.ts` (10 pass). Check: four warm-ups of the rebuilt app, all started, no "Blocked" line.

### 7. The launch page gets its files before the application starts (`52965cababa`)

Cause: with the import done early, `startup()` called `main()` right after `ready`: the bundle's evaluation and the
application's start held the main thread, so the launch page's files and its picture request waited (renderer start 410 ->
580 ms in r6a; the snapshot came only with the first window's configuration; controls on screen 467 -> 606 ms). Change:
`main()` waits for the launch page (at most `EARLY_PAGE_WAIT_MS`), as the import did in round 5. Result: the table above
(controls 750 -> 576 ms vs `f037d0a63cb`, equal to before; Ready and real composer kept their gains).

### 8. Marks (`3a912ebb52a`)

`code/voltWillStartApp`, `code/voltDidInitAppServices`, `code/voltWillOpenFirstWindow` in `CodeApplication.startup`;
`code/voltWillImportMainBundle` / `code/voltDidImportMainBundle` in the main entry.

## Not done

- A2 Ready is 701 ms, not under Diri's 0.67 s; the first window (~360 ms) did not move. Carried to round 7.
- The controls on screen are the snapshot's picture; the real composer (with the attach control) is at ~880 ms.
- No V8 startup snapshot was tried; main-process services were not deferred past the first window.
- The mermaid/device-viewer split was checked on the after build (separate `vendor/beautifulMermaid.js`, 1.57 MB; bundle
  20.16 -> 17.77 MB; CDP import and `renderMermaidSVG` OK) but its start-up effect was not timed on its own.

Data: `data/launch/` (`r6a-*.jsonl`, `r6b-*.jsonl`, `r6a-summary.txt`, `r6b-summary.txt`). Scripts: `scripts/launch/`.
