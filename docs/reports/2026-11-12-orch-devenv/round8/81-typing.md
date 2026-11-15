Status: **draft** (timed rows pending)

# Round 8, area "typing": A8 typing lag while 5 agents stream

Branch `e8/typing` (worktree `volt-e5-codeintel`), from `3b41bdb483f`. Release arms: `base` =
`~/.volt-r7/min/base/VOLT.app` (`039a70b7208`, before round 7), `r7` = `~/.volt-r8/min/r7/VOLT.app` (`3b41bdb483f`,
this round's base). Dev arms: `before` = `volt-e5-base` (`69073864ed2`, round 7's code), `after` = this branch.
ADEMark's replay server on port 18995, CDP 9985, profiles `~/.volt-r8/typing/ud/<arm>`. ADEMark method, unofficial.

## Summary

PENDING

## Before / after

PENDING

## Method

- **Rig**: `round8/scripts/typing/` (round 7's with round 8 paths). `a8.mjs` is ADEMark's A8: a fresh launch per row
  from a template profile, 5 new chats each sent `replay:stream-<n>` 2 s apart, then 60 probe characters into the
  streaming chat's composer at 250 ms +-20 %. A key with no echo within 2 s is missed. New this round: every row also
  stores the key's time split into Chromium's stages (`stages`: median and p95 per stage), `t3a8.mjs` takes the same
  measure on T3 Code, `exp.mjs` switches one part of the streaming frame off at a time in one launch, `fadecheck.mjs`
  checks the fade's step clock in a live window, `light.mjs` + `framesum.mjs` give the distribution of main frames from
  a trace without stacks, `heavyframes.mjs` says what the long animation frames of a V8 profile hold.
- **What is measured**: Chromium's own EventLatency of each `KEY_PRESSED`: from the key event's creation in the
  browser process to the presentation time of the frame that carries its echo (the swap the OS reports as shown).
- **How that relates to ADEMark's key to pixel**: ADEMark films the screen and takes the first frame whose composer
  pixels changed. This account has no Screen Recording grant (`screencapture -x` fails with "could not create image
  from display"), so `bun bench/cli.ts`'s pixel runner cannot run here. EventLatency leaves out: the time from the
  physical key (or ADEMark's posted event) to the browser process, the display's scan-out after presentation, and the
  recorder's own frame quantisation (a 60 fps recording adds up to 16.7 ms and half of that on average). It also
  depends on the screen: this Mac's panel runs at 120 Hz (a frame every 8.3 ms), ADEMark's board was filmed at 60 Hz
  (TESTS.md A8: "the 60 Hz display"). So a number from this rig is lower than the board's for the same app, and the
  board's 47.9 ms for T3 Code cannot be compared with it directly. For that reason T3 Code was timed here with the
  same rig, same replay streams, same day (`t3a8.mjs`): the comparison below is between those two.
- **Load**: timed rows ran under `~/.volt-r8/timing.lock` at a 1-minute load of 14 or less (recorded per row). Rows
  taken above that are marked and left out of medians.

PENDING
