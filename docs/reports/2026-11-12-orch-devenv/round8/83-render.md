# Round 8, render (83): A7's app side under load

Status: **final** (release `r8` rows and the pixel check taken by the coordinator on 16 November). Branch `e8/render` (worktree `volt-e5-tokens`) from `3b41bdb483f`.
ADEMark method, unofficial. No live model turn was used: every run is on ADEMark's replay server (port 18993).
Rig: `round8/scripts/render` (CDP 9983, profiles `~/.volt-r8/render/ud-<arm>`). The render agent stopped before
writing this report; the coordinator wrote it from the branch's commits, the agent's notes and the final block.

Target from the brief: GPU + renderer + extension-host helpers + main + shared process during A7 at or under about
650 MB (about 1,800 on `r7`). **Not reached** (numbers below): what is left is mostly the GPU driver's memory, which
this round found cannot be released while anything on screen changes.

## What changed

### No language service for a file an agent only read (`e38f973aeaf`)

Before: an agent's `Read` of a `.ts` file opened it for TypeScript (three helper processes, 175-243 MB) so a later
edit could tell which errors it added. Read-only chats paid for that.

Now a read warms a file only when its language service is already running (an editor tab, an earlier edit). The
first edit's start opens the file; while the service has not answered, the document is held at the text before the
edit, so the edit's end still compares before and after. An answer later than the hook may wait goes out with the
chat's next hook answer. TypeScript still starts at once when the user opens a TS file in an editor.

First-edit check, dev build, ADEMark-style replay session `edit-1` (`editcheck.mjs`, rows `data/render/editcheck.jsonl`;
loads 15-17, so these prove behaviour, not timing):

| Run | Helpers at start / after Read / after Edit | Told the agent | Read to edit result | Send to edit result |
|---|---|---|---|---|
| cold, 09:25:11Z | 0 / 0 / 3 | yes: "This edit added 3 errors in src/paginate.ts" | 2,573 ms | 3,713 ms |
| warm, 09:25:32Z | 3 / 3 / 3 | yes, same 3 errors | 763 ms | 1,529 ms |
| warm, 09:25:51Z | 3 / 3 / 3 | yes, same 3 errors | 1,054 ms | 2,011 ms |

A fourth row (09:21:18Z, cold, not told) was taken on the work in progress before the commit (13:25:59 +04 =
09:25:59Z is after it; the committed code is what the 09:25 rows ran). After the Read, no helper is alive.

### Under a pinned sent card, mask only the rows in the card's band (`60ae30ac30b`)

The mask that fades replies under the pinned sent card sat on the whole reply. A masked element is a GPU layer plus
a mask of its own size, and the mask moved on every scrolled frame: for ADEMark's A7 stream that was the reply's
full height (about 38,000 px), redrawn on every frame of the stream (`paintprobe.mjs`). Replies taller than 400 px
now get the same gradient on just the rows between the viewport's top and the end of the fade.

Pixel check on the release build `r8` (`stuckpix.mjs`, 16 November 04:05-04:15 +04, coordinator): ADEMark's A7
reply 1 streamed in the front chat (24,510 px tall), the pinned sent card over it; at 8 wheel positions the chat
column is captured as `r8` draws it and with the mask as it was before (on the whole reply, same gradient), on a
transparent page background, alpha included. Rows `data/render/stuck-pixel-ab.jsonl` (labels `r8-*`).

| Theme | A/A control (2 captures of the same drawing) | Max difference per position, of 255 | Rows that differ |
|---|---|---|---|
| dark (`vs-dark`) | 72 and 0 (the page moved between captures once) | 3, 16, 3, 3, 3, 3, 3, 3 | inside rows 123-170 only (the fade band) |
| light (`vs`) | 0 and 0 | 3, 24, 3, 0, 3, 3, 3, 3 | inside rows 123-170 only |

**It is not pixel-identical**: every difference sits in the fade's band under the card (about 47 px); outside it the
two drawings match byte for byte. In 13 of 16 positions the largest difference is 3 of 255 (the band's edges fall half
a device pixel apart); at one position per theme it is 16 (dark) and 24 (light) on a few pixels of the gradient. The
render agent's own dev runs of 15 November held a run of positions with 57 of 255 over the whole column height
(09:45:50-09:47:09Z); they are not reproduced on `r8` and the agent's notes do not explain them. The test window was
the rig's (vibrancy as the build ships it). The brief allowed this change only if pixel-identical in light and dark:
that bar is not met, so whether to keep it is a decision for the user (it removes a 25,000 px layer and mask that
repainted on every frame of a stream; its share of the GPU drop is not measured on its own).

## Numbers

ADEMark's A7 (fresh profile, 5 seeded threads, relaunch, 30 s, five replay streams for 180 s sampled at 4 Hz;
total p95 = app + agents at the p95 tick) and A5 (at rest, 90 s settle, 60 s at 4 Hz), release builds `r7`
(`3b41bdb483f`) and `r8` (`3c920df8444`, all three round-8 branches), interleaved, one round per hold of the timing
lock, 1-minute load at most 14 at each launch. Rows `data/render/{a5,a7}.jsonl`; the five earlier A7 rows of
15 November are excluded (`data/render/excluded.json`: windows of other probes were in front during them).

Block of 16 November 02:27-03:13 +04 (`ARMS="r7 r8" finalblock.sh 3`), loads 4.7-7.2; table by `a7roles.mjs 14 r7 r8`.
Medians (n; range). The roles are taken at the tick whose total is the p95 one.

| A7, MB | r7 | r8 |
|---|---|---|
| **total p95** | 2,830 (n 3; 2,817-2,864) | **2,295** (n 3; 2,287-2,302) |
| app p95 | 2,056 (n 3; 2,044-2,103) | 1,542 (n 3; 1,529-1,548) |
| agents p95 (5 Claude CLIs) | 799 (n 3; 799-802) | 795 (n 3; 795-799) |
| render side at the p95 tick | 1,516 (n 3; 1,508-1,595) | **1,301** (n 3; 1,292-1,307) |
| GPU | 730 (722-756) | 610 (610-648) |
| renderer | 271 (254-379) | 488 (461-503) |
| extension host | 78 (62-78) | 57 (56-57) |
| TypeScript helpers (tsserver) | 233 (229-234), 3 alive | **0**, none alive |
| main | 117 (112-119) | 80 (79-80) |
| shared process, file watcher, pty | 78 (43-81) | 43 (42-44) |
| network service | 14 | 14 |
| ACP adapters (agents area) | 402 (354-423) | 90 (87-95) |
| agent server | 88 (85-126) | 140 (133-141) |
| GPU, its own p95 | 739 (723-749) | 683 (671-688) |
| renderer, its own p95 | 513 (503-545) | 481 (478-488) |

| A5 at rest, MB | r7 | r8 |
|---|---|---|
| total median | 540 (n 3; 535-541) | 536 (n 3; 535-538) |

- **A7 total: 2,830 to 2,295 MB (-535)** on the release builds. Of that, the TypeScript helpers are 233 (none start
  now), the adapters 312 (one shared host, the agents area), main and shared process 72, the GPU 120 at the p95
  tick (56 by its own p95). The renderer at the p95 tick is higher on r8, but its own p95 is lower (481 vs 513): the
  tick that tops the total falls at a different moment of the stream.
- The render side is 1,301 MB against the brief's 650: the GPU (610-683) and the renderer (about 480) are what is
  left, see below.
- A5 at rest does not change (536 vs 540): none of these cuts act at rest.
- MonoCode's 1,533 MB (board) is not reached; 5 Claude CLIs alone are 795.

## The GPU process: what holds it, and why it stays

What the agent found (standalone Electron pages in `~/.volt-r8/render/gpumin`, then Volt `r7` at A7):

- **About 197 MB of "owned unmapped graphics" per Metal drawing surface**, allocated whenever any Metal render pass
  runs (GPU raster, or full-frame compositing), at 4 Hz as at 60 Hz, independent of window size and glyph count. It
  is held for about a second after the last GPU frame: at 0.5 Hz it comes and goes, at 1 Hz it stays. The driver's
  strings point at the AGX per-queue parameter buffer.
- In Volt `r7` at A7: owned unmapped 377 MB, IOSurfaces 196 MB (raster tiles 121 + three 62 MB compositor buffers).
- **While any agent works, something on screen changes at least once a second** (the sidebar spinners, the status
  line's shimmer, the reply's fade), so the driver never releases it. Pausing those would change how Volt looks.
- `--disable-gpu-rasterization` takes the GPU process from 646 to 355 MB (p95 760 to 610), but the renderer's CPU
  goes from 19 s to 137 s per 60 s: the root layer repaints about 1.5 million device pixels per frame. It does not
  ship; it becomes an option only if the repainted area per frame falls about tenfold.
- No gain: a composited thread scroller (fewer root tiles in a probe, same GPU total), Graphite, the Ganesh cache
  limit.

## Left open

- **GPU** (above): the driver's per-surface memory is the largest piece of A7's app side, and it is not something
  Volt's drawing code allocates. The structural route is fewer surfaces that draw while agents run.
- **Renderer** (brief item 4: background chats keeping a model instead of a rendered transcript) and **main, shared
  process and extension host under load** (item 5) were not reached this round.
