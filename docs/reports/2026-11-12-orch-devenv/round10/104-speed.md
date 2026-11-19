Status: **draft** (17 November; the timed rows are queued behind the shared timing lock, see "Before / after")

# Round 10, area "speed": A2 relaunch and A4 first word

Branch `e10/speed` (worktree `volt-e5-firstword`), from `7312123ce14` (code = the `r8` release build). ADEMark
method, unofficial: CDP timing on a shared M4 Max laptop, replay server on 18997, no `purge`, no screen recording.
No live model turn was used.

## Summary

- **A4 first word: the 719 ms on the board is a rig artifact, not Volt's first word in a project.** Round 7 and
  round 8's launcher passed the arena folder as the last argument, after `--disable-background-timer-throttling`. The
  argument parser reads a path that follows a flag it does not know as that flag's value, so the test window opened
  with no folder ("Select project") and every new chat was a chat without a project. Such a chat runs in a scratch
  folder named from its first message, made at Enter, so no agent can be warm for it: every run paid a cold agent
  start (about 0.5 s). With the folder honoured (first in the arguments; the same state ADEMark's own
  `code <folder>` step gives, checked) a new chat is in the arena project, its agent is warm before Enter, and the
  first word is PENDING ms. Nothing in Volt changed for this number: it is `r8`.
- **A2 relaunch: keys typed while the window appears are now kept** (`12eb40f60c7`). A starting window's page had
  nothing to type into until it had drawn the window's last screen; probe keys that arrived between the page's
  start and that paint went to the empty document and were lost, so "typing accepted" came two more keys after the
  paint. The preload script now keeps plain characters typed from the document's start and the composer's stand-in
  text area takes them when it is made: they are in its first frame and in the real composer afterwards.
  A2 Ready PENDING, A1 PENDING.

## Before / after

PENDING

## Method

PENDING

## Fixes

PENDING

## Not done, floors and choices for the user

PENDING
