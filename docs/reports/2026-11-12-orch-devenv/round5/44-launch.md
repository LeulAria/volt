# Round 5: launch (A1 cold start, A2 relaunch)

Status: **final** (2026-11-14 23:30). Branch `e5/launch`, worktree `volt-e5-launch`, from `9bbb8818c60`. The area's
agent was stopped after its final timed runs (22:54); the coordinator wrote this report from its rows and notes.
ADEMark method, unofficial (shared M4 Max laptop, CDP timing, release builds).

## Summary

- **Relaunch (A2), release builds, load 3.9-7.3, n 4 each, interleaved:** first window **595 to 363 ms**, Ready (first
  composer that takes keys) **944 to 773 ms**, real composer 1,126 to 1,037 ms. Target (under Diri's 0.67 s): **not
  met**.
- **Cold start (A1), n 3 each:** first window **422 to 356 ms**, but Ready **757 to 797 ms** (+40) and the real
  composer **862 to 1,056 ms** (+194): the full workbench starts about 190 ms later, because main now builds the launch
  window before the main bundle and opens its own window later (`willOpenNewWindow` 387 to 563 ms).
- First window target (under 0.29 s): **not met**, and not reachable here by the floor rig's timer: Volt's own Electron
  with an empty main shows a window at a median 441 ms (n 6, load up to 13.8, window watcher, a different timer from
  the CDP rows above).
- Ready in the after build comes from the last screen's picture with a live text area (4 of 4 A2, 3 of 3 A1); the keys
  typed there carry into the real composer.

## What changed

| Commit | Change |
|---|---|
| `ec41f576f82` | Open the last window at Electron `ready`, before the main bundle loads (`bootstrap-window.ts`, adoption in `windowImpl`, early protocol and held IPC, main bundle split) |
| `bd48ebaf054` | The launch window's page paints the last screen's picture before the main bundle (early snapshot channel, `#volt-launch` fragment, modulepreload of the workbench, main waits up to 300 ms for the page) |
| `f9d3d9a5bcd` | Marks around the launch window (`voltWillCreateLaunchWindow`, `voltDidCreateLaunchWindow`, `voltLaunchPageStarted`) |
| `f4f0d4b9b07` | **Fix:** keep the launch window's page. Electron writes `show` into the view's web preferences, so every adoption hint mismatched and the page was reloaded at `willOpenNewWindow`; this is why after1 was slower than before in the r5b pairs |
| `1d0206ba62c` | Exploration switch `VOLT_LAUNCH_EXP` removed |

Unit tests: `earlyWindow.test.ts` (8 pass on the branch).

## Before / after (r5d, the final pairs)

Before = `9bbb8818c60` minified (`~/.volt-r5/min/base`). after2 = `f9d3d9a5bcd` minified. after2p = after2's bundle
with `f4f0d4b9b07` patched into `electron-main/main.js`, which equals the committed code apart from the removed
switch; no clean build of the branch tip was timed. All rows at load 3.9-7.3, `--use-mock-keychain`.

| Arm | Test | First window | Ready | Real composer |
|---|---|---|---|---|
| before | A2 | 595 (n 4, 430-776) | 944 (758-2,031) | 1,126 (834-2,031) |
| after2 | A2 | 380 (n 4, 350-675) | n 0: the rig attached to the discarded launch page | n 0 |
| after2p | A2 | **363** (n 4, 345-913) | **773** (726-1,779) | 1,037 (999-2,281) |
| before | A1 | 422 (n 3, 414-422) | 757 (686-849) | 862 (849-932) |
| after2p | A1 | **356** (n 3, 349-365) | 797 (797-802) | 1,056 (1,050-1,067) |

The first rep of each A2 arm is the slowest (2,031 and 1,779 ms Ready); without it, Ready is 834 (before) and 757
(after2p).

Marks (A2 medians, ms from process origin): renderer start 802 to 416, snapshot painted 830 to 441, workbench main
loaded 966 to 822, workbench started 1,236 to 1,148.

## Earlier pairs (r5b, not for the result)

before vs after1 (`a22a28a6b1a`, without the page fix), 6 A2 pairs at load 5.5-11.0: Ready 1,519 vs 1,646, real
composer 1,889 vs 2,794, snapshot hand-off at 13.3 s in after1 (the 10 s deadline). That was the `show` mismatch fixed
in `f4f0d4b9b07`. The first window time is missing in these rows (the window watcher timed out; display likely asleep).

## Not done

- A clean minified build of the branch tip was not timed (after2p is a string patch of after2).
- Cold start with `sudo purge` first (ADEMark's A1 procedure) was not run.
- The cold-start cost: the workbench starts about 190 ms later on A1. Moving the main bundle import ahead of the
  launch window's creation, or creating the launch window off the critical path, is the next thing to try.

Data: `data/launch/r5d/` (final pairs and log), `data/launch/r5b/` (earlier pairs), `data/launch/floor/` (Electron
floor). Scripts: `scripts/launch/`.
