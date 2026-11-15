Status: **final** (A8 timed rows added 2026-11-15 by the coordinating session from `data/typing/a8.jsonl`)

# Round 6, area "typing": A8 typing lag while 5 agents stream

Branch `e6/typing` (worktree `volt-e5-codeintel`), from `7f07f73d677`. Before = `volt-e5-base` (same commit, read-only),
after = this branch. Both dev builds (transpiled `out/`), one at a time on CDP 9975 with their own profiles
(`~/.volt-r6/typing/ud/<arm>`), ADEMark's replay server on port 18975 (`replay:stream-1..5`). ADEMark method, unofficial.

## Summary

- **No A8 timed row.** Every run of this session was at a 1-minute load of 40 to 92 (the launch agent's release build and
  other areas' test suites); the load gate (14) and the timing lock never opened. A timed session (`session.sh - 3`: A8
  before/after, ABBA, 3 reps per arm) is left waiting in the background for the gate and writes to `data/typing/a8.jsonl`.
- What this report has instead: Chromium traces of the renderer's main thread while ADEMark's 5 streams run and 60 keys go
  into the streaming chat's composer, with style invalidation tracking. At that load their times are not results (one
  trace holds a 25 s stall where the renderer was not scheduled), but the **counts** are: how many forced style and layout
  passes each frame runs, which JS stack forces them, and which DOM writes dirtied style before them.
- Found per streamed frame: three or four forced style and layout passes instead of one (the scrollbar slider drawn
  inside each scroll write), the open code fence's card rebuilt and re-tokenized whole on every chunk (ADEMark's stream is
  58K characters with 109 code and diff fences), the whole reply re-parsed on every frame, a sticky-card pass walking the
  reply's subtree with `querySelectorAll` and rewriting a mask property every frame, nine SVG circles animating opacity
  (nine style recalcs and a repaint per frame while the chat worked), and one `color`-animated span per 50 ms chunk
  (about 22 animating at a time, each a style recalc per frame).
- Seven fixes, each committed with a unit test where the code is testable. The suites covering the changed files pass
  (`agentThreadView`, `agentCodeBlock`, `agentTranscript`, `agentTranscriptReuse`, `agentTimeline`, `agentBlocks`,
  `agentFreshText`, `agentComposerChips`: 155 tests; the whole `voltAgent` browser folder: see Verification), type check
  clean.
- The composer's own per-key JS is not where A8's time goes: a 60-key profile on an idle composer shows no Volt key handler
  in the top 40 entries (the machine's 3.6 s of non-idle time in 65 s is TextMate grammar loading and extension state).
  A8's p95 is set by what the streaming thread costs the main thread per frame, which is what the fixes cut.

## Before / after

| Test | Before | After | Load at start |
|---|---|---|---|
| A8 key to pixels p95, 5 streams, 60 keys (dev builds) | 105.9 ms (71.9-118.3, n=3) | 97.6 ms (81.0-111.1, n=3) | 12.6-13.9 (13.7-20.7 while typing) |
| A8 key to pixels p50 | 39.6 ms (36.5-60.2) | 41.0 ms (36.0-48.4) | |
| A8 event-loop delay p95 | 90.6 ms (62.4-100.2) | 78.5 ms (61.2-111.2) | |
| A3 long thread | not measured | not measured | - |

Trace counts over the 60-key window (one run per column; load 40-92; `node scripts/typing/tracesum.mjs` over
`data/typing/traces/`). `after-1` is the before code (the branch before any fix); `before-1` is `volt-e5-base`; `after-2`
has fix 1; `after-3` fixes 1-5 without the strip; `after-4` and `after-5` all fixes but the fresh-text coalescing;
`after-6` is a 16-key run with 2 streams for the animation check. Times in brackets are ms and scale with the load.

| Count | before-1 (base) | after-1 (no fix) | after-2 (fix 1) | after-3 | after-4 | after-5 |
|---|---|---|---|---|---|---|
| frames (BeginMainFrame) | 593 | 509 | 881 | 1086 | 493 | 818 |
| main-thread ms per frame | 25.1 | 37.8 | 14.6 | 11.2 | 33.9 | 15.8 |
| longest V8 interrupt stall ms (starvation) | 7678 | 0 | 3579 | 2251 | 24972 | 6182 |
| forced `Layout`: forced of all | 937 of 1159 | 740 of 924 | 647 of 1323 | 709 of 1401 | 503 of 974 | 594 of 1194 |
| forced `Layout` by the scrollable's `scrollTop` write | - | 106 | - | - | - | 5 |
| forced `Layout` by `adoptNativeScroll` | 80 (150) | 81 (161) | 105 (65) | 127 (78) | 71 (38) | 99 (92) |
| forced `Layout` by `writeBackThreadScrollTop` | 86 (24) | 71 (68) | 0 | 0 | 0 | 0 |
| forced `UpdateLayoutTree` by the scrollable's write | 344 (152) | 119 | 41 | - | - | 43 (24) |
| forced `UpdateLayoutTree` by `writeBackThreadScrollTop` | 86 (139) | 71 (42) | 0 | 0 | 0 | 0 |
| fresh-text span animation recalcs before forced reads | 5519 | - | - | 12506 | 2511 | 6730 |
| dock-dot animation recalcs before forced reads | 1285 | - | - | 5211 (9 circles) | 2901 (9 boxes) | 700 (1 strip) |

Reading it: the scrollable's own forced flushes and the write-back's are gone after fix 1 (the one legitimate forced pass
per rendered frame, `syncThreadScroll`'s `clientHeight`, stays: 222-330 per run, one per chunk). `adoptNativeScroll`'s
forced recalcs remain because CSS animations (fresh text, dots) dirty style at the start of every frame; those recalcs
are the frame's own animation work moved earlier, and their count follows the animating elements: nine dots became one
strip (5,211 -> 700 recalcs over the window), and the fresh-text spans are halved by the last commit (not yet traced).

## Method

- **Rig**: `scripts/typing/` (ported from round 5's `scripts/idle/`): `lib.mjs` (arms, ports 9975/18975, profiles under
  `~/.volt-r6/typing`, `minbase`/`minafter` arms for release builds), `streams.mjs` / `restream.mjs` (5 chats each sent
  `replay:stream-<n>`), `a8.mjs` (ADEMark's A8: 60 keys at 250 ms +-20 % into the composer of a streaming chat; key to
  presented frame from Chromium's EventLatency), `typeprof.mjs` (a Chromium trace over the typing window: timeline events,
  forced layouts and style recalcs with their JS stacks; `--inval` adds the style invalidations that preceded each forced
  recalc; `--out` saves the trace), `tracesum.mjs` (the table above), `animcheck.mjs` (which animations the trace shows
  composited or not), `keyprof.mjs` / `jsprof.mjs` (V8 CPU profiles), `session.sh` (one timed A8 session under
  `~/.volt-r6/timing.lock` at load <= 14).
- **Why counts, not times**: all traces ran at a 1-minute load of 40-92. Wall times scale with the contention (`after-4`
  holds a 25 s `V8.InvokeApiInterruptCallbacks` stall inside one task with a 24 s key latency: the renderer was not
  scheduled, not Volt's work). The number of forced passes per frame, who forced them and what dirtied style before them
  do not depend on the load. Summaries: `data/typing/traces/*.txt` (raw traces are 100-500 MB and not kept).
- **ADEMark's stream**: `~/.volt-r4/ademark/bench/replay/sessions/stream-1.jsonl`: one `Read` tool call, then a 57,816-
  character reply with 218 fence markers (109 code and diff fences), streamed at 80 tokens/s for 3 minutes. So the open
  fence's card is what every chunk redraws for most of the stream.
- **Key path alone**: `keyprof.mjs` on a fresh `after` launch with no stream, 60 keys (`data/typing/traces/keyprof-after-idle.txt`).

## Fixes

Each is one commit on `e6/typing`.

1. **`394e89925b2` perf(agent): draw the thread's scrollbar slider once per frame, after every layout read.** Cause: the
   thread's `DomScrollableElement` drew its slider inside each scroll write (the frame's scroll sync, the follow's
   scrollTop every frame), leaving style dirty, so each later read in the frame (the native scroll check at -1200, the
   sticky pass at -2000, the write-back) and the follow's own scrollTop write flushed style and layout again. Change:
   `lazyRender: true` and one `renderNow()` at priority -2500. Test: `agentThreadView.test.ts` (slider untouched by two
   scroll writes, drawn by the frame's end). Counts: the scrollable's forced flushes 106 + 119 -> 0 + 41, the write-back's
   71 + 71 -> 0 (`after-1` -> `after-2`); main-thread ms per frame 37.8 -> 14.6 at similar load.
2. **`497cb09a357` perf(agent): a streaming code fence grows in place instead of rebuilding its card on every chunk.**
   Cause: `renderCodeCard` rebuilt the open fence's whole card on every chunk (20 a second) and re-tokenized the whole
   fence with TextMate (1.65 s of a 67 s stream in the V8 profile `keyprof-after-1.txt`; `cloneNode` 102 ms; hundreds of
   spans removed and added under the frame's layout). Change: `LiveCodeCard` keeps the shell and the lines above the first
   changed one, draws only the changed tail, colours it from the tokenizer state at the end of the line before (a line or
   two per chunk), and keeps the coloured lines in the highlight cache under the final card's key so the closing render is
   immediate and in the same colours. Diff fences the same. File cards, cited snippets and chart fences are drawn whole as
   before. Tests: `agentCodeBlock.test.ts` (three new).
3. **`e448de9df50` perf(agent): the sticky pass walks the exchange's children and writes the fade only when it moved.**
   Cause: `syncStuckTurns` ran on every scrolled frame with a `:scope > ...:not(.user)` query that walked the whole
   reply's subtree (`querySelectorAll` 1.4 s self in 67 s) and rewrote `--volt-sticky-fade-end` on every reply every frame.
   Change: a loop over `exchange.children`; the property is written only when its rounded value changes. (While the follow
   scrolls, the value does change every frame: that write stays and only restyles the reply itself, `inherits: false`.)
4. **`fcd3870d638` perf(agent): remember paragraph kinds and introduced paths across a streaming reply's frames.** Cause:
   `buildTranscriptRows` re-parses the whole reply every frame (4.4 s of a 67 s stream: O(n) per frame, O(n^2) over the
   stream): `partitionAssistantText` classified every paragraph again (preview-URL, answer-form and narration scans,
   1.3 s) and `introducedPath` re-ran per markdown block (0.5 s). Change: bounded memo maps keyed by the paragraph / the
   last line. Left: `presentOutput` and `splitTextWithShell` still scan the whole text per frame (see below).
5. **`6ad0274fee0`, `4c53ec201a1`, and the timer commit after them: perf(agent): the working dots are one masked strip
   stepped by a timer.** Cause: the composer chip's nine SVG circles animated opacity for as long as the chat worked; an
   SVG animation costs the main thread a style recalc and a repaint per element per frame (5,211 recalcs over the window
   in `after-3`). HTML boxes with opacity animations still recalculated per element (`after-4`: 2,901); one strip whose
   mask carries the eight sine_3x3 frames with a `transform` animation still ticked style once a frame (`after-5`: 700;
   `after-7`, with an explicit first keyframe: 307 over 24 keys), so Chromium was not compositing it either. The strip is
   now moved by a 175 ms timer, only while an IntersectionObserver sees the dots on screen and motion is not reduced:
   `after-8` shows 47 style writes over the 8 s window (6 a second) and no per-frame animation recalc. Test:
   `agentComposerChips.test.ts`.
6. **`3416b02f600` perf(agent): streamed text landing within 120 ms of the last chunk shares its fade span.** Cause:
   one `<span class="volt-agent-fresh-text">` per 50 ms chunk animates `color` for 1.1 s, so about 22 spans animate at a
   time, each a style recalc per frame (the largest remaining invalidation source: 6,730 recalcs over the window in
   `after-5`). Change: text landing within 120 ms of the previous chunk joins that chunk's span and fade (a start at most
   120 ms earlier on a 1.1 s ease-out), so about 9 spans animate instead of 22. Test: `agentFreshText.test.ts`. Counts:
   fresh-text animation recalcs before forced reads per frame 8.2 (`after-5`, before the change) -> 2.9 and 3.3
   (`after-7`, `after-8`; fresh launches with the change; 2 streams instead of 5, which does not change the shown chat's
   spans).
7. **`2315b27ce2c` test(typing)** and this report's scripts: the rig (`typeprof.mjs --inval`, `keyprof.mjs`,
   `tracesum.mjs`, `animcheck.mjs`, `restream.mjs`).

## What the traces say is left

- The one legitimate forced flush per rendered frame (`syncThreadScroll`'s `clientHeight`) is the frame's style and
  layout work moved earlier, not extra work; its cost is what the DOM churn per chunk costs (the live markdown block's
  nodes removed and re-added: `LiveMarkdown.update`, 1,454 + 1,414 "removed from layout" per window in `after-5`). An
  incremental last-paragraph update at the text-node level would cut it further.
- `buildTranscriptRows` still parses the whole reply per frame (`presentOutput`, `splitTextWithShell`,
  `extractLocalPreviewUrl` over the reply text, `layoutOutput`): an incremental split at the last settled block would end
  the O(n^2).
- The fresh-text `color` animation cannot be composited (inline elements). Fewer or shorter fades are a product call.
- The composer's own per-key work is Monaco's (`_readClientRects`, `domLineBreaksComputer`, the text area render: about
  four forced passes per key, each paying for whatever the animations dirtied since the frame began). Round 5's shape
  check already skips the composer layout on a plain key.
- Dev builds only: `trackDisposable` (666 ms self in 67 s) is the dev-only GC disposable tracker
  (`performance.contribution.ts`, `!isBuilt`), absent from the release build.

## Verification

- Type check (`tsgo --noEmit`): clean after each commit.
- Unit tests: the eight suites covering the changed files, 155 passing, 0 failing; see the end of this report's git log for
  the whole `voltAgent` browser folder run.
- Live: five streaming chats plus typing on the `after` build in every trace run (the live code card, sticky pass, memo,
  dots and fade changes ran under the stream for 20-50 s each with no console errors in the test window's log).

A8 rows: `session.sh - 3` took the timing lock at 02:12 and ran ABBA (before, after, after, before, before, after) on the
dev builds, 60 keys each into the streaming chat's composer, 5 replay streams, every key landed. Each run started at a
load of 12.6-13.9, but the load rose to 13.7-20.7 while it typed. **The ranges overlap: no measurable change in A8 on
dev builds** (the median p95 is 8 ms lower after, inside the spread). The trace counts above are the evidence that
the per-frame work fell. ADEMark's leader is 48 ms p95; Volt is about twice that on a dev build here. A release-build
A8 run on a quiet machine is the next step.

## Not done, and why

- **A8 under 48 ms p95** (the brief's target): not reached. The rows above are dev builds and the load rose past 14
  while typing; no release-build A8 row was taken.
- **Minified builds**: the shared minified before build (`~/.volt-r6/min/base/READY`) was not ready during the session;
  `lib.mjs` has `minbase` / `minafter` arms for it.
- **A3 long thread**: not measured this round; nothing in these fixes touches the long-thread path except the sticky
  pass, which does less work than before.
- **Processes**: `session.sh - 3` finished at 02:26; its replay server on 18975 was stopped afterwards.
