# Round 6: weight (A5/A7/A9/A10 on release builds)

Status: **final** (2026-11-15 09:05).

Branch `e6/weight`, worktree `volt-e5-weight`, from `7f07f73d677`. Scripts `round6/scripts/weight/` (round 5's rig
with `~/.volt-r6` paths), data `round6/data/weight/` (rows in `a5.jsonl`, `a7.jsonl`, `a9.jsonl`; 4 Hz samples in
`raw/`; block logs in `logs/`; dev probes in `dev/`). Table: `node scripts/weight/summarize.mjs 14 minbefore minafter`.

**ADEMark method, unofficial.** ADEMark's sampler (`ademark-native`, `phys_footprint`, its app/agents grouping),
its replay server and its seed and A7 prompts, run by our own CDP scripts on a shared Apple M4 Max laptop (14 cores)
with six other agents' work on it. The published leaders were measured by ADEMark on a Mac mini M4, 16 GB, Opus 5.5
high effort; every turn here is a replay (no model, so effort does not apply). None of this is an ADEMark result;
the comparison with the leaders is indicative only. MB = MiB, as in ADEMark. Prompts are pasted, as ADEMark's
`timed.send` pastes (GUIDE.md); round 5's rig typed them, which also started the Tab predictor's agent.

## Summary

- **A10 per thread: 57.7 -> 15.7 MB** on the release build (47-58 before depending on the A5 row; rest-20 `app`
  1,486 -> 1,019 MB). Two things filled the 60 s window ADEMark samples right after the 15th seed turn: a spare agent refilled after every reply and
  kept 10 minutes, and the GPU process holding a streaming chat's working set (about 400 MB) for 60 s after every
  turn because the turn footer's "12s ago" label rewrote the DOM once a second. Both are fixed (`cdc82211e86`,
  `ee66175e499`). On the release build the GPU at rest-20 is 201-204 MB after, 604 MB before. Place: last of 13 ->
  7th (leader Zeron 2.1, top third needs about 6.5).
- **A5 at rest: unchanged**: 785 MB after (n 3, 781-787), 778 before (n 3, 620-782; the 620 row had every
  process paged down at once, the other two are within 9 MB of the after rows). 4th of 14 (capy 594 is 3rd).
  Neither fix touches the at-rest path; per process the arms match to a few MB.
- **A7 under load: unchanged**, 3,246 -> 3,222 MB total p95 (n 2 each, ranges 7 and 13 MB). Still 10th of 11; five
  Claude CLIs alone are about 1,050 MB of it.
- **A9: 0 MB** 60 s after a quit, both arms (tied 1st).
- Not built: one adapter for several chats (sandbox and account are per adapter process). Found, not changed: the
  thread's fade mask costs a render pass per visible chat; three extra Plugin-helper processes (about 175 MB)
  start with the first A7 stream.

## Builds

| Arm | Build | Carries |
|---|---|---|
| `minbefore` | shared before build (launch's), `7f07f73d677` | - |
| `minafter` | `f0bc50afe7e` (e6/weight; later commits are docs and rig only) | spare refill lives 20 s; "ago" label reads "just now" for its first minute |
| `before` / `after` (dev) | `volt-e5-base` dev / this tree's dev build | same as above |

Each run from a fresh `--user-data-dir` with `--use-mock-keychain`, CDP 9976, replay server on 18976. The agent
server runs as a plain child (`VOLT_AGENT_SERVER_LAUNCHD=0`) for A5, A7 and A10 (the launchd job does not inherit
the replay's `ANTHROPIC_BASE_URL`); A9 runs as shipped, under launchd. The minified after build ignored four type
errors (`VOLT_BUILD_IGNORE_TYPE_ERRORS=1`: two mangler errors in `voltTestController.ts` and two cyclic imports,
none in files this branch changed; launch's and idle's minified builds of their own branches log the same four).

## Results (release builds)

Rows taken under `~/.volt-r6/timing.lock`, arms interleaved (blocks minbefore, minafter, minafter, minbefore
overnight, then one more pair minafter, minbefore at 08:40-08:58 for A5's n; that pair's A10 rows ran at load
19.5-22.5), 1-minute load gate 14; rows above 14 are listed and left out of the medians.

| ADEMark test (headline in bold) | minbefore | minafter | Leader (ADEMark v1, other machine) | Place after (before) |
|---|---|---|---|---|
| **A5 at rest, 5 idle threads, total** (= app, no agent alive) | 778 MB (n 3: 620, 778, 782) | 785 (n 3: 781-787) | super.engineering 134 | 4th of 14 (4th) |
| A5 agent processes at rest | 0 | 0 | | |
| **A7 under load, 5 streams, total p95** | 3,246 MB (n 2: 3,242-3,249) | 3,222 (n 2: 3,215-3,228) | super.engineering 969 | 10th of 11 (10th) |
| A7 app p95 / agents p95 | 2,211 / 1,054 | 2,208 / 1,057 | Zeron 236 (app) | |
| A9 60 s after quit (`no-sessions`) | 0 MB (n 3) | 0 (n 3) | 11 apps at 0 | tied 1st |
| **A10 per thread, 5 -> 20** ((rest-20 app - A5 app) / 15, per block) | 57.7 MB (n 1; rows above load 14: 47.8, 48.9) | **15.7** (n 2: 15.0, 16.3; above 14: 21.6) | Zeron 2.1 | 7th of 13 (13th, last) |
| A10 rest-20 `app` | 1,486 MB (n 1; above 14: 1,495, 1,515) | **1,019** (n 2: 1,006-1,032; above 14: 1,109) | Diri 212 | 9th of 13 (10th) |
| A10 rest-20 total | 1,989 (n 1; above 14: 1,969, 2,000) | 1,332 (n 2: 1,311-1,352) | | |
| CPU in A10's window, app / agents | 3.3-5.9 % / 7.4-9.7 % | 1.9-3.0 % / 5.3-7.9 % | | |

Loads of the rows used: A5 5.1-13.9, A10 4.1-8.9, A9 4.8-13.9, A7 3.9-4.6. A10 before has one row under the
gate, but all four minbefore rows (1,486-1,515) and round 5's three (1,487-1,489) agree, and the after row taken at
load 22.5 (1,109) is still far under them, so the gain does not hang on n. The per-thread "before" depends on which
A5 row it is divided against: with the block's A5 of 778 it is 47.2. The summarizer's "ACP adapters alive" (10 on
both) counts every adapter seen in the 60 s, not the ones alive at once; the median alive is in the table below.
Raw: `data/weight/a5.jsonl` (A5 and A10 rows), `a7.jsonl`, `a9.jsonl`, `raw/*.csv`, `logs/`.

Leader and place: ADEMark's published v1 summary (`data/v1/summary.json`, 2026-11-12), bare CLI left out of the
place (it is a control, not an ADE).

### A10's window, by process (median over the 60 s, release, MB)

| Process | minbefore (2 rows) | minafter (2 rows) |
|---|---|---|
| GPU | 604, 604 | 204, 201 |
| renderer | 244, 177 | 230, 177 |
| ACP adapters (`node`, counted as `app`), median alive | 173, 208 (3 alive) | 114, 138 (2 alive) |
| main + agent server + code index + one more bootstrap-fork child (`Electron` executable) | 298, 325 | 312, 312 |
| Claude CLIs (`agents`) | 474, 503 (3 alive) | 320, 306 (2 alive) |

What is left of the 235 MB that 15 more threads add on minafter: the two agents still alive in the window (the
chat in use, kept 15 minutes, and the last seeded chat in its 30 s grace) are about 126 MB of `app` (8.4 MB per
thread by ADEMark's formula) plus their CLIs in `agents`; the agent server grows about 55 MB, and the code index (34
MB) and one more bootstrap-fork child (33 MB, its command line is cut in the sampler) start with the first turn
and are not in A5. Without both adapters, per thread would be about 7.3 MB (5th); without them and the code index,
about 5 MB (2nd). Those are firstword's (the 15-minute chat agent) and codeintel's (the index) calls; not changed
here.

### A7 at the app p95 tick, by process (release, MB)

| Process | minbefore | minafter |
|---|---|---|
| Claude CLIs (`agents`) | 1,054 | 1,010 |
| GPU | 776 | 741 |
| renderer | 277 | 511 |
| ACP adapters | 454 | 384 |
| main + agent server + code index | 286 | 253 |
| Plugin helpers (extension host + 3) | 313 | 243 |
| node utility, network | 97 | 57 |

The p95 tick mixes processes at different moments, so the split moves between rows while the totals stay within
13 MB. The ".. ago" fix cannot show in A7: A7 samples during the streams, and the label only ran after a turn.

**Three Plugin-helper processes start with the first stream** (found, not traced to its source): the extension
host log shows `vscode.typescript-language-features` activated by `onLanguage:typescript` 33 s after launch (when
A7's sends begin), and three `VOLT Helper (Plugin)` processes start together at that moment (37-40, 66-89 and 73-101
MB: the shape of tsserver's syntax and semantic servers and its typings installer). With the extension host they
are 243-313 MB at the p95 tick, against 69 MB for the extension host at rest. Not the transcript's code cards
(simple-widget models, never sent to the extension host), not the ACP `fs/read_text_file` path (reads through the
file service). A7's replay has a `Read` of `paginate.ts` and 52 ` ```ts ` fences. Next step: a test profile with
`typescript.tsserver.log` on, to see which document opens tsserver; if it is a model only the transcript needs, the
TS extension's `disabledSchemes` (as upstream does for `chat-editing-text-model`) would keep tsserver off.

## Dev build, same tree before and after each fix, same day

| What | Before | After |
|---|---|---|
| GPU process footprint after one seed turn (`footprint`, MiB; rest about 240) | 600-640 from 5 s to 60 s after the turn, 252 at 64 s (n 2: `afterturn-1.log`, `afterturn-2.log`) | 510 at 5 s, **242 at 11 s**, 235-250 from 27 s on (n 1: `afterturn-3-fixed.log`) |
| Renderer / GPU CPU after one seed turn | 0.5-1.5 % / 1-2 % until 60 s, 0 % from 69 s | 0 % from 27 s |
| Agents alive at rest after seeding, besides the chat in use | refill spare (10 min) + Tab predictor when typed into | refill spare 20 s; none with pasted prompts |
| A10 rest-20 `app`, dev (`blocks-dev-1`) | 2,102 MB (load 8.9) | 1,729 MB (load 17.5, left out) |
| A5 `app`, dev | 1,367 MB (n 1) | 1,362 MB (n 1) |

Raw: `data/weight/dev/` (the `~/.volt-r6/weight/*.log` probes) and `logs/blocks-dev-1.log`.

## What lives after a chat finishes (dev build, process list)

Seeding 5 threads by paste, then looking at the tree (`watch.mjs`, `fp.mjs`):

- the chat in use keeps its agent (ACP adapter + Claude CLI) for 15 minutes (`IDLE_AGENT_TTL_MS`);
- every other chat's agent stops 30 s after its turn (`IDLE_AGENT_GRACE_MS`; it resumes on the next send);
- a **spare for the next new chat**, refilled when a run ends (`afterRun`), lived 10 minutes (`SPARE_AGENT_TTL_MS`;
  20 s after `cdc82211e86`);
- the **Tab predictor** (a text-only ACP session: adapter + CLI, `--tools=`, low effort) boots on the composer's
  first inline-completion request, which typing triggers and a paste does not, and stops after 10 idle minutes.

So round 5's "3 adapters at rest-20" were the chat in use, the refilled spare and the predictor (its rig typed).
Opening a thread does not start an agent by itself beyond the new chat's own warm-up (which is the agent that chat
then uses); nothing else grows per thread: hidden chats keep no DOM, the agent server's heap grows 0.8 MB per chat,
and the GPU's growth was per turn.

## Where the GPU's 400 MB went (dev build)

- `footprint`: the GPU process at rest is about 240 MB; during any turn and for 60 s after, 600-760 MB
  ("owned graphics unmapped" about 360 MB, IOSurface 190-260 MB). Three turns or eight: the same. Ten New Chat
  clicks without a send: nothing. So it is a working set per turn, not state per thread.
- memory-infra (`gputiles.mjs`): raster tiles 12 (52 MB) at rest, 62 (189 MB) during a stream, all 3040x480 at
  2x: the compositor's prepaint area (3000 px above and below the viewport) of the thread. Render passes 3 x 15-21
  MB, display buffers 62 MB. Tracked growth is 140-190 MB; the rest is driver memory the dumps do not see.
- Not the cause: reduced motion (peak 737), Skia Graphite off (751), Chromium's `SmallerInterestArea` and
  `ReclaimPrepaintTilesWhenIdle` features (733, still 629 at 40 s) (`turnexp-*.log`).
- The cause (`animprobe.mjs`, `mutprobe.mjs`): after a turn the renderer did one layout and one style recalc a
  second for 60 s, with no CSS animation running. The writer was the turn footer's "ago" label: `dayjs.ts`
  formatted 10-59 s as "12s ago", so `tickMeta` changed its text every second, each a frame. When the frames
  stopped at 60 s ("1m ago"), the GPU let the working set go in one step. The release rows confirm it: GPU at
  rest-20 604 MB before, 201-204 after.

### The thread's fade mask (found, not changed)

At rest the GPU also holds a render pass the size of the chat column (`RenderPassBacking` 2432x1600, 15 MB, plus
1-3 `RenderPassOverlay` copies of 15 MB each) and twice the raster tiles it needs: `.volt-agent-thread >
.monaco-scrollable-element` carries a `mask-image` (the transcript fades out over its last 64 px, "instead of
painting over the translucent window surface", agentEditor.css) and a masked layer gets its own surface, redrawn
every frame it changes. Setting the mask to `none` in the running window dropped shared images from 212 to 114 MB
and raster tiles from 22 to 13 (`cssexp-mask.log`); sticky turns and rounded clips were not the cause
(`cssexp-sticky.log`, `cssexp-radius.log`). A gradient band painted over the transcript would cost nothing, but it
needs an opaque colour behind the thread, and the agent window has vibrancy by default (`setVibrancy('under-window')`,
windowImpl.ts), so the band would show over the see-through surface. Left as a design question for the user: the
fade as it is (about 60-100 MB of GPU memory per visible chat, more while it streams), a band over an opaque chat
background, or no fade. The replies under a pinned user turn (`has-stuck-turn`) carry the same kind of mask while
the chat scrolls.

## Fixes

| Commit | What | Evidence |
|---|---|---|
| `cdc82211e86` | The spare refilled after a run lives 20 s, not 10 min. A new chat warms its own agent when it opens (300 ms after the open, at once on a click), about a second before anyone can send, so the refill only helps a chat opened right after a reply. | Release A10: median adapters alive in the window 3 -> 2, `agents` 474-503 -> 306-320 MB. Dev: spares gone 20 s after a seed; runtime unit suite 38 passing (a check of the refill's time to live added). |
| `ee66175e499` | An "ago" label reads "just now" for its whole first minute (then "1m ago", as before); the chat clock keeps its one-second pace only for live counters. | Release A10: GPU 604 -> 201-204 MB. Dev, one seed turn: GPU 600 MB until 64 s after -> 242 MB at 11 s; renderer and GPU CPU at 0 % from 27 s instead of 69 s. `dayjs.test.ts`. Typecheck clean. |

Both are shipped defaults, no setting, no bench detection. Capability kept: a new chat still gets a warm agent
(its own warm-up on open or focus, or the refill within 20 s); the label still says when a turn ended, to the minute.
First word: not measured on either build (firstword owns the warm-up and the timing lock was spent on the weight
blocks); by the code path, a chat opened more than 20 s after the last reply warms its own agent on open, as it
did before for every chat opened more than 10 minutes after one.

## Check-at-120 s (round 5's open risk)

Code check only: `voltMemoryService.sandboxedContext` serves the last context block at once and reads again behind
the turn once it is stale, so a plugin host stopped at 90 s costs a new agent's first prompt nothing after the
launch warm-up's read. The sandboxed host's cold start is paid only when no block was read since launch. Not timed.

## Not done, and why

- **One ACP adapter for several chats.** The adapter is spawned per chat with the chat's sandbox wrap
  (`acpProvider.ts`, `stdio.spawn({ ..., sandbox })`) and its `CLAUDE_CONFIG_DIR` account overlay; one process for
  several chats would put them in one sandbox and one account. Not built (as round 5).
- **The chat in use keeps its agent 15 minutes**, and the last chat's agent its 30 s grace: about 126 MB of `app`
  in A10's window (8.4 MB per thread). Stopping them sooner is a first-word trade (follow-ups would pay a
  `session/resume`); firstword owns that call.
- **A7** stays near the back: five streaming Claude CLIs are about 1,050 MB of `agents`, and the app side is five
  streaming chats' renderer and GPU working set plus the Plugin helpers above. The top third (< 1,533 MB) is out of
  reach while each chat runs its own CLI.
- **A6/A8** are idle's and typing's.
