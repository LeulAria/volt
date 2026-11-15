Status: **draft** (timed rows pending)

# Round 7, area "typing": A8 typing lag while 5 agents stream

Branch `e7/typing` (worktree `volt-e5-codeintel`), from `039a70b7208`. Before = the shared release build
`~/.volt-r7/min/base/VOLT.app` (same commit); after = this branch built the same way (`scripts/typing/build-after.sh`,
nested tree `volt-e5-min-typing/volt`, product.json commit stamped). ADEMark's replay server on port 18995
(`replay:stream-1..5`, `replay:seed`, `replay:hi`); the brief's 18985 was held by a round-6 `node mcpstub.mjs 18985`
that is not ours and was left alone. CDP 9975, profiles `~/.volt-r7/typing/ud/<arm>`. ADEMark method, unofficial.

## Summary

Round 7 was stopped by the user before its timed runs (see [README.md](README.md)): the fixes are merged, with no before/after rows.

## Before / after

PENDING

## Method

- **Rig**: `round7/scripts/typing/` (round 6's, `~/.volt-r7` paths). `a8.mjs`: ADEMark's A8, a fresh launch per row,
  5 new chats each sent `replay:stream-<n>` 2 s apart, then 60 probe characters into the streaming chat's composer
  at 250 ms +-20 %; key to pixels = Chromium's EventLatency of each KEY_PRESSED (key event creation in the browser
  process to the presentation of the frame that carries it). A key with no echo within 2 s is missed. `ab.mjs` runs
  A3 (`a3.mjs`, round 3's: New Agent to two probe letters painted in the new composer) and A4 (`a4.mjs`, round 6's:
  Enter to `LEDGERMARK` on screen) on fresh launches of each arm, interleaved.
- **Traces** (analysis, not timings): `typeprof.mjs` now also splits each key's EventLatency into Chromium's stages
  (queueing on the renderer main thread, main-thread processing, BeginMainFrame to commit, presentation), lists the
  main-thread tasks inside the slowest keys, the size of each layout and style pass, and the large style recalcs with
  their forcing stacks. `callers.mjs --tree` prints merged call trees from a saved V8 profile.
- **Load**: every trace below ran at a 1-minute load of 35 to 65 (the shared and the launch agent's release builds and
  other areas' runs). Their times are not results; counts and shares are.

## Where a key's time goes (release build, traces at load 48-65)

`data/typing/traces/typeprof-minbase-{1,2}.txt` and `keyprof-minbase-1.txt`: the shared before build, 5 streams, 60
keys each. Shares and counts, not times (load 48-65).

- **A slow key's stages** (EventLatency split): waiting for the renderer main thread (`RendererCompositorToMain`:
  a running frame, a socket message batch or a GC), the key's own handler (`RendererMainProcessing`: Monaco's edit,
  the composer's listeners, the ghost-text provider), then the frame that draws it
  (`RendererMainFinishedToCommit`: that frame also patched the streaming reply), then presentation (about one display
  refresh plus GPU). The slowest keys of both traces sit behind a stream frame of 30-180 ms at that load or behind the
  next one, which is what fix 1 takes out of the key's frame.
- **The main thread's work while 5 chats stream** is the visible chat's frames: about 34 frames a second, 6 ms of
  animation-frame callbacks each and two style passes per frame. Forced style and layout lead the V8 profile
  (`clientHeight` in the scroll sync 4.9 s self of 60 s; the scrollable's `scrollTop` write and `adoptNativeScroll`'s read
  1.4 s each): the frame's own style and layout, run early by the first read. Layout passes are small (34 dirty of
  about 1,600 objects at p50); style passes recalculate 9 elements at p50 and 33 at p95, and 22 of 1,892 recalculated
  100 elements or more (the frame's pass and the scroll sync, none in a key handler).
- **JS in a stream paint** (dev profile, names readable): the transcript view's render (the open markdown block's
  redraw 24 % of the paint, the code card's colouring 13 %), the whole-reply parse in `buildTranscriptRows` 28 %, the
  fade pass 10 %. Fix 3 removes most of the markdown redraw for prose.
- **The key's own handler** (dev profile): Monaco's edit and view events, DOM line-break measuring, the inline
  completions source (the ghost text: 222 ms over 60 keys at load 42, of which the context build fixed by fix 2 was
  73 ms; the rest is upstream's observable machinery), editor status updates.

## Fixes

Each is a commit on `e7/typing` with a unit test.

1. **`7f8f1fe21d9` perf(agent): a key's frame in the composer does not also paint the streaming reply** (with
   **`1df9f9b5f30`**, which leaves out a send's and a restored draft's `setValue`). Cause: Monaco draws a typed key at
   the next animation frame, and the streaming chat's paint (`scheduleThreadRender`: patch the live reply, then the
   scroll sync's forced style and layout) was queued in the same frame, so the frame carrying the key's echo also paid
   for the stream. In the release trace, a slow key's stages are queueing behind a running frame, the key handler,
   then `RendererMainFinishedToCommit`: its own frame. Change: `InputFirstGate` marks the frame after a typed edit
   (a lowest-priority callback clears the mark at that frame's end); a stream paint that finds the mark moves to the
   next frame, at most once in a row, so the reply still paints at least every other frame however fast the user
   types. The follow glide and everything else in the frame are unchanged. Test: `agentInputFirst.test.ts` (3).
2. **`6d046f6c06e` perf(agent): the composer's ghost-text context reads replies only as far as its cut.** Cause: every
   key builds the Tab prediction's context (the last 8 messages, each flattened and cut to 400-600 characters); the
   flatten ran over the whole text before the cut, and a streaming reply was first joined from all its segments, so a
   key cost O(reply length) inside its own handler (ADEMark's reply reaches 57,816 characters). A failed command's last
   two lines were taken by splitting its whole output. Change: `clipForPrediction` flattens a prefix that decides the
   cut, `clipPiecesForPrediction` stops reading segments once it has it, `lastLines` reads from the end. Same output:
   `agentComposerDraft.test.ts` compares them with the whole-text versions on 310 texts (long whitespace runs
   included).
3. **`6f4855e4e13` perf(agent): plain prose added to a streaming reply's open block grows it in place.** Cause: each
   chunk drew the open markdown block again (marked, DOMPurify, a new element tree), removed the old one and re-created
   every fade span in it, so each paint built new elements whose style had to be resolved from scratch. Change:
   `LiveMarkdown.update` appends text that draws as itself (ASCII letters, digits, spaces and plain punctuation, one
   line, no trailing space) to the open block's last text node when the block is a paragraph, list item, quote or
   heading ending in such a word, the line's start is settled (a word with a letter before the last word, so `- 1` +
   `.` or `--` + `-` cannot turn into a list or a rule) and the last word plus the addition hold no `://` or `www.`;
   anything else goes through the renderer as before. Each fade span remembers its chunk, so text added within the
   chunk's 120 ms coalescing window joins the running span and later text gets its own, as a redraw draws them.
   Tests: `agentLiveMarkdown.test.ts` streams 7 replies (prose, lists, quotes, headings, tables, footnotes, URLs, paths,
   emphasis, escapes, entities) in 4 random chunkings each and compares the markup with each step drawn whole after
   every update; the open paragraph keeps its element; `agentFreshText.test.ts` (in-place text joins its chunk's span).
   On ADEMark's `stream-1`, 60 % of the prose chunks (16 characters each) meet the text conditions
   (`fastpath-estimate.mjs`; prose is 58 % of the stream's chunks, code fences grow in place since round 6).

## Not done, and why

PENDING
