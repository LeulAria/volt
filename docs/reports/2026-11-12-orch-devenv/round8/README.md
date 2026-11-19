# Round 8: typing lag, per thread, under load (index)

ADEMark method, unofficial. The ask: "Let's improve Typing lag to beat T3 Code, check T3 Code source code and beat
it. Per thread improve and beat T3 Code. Under load let's beat MonoCode. Improve these things and render the html
diagram again."

Three areas, each on its own branch from `3b41bdb483f` (rounds 1-7), merged into `volt/8fb8291c` at `3c920df8444`
(code) and their final reports at `76ff1113735`. Release builds compared, interleaved, on 16 November 01:41-03:57
+04, every timed row under `~/.volt-r8/timing.lock` with a 1-minute load of 14 or less:

- `r7` = `~/.volt-r8/min/r7/VOLT.app`, `3b41bdb483f` (round 7's fixes, before round 8)
- `r8` = `~/.volt-r8/min/r8/VOLT.app`, `3c920df8444` (all three round-8 branches)

No live model turn was used: every row is on ADEMark's replay server.

| Report | Area | Status |
|---|---|---|
| [81-typing.md](81-typing.md) | A8 typing lag while 5 agents stream | final |
| [82-agents.md](82-agents.md) | A10 per thread, A7's agent side: one adapter process for every Claude chat | final |
| [83-render.md](83-render.md) | A7's app side: TypeScript on first edit, the pinned card's mask, the GPU | final |

## Headline (release builds, medians)

| Column | r7 | **r8** | Target | Reached? |
|---|---|---|---|---|
| A10 per thread | 6.5 MB (n 3; 4.9-16.8) | **3.1 MB** (n 3; 2.9-3.2) | T3 Code 5.3 MB | **yes**, every pair; 2nd on the board behind Zeron 2.1 |
| A7 under load, total p95 | 2,830 MB (n 3) | **2,295 MB** (n 3; 2,287-2,302) | MonoCode 1,533 MB | no; 5th of 11 (T3 Code 2,289) |
| A8 typing lag p95, key to presentation | 36.2 ms (n 3) | **34.6 ms** (n 3; 32.1-40.1), 0 missed | T3 Code 47.9 (board, pixels) | not comparable: see below |
| A5 at rest | 540 MB (n 3) | 538.5 MB (n 6) | | unchanged |
| A3 new thread | 149, 162 ms | 152, 151 ms | | unchanged |
| A4 first word, new chat | 1,029 ms (n 12) | **719 ms** (n 12) | | 330 ms faster than r7; see "Regressions" |

- **A10.** One shared adapter host instead of a process per chat, the agent server freeing memory when quiet, and no
  agent process alive in the window after the 20 s stop (82).
- **A7: -535 MB.** TypeScript helpers 233 -> 0 (they start at the first edit, not at a read), adapters 402 -> 90,
  main and shared process -72, GPU -120 at the p95 tick. What is left: 5 Claude CLIs (795 MB) and the GPU process
  (610-683 MB), most of it Apple's Metal driver memory, held while anything on screen changes at least once a second
  (83). MonoCode's 1,533 would need the whole app, adapters included, near 740 MB with 5 CLIs streaming.
- **A8.** On our rig `r8` is 1.6 ms under `r7` at p95; T3 Code measured 43.6 on the same rig, but its reply does not
  stream to the screen during the probe, so that is its idle floor. Our rig is Chromium's EventLatency, not
  ADEMark's pixel method (it needs Screen Recording), so the page shows Volt's 34.6 in italics and leaves the column
  unranked for Volt; T3 Code keeps that column's red cell.

## Regressions and decisions for the user

- **A4, first word in a new chat: 92 ms (round 6, dev) is now 719 ms on r8.** Every A4 run started a cold agent: since
  round 7's `cdc82211e86` the spare agent started after a run lives 20 s instead of 10 minutes, so A4's runs find none.
  r8's shared host made the cold start 330 ms faster than r7, but it is still a cold start. Bringing the warm spare
  back costs A10/A5 memory (a CLI kept alive at rest). On the page Volt drops from 1st to 5th in this column.
- **Follow-up 30 s after a reply** (round 7's 20 s agent stop): r8 407.5 ms (gap 400) / 807 ms (gap 0), against
  198 / 193.5 before round 7. With the pointer moving over the reply while reading, r8 keeps the agent and answers
  in 298 ms. Keeping the 20 s stop is what holds A10 at 3.1.
- **The pinned card's row mask (`60ae30ac30b`) is not pixel-identical.** The brief allowed it only if pixel-identical
  in light and dark. On r8 every difference sits in the fade band under the card: 3/255 in 13 of 16 positions, 16/255
  (dark) and 24/255 (light) at one position each (83). Keep it or revert it.
- **The shared adapter host runs outside the chats' sandboxes**; its file and process limits are enforced in code,
  and every process it asks for (the CLI and its tools) still starts in the chat's own sandbox. The setting
  `volt.agents.sharedAdapterHost: false` restores one sandboxed adapter per chat (82).

## The bench page

`../bench.html` (also served at http://127.0.0.1:9936/ from `~/.volt-r7/bench/site`), made by
`~/.volt-r7/bench/make_bench2.py <ademark site> <volt mark> <out>`. Round 8 changed Volt's A3, A4, A5, A7, A8 and A10
cells to the r8 numbers above; A1, A2, A6, A11, B1, B3 and C1 are from earlier rounds. A Volt value can now be shown
without a rank (a third tuple element `True`): A8 uses it. Volt stays 1st overall (5 columns led: cold start, new
thread, long thread, hello, real prompt).

## Rerun

- typing: `round8/scripts/typing/session8.sh a8 r7,r8,r8,r7,r7,r8 t3 2` and `session8.sh ab r7,r8 2 3 6`
- agents: `round8/scripts/agents/r8run.sh <arm>`, `FUBLOCK_READER=1 fublock.sh "r7 r8" 2 2`, `fwblock.sh r7 r8 3`
- render: `ARMS="r7 r8" round8/scripts/render/finalblock.sh 3`; pixel check `stuckpix.mjs <label> 8` (`PIX_CONTROL=1`
  for A/A) with a long reply under the pinned card in the front chat
