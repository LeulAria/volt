# Round 6 (2026-11-15): orchestration, first word, tokens, launch, memory, idle CPU, typing lag

Round 5 (`../round5/`) left Volt ahead of Claude Code on the four orchestration tasks and short of ADEMark's leaders
on relaunch, first word, idle CPU, typing lag and the memory columns. Round 6 took the user's request ("fix every
low-hanging fruit, rank 1st on ADEMark wherever possible; Volt and its composer must show instantly") as seven
areas, each with its own agent, worktree and branch off `7f07f73d677` (main with rounds 1-5 and PR #99). Every
branch is merged into `volt/8fb8291c` (this tree).

**ADEMark method, unofficial.** ADEMark's prompts, replay server and procedures on a shared laptop (Apple M4 Max,
14 cores) in a normal account, with our own CDP scripts. None of it is an ADEMark result; the published leaders ran on
a Mac mini M4 with Opus 5.5 at high effort. Live turns here ran on Opus 5.5 at **medium** effort (the user's choice);
replayed turns use no model.

Timed rows count only at a 1-minute load of 14 or less, before and after interleaved, one area timed at a time (a
shared timing lock), one heavy build at a time (a shared heavy lock). The round's agents died once with the parent
session (02:30); their queued timed runs kept going overnight and were picked up at 08:25.

## Reports

| # | Report | Area | Branch |
|---|---|---|---|
| 51 | [51-orchestration.md](51-orchestration.md) | C1 orchestrated build vs Claude Code solo, C2-C6 reliability | `e6/orch` |
| 52 | [52-first-word.md](52-first-word.md) | A4 Enter to first word, relaunched and reopened chats | `e6/firstword` |
| 53 | [53-tokens.md](53-tokens.md) | Track B prompt size ("hi", the real prompt) and cost | `e6/tokens` |
| 54 | [54-launch.md](54-launch.md) | A1 cold start, A2 relaunch, composer on screen, release builds | `e6/launch` |
| 55 | [55-weight.md](55-weight.md) | A5 at rest, A7 under load, A9 after quit, A10 per thread, release builds | `e6/weight` |
| 56 | [56-idle.md](56-idle.md) | A6 idle CPU, window in front and covered, release builds | `e6/idle` |
| 57 | [57-typing.md](57-typing.md) | A8 typing lag while 5 agents stream | `e6/typing` |

Data is in `data/<area>/`, scripts in `scripts/<area>/`.

## Orchestration (report 51)

C1, Opus 5.5 at medium effort, n 1 per arm. The queue stopped itself at 97 % of the account's 7-day limit; five
overnight runs were refused on an expired token and do not count.

| Arm | Shipped | Time | Tokens | Cost |
|---|---|---|---|---|
| Volt after | 5/5 | **2.58 min** | 842K | $1.56 |
| Volt before | 5/5 | 2.69 min | 1,106K | $1.83 |
| Claude Code 2.1.322 alone | 5/5 | 3.72 min | **695K** | **$1.11** |
| ADEMark v1 leader, Synara (other machine, high effort) | 5/5 | 5.18 min | 2.03M | |

Giving subagents the user's request whole cut their tokens by 34 % (722K -> 473K). Volt is 31 % faster than Claude
Code alone but uses 21 % more tokens. Reliability, on our own rigs: C2 delivered 3/3 follow-ups and C3 had 0 locks.
C4 (agent killed), C5 (network cut) and C6 (app restart) pass after two fixes: a lost agent process now restarts
and retries, and Claude Code's own connection retry stays a notice.

## First word (report 52)

Dev builds, medians, load 14 or less, arms alternating.

| Test | Before | After |
|---|---|---|
| A4 new chat, Enter to first word | 109 ms (n 9) | **92 ms** (n 9) |
| Restored chat, pointer first, Enter to first word | 650 ms (n 6) | **218 ms** (n 6) |
| Adapter alone, prompt 400 ms after ready, to the model request | 395 ms (n 5) | **98 ms** (n 5) |

- Cause of round 5's slow relaunched chat: Claude Code's first command waited for every MCP server still connecting,
  including the account's four claude.ai connectors, which arrive about 0.4-1.1 s after the session is ready.
- Fix: `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0` plus `mcp__volt` in each session's allow rules, so the first command waits
  only for Volt's own server (connected in 11 ms). The connectors' tools still join when they connect.
- Also fixed: the global `claude-agent-acp` on PATH skipped Volt's preload (compile cache, after-turn patches).
- No agent stays alive at rest because of this.

## Tokens (report 53)

Opus 5.5 at medium effort, medians of n=3 (every run within 0.1K for "hi"). Bare CLI = Claude Code 2.1.322, the
version Volt's adapter runs.

| Test | Before | After | Bare CLI, this Mac | Paseo (site) |
|---|---|---|---|---|
| B1 "hi" | 12.2K | **11.4K** | 18.1K | 22.2K |
| B3 real prompt | 47.4K | **44.3K** | 60.4K | 73.2K |
| B3 cost | $0.0689 | **$0.0667** | $0.0710 | $0.150 |

- Ratio to the bare CLI: "hi" 0.67 to **0.63**, the real prompt 0.78 to **0.73**. Paseo's 0.58 and 0.43 are not
  reached.
- How: Claude Code 2.1.322's hooks module can rewrite named sections of its system prompt and each per-request
  attachment, not only defer tools. Volt now rewrites eight of Claude Code's texts and compacts its own; the chat
  title prompt and the visuals note are shorter.
- Left as the user's call: the three task tools kept loaded for orchestration (1.6K tokens per request), Claude Code's
  memory section (about 560), the Skill tool (909).

## Launch (report 54)

Release builds, three arms interleaved, n 6 each, load 4.0-7.5, ms.

| Test | Before | After (`52965cababa`) | Leader |
|---|---|---|---|
| A2 relaunch, Ready | 852 | **701** | Diri 670 |
| A2 real composer on screen | 1186 | **877** | |
| A2 composer controls visible | 573 | 576 | |
| A1 cold start, Ready (no `purge`) | 758 | **669** | super.engineering 1,760 |
| A1 real composer | 1011 | **843** | |

- Found: round 5's launch window broke the renderer's V8 code cache, so every launch compiled the 20 MB workbench
  bundle and wrote a new 13 MB cache entry. The cache path is now set before the launch window (`a4481680b6d`).
- The main bundle is imported while Electron starts, mermaid and the device viewer load on first use, and the canvas
  warm-up waits for idle time.
- An intermediate build (`f037d0a63cb`) made the composer controls appear later (573 -> 750 ms); `52965cababa`
  fixed that by making `main()` wait for the launch page.
- A2 is 31 ms above Diri's 0.67 s.

## Memory (report 55)

Release builds, ADEMark's sampler, MB.

| Test | Before | After | Leader | Place after (before) |
|---|---|---|---|---|
| A5 at rest, 5 idle threads | 778 (n 3) | 785 (n 3) | super.engineering 134 | 4th of 14 (4th) |
| A7 under load, total p95 | 3,246 (n 2) | 3,222 (n 2) | super.engineering 969 | 10th of 11 (10th) |
| A9 60 s after quit | 0 | 0 | 0 | tied 1st |
| A10 per thread, 5 -> 20 | 57.7 (n 1) | **15.7** (n 2) | Zeron 2.1 | 7th of 13 (last) |
| A10 rest-20, app | 1,486 | **1,019** | Diri 212 | 9th of 13 (10th) |

- Two fixes: the spare agent refilled after every reply now lives 20 s, not 10 min (`cdc82211e86`); the turn footer's
  "12s ago" label reads "just now" for its first minute, so the GPU process no longer keeps a streaming chat's
  working set for 60 s after every turn (`ee66175e499`; GPU at rest-20 604 to about 202 MB).
- What is left of 15.7 MB per thread: the open chat's agent (kept 15 min) and the last chat's 30 s grace (about
  8.4 MB), plus the code index (34 MB) and one more child process (33 MB) that start with the first turn.
- Found, not changed: the thread's fade mask costs about 60-100 MB of GPU memory per visible chat (a design call);
  three Plugin-helper processes (about 175 MB) start with the first A7 stream (cause not found yet).

## Idle CPU (report 56)

Release builds, ADEMark's sampler, median (n 5 per arm), window in front; ABBA, load 4-14.

| Test | Before | After | Leader |
|---|---|---|---|
| A6 idle CPU, in front | 0.70 % (0.46-1.16) | 0.71 % (0.49-0.88) | super.engineering 0.18 |
| A6 wakeups/s, in front | 19.8 | 16.0 | |
| A5 at rest (same samples) | 869 MiB | 742 MiB | super.engineering 134 |

- Six fixes cut what Volt re-reads and keeps at rest (worktree `du` pass, code index hold and status forks, a second
  kernel-log read, the awake lease every 30 s): fewer wakeups and processes, **no CPU change beyond the noise**.
- Covered rows on the release builds are too few to compare: the window sat on another Space (the user had a
  full-screen app in front) for 5 of 9 covered samples, and both valid "after" covered rows had a warm agent alive.

## Typing lag (report 57)

Dev builds, ABBA n=3, 60 keys into the streaming chat's composer while 5 replay streams run. Each run started at load
12.6-13.9; the load rose to 13.7-20.7 while it typed.

| Test | Before | After | Leader |
|---|---|---|---|
| A8 key to pixels p95 | 105.9 ms (71.9-118.3) | 97.6 ms (81.0-111.1) | 48 ms |

- **No measurable change in the timed rows** (the ranges overlap). The traces show the per-frame work fell: per
  streamed frame, three or four forced style and layout passes became one; the open code fence's card is no longer
  rebuilt and re-tokenized on every chunk; the working-dots strip is stepped by a 175 ms timer instead of nine
  animating SVG circles; fresh-text recalcs per frame 8.2 to 3.
- Open: a release-build A8 run on a quiet machine; Volt is about twice the leader on a dev build.

## Also merged

- Your UI fixes from the main checkout that had not reached this branch: danger buttons get a faint tint of the error
  colour instead of red text on grey, compact buttons on the watched-task card and the sandbox confirm line, the
  Volt Guard card's 5px top margin, one split line beside an empty tools area (`1ec691d32a0`); the workflow template
  service registers at startup (`bd4ce7048ac`).
- The mobile-workbench follow-up that PR #98 merged without (uncommitted in its checkout, 34 files): on a phone the
  sidebar toolbar and filter menus open as bottom sheets, an Editor button in the chat's title bar, the model picker,
  Settings pages, a key bar and drag scrolling (`9d56dac17e5`, merged in `f689f03294f`; conflicts were import lists
  of files moved since, and one line in Settings).
- Volt Guard no longer shows a card for Claude Code's own plugin sync in a chat's config overlay
  (`.../agent-state/<chat>/claude-code/config/plugins`): still denied and logged, like the same writes in
  `~/.claude/plugins` (`72e120404cc`).
- `origin/main` had nothing new (its only new commit is PR #99, this branch). The one open PR, #81, is a draft and is
  not merged.

## Merge notes

- Every round-6 branch merged into this tree without conflicts: tokens and typing (round 6 itself), memory, then
  idle, launch, first word and orchestration with their code (11:10), then their final reports (12:35).
- The orchestration, first-word, launch and idle reports were finished after their agents had stopped: orchestration
  by the coordinator from the agent's committed rows, the other three by round 7's agents before they stopped.

## Verification

- Type check (`npm run compile-check-ts-native`) clean after every merge.
- Each area's unit tests passed in its own branch; the touched suites were run again on the merged tree with round 7
  (see `../round7/README.md`).

## Open after round 6

- A2 relaunch 701 ms against Diri's 670.
- A6 idle CPU about 0.70 % in front against 0.18 %: wakeups fell (19.8 -> 16.0 per s) but CPU did not move beyond noise.
- A7 under load (3,222 MB, 10th of 11) and A10 per thread (15.7 MB, 7th of 13).
- A8 typing lag (97.6 ms on dev builds, no release-build row) against T3 Code's 48.
- C1 has n 1 per arm; Volt uses 21 % more tokens than Claude Code alone.
- The user's calls: the thread's fade mask, and the three task tools kept loaded.
- Round 7 (`../round7/`) started on these and was stopped before its timed runs.
