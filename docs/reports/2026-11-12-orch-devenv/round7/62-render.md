# Round 7: render (A7's app side, A5's GPU)

Status: **draft** (release-build rows pending).

Branch `e7/render`, worktree `volt-e5-tokens`, from `039a70b7208`. Scripts `round7/scripts/render/` (round 6's
weight rig with CDP 9973, replay 18983, `~/.volt-r7/render`), data `round7/data/render/`.

**ADEMark method, unofficial.** ADEMark's sampler and replay server, our own CDP scripts, a shared Apple M4 Max
(14 cores) with four other agents' builds on it. No live model turns: every turn is ADEMark's replay.

## Summary

- **The thread's bottom fade mask comes off while it changes no pixel** (`ba677355e66`). The transcript fades
  over its last 64 px with a mask on the thread's scroller, which makes the scroller a GPU surface of its own (a
  render pass the size of the chat column, its overlay copies, the mask's tiles). Pinned at the end, which is
  where a chat sits at rest and while it follows a stream, the band holds only the empty space under the last
  exchange, so the mask does nothing visible there. Volt now drops it exactly then. Dev, at rest: GPU shared
  images 126 -> 101 MiB in a 1175x705 window (round 6 saw 212 -> 114 at 1520 px wide).
- **tsserver (three Plugin helpers, about 175 MB) is started by Volt's own edit check, not by chat content.** A
  `Read` of a `.ts` file makes the Claude hook open the file for its language server, so the edit that may
  follow can tell the errors it added. Each A7 stream reads `paginate.ts` and edits nothing. Kept: moving the
  warm-up to the edit would leave the first edit of a TS file in a cold window without its check (cold start to
  first diagnostics 5.7 s here against the edit's 1.5 s wait).
- **The rest of A7's GPU is tiles and a second mask.** At A7's peak (dev): 61-68 raster tiles (226-229 MiB),
  of which the streaming reply's own layer (made by the pinned-card mask) holds 14-18 tiles (73-94 MiB) plus
  20-35 MiB of render passes. Chromium's per-renderer tile budget (512 MB on desktop) is what lets the
  prepainted tiles pile up: a 128 MB budget cut the GPU at the peak 748 -> 653 MB (n 1 pair), but it is one
  process-wide cap with a blank-tile risk on large displays; not shipped (open item).
- Round 7 was stopped by the user before its timed runs (see [README.md](README.md)): the fixes are merged, with no before/after rows.

## Before / after (release builds)

TABLE_PLACEHOLDER

## Method

- Release builds: `minbefore` is the shared before build (`~/.volt-r7/min/base`, `039a70b7208`); `minafter` is
  this branch at `9ee03e1113b` built by `scripts/render/minbuild.sh` (core mode, `.build/extensions` reused,
  `VOLT_BUILD_IGNORE_TYPE_ERRORS=1`, product.json commit stamped).
- Rig: round 6's weight rig. A5 and A10 by `block.sh` (fresh profile, 5 seeded threads, relaunch, 90 s settle,
  60 s at 4 Hz; then 15 more seeded threads, 60 s at once); A7 by `a7block.sh` (5 seeded threads, relaunch,
  30 s, five `replay:stream-N` sends 2 s apart, thread 1 back in front, 180 s at 4 Hz). Arms interleaved,
  `~/.volt-r7/timing.lock`, 1-minute load gate 14.
- Window: this Mac's display is 1512x982 points, so ADEMark's 1600x1000 window does not fit (the app then opens
  1175x705). The rig now stores 1500x930 (`SPEED_WIN_W/H` in `arm.sh`), both arms.
- Exploratory probes (dev build, not timed, load 36-72): `a7probe.sh` (GPU shared images, footprint by role,
  memory-infra allocators and the renderer's heap at about 40 s into A7), `a7ab.sh` (a style's effect mid-stream),
  `cssexp.mjs` (at rest), `pixcmp.mjs` / `pixab.mjs` (pixel A/B), `domcount.mjs` (attached vs detached DOM).

## Fix: the bottom fade only while content is under it (`ba677355e66`)

Cause. `.volt-agent-editor.has-turns .volt-agent-thread > .monaco-scrollable-element` carries
`mask-image: linear-gradient(to top, ...)` (agentEditor.css): the last 64 px of the transcript fade to 10 %. A
masked element is drawn into its own render surface and its mask into its own tiles; for the scroller that is a
surface the size of the chat column, redrawn every frame anything in the transcript changes.

Change. `AgentThreadView.syncStuckTurns`, which already runs at the end of the frame for every scroll, redraw and
resize (the thread's ResizeObserver also watches the live exchange), reads the last exchange's bottom with the
rects it already reads and marks the scroller `bottom-clear` while that bottom is 80 px (the 64 px band plus 16 px
for a card's shadow) or more above the viewport's bottom. The space under the last exchange
(`.volt-agent-thread-inner::after`, `min(200px, 30%)`) is empty, so pinned at the end the band is clear. CSS:
- `bottom-clear` sets `mask-image: none`; with the class missing (any path that skips the sync) the mask is on,
  as before, so a miss can only cost memory, never the look;
- `isolation: isolate` on the scroller keeps the stacking context the mask made (the side toolbar inside it has
  `z-index: 6`);
- the vertical scrollbar sat under the mask when the side toolbar is collapsed (`quick-open-expanded` gives the
  toolbar's 243 px column an opaque mask, so there it was never faded): in that layout it takes the same gradient
  itself (a 10 px wide surface, 0.3 MiB).
The class lives on the scroller node, so a toggle restyles that one element.

Looks the same. Pixel A/B in one window, same scroll position, class as set vs removed, page background
transparent so alpha is compared too (`pixcmp.mjs`, `data/render/pixel-ab.jsonl`): dark and light, toolbar
expanded and collapsed, scrollbar hidden and shown. Alpha is identical everywhere and the fade band identical
(including the scrollbar slider drawn inside it). RGB differs by at most 1/255 in 0.005-0.14 % of the bytes, at the
top of the viewport (the pinned card and the side toolbar): translucent pixels composited straight into the window
instead of through the mask's intermediate surface round differently. An A/A control is bit-identical. Not
verified on screen with vibrancy: macOS's window capture is refused to the agent's shell (no Screen Recording
permission). The window server composites the page's pixels over the material, so a page output identical in
alpha and within 1/255 in RGB composites the same way; the user can confirm in a real window.

Checks. Scroll up from the end with wheel events: clear at a 115 px gap, mask back at 43 px, and on while content
fills the band. Unit test `agentThreadView.test.ts` ("the bottom fade is marked clear only while no content
reaches its band"): 5 passing. Typecheck clean. No `backdrop-filter`, no transparent fills added.

Numbers. Dev, at rest, same window (`data/render/probe/cssexp-rest.txt`): shared images 126 -> 101 MiB (render
pass 2368x1216 and one overlay gone, tiles 19 -> 17). Release rows: see the table.

## tsserver: who opens the TypeScript file (no change)

Trace (dev, test profile, `typescript.tsserver.log: verbose`; `data/render/tsserver/`):
- The dev trees cannot show it at all: `extensions/typescript-language-features/node_modules` is missing in
  `volt-e5-base` and this tree, so the extension's entry point fails to load ("entry point is missing") and no
  tsserver starts in dev, before or after. For the trace its dependencies were cloned in from the main checkout
  (gitignored, not committed).
- With the streams sent, the extension activated by `onLanguage:typescript` (11:27:00.06), then started the syntax
  and semantic servers. The only document tsserver was ever given: `file:///…/arena/src/paginate.ts`, opened
  once, never closed, with five rounds of syntactic and semantic diagnostics.
- The opener: Claude Code's `Read` hook to Volt's edit check (`codeIntelligenceTools.editCheck('read')` ->
  `codeIntelHost.settledErrorCounts` -> `createModelReference(file)`, kept open 90 s). It reads the file's errors
  while the model thinks, so the edit's start (which waits at most 1.5 s, `BASELINE_WAIT_MS`) finds them ready
  and the edit's end can report only the errors that edit added.
- Each `stream-N.jsonl` in ADEMark's replay has one `Read` of `paginate.ts` and no edit.
- Not a chat-surface model, so the TS extension's `disabledSchemes` (as for `chat-editing-text-model`) does not
  apply. Code cards in the transcript are highlighted HTML (`highlight()`); only a mermaid card's source view is a
  Monaco editor.

The trade: about 175 MB in A7 (the three Plugin helpers: 243-313 MB with the extension host at A7's p95 tick
against 69 MB for the extension host at rest, round 6) against the first edit's error check in a cold window.
Within a coding session the server starts at the first edit anyway; only read-only sessions (A7's shape) pay
the memory for nothing.

The coordinator's variant, evaluated on paper and not built: start the server at the first edit, and when no
baseline is ready, report the post-edit errors in or next to the edited lines instead of nothing.
- Time. A server started at the edit's start has the edit's 1.5 s wait (`BASELINE_WAIT_MS`) plus the 4 s the
  edit's end waits for fresh diagnostics (`AFTER_EDIT_WAIT_MS`), about 5.5 s plus the edit itself. Cold start to
  first diagnostics measured 5.7 s (load 44; extension activation 11:27:00.06 to the first semantic diagnostics
  11:27:05.81, `data/render/tsserver/`). At that load the fallback would mostly time out and report nothing,
  while holding the first edit for up to 5.5 s that today's read-time warm-up spends during the model's thinking.
  Not timed on an idle machine (load stayed 36-72 all day).
- Coverage when it does report. An edit that breaks its own lines (a typo, a wrong type in the new text): caught
  by both. An edit that breaks a caller elsewhere in the same file (a changed signature, a renamed export used
  below): caught by today's before/after comparison, **missed by the range fallback**. A caller in another file:
  missed by both (the check is per file; the end-of-turn check covers it).
- So it fails the bar (the agent must still be told about the errors it introduced): kept as it is. A real
  change here belongs to the edit check's owner (codeintel), for example a cheaper baseline.

## A7's GPU and renderer at the peak (dev, exploratory)

`a7probe.sh` at about 40 s into A7, window 1500x896, load 40-50 (`data/render/probe/`):

| | after fix, budget 512 (default) | after fix, budget 512 (second run) | after fix, budget 128 |
|---|---|---|---|
| GPU footprint (fp) | 758 MB | 748 | 653 |
| GPU shared images / raster tiles | 329 / 61 tiles (226 MiB) | 339 / 68 (229) | 227 / 46 (126) |
| GPU IOSurfaces (memory-infra) | | 303 MiB | 198 |
| renderer footprint | 700 | 659 | 696 |

- Tiles: 20-22 tiles of 3008x480 belong to the window's root layer (the thread is not a composited scroller: it
  paints into the root layer, 3000x1792 device px), re-rastered as the streams change it; 14-18 tiles of 1472x928
  are the streaming reply's own layer. That layer exists because of the second mask: replies under a pinned user
  card are masked (`.volt-agent-exchange.has-stuck-turn > .volt-agent-turn`) so they vanish under the translucent
  card and fade in below it. While a card is pinned there is always reply content under it, so that mask is
  always visible; no look-identical replacement found. A two-layer variant (24 px ramp + solid, alpha identical,
  RGB within 1/255) did not reduce tiles mid-stream (14, 18, 15 tiles shipped/variant/shipped: noise): not
  adopted. A solid no-op mask showed the gradient tiles at rest are 8 tiles (23 MiB) after a stream and none in a
  fresh window.
- Renderer (memory-infra, dev; release is smaller): v8 200-244 MiB, Oilpan (DOM, layout, CSS) 123-182, cc tile
  accounting 213, parkable strings 169 (unminified sources), partition_alloc 79-96, malloc 68-70. The JS heap
  holds no per-chat structure of note (largest constructors are strings, code and shapes).
- Background chats: 25,000 detached DOM nodes against 15,000 attached at rest after 15 chats (`domcount.mjs`):
  the parked threads (`MAX_STASHED_THREADS` 16, 150,000 elements, 15 minutes; a parked running chat keeps its
  last 12 exchanges drawn). Parking keeps switching back instant (A3); not changed.

## A5 at rest

The visible chat at rest is pinned at its end, so the fix removes the thread mask's surface there.
RESULTS_A5_PLACEHOLDER

## Not done, and why

- **Tile budget** (`--force-gpu-mem-available-mb`). 512 MB per renderer on desktop (1 GB on 3500 px+ displays);
  128 cut A7's peak GPU by about 95 MB (n 1 pair). It is one value for every renderer (workbench windows, IDE
  layouts, browser tabs' webviews) fixed at launch: on a large display or a layer-heavy page the visible tiles
  alone could exceed it and cc then leaves tiles blank. Scoping it to the agent window's renderer
  (`webPreferences.additionalArguments`) and scaling it to the display would need tests this Mac cannot run (one
  3024x1964 panel). Open item.
- **The pinned-card reply mask**: always visible while a card is pinned; no identical replacement.
- **tsserver at A7's first stream**: Volt's edit check; see above.
- **Parked threads' DOM**: an A3 trade, small next to the GPU items.
- **Vibrancy-on screen check**: blocked by macOS permissions for the agent; see the fix.
