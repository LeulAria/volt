# Round 6: weight (A5/A7/A9/A10 on release builds)

Status: **in progress** (2026-11-15 02:00). Code fixes done and measured on the dev build; the release-build
blocks (A5/A9/A10 and A7, before/after interleaved) run unattended from `~/.volt-r6/weight/chain.sh` once the
shared minified before build exists (launch's build has held the heavy lock since 00:50 at a 1-minute load of
40-60) and this branch's minified build is made. Their rows go to `round6/data/weight/`.

Branch `e6/weight`, worktree `volt-e5-weight`, from `7f07f73d677`. Scripts `round6/scripts/weight/` (round 5's rig
with `~/.volt-r6` paths), data `round6/data/weight/`.

**ADEMark method, unofficial.** ADEMark's sampler (`ademark-native`, `phys_footprint`, its app/agents grouping),
its replay server and its seed and A7 prompts, run by our own CDP scripts on a shared Apple M4 Max laptop with six
other agents' work on it (1-minute load 20-60 all night). MB = MiB. Prompts are pasted, as ADEMark's `timed.send`
pastes (GUIDE.md); round 5's rig typed them, which also started the Tab predictor's agent.

## Summary

- **A10's per-thread cost was never per thread.** Two things filled the 60 s window ADEMark samples right after
  the 15th seed turn: a spare agent refilled after every reply and kept 10 minutes (an ACP adapter, counted as
  `app`, plus a Claude CLI), and the GPU process holding a streaming chat's whole working set (about 400 MB) for
  60 s after every turn, because the turn footer's "12s ago" label rewrote the DOM once a second and each write
  was a frame. Both are fixed (`cdc82211e86`, `ee66175e499`); dev build numbers below, release rows to come.
- Nothing else grows per thread: hidden chats keep no DOM, the agent server's heap grows 0.8 MB per chat, the
  GPU's growth was per turn.
- Not built: one adapter for several chats (the sandbox wrap and the account's `CLAUDE_CONFIG_DIR` overlay are
  per adapter process). Not changed: the chat in use keeps its agent 15 minutes (firstword's follow-up path; about
  70 MB of `app` in A10's window, 4.7 MB per thread by ADEMark's formula on its own).

## Results

Release-build rows: to come (`node scripts/weight/summarize.mjs 14 minbefore minafter`).

### Dev build, same tree before and after each fix, same day

| What | Before | After |
|---|---|---|
| GPU process footprint after one seed turn (`footprint`, MiB; rest about 240) | 600-640 from 5 s to 60 s after the turn, 252 at 64 s (n 2: `afterturn-1.log`, `afterturn-2.log`) | 510 at 5 s, **242 at 11 s**, 235-250 from 27 s on (n 1: `afterturn-3-fixed.log`) |
| Renderer / GPU CPU after one seed turn | 0.5-1.5 % / 1-2 % until 60 s, 0 % from 69 s | 0 % from 27 s |
| Layouts per 5 s after a turn (CDP `Performance.getMetrics`) | +5 (one a second) until 60 s | not re-measured; the writer is gone (`mutprobe-1.log`) |
| Agents alive at rest after seeding, besides the chat in use | refill spare (10 min) + Tab predictor when typed into | refill spare 20 s; none with pasted prompts |

Raw: `data/weight/dev/` (the `~/.volt-r6/weight/*.log` probes).

## What lives after a chat finishes (dev build, process list)

Seeding 5 threads by paste, then looking at the tree (`watch.mjs`, `fp.mjs`):

- the chat in use keeps its agent (ACP adapter + Claude CLI) for 15 minutes (`IDLE_AGENT_TTL_MS`);
- every other chat's agent stops 30 s after its turn (`IDLE_AGENT_GRACE_MS`; it resumes on the next send);
- a **spare for the next new chat**, refilled when a run ends (`afterRun`), lived 10 minutes (`SPARE_AGENT_TTL_MS`);
- the **Tab predictor** (a text-only ACP session: adapter + CLI, `--tools=`, low effort) boots on the composer's
  first inline-completion request, which typing triggers and a paste does not, and stops after 10 idle minutes.

So round 5's "3 adapters at rest-20" were the chat in use, the refilled spare and the predictor (its rig typed).

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
  stopped at 60 s ("1m ago"), the GPU let the working set go in one step.

## Fixes

| Commit | What | Evidence |
|---|---|---|
| `cdc82211e86` | The spare refilled after a run lives 20 s, not 10 min. A new chat warms its own agent when it opens (300 ms after the open, at once on a click), about a second before anyone can send, so the refill only helps a chat opened right after a reply. | Dev: spares gone 20 s after a seed; runtime unit suite 38 passing (a check of the refill's time to live added). Release A10: to come. |
| `ee66175e499` | An "ago" label reads "just now" for its whole first minute (then "1m ago", as before); the chat clock keeps its one-second pace only for live counters. | Dev, one seed turn: GPU 600 MB until 64 s after -> 242 MB at 11 s; renderer and GPU CPU at 0 % from 27 s instead of 69 s. `dayjs.test.ts`. Typecheck clean. |

Both are shipped defaults, no setting, no bench detection. Capability kept: a new chat still gets a warm agent
(its own warm-up on open or focus, or the refill within 20 s); the label still says when a turn ended, to the minute.

## Check-at-120 s (round 5's open risk)

Code check only (no timing at load 40-60): `voltMemoryService.sandboxedContext` serves the last context block at
once and reads again behind the turn once it is stale, so a plugin host stopped at 90 s costs a new agent's first
prompt nothing after the launch warm-up's read. The sandboxed host's cold start is paid only when no block was read
since launch.

## Not done, and why

- **One ACP adapter for several chats.** The adapter is spawned per chat with the chat's sandbox wrap
  (`acpProvider.ts`, `stdio.spawn({ ..., sandbox })`) and its `CLAUDE_CONFIG_DIR` account overlay; one process for
  several chats would put them in one sandbox and one account. Not built (as round 5).
- **The chat in use keeps its agent 15 minutes.** In A10's window that is the adapter of the last seeded chat
  (about 70 MB of `app`). Stopping it sooner is a first-word trade (follow-ups would pay a `session/resume`);
  firstword owns that call.
- **A7's app side** is five streaming chats' renderer and the GPU working set above, which is per turn and not
  cut; the fix here only ends it sooner. A7 total cannot reach the top third while five Claude CLIs (about 1,000
  MB, `agents`) stream.
- **The 30 s idle grace** of chats not in use was left: in A10's window it is 0-1 adapters at the median tick.
