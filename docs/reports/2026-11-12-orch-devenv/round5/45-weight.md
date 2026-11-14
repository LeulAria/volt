# Round 5: weight (memory on a release build)

Status: **final** (2026-11-14 22:30). Stopped on the user's request to finish: the second A7 round, the first-word
check and the release landing A/B were queued but never got the timing lock, so they have no rows.

Branch `e5/weight`, worktree `volt-e5-weight`, from `9bbb8818c60`. Scripts `round5/scripts/weight/`, data
`round5/data/weight/` (rows in `a5.jsonl`, `a7.jsonl`, `a9.jsonl`; 4 Hz samples in `raw/`;
block logs in `logs/`). Table: `node scripts/weight/summarize.mjs 14 minbefore min2`.

**ADEMark method, unofficial.** ADEMark's sampler (`ademark-native`, `phys_footprint`, its app/agents grouping
rules), its replay server and its seed and A7 prompts, run by our own CDP scripts on a shared Apple M4 Max laptop
(14 cores) with six other agents' work on it. The published leaders were measured by ADEMark on a Mac mini M4,
16 GB. None of this is an ADEMark result; the comparison with the leaders is indicative only. MB = MiB, as in
ADEMark.

## Builds

Every number here is from a **release (minified) build**, `gulp vscode-darwin-arm64-min`, each run from its own
fresh `--user-data-dir` with `--use-mock-keychain`, CDP 9976:

| Arm | Build | Carries |
|---|---|---|
| `minbefore` | shared before build, `9bbb8818c60` (round 4 merged) | - |
| `minafter` | `ab157fe66a7` | plugin host idle stop 90 s, Orbit still picture |
| `min2` | `1f9c93b49cf` (e5/weight's code tip) | the above + dictation glow out of the layout at rest + event log keeps frames only |

The agent server runs as a plain child (`VOLT_AGENT_SERVER_LAUNCHD=0`) for A5, A7 and A10: the shipped launchd job
does not inherit `ANTHROPIC_BASE_URL`, so under launchd the seed turns went to the real API (rows set apart in
`data/weight/invalid-live-api/`). A9 runs as shipped, under launchd.

## Results

All rows at a 1-minute load of 3.1-10.9 (gate 14), each arm's block taken under `~/.volt-r5/timing.lock`, arms
interleaved. n is small: one block per arm per pair.

| ADEMark test | minbefore | minafter (build 1) | min2 (tip) | Leader (ADEMark, other machine) |
|---|---|---|---|---|
| A5 five idle threads, app (= total, no agent alive) | 661 MB (n 2: 630, 692) | 637 (n 1) | 630 (n 1) | super.engineering 134 MB |
| A5 agent processes at rest | 0 | 0 | 0 | |
| A7 five streams, total p95 | 3,337 MB (n 1) | - | 3,016 (n 1) | super.engineering 969 MB |
| A7 app p95 | 2,301 (n 1) | - | 1,992 (n 1) | |
| A7 agents p95 | 1,084 (n 1) | - | 1,070 (n 1) | |
| A9 left 60 s after quit | 0 MB (n 2) | 0 (n 1) | 0 (n 1) | 0 (many) |
| A10 MB per thread, (rest-20 app - A5 app) / 15 | 55.1 MB (n 2: 53.0, 57.3) | 55.9 (n 1) | 57.3 (n 1) | Zeron 2.1 MB |
| A10 rest-20 app | 1,488 MB (n 2: 1,487, 1,489) | 1,475 | 1,489 | |
| A10 rest-20 total | 1,977 MB (n 2: 1,976, 1,978) | 1,975 | 1,956 | |

**No cut moved A5, A9 or A10 beyond the spread between two blocks of the same build** (minbefore's two A5 blocks
differ by 62 MB). A7 dropped by 321 MB total p95 (309 MB app), but that is one pair; see below.

### Where Volt stands against the published field (indicative)

- **A5 at rest: 630-692 MB**, against super.engineering 134, Bare CLI 188 (app only), Zeron 209, monocode 419
  (total), Orca 528, Paseo 559, Capy 594, Synara 631, T3 Code 652, bb 788, Claude Desktop 865, Traycer 1,092,
  Emdash 1,494. By `total` (what the Mac pays, agents included) Volt is fourth of the measured field, behind
  super.engineering 134, monocode 419 and Capy 594, ahead of Zeron 951 and Bare CLI 1,013, because Volt keeps no
  agent alive at rest (round 4). By `app` it is mid-field.
- **A7 under load: 3,016-3,337 MB total p95**, near the back of the field: super.engineering 969, monocode 1,533,
  Zeron 1,817, Bare CLI 1,905, T3 Code 2,289, Paseo 2,516, Synara 2,581, Traycer 2,605, bb 2,683, Orca 2,780, then
  Volt, then Emdash 3,531. Volt's agents (five Claude CLIs, 1,070-1,084 MB p95) cost about what the Bare CLI's do;
  the gap is the app side (about 2,000-2,300 MB p95).
- **A10 per thread: 53-57 MB, last of the measured field** (Zeron 2.1, T3 Code 5.3, super.engineering 6.5, Diri
  6.9, ..., Traycer 39.9).
- **A9: 0 MB**, with the leaders (round 4's 20 s agent-server stop holds on the release build, launchd path).

## Where the memory goes (release build)

**A5 at rest (min2, 630 MB):** GPU process 206, renderer 164-177, main 73-79, extension host 56-57, agent server
55-57, node utility (shared process, file watcher, pty host) 42-44, network service 14, sandbox helper 2. Nine
processes, no agent. The renderer's JS heap is about 57 MB (minbefore heap snapshot, exploratory); its largest single item is the
shipped material icon theme's CSS, a 3.12 MB string (13k file associations).

**A10, 20 threads right after seeding 15 (min2, app 630 -> 1,489 MB):** the sample starts at once, as ADEMark's
does, while the seeds' agents are still in their grace period:

| t in window | app | agents | ACP adapters | Claude CLIs | GPU |
|---|---|---|---|---|---|
| 0 s | 2,254 | 1,649 | 10 (801 MB) | 10 | 704 |
| 18 s | 1,630 | 815 | 5 | 5 | 617 |
| 30 s | 1,349 | 468 | 3 | 3 | 479 |
| 54 s | 1,418 | 476 | 3 (208 MB) | 3 | 611 |

ADEMark counts the ACP adapter (a `node` process) in `app`, so about half of A10's growth is adapters still in
their 30 s idle grace, about 70 MB each; the rest is the GPU process (+330-405 MB, still 611 MB at the end of the
window), agent server +66-94, code index +34 (a child that starts with the first turn), node utility +20-40, main
+16-33, renderer +15-42, extension host +8-14. Hidden chats keep no DOM (one editor, 1,306 nodes with 20 threads).

## Fixes (code commits)

| Commit | What | Evidence |
|---|---|---|
| `f55379a6fc2` | The sandboxed T2 plugin host (Memory) stops 90 s after its last call, not 5 min. It is started by the launch warm-up, so before this it held the host, its sandbox watchdog and the sandbox denial monitor (`log stream`, about 1 % of a core) through A5's rest window. | Dev, live: host, watchdog and `log stream` gone by t = 100 s. Neither arm's release A5 rows have a plugin host alive, so A5 does not see this cut. First word after it: not measured (see below). |
| `ab157fe66a7` | The new chat's Orbit background (a window-sized 2x canvas, 3024x1792) trades its canvas for a PNG of the same frame once idle, and gets the canvas back on input, resize or redraw in the same task. | Dev, landing at rest: renderer canvas 103 MB gone, iosurface 204 -> 95 MB, GPU 245 -> 157-181 MB (load 50-60, n 1). Release: not measured (the landing A/B never got the lock). A5, A7 and A10 keep a chat open, not the landing, so they cannot show it. |
| `62a18ec2510` | The composer's dictation glow (a blurred aurora twice the composer's width) leaves the layout at rest, so it and the composer layers kept above it are no longer composited layers. | Dev: 13 composited layers -> 8 at rest. Footprint A/B too noisy to show a change (1 pair, `gpuab.jsonl`). |
| `1f9c93b49cf` | The agent server's event (replay) log keeps each event's JSON frame, seq and topic, not the event object. A streaming reply's patch carries the appended text as a V8 sliced string of the whole reply so far, so every buffered patch kept a full copy of the reply. | Dev, 130 s into A7: server heap 170 -> 86 MB; 2,005 copies of one earlier answer gone (`agentserver-a7-strings.txt`). Release: A7 below. |

## A7 on the release build

One pair, minbefore then min2, fresh profile with 5 seeded threads each, 30 s at rest, then five replay streams
sampled for 180 s at 4 Hz (720 ticks each), load 6.0-8.0, no swap, agent count median 6 on both. p95 by process
(from `raw/a7-*.csv`):

| Process | minbefore p95 | min2 p95 |
|---|---|---|
| Claude CLIs (agents) | 1,084 | 1,070 |
| GPU | 782 | 782 |
| renderer | 668 (median 352) | 493 (median 331) |
| ACP adapters (`node`, counted as app) | 482 | 453 |
| main + agent server + code index (`Electron` executable) | 439 (median 284) | 267 (median 244) |
| node utility | 94 | 84 |
| extension host | 73 | 74 |

The drop is in the renderer's peaks and in the `Electron` group that holds the agent server, which is where the
event-log fix (`1f9c93b49cf`) acted in the dev heap snapshots (170 -> 86 MB). **With n 1 per arm this is not a
measured gain**: a second round (arms reversed) was queued and stopped before it ran. min2 also carries the glow
cut; the Orbit cut is in both min builds' landing only.

## First word (firstword owns warm-up)

Not measured. `fwblock.sh` (first prompt in a new thread 120 s after launch, when `f55379a6fc2` has stopped the
plugin host that the launch warm-up started, 3 interleaved reps per arm) was written and committed but never got
the timing lock before the stop. Risk to check: a new agent's first prompt then waits for the plugin host to
restart (about 0.5 s in dev) unless Memory's context block is served from the last one read, as the commit
intends. None of the other cuts touches the turn path.

## Not done, and why

- **One shared ACP adapter for all threads.** The adapter supports many sessions (a sessions map, per-session env
  through `_meta.claudeCode.options.env`, `session/close`), and the adapter is the largest share of A10 and of A7's
  `app`. But Volt's sandbox wrap, its `CLAUDE_CONFIG_DIR` overlay (per account), its network broker and its file
  broker are all per adapter process, and chats are sandboxed by default. Sharing needs the wrap moved down to the
  CLI spawn (a preload around `spawnClaudeCodeProcess`) and every broker routed by session id. That is a large,
  security-sensitive change; it is left as this design, not built.
- **Extension host started lazily in the agent window.** Not viable without losing features: the composer's
  branch chip, the title bar's changes count and the landing's chrome all use `ISCMService`, which the git
  extension feeds.
- **Adapter Node flags** (`--max-semi-space-size`, `--optimize-for-size`, `--max-old-space-size`): no change at
  rest (53-54 MB each, `adapterflags.jsonl`); the adapter's 33 MB heap is mostly the SDK's 2.6 MB source and about
  8.7k zod schema objects. Dropped.
- **A10's GPU growth** (+330-405 MB after seeding 15 threads, still there at the end of the 60 s window) and the
  material icon theme's 3.12 MB CSS string were found but not cut this round.
- The agent server's file watcher child (33-49 MB, checkpoint watches) appears after the first turn; A5 starts a
  fresh server, and A7/A10 need the watches, so cutting it gains no ADEMark column.

## Notes

- The first two minbefore blocks (load 30-83) ran with the agent server under launchd and hit the real API (Haiku
  5.5) instead of the replay server; no seed finished. They are kept apart as invalid.
- Early in the round, before `--use-mock-keychain` was added for built arms, launches of a round-4 minified build
  may have shown a keychain prompt on the user's screen.
- Dev-build numbers from earlier rounds are not comparable: a dev renderer holds about 174 MB of module source
  strings and a dev agent server about 66 MB.
- The A10 rows sample right after seeding, as ADEMark does; their per-thread figure mostly measures agents in their
  idle grace and the GPU process, not per-thread state Volt keeps.

## Commits on `e5/weight`

Code: `f55379a6fc2` (plugin host idle stop 90 s), `ab157fe66a7` (Orbit still picture), `62a18ec2510` (dictation
glow out of the layout), `1f9c93b49cf` (event log keeps frames). Rig and data: `8b3b14f1c5d`, `2c700b8e3cd`,
`9b032b0593c`, `78dca2cba56`, `bbc97b387c2`, `adfbae5b392`, `0d64e4cf7f4`, and this report's commit (A7 rows).
