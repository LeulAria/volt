# Round 3 / 22: long threads and remote

Status: final (2026-11-13). Branch `e3/thread`, worktree `volt-e3-thread`. Dev-build A/B on this laptop; the A11
row uses ADEMark A11's thread shape, but these are not ADEMark results.

## Summary

Six Volt-side fixes, measured as one A/B: the round-3 base (`82ae771c1d9`) against this branch, the same window
and seeded chats, three rounds per side, every sample started at a 1-minute load of 14 or less.

- **Home (Scroll Chat to Top) in a 1,098-turn chat now reaches the first message.** Before: in 0 of 9 runs did
  the first message settle on screen within 60 s (one press landed about 200 turns up). After: 9 of 9, median
  615 ms (range 402-40,709 ms; the 40.7 s run started right as the load rose to 27). `7cd2169d8ea`.
- **Reopening long chats: 41k items 102.7 to 38 ms, 75k items 198.9 to 18.3 ms** (to the frame from which the
  thread is still, median of 9 each; after lower in 3 of 3 rounds for both). Mostly `750be821a3e` (the message
  rail drew one tick per message, 1,000-1,830 of them, on every switch, and parked exchanges lost their heights).
- **Idle CPU with a long chat open and fully drawn: 20.9 to 7.9 ms of renderer main-thread work per second**
  (n 9 each, after lower in 3 of 3 rounds); layout 3.6 ms/s to 0. `1018d255ec4` (the chat clock rewrote every
  drawn exchange's "ago" label once a second).
- **Sending into the 75k-item chat: the sent message is on screen in 17 ms instead of 103 ms** (n 6 each, after
  lower in 3 of 3 rounds). The reply's first word is the model's time and did not move (2,766 vs 2,769 ms).
- **A long reasoning is drawn whole:** 222,144 of 222,144 characters instead of the first 99,357, in about the
  same time to screen (15 vs 13 ms) at the cost of more main-thread work while it lays out (long tasks 63 to
  102 ms). `78e73552fe3`.
- **A phone's first web launch downloads 5.45 MB instead of 7.16 MB** (encoded bytes, n 3 each, identical
  within 400 bytes per side). `3466145e314`. Launch time over a fast link was taken under load and is not claimed.
- **No change:** first open of a never-shown 41k chat (cold), the A11 2,000-row thread's open (12.4 vs 13.9 ms)
  and its scroll stutter (0 frame gaps over 33 ms on both). Loading earlier turns by scrolling and the slow-3G
  launch, reconnect and terminal attach have no usable before/after (see "Not done").

## Before and after

Pooled over rounds 1-3 per side by `node scripts/thread/summarize.mjs`. Median (n, range), ms unless named.
Each sample waited for a 1-minute load of 14 or less before it started; "max load" is the highest 1-minute load
seen just before or just after any sample of that cell (before / after), so a value over 14 means the load rose
during or right after a sample. "Rounds" counts the rounds whose after median is lower than the same round's
before median.

| Test | Value | Before (base) | After (branch) | Rounds | Max load | Commit |
|---|---|---|---|---|---|---|
| Reopen "Long thread 41k" (warm) | settled | 102.7 (9, 59.7-361.9) | **38** (9, 9.4-127.3) | 3 of 3 | 12.0 / 12.4 | `750be821a3e` |
| | first visible | 59.8 (9, 40.6-301.6) | **13** (9, 9.4-102.4) | | | |
| First open of a 41k chat (cold copy) | settled | 260.5 (15, 131.4-4,023.7) | 142.5 (15, 118.6-1,396) | 1 of 3 | 15.1 / 12.8 | none (no change) |
| | first visible | 101.3 (15, 39.7-2,281.2) | 63.2 (15, 47.2-658) | | | |
| Reopen "Long thread 75k" | settled | 198.9 (9, 103.3-2,036.4) | **18.3** (9, 6.9-376.1) | 3 of 3 | 13.5 / 13.6 | `750be821a3e` |
| Home to the first message, 45k chat | to top | never within 60 s (0 of 9) | **615** (9 of 9, 401.9-40,709) | 3 of 3 | - / 27.1 | `7cd2169d8ea` |
| Load earlier turns, 45k chat (5 s of wheel) | turns/s | 0 (6, 0-10.7) | 12.5 (6, 0-20.2) | no claim | 22.3 / 16.7 | see "Not done" |
| A11 thread (1 reply, 1,000 steps, ~2,000 rows): open | settled | 12.4 (9, 6.7-583.1) | 13.9 (9, 7-215.4) | 0 of 3 | 16.4 / 13.5 | none (no change) |
| A11 thread: scroll stutter (20 wheel notches) | gaps > 33 ms | 0 (15, 0-1) | 0 (15, 0-4) | | 13.9 / 13.9 | none (no change) |
| | max gap | 12 (15, 9-52) | 16 (15, 10-110) | | | |
| Idle, 45k chat open with all 1,098 turns drawn | task ms/s | 20.9 (9, 14.9-281.9) | **7.9** (9, 1.6-21.4) | 3 of 3 | 29.7 / 13.0 | `1018d255ec4` |
| | layout ms/s | 3.6 (9, 1.6-22.5) | **0** (9, 0-4.5) | | | |
| Long reasoning (224k characters): open the Thought row | on screen | 15 (9, 11-59) | 13 (9, 6-223) | | 13.6 / 10.7 | `78e73552fe3` |
| | characters drawn | 99,357 (all 9) | **222,144** (all 9) | | | |
| | long tasks | 63 (9, 0-119) | 102 (9, 72-221) | | | |
| Send into the 75k chat (Haiku 5.5, live) | sent message on screen | 103 (6, 62-221) | **17** (6, 8-29) | 3 of 3 | 13.9 / 11.8 | likely `750be821a3e` |
| | first word of the reply | 2,766 (6, 1,928-4,090) | 2,768.5 (6, 1,557-4,486) | | | none (model time) |
| Web IDE first launch (phone page, fast link) | encoded bytes | 7,155,260 (3) | **5,447,706** (3) | 3 of 3 | 24.9 / 14.3 | `3466145e314` |
| | composer on screen | 3,600 (3, 1,253-7,818) | 1,064 (3, 964-2,007) | 2 of 3 | | not claimed (load) |
| Web IDE launch over Slow 3G | composer on screen | not measured (see "Not done") | | | | |
| Reconnect over Slow 3G after a 5 s outage | first message on a new socket | no before run | 913 (3, 892-931) | | - / 15.7 | none |
| Terminal attach over Slow 3G | first output | not measured (bench read no output) | | | | |

Per-round medians (before / after), the basis of the "Rounds" column: warm 163/102, 159/37, 99/29; cold
261/347, 1,075/122, 139/142; 75k 309/204, 218/13, 113/18; A11 open 126/159, 12/14, 10/10; idle 21/2.3, 51/17.6,
18/7.9; send 160/23.5, 110/10, 72/18.5. Cold's pooled drop comes from one before round (round 2) taken while the
load swung between 14 and 27 between samples; the other two rounds show no gain, so no change is claimed.

Raw data: [`data/thread/ab/`](data/thread/ab/) (`<side>-r<round>-<test>.json`, the suite logs `ab3.log` and
`new-r2.log`), remote runs in [`data/thread/remote/`](data/thread/remote/), launch byte counts in
[`data/thread/launch-bytes.json`](data/thread/launch-bytes.json). The first A/B pass, which lost warm and 75k to
rig bugs, is kept in [`data/thread/ab-v1/`](data/thread/ab-v1/) and is not pooled.

## Method

- **Rig.** One Volt dev window from this worktree (`scripts/thread/instance.sh`, CDP 9953, profile
  `/tmp/v3-thread-ud`, repo `/tmp/v3-thread-repo`), seeded by `scripts/thread/seed.mjs` with chats in Volt's own
  history format: "Long thread 41k" (1,000 turns x 41 items), "Long thread 45k" (1,098 turns), "Long thread 75k"
  (1,830 turns, grows by the live sends), "Long thread A11 (seeded)" (ADEMark A11's shape: one reply with 1,000
  steps, about 2,000 rows), five "Cold 41k" copies, and "Long reasoning" (one reply that thought for 2,500
  lines, 224,000 characters).
- **A/B.** `scripts/thread/ab.sh` switches `out/` between the round-3 base (`82ae771c1d9`) and this branch for
  every source file the branch changed, then restarts the window and its agent server. `suite.sh <side> <round>`
  runs every test once on one side. Order: base r1, new r1 (partly before the 15:00 reboot, the missing tests
  after it), base r2, base r3, new r3, new r2. New r2 ran last: in `~/.volt-r3/thread/ab3.sh` its first test
  (warm) was ended by a SIGTERM from outside the suite and the side was skipped, so it was run again on its own
  after the script ended. So rounds 2-3 are interleaved but not strictly alternating.
- **Remote.** `scripts/thread/remote-ab.sh`: `hybrid-server.mjs` clones the installed `/Applications/Volt.app`
  app folder and swaps in this worktree's agent server bundled at base or at this branch, so the phone page is the
  release workbench and only the server change differs. Headless Chrome (CDP 9957, 430x932) loads `/code/` through
  `slowlink.mjs`, a TCP proxy with DevTools' "Slow 3G" numbers (400 ms round trip, 400 kbit/s each way) that,
  unlike DevTools throttling, also slows WebSockets; "fast link" is the same proxy with pacing off.
- **Load.** Every sample waits until the 1-minute load is 14 or below (`lib.mjs waitLoad`) and records the load
  before and after it. Five agents and a VM shared this 14-core laptop; the load went past 100 (once past 400)
  several times during the runs, and 5-minute loads of 80-130 surrounded new r1's A11 open and stutter samples.
- **Timing.** Measured in the renderer: t0 is the input event's `timeStamp` (mousedown, keydown, wheel), the end
  is the `requestAnimationFrame` time of the first frame from which the target is on screen and the thread stops
  moving (1 s for opens, 800 ms for Home and reasoning). Long tasks from a `PerformanceObserver`. Idle work is
  `Performance.getMetrics` TaskDuration/LayoutDuration over 10 s. ADEMark times from a screen recording, which adds
  the compositor and the display's frame (roughly one to three 16.7 ms frames); our numbers are not ADEMark
  results.
- **Live turns.** `send` uses Haiku 5.5 (`pick-model.mjs`), two sends per side and round.

## Fixes

Each is one commit on `e3/thread`. The A/B compares the whole branch with the base; which commit moved a number
is read from what each commit changes, not from a per-commit bisect.

1. **`750be821a3e` perf(agent): window the message rail's ticks and keep parked exchange heights.** Cause: a
   1,000-turn chat drew 1,000 rail ticks (2,000 elements) on every switch and restyled the window for them, and a
   parked thread's exchanges lost their measured heights, so showing it again settled over several frames.
   Change: the rail draws as many ticks as fit and slides them; parked exchanges keep their heights. Test:
   `agentTurnNav.test.ts`. Numbers: reopen 41k 102.7 to 38 ms, 75k 198.9 to 18.3 ms; the sent message on screen in
   the 75k chat 103 to 17 ms is most likely the same change (a send adds a message to the rail), not bisected.
2. **`0563bebad14` perf(agent): the message rail measures only the messages on screen.** Cause: with 1,098 turns
   drawn, every scrolled frame read the box of every drawn exchange and queried the whole transcript: 494 ms of
   3 s of wheel scrolling (trace). Change: bisect the boxes, keep the exchange list until the nodes change (18 ms
   in the same trace). Test: `agentTurnNav.test.ts`. Numbers: trace only. The rig's stutter test runs on the A11
   thread (one message, so one tick) and does not exercise it; the earlier-turns test cannot show it (see below).
3. **`1018d255ec4` perf(agent): the chat clock stops laying out long threads every second.** Cause: once a second
   the clock rewrote every drawn exchange's time labels with the same text, after three whole-transcript queries:
   a full layout per tick (62 ms/s in the first trace). Change: write a label only when its text changes, live
   collections for the lookups, hour-old labels once a minute. Test: `agentTranscript.test.ts`. Numbers: idle
   20.9 to 7.9 task ms/s, layout 3.6 to 0 ms/s.
4. **`7cd2169d8ea` fix(agent): Scroll Chat to Top reaches the first message of a long chat.** Cause: Home glided up
   while older exchanges were drawn on the way, each one pushing the scroll down to hold the view, so a press in a
   1,000-turn chat landed about 200 turns up (turn 791, then 604). Change: Home draws the rest over the next frames
   (32 ms a frame, view held), then glides to the top. No unit test (scroll and layout timing; covered by the rig's
   `home` test). Numbers: 0 of 9 to 9 of 9 reaching the first message, after median 615 ms.
5. **`3466145e314` perf(server): a phone's first launch of the web IDE downloads 1.6 MB less.** Cause: the
   workbench bundle went out as brotli quality 4 (5.77 MB) and built-in icon/color themes uncompressed through
   `vscode-remote-resource` (451 + 43 KB). Change: for a device that is not this computer, a quality-11 copy
   (4.57 MB) is made in the background and kept on disk; built-in extension files the workbench reads are served
   compressed (icon theme 451 KB to 50 KB). Test: `serverCompression.test.ts`. Numbers: 7,155,260 to 5,447,706
   encoded bytes per launch (n 3 each).
6. **`78e73552fe3` fix(agent): a reasoning or reply over 100,000 characters is drawn whole.** Cause: the markdown
   renderer cuts a string at 100,000 characters. Change: longer text is drawn in parts of at most 90,000
   characters split where `splitMarkdownChunks` says pieces render the same alone, with one footnote numbering.
   Test: `agentTranscriptReuse.test.ts`. Numbers: 99,357 to 222,144 characters drawn; time to screen 15 vs 13 ms;
   long tasks 63 to 102 ms (2.2x the text to lay out).

Rig and data commits: `287496cd37d`, `b1d5e7f39e2`, `2ffeec3f632`, `576ab12648f`, `c96f97abfde`, `7eec68d93e5`,
`c85068b8744`, `a6b76a2aea4`, `9904d1f7d95`, `d210a435011`, `e02c8fe2e5b`.

Checks: `npm run compile-check-ts-native` clean; `scripts/test.sh --run` on `agentTurnNav.test.ts`,
`agentTranscript.test.ts`, `agentTranscriptReuse.test.ts` and `serverCompression.test.ts`: 72 passing.

## Not done, and why

- **Loading earlier turns by scrolling: no claim.** Both sides have runs that drew nothing in 5 s of wheel
  (before 4 of 6, after 2 of 6; on the after side always the first run of a round), so the test measures the
  rig's starting state as much as the app. The scroll-path fix (`0563bebad14`) has only its trace numbers.
- **First open of a never-shown chat (cold): no change claimed.** Pooled medians 260.5 vs 142.5 ms, but after is
  lower in only 1 of 3 rounds (round 2, whose before samples ran while the load swung up to 27).
- **A11 open and stutter: already fast before.** The seeded A11 thread is one reply, so the rail has one tick and
  the per-message fixes do not apply; open is about 10-14 ms and scrolling has no frame gap over 33 ms in the
  medians on both sides. New r1's A11 open (153-215 ms) ran between load spikes (5-minute load 80-130); rounds 2-3
  are 12/14 and 10/10 ms.
- **Web launch time.** Over the fast link, launch time follows the load more than the bytes (before 7.8 s at a
  load that rose to 25, then 3.6 and 1.3 s), so only bytes are claimed. Over Slow 3G, the one paired run per side
  never showed the composer within the bench's limit, and a release-app run took 232.8 s at load 42, outside the
  load rule. At 400 kbit/s, 1.71 MB less is about 34 s less transfer: arithmetic, not measured.
- **Reconnect and terminal attach over Slow 3G.** Reconnect was run on the branch's server only (913 ms median to
  the first message on a new socket, no "connection lost" text), so it is not an A/B; no commit targeted it.
  Terminal attach failed on the bench (no terminal output read within 60 s in either run), so it has no number.
- **Per-commit attribution.** The A/B switches all branch files at once; a per-commit bisect was not run, so the
  send-echo gain is attributed to `750be821a3e` by its mechanism only.
- **Official numbers.** None of these is an ADEMark result: the A11 row is our seeded copy of its thread shape on a
  dev build, timed in the renderer, not ADEMark's runner with screen capture on its reference Mac.
