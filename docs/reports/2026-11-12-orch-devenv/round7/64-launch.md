# Round 7: launch (A2 relaunch, A1 cold start, the composer on screen)

Status: **draft** (2026-11-15). Branch `e7/launch`, worktree `volt-e5-launch`, from `039a70b7208` (round 6 merged) plus
round 6's final launch report (`e6/launch`). ADEMark method, unofficial (shared M4 Max laptop, CDP timing, release
builds, `--use-mock-keychain`, no `purge`).

## Summary

Round 7 was stopped by the user before its timed runs (see [README.md](README.md)): the fixes are merged, with no before/after rows.

## Before / after

PENDING

## Method

Round 6's rig (`scripts/launch/run.ts`, `pair.sh`, `setup.sh`, `summarize.mjs`, round-7 paths), arms under
`~/.volt-r7/launch/apps/<arm>/VOLT.app` with their own HOME and profile (copies of one seeded five-thread profile), CDP
9974, the ADEMark replay server on 18984. "before" is the shared release build of `039a70b7208`
(`~/.volt-r7/min/base`); "after" is `e7/launch` built the same way (`compile-build-with-mangling`, `minify-vscode`,
`vscode-darwin-arm64-min-ci`) in this area's nested tree, commit stamped, with the base build's built-in extensions copied
in so the two apps differ only by this branch's commits. "First window" is ADEMark's window watcher; "Ready" the first
poll where the composer (the snapshot's text area or the real one) holds a pair of probe keys typed every 50 ms over CDP;
"real composer" the same for Monaco; "composer controls on screen" the first poll where the text box and send control
have a size. Rows count only at a 1-minute load of 14 or less, before and after interleaved rep by rep.

## Fixes

### 1. The launch page's view loads before its window is built (`4e1691b1700`)

PENDING

### 2. The main bundle loads after the launch page has its files, from Node's code cache (`4d799b6ca27`)

PENDING

## Not done

PENDING

Data: `data/launch/`. Scripts: `scripts/launch/`.
