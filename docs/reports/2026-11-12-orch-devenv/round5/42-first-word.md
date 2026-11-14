# Round 5: Enter to first word, and the first message to a stopped chat

Status: draft (chains 4-5 pending). Branch `e5/firstword`, worktree `volt-e5-firstword`, from `9bbb8818c60`.
ADEMark method, unofficial.

## Summary

Targets: A4 (Enter to first word on a new chat) below Diri's 256 ms by ADEMark's runner, and the first message to a
restored or just-reopened chat at 0.4 s or less without bringing back resident agents at rest.

- **A4: Volt is far below the Bare CLI on this Mac, and did not change this round.** Volt 100 ms after, 102 ms before
  (DOM poll, n 15 each, load 4-6); 114 ms both, counted two frames after the DOM insert. The Bare CLI control
  (ADEMark's command in a pseudo-terminal) is 214 ms (n 10), close to its 219.6 ms on the board. By ADEMark's gap
  rule (Diri is 36.4 ms above the Bare CLI) Volt is about 100 ms *below* it. Not a ranking number: **ADEMark's own
  A4 runner could not run here** (no process holds the Screen Recording grant, no Ghostty), so both Volt and the
  Bare CLI are lower bounds of a pixel time (DOM, terminal bytes).
- **Reopened chat (sent to after its agent stopped, same app run): target met with a click.** Clicking straight into
  the composer: 718 ms before, **379 ms after** (n 6 each, 289-501). With a hand-like pointer move first: 210 and
  214 ms (both arms already warm by then).
- **Restored chat (first message after a relaunch): target not met.** Click straight in: 1,125 ms before, 1,023 ms
  after (n 4 each, ranges overlap: no measured gain). Pointer first: 704 before, 788 after (n 4 each): the earlier
  warm got the agent ready before Enter (50 ms vs 464 ms after it), but the turn's request then left Claude Code
  0.45-0.6 s after the prompt instead of 0.1-0.2 s. Why is in "What a stopped chat's first prompt waits for".
- **No agent at rest:** every restored-chat run found 0 agent processes before the click (n 16); the intent warm is
  short-lived (stops after 30 s unless a click or key follows).
- **Cold start of the adapter:** Node's compile cache cut spawn to `initialize` from 521 to 331 ms (n 10 each, load
  12-13) and the adapter's CPU to it from 515 to 420 ms.
- **Direct path (Agent SDK, no adapter):** ready in 229 ms instead of 519, first text 81-86 ms after the prompt
  instead of 105-110 ms, one process less per chat. Not built this round: see "Not done, and why".

## Before and after

Medians, (n, min-max), ms. Only rows at a 1-minute load of 14 or less count (all rows here qualify). "Before" =
`volt-e5-base` (`9bbb8818c60`), "after" = `e5/firstword`, dev builds, arms alternating per round. Tables from
`node scripts/firstword/summarize.mjs`.

### A4 First Word (ADEMark sequence: New Chat, 1.5 s, type `replay:hi`, 0.4 s, Enter; Opus 5.5; replay)

2026-11-14 19:17-19:29 +04, load 3.4-5.7.

| Enter to ... | Volt before | Volt after | Bare CLI (pty) |
|---|---|---|---|
| first word, DOM poll (round 3's runner) | 102 (15, 91-171) | 100 (15, 92-168) | |
| first word, two frames after the DOM insert | 114 (15, 107-186) | 114 (15, 109-175) | |
| first word, the TUI writes it to the terminal | | | 214 (10, 194-1,442) |
| the turn's request at the replay server | 87 (15, 76-137) | 85 (15, 77-130) | 84 (10, 66-1,311) |
| request to first word | 18 (15, 10-52) | 15 (15, 9-52) | 131 (10, 126-137) |

Volt and the Bare CLI send the request equally soon after Enter (85 vs 84 ms); the difference is the CLI's TUI, which
takes 131 ms from the request to writing the first word, against Volt's 15-18 ms to the DOM. One Bare CLI run took
1.3 s before its request (the CLI's own start-up work, below); it is in the range, not left out.

### Reopened chat: send in chat A, new chat B, idle 40 s (A's agent stops), open A, 1 s, click the composer, type, Enter

2026-11-14 18:48-19:16 +04, load 2.9-9.3.

| | before, click | after, click | before, pointer first | after, pointer first |
|---|---|---|---|---|
| Enter to first word painted | 718 (6, 688-773) | **379 (6, 289-501)** | 210 (6, 200-649) | 214 (6, 201-228) |
| agent ready (from the send) | 3 (6, 2-4) | 3 (6, 2-3) | 3 (6, 2-5) | 4 (6, 2-4) |
| first text (from the send) | 624 (6, 597-673) | 278 (6, 192-395) | 107 (6, 98-547) | 117 (6, 103-128) |

In every arm the agent is up before Enter (it resumes when the chat opens); what differs is how long before. Before,
the open timer starts it 300 ms after the open; after, a clicked open starts it at once (`2db7ce0d91e`), which gives
Claude Code enough of a head start that the first prompt mostly no longer waits for its start-up. A pointer moving to
the composer first (300 px in 400 ms, a 150 ms rest) adds that head start in both arms.

### Restored chat: launch, rest 45 s, click the restored chat's composer, paste, 0.5 s, Enter

2026-11-14 18:30-18:47 +04, load 3.6-13.5.

| | before, click | after, click | before, pointer first | after, pointer first |
|---|---|---|---|---|
| Enter to first word painted | 1,125 (4, 666-1,707) | 1,023 (4, 565-1,380) | 704 (4, 593-728) | 788 (4, 705-808) |
| agent ready (from the send) | 488 (4, 372-822) | 323 (4, 239-441) | 464 (4, 375-557) | 50 (4, 34-61) |
| first text (from the send) | 1,003 (4, 528-1,589) | 882 (4, 464-1,243) | 591 (4, 482-620) | 656 (4, 580-675) |
| agent processes at rest before the click | 0 (4) | 0 (4) | 0 (4) | 0 (4) |

### Adapter alone: spawn to `initialize` (compile cache, `9e11c638ca2`)

Chain 1, 2026-11-14 17:57-17:58 +04, load 11.7-12.9, variants interleaved.

| | before (no compile cache) | after (compile cache) |
|---|---|---|
| spawn to `initialize` | 521 (10, 377-768) | 331 (10, 299-819) |
| adapter CPU at `initialize` | 515 (10, 480-550) | 420 (10, 370-460) |

## What a stopped chat's first prompt waits for

**Adapter alone, quiet machine** (chain 3, 19:51-20:03 +04, load 2.9-5.5, after build's preload, `session/new`, prompt the moment the
session is ready, n 6 per variant, interleaved):

| | Volt's params | no MCP server | no `_meta` (no prompt append, hooks, plugin) | no claude.ai connectors |
|---|---|---|---|---|
| spawn to `initialize` | 200 (198-207) | 203 (200-208) | 202 (200-244) | 200 (197-206) |
| `initialize` to session ready | 271 (266-291) | 251 (244-274) | 268 (262-274) | 270 (267-280) |
| prompt to the turn's request | 94 (92-96) | 89 (77-98) | 97 (95-98) | 94 (91-96) |
| prompt to first text | 105 (102-107) | 101 (83-107) | 108 (105-109) | 105 (102-107) |
| spawn to first text | 626 (618-644) | 592 (580-609) | 629 (616-668) | 626 (615-635) |

So a cold start of Claude's agent is about 0.63 s on a quiet machine, prompt included: 0.2 s the adapter's own start,
0.27 s `session/new` (Claude Code's start inside it), 0.1 s from the prompt to the first text. Volt's MCP server costs
about 35 ms of it; Volt's `_meta` and claude.ai's connectors nothing measurable.

Under load (chain 1, load 6-13) the same start is 1.2-1.3 s to ready and its spread is wide (0.55-1.9 s).

**In the app**, the request of a restored chat's first prompt left Claude Code a varying time after the prompt.
Times below come from the replay server's log (CLOCK_UPTIME_RAW, put on the wall clock by matching the 30 A4 rows'
requests: 27 of 30 matched within 5 ms) and the agent server's `[volt timing]` and `[ACP]` lines:

| restored-chat run | prompt to the turn's request | session ready before the prompt |
|---|---|---|
| before (7 runs in the log) | 800, 191, 172, 98, 90, -4, 704 (median 172) | 7-81 ms |
| after, click (4) | 206, 924, 27, 798 | -2 to 60 ms |
| after, pointer first (4) | 610, 486, 455, 511 | 709-802 ms |

PENDING chain 4/5 analysis.

## Method

- **Before** is the shared read-only dev build `volt-e5-base` (`9bbb8818c60`, round 4 merged, which already has round
  4's idle stop: a chat's Claude agent stops 30 s after its last turn and comes back with `session/resume`). **After** is
  this worktree's dev build. Each arm has its own profile (`~/.volt-r5/firstword/ud-base`, `ud`) with the same three
  seeded threads, the same settings and the same project (`~/.volt-r5/firstword/arena`), on CDP port 9972. Arm order
  alternates per round. Every timed round holds the shared timing lock (`~/.volt-r5/timing.lock`) and starts only at a
  1-minute load of 14 or less; every row records the load at Enter, and rows above 14 are left out of medians.
- Models never answer: ADEMark's replay server (`bench/replay/server.ts`, port 18972) answers `replay:hi` with
  `LEDGERMARK` and `replay:seed` with a fixed text, logging each request on CLOCK_UPTIME_RAW.
- **ADEMark's own A4 runner could not run on this Mac.** It reads the first word off screen frames
  (ScreenCaptureKit + OCR), which needs the Screen Recording grant. No process this session can reach holds it (the
  Volt.app TCC entry has a stale code requirement, iTerm has none, `ademark-native permissions` reports
  `screen_recording: false`, `screencapture` fails), and Ghostty, which the Bare CLI control runs in, is not
  installed. So A4 follows ADEMark's sequence (TESTS.md A4, its `runRep`) with in-app timing: New Chat, 1.5 s, type
  `replay:hi` key by key, 0.4 s, Enter, and "on screen" read three ways (a DOM poll every ~4 ms as round 3's runner,
  the DOM insert, and two animation frames after it). The **Bare CLI control** runs ADEMark's command
  (`claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions`) in a pseudo-terminal of the same
  size with the same sequence, first word = the TUI writing `LEDGERMARK` to the terminal (ANSI stripped). Both are
  lower bounds of a pixel time in the same way, so the gap between them is what is compared with the board's gap
  (Diri 256 ms vs Bare CLI 219.6 ms: 36.4 ms).
- **Restored chat** (`firstlaunch.mjs`, round 4's weight rig): launch the arm, rest 45 s (past the 30 s short-lived warm
  of the restored chat), click the restored chat's composer, paste `replay:seed`, 0.5 s, Enter; first word = two frames
  after the answer's text lands. **Reopened chat** (`resume.mjs`): send in chat A, then in a new chat B, idle 40 s (A's
  agent stops), open A from the sidebar, 1 s, click the composer, type `replay:seed`, Enter. Both run "strict" (a click
  lands with no pointer move before it, the worst case) and `HUMAN=1` (the pointer travels 300 px in 400 ms and rests
  150 ms on the target before the click, as a hand does).
- **Adapter level** (no app): `initbench.mjs` (spawn to `initialize`, the adapter as before vs with the after build's
  preload), `resumebench.mjs` (spawn, `initialize`, `session/new` or `session/resume` with Volt's recorded params and
  preload, an MCP stub serving Volt's tool list, then the prompt at once or after a wait; times at the replay tap),
  `sdkbench.mjs` (Claude Code driven through the Agent SDK with no adapter: the direct path).
- Rows labelled `try*` and `diag*` were taken under load (30-80) to find structure; they are kept in the data and are
  in no table.
- Scripts: [`round5/scripts/firstword/`](scripts/firstword/) (chains 1-5 are the exact sequences that produced the
  rows); data: [`round5/data/firstword/`](data/firstword/); tables: `node scripts/firstword/summarize.mjs`.

## Fixes

1. **`9e11c638ca2` perf(acp): Claude's adapter keeps Node's compile cache.** Every cold start of the adapter compiled
   the adapter and the Agent SDK again (`compileSourceTextModule` 210-520 ms in CPU profiles under load). The preload
   turns on Node's compile cache before the adapter loads and writes it itself at 5 s and 60 s (Volt stops adapters
   with a signal, which skips Node's write at exit). The folder follows the process's trust: a sandboxed adapter uses
   its project's sandbox cache, an unconfined one `~/.volt/acp-node-cache`, never the temp folder. Measured: spawn to
   `initialize` 521 to 331 ms (n 10 each, load 12-13, interleaved). Unit tests: 3 in `claudeAcpPatch.test.ts`.
2. **`2db7ce0d91e` perf(agent): warm a stopped chat's agent on the first sign of intent.** A chat clicked open warms
   at once (opens less than 1 s apart, and opens nobody clicked, still wait 300 ms); the pointer entering the composer
   and the window coming to the front start a short-lived warm (30 s unless a click or key follows; asked at most
   every 5 s). Measured: reopened chat, click, 718 to 379 ms (n 6 each). Restored chat: no measured gain (above).
   Unit tests: `agentPrewarmIntent.test.ts`.

Typecheck (`npm run compile-check-ts-native`) exit 0; the 13 unit tests of both files pass.

## Direct path: the ACP adapter vs Claude Code through the Agent SDK

Chain 2, 19:28-19:35 +04, load 3.5-6.3, interleaved, the same Volt MCP server (stub) and settings sources in both.

| | adapter, prompt 5 s after ready | SDK, 5 s after ready | adapter, prompt at once | SDK, at once |
|---|---|---|---|---|
| start to ready | 524 (6, 517-900) | 229 (6, 228-273) | 519 (6, 515-538) | 229 (6, 220-261) |
| prompt to the turn's request | 102 (6, 95-109) | 75 (6, 56-79) | 94 (6, 92-99) | 81 (6, 79-84) |
| prompt to first text | 110 (6, 103-118) | 81 (6, 62-84) | 105 (6, 102-109) | 86 (6, 84-93) |
| start to first text | | | 626 (6, 622-644) | 315 (6, 311-355) |

The adapter costs about 290 ms on a cold start (its own Node start and module load before Claude Code is spawned) and
20-30 ms per prompt (ACP framing and its own per-prompt work), and one process per chat (adapter + CLI vs CLI only).

## Not done, and why

PENDING
