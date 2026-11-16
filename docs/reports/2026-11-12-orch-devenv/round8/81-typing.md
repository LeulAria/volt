Status: **final** (release `r8` rows taken by the coordinator on 16 November, under "Final rows on the release builds")

# Round 8, area "typing": A8 typing lag while 5 agents stream

Branch `e8/typing` (worktree `volt-e5-codeintel`), from `3b41bdb483f`. Release arms: `base` =
`~/.volt-r7/min/base/VOLT.app` (`039a70b7208`, before round 7), `r7` = `~/.volt-r8/min/r7/VOLT.app` (`3b41bdb483f`,
this round's base). Dev arms: `before` = `volt-e5-base` (`69073864ed2`, round 7's code), `after` = this branch.
ADEMark's replay server on port 18995, CDP 9985, profiles `~/.volt-r8/typing/ud/<arm>`. ADEMark method, unofficial.

## Summary

While 5 chats stream, a key typed in the front chat's composer reaches the screen about one 120 Hz refresh sooner:
key-to-presentation p50 31.85 -> 25.9 ms, p95 36.85 -> 35.55 ms (dev builds, medians of 6 interleaved rows each, 60
keys per row, 0 missed; pooled over 360 keys per arm: p50 31.6 -> 25.7, p95 37.3 -> 35.8). T3 Code on the same rig,
streams and day: p50 24.85, p95 35.25 (2 rows; pooled 24.8 / 36.5), and its reply does not stream during the probe
(its paragraph mode holds the text), so that is its idle floor. **Volt now ties T3 Code on this measure, it does not
clearly beat it**: p95 35.55 vs 35.25 by row medians, 35.8 vs 36.5 pooled, p50 about 1 ms over. Both sit at this
panel's floor (an idle Volt chat: p50 23.6): the rest of each key is the vsync wait and two refreshes to presentation.
On the release builds (3 interleaved rows each): `r7` 27.85 / 36.2, `r8` **26.55 / 34.6**, T3 Code 24.5 / 43.6 (its
reply not streaming); details under "Final rows on the release builds".

The cause was the fade of freshly streamed text: its colour changed on every frame, so every frame of a streaming
chat painted text, the compositor always had a frame in flight on this 120 Hz panel and held each next frame (the
key's included) until the previous one was shown. Three commits:
- `fe927962147` the fade steps its colour 60 times a second on one shared clock (the document timeline): every span
  changes colour in the same frames and the frames between paint no text. On a 60 Hz screen nothing changes.
- `590cec49a49` a stream paint that falls between two of the fade's step frames waits for the next one (8 ms at
  120 Hz), only while a fade runs.
- `33c35bedc9e` "while a fade runs" now means streamed text is fading (the tracker's newest chunk), not "a streamed
  paint ran in the last 1.1 s": the turn's own first paints (prompt, thinking line) made a reply's first words wait up
  to a frame, which A4 counts.

## Before / after

Key-to-presentation (Chromium EventLatency, ms), 60 keys per row, 0 missed in every row. Load = 1-minute load at
the row's start gate / during the typing window. `after` rows 1-4 ran `590cec49a49`, rows 5-6 `33c35bedc9e` (same
behaviour while text streams).

| Arm | Rows (p50 / p95, load) | Median p50 (range) | Median p95 (range) | Pooled p50 / p95 (n) |
|---|---|---|---|---|
| `before` dev (`69073864ed2`) | 32.1/41.5 (13.4/11.6), 31.9/36.2 (8.4/9.9), 31.75/54.6 (9.1/21.9), 29.1/36.4 (12.6/11.2), 32.5/37.3 (6.8/7.9), 31.8/36.4 (8.0/8.8) | 31.85 (29.1-32.5) | 36.85 (36.2-54.6) | 31.6 / 37.3 (360) |
| `after` dev (`e8/typing`) | 25.8/31.7 (9.9/10.5), 26.45/35.3 (9.8/9.3), 24.5/32.7 (13.1/16.8), 26.1/36.6 (12.9/20.2), 25.35/41.4 (9.8/8.1), 25.95/35.8 (7.4/13.0) | 25.9 (24.5-26.45) | 35.55 (31.7-41.4) | 25.7 / 35.8 (360) |
| T3 Code (same rig) | 25.1/36.5 (12.9/9.4), 24.6/34.0 (13.6/13.0) | 24.85 (24.6-25.1) | 35.25 (34.0-36.5) | 24.8 / 36.5 (120) |

Three dev rows had other agents' work push the load over 14 during typing (second load figure). Without them:
`before` 31.9 / 36.4 (n 5), `after` 25.9 / 35.55 (n 4). A row's p95 is its 57th of 60 keys, so one long task moves it:
`after` 12:23 holds keys of 69, 81 and 99 ms at load 8 (its p95 41.4); T3 Code's rows hold 56 and 88.

Release arms, session 1 (same rig, before this branch): `base` 34.6/79.9, 35.3/110.3; `r7` 37.6/100.9 (load to 19),
32.35/36.8. The p95 outliers sit in rows whose load rose to 15-19 during typing.

### Final rows on the release builds (`r7` vs `r8`)

`r8` = `~/.volt-r8/min/r8/VOLT.app`, `3c920df8444` (all three round-8 branches merged), built 16 November 01:29.
Session of 01:41-01:51 +04 under the timing lock (`session8.sh a8 r7,r8,r8,r7,r7,r8 t3 2`), 60 keys per row, 0
missed in every row, 5 replay streams in every Volt row (6,364-6,613 characters streamed during the 60 keys).

| Arm | Rows (p50 / p95, load start / typing) | Median p50 (range) | Median p95 (range) | Pooled p50 / p95 (n) |
|---|---|---|---|---|
| `r7` release | 29.95/36.2 (12.7/9.8), 27.85/35.3 (10.4/9.7), 27.85/36.2 (9.6/8.1) | 27.85 (27.85-29.95) | 36.2 (35.3-36.2) | 28.6 / 36.2 (180) |
| `r8` release | 26.55/40.1 (12.8/12.8), 26.7/34.6 (11.6/11.2), 24.7/32.1 (6.6/12.1) | 26.55 (24.7-26.7) | 34.6 (32.1-40.1) | 26.3 / 35.3 (180) |
| T3 Code (Nightly) | 24.15/41.1 (9.5/14.05), 24.85/46.1 (10.8/10.3) | 24.5 (24.15-24.85) | 43.6 (41.1-46.1) | 24.5 / 41.3 (120) |

On the release builds `r8` is 1.3 ms (p50) and 1.6 ms (p95) under `r7`; one `r8` row (40.1) holds a 120.7 ms key. T3
Code's reply grew 16 characters during each of its rows: it does not stream to the screen while its probe types, so
its rows are its idle floor, not a like-for-like test. On this rig `r8` and T3 Code are within a frame of each other.
This is Chromium's EventLatency (key to presentation), not ADEMark's pixel method (key to OCR'd pixels, T3 Code 47.9
ms on the board): ADEMark's method needs Screen Recording, which this shell does not have.

A3 and A4 on the release builds (`session8.sh ab r7,r8 2 3 6`, 02:01-02:07 +04, loads 5.2-8.6, 2 launches per arm,
interleaved r7, r8, r8, r7):

| | `r7` | `r8` |
|---|---|---|
| A3 ready, median of each launch (n 3 per launch) | 149, 162 ms | 152, 151 ms |
| A4 total, Enter to first word (n 6 per launch) | 1,074, 1,029 ms | 735.5, 698.5 ms |
| A4 before the request (agent start) | 1,049, 1,005.5 ms | 710.5, 674 ms |
| A4 on screen (request to first word) | 26.5, 24 ms | 25, 24.5 ms |

A3 is unchanged. A4 on screen is unchanged; A4's total is 330 ms faster on `r8` (the shared adapter host: no adapter
process to start). **Every A4 run started a cold agent** (`agentSource: cold`, 24 of 24 here and 48 of 48 on the dev
rows): round 6's 92 ms (dev) was taken with a warm spare agent waiting, and since `cdc82211e86` (round 7: the spare
started when a run ends lives 20 s, not 10 min) A4's runs find none. A4 is a regression from round 6, not from this
round.

### A3 and A4 (`session8.sh ab before,after 2 ...`, interleaved launches, loads 7-11)

| | `before` | `after` |
|---|---|---|
| A3 ready, `590cec49a49` (n 12 each) | 156.5 (142-200) | 161.5 (128-201) |
| A3 ready, `33c35bedc9e` (n 6 each) | 172 (145-283) | 159.5 (145-170) |
| A4 request to first word on screen, `590cec49a49` (n 12) | 25 (22-33) | 32.5 (23-216) |
| A4 request to first word on screen, `33c35bedc9e` (n 12) | 28 (22-35) | 28.5 (22-37) |
| A4 Enter to first word, per launch, `33c35bedc9e` | 726.5, 692 | 756.5, 754.5 |

A3 is unchanged. A4's on-screen part (what these commits can touch) is equal after `33c35bedc9e`. A4's total differs
by about 40 ms in Enter to request (the replay server's receive time), in both sessions; that part runs before any
reply paint, in code these commits do not change (the dev trees differ only by them: `69073864ed2..3b41bdb483f` changes
one test file), so it is a difference between the two dev trees' builds; the release `r7` vs `r8` A4 rows settle it.
A11 (long thread open, scroll, switch) has no rig in this repo; the three commits act only while a reply streams
(the fade spans and the stream paint gate), which A11's finished thread never does.

### Looks the same

`cast.mjs` screencasts of one streaming reply per arm: `~/.volt-r8/typing/cast/{before,after}.mp4` (frames and crops in
`cast/`). Same text, colours and layout. A CDP screencast runs at 38-46 frames a second here, below 60, so it cannot
show the difference between a colour stepped at 60 Hz and one changed every 120 Hz frame; that difference is at most
one 60 Hz step of the ease-out curve (the unit test checks each step equals ease-out at its start). Seen in both arms
alike (not from this branch): mid-stream, an open code fence's first line briefly overlaps the "Explored File" row
above it until the fence closes.

Where the remaining time goes (`after`, stage medians): browser to renderer main 0, key handler about 2 ms, main to
commit about 2.3, draw about 1, submit to presentation about 16.5 (two refreshes of the panel: the floor of an idle
chat too, whose p50 is 23.6). Switching every CSS animation in the window off (`exp.mjs ... noanim`) gains nothing any
more (plain 27.35/37.2 and 23.6/27.9 vs noanim 26.2/33.7 and 23.55/33.2, loads 9.4-10.6), and the running-animation
census during the probe holds only the fade's spans (`anims.mjs`). The live status line's shimmer (a custom-property
animation that repaints every frame) is not on screen while text streams (the live line hides while text arrives), so
it is not in A8's frame and was left as it is.

## T3 Code, read (`~/.volt-r8/src/t3code`, one squashed commit `50a2f5b9`, so "long threads open about 2.5x faster"
cannot be read as a diff)

| Stage | T3 Code | Volt |
|---|---|---|
| Key echo | Tiptap contenteditable: the browser inserts the character itself | Monaco composer: its own key handler (about 2 ms in our traces), then the frame |
| Stream to client | server paragraph mode (`orchestration-v2/assistantStreaming.ts`): text is released at paragraph or block boundaries, at most every 400 ms, plus a 50 ms client coalescer | token chunks, painted at most once per frame |
| Reply render | only the open tail block re-parsed (`markdown-incremental.ts`) | the live transcript keeps rows mounted and redraws the rows that grew (round 7) |
| Fresh-text effect | none | 1.1 s colour fade (kept: now stepped at 60 Hz on one clock) |
| Background threads | unmounted | their editors stay mounted (round 8's render area, not this one) |

So in T3 Code the probe's frames carry almost no streamed paint at all (its number is its idle floor), while Volt
keeps token-by-token streaming and the fade and still matches it.

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
- **Load**: timed rows ran under `~/.volt-r8/timing.lock`, each launch gated on a 1-minute load of 14 or less. Each
  row records the load at the gate, during typing and at the end; medians are given with and without the rows whose
  typing-window load went over 14 (other agents' builds and runs on this shared Mac).
- **Rerun on any app**: `round8/scripts/typing/session8.sh a8 r7,new=/path/VOLT.app,new=/path/VOLT.app,r7 t3 2` (takes
  the lock itself; rows to `round8/data/typing/a8.jsonl`); `session8.sh ab r7,new=/path/VOLT.app 2 3 6` for A3/A4.
  Needs ADEMark's replay server on 18995 (NEXT.md has the command) and T3 Code's isolated home for `t3`.

## What is left

- **A clear win over T3 Code.** Both apps sit at this panel's floor: the key waits for the next frame (0-8.3 ms),
  then about 16.5 ms from submit to presentation (two refreshes). Volt's p50 is about 1 ms over T3 Code's: the
  Monaco composer's own key handling (about 2 ms) against a contenteditable the browser edits itself. A key that
  arrives late in a frame misses it when handler plus commit run past the deadline, so shaving the composer's
  per-key work (Monaco's key path, its view-line render, the composer's listeners) would move some keys a whole
  refresh earlier. Not attempted this round: it is Monaco's core input path, and a change there needs its own
  measurement of every other editor.
- **The p95 tail**: single keys of 55-137 ms in some rows of both arms (and of T3 Code). One trace of such a key would
  say whether it is a stream paint, a GC or the machine; with a p95 at the 57th of 60 keys, three of them decide it.
- **Shimmers**: the live status line's shimmer animates a custom property and so restyles and repaints on every
  frame. It is not on screen while text streams, so A8 does not see it; stepping it on the fade's clock (`steps()`
  with a delay aligned to the document timeline, as the fade does) would help a chat that waits on a tool.
