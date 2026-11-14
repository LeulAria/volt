# Round 5 (2026-11-14): orchestration, first word, tokens, launch, memory, idle CPU, code intelligence

Round 4 (`../round4/`) left Volt ahead of Claude Code on three of the four orchestration tasks, at 14.1K tokens for
"hi", and short of ADEMark's leaders on relaunch, first word, idle CPU and the three memory columns. Round 5 took the
user's request ("make Volt the best in everything") as seven areas, each with its own agent, worktree and branch off
`9bbb8818c60`. Every branch is merged into `volt/8fb8291c` (this tree).

**ADEMark method, unofficial.** ADEMark's prompts, replay server and procedures, on a shared laptop (Apple M4 Max,
14 cores) in a normal account, with DOM timing over CDP. ADEMark's own A4 runner could not run here (no process holds
the Screen Recording grant). None of it is an ADEMark result; the published leaders ran on a Mac mini M4.

Timed rows count only at a 1-minute load of 14 or less, with before and after interleaved, and only one area timed at
a time (a shared timing lock). The round lost its agents to session restarts six times and to a reboot at 21:13; the
quiet machine after the reboot (load 4-10) is where most timed rows come from. At 22:25 the user asked to finish
fast, so several areas stopped with planned runs not taken; each report lists them.

## Reports

| # | Report | Area | Branch |
|---|---|---|---|
| 41 | [41-orchestration.md](41-orchestration.md) | Volt before/after vs Claude Code on t0-t3, C1 orchestrated build | `e5/orch` |
| 42 | [42-first-word.md](42-first-word.md) | A4 Enter to first word, reopened and restored chats, adapter start | `e5/firstword` |
| 43 | [43-tokens.md](43-tokens.md) | Track B prompt size ("hi", the real prompt) and cost | `e5/tokens` |
| 44 | [44-launch.md](44-launch.md) | A1 cold start and A2 relaunch on release builds | `e5/launch` |
| 45 | [45-weight.md](45-weight.md) | A5 at rest, A7 under load, A9 after quit, A10 per thread, release builds | `e5/weight` |
| 46 | [46-idle-typing.md](46-idle-typing.md) | A6 idle CPU, A8 typing lag | `e5/idle` |
| 47 | [47-code-intelligence.md](47-code-intelligence.md) | Tree-sitter index, `code_nav impact`/`body`/`structural`, diagnostics on edit | `e5/codeintel` |

Data is in `data/<area>/`, scripts in `scripts/<area>/`.

## Orchestration (report 41)

Haiku 5.5 for the lead and every subagent, medians of runs taken under the timing lock at load 3.2-9.7, seconds, n in
brackets. Every answer was right in every arm.

| Task | Claude Code | Volt before (`9bbb8818c60`) | Volt after |
|---|---|---|---|
| t0 Reply "OK" | 2.9 (4) | 1.9 (4) | **1.8** (4) |
| t1 3 research subagents + synthesis | 25.9 (4) | 30.4 (3) | **21.9** (3) |
| t2 3 parallel bug fixes + `npm test` | 21.2 (3) | 21.7 (3) | **20.7** (3) |
| t3 writer + reviewer | 40.5 (3) | 37.0 (3) | **35.3** (3) |

- **Volt is ahead of Claude Code on all four tasks.** t1, 2 s behind in round 4, is now 4.0 s ahead of Claude Code
  and 8.5 s ahead of the before build, with no overlap of the ranges. t2's ranges overlap.
- Where t1's time went: last subagent to answer 8.7 to 3.9 s (the lead's last turn thinks half as much without the
  pre-read project files); subagents 18.0 to 14.6 s (the synthesis subagent writes the short answer its brief asks
  for).
- Fixes: a subagent reports in the form its brief asks for (`4688f96e870`); a top-level chat is told its task tools
  are loaded, so it no longer searches for them first (5 of 72 probe runs before, 0 of 72 after, `d00c8e695b1`); a
  delegating top-level chat gets no pre-read project files (`156015845ba`, `8c01ffbbd11`); a stray or placeholder
  `delegate_task` starts no subagent (`616ad44e0aa`; no real over-delegation of one-tool tasks in 290 runs).
- **C1 (Opus 5.5, n 1, after only):** 5/5 shipped on our own tests in **4.1 min** at load 6.2, 1.40M tokens ($2.50),
  handoff 4/4, four workers at once, all in worktrees Volt made (two adopted a worktree made ahead with its agent
  already running). The lead waited with one `wait_tasks` call (97.8 s, not cut off at 60 s). ADEMark's published
  leader Synara: 5/5 in 5.18 min, 2.03M tokens. Round 4's C1 runs were all at load 30-124, so no before/after or
  Claude Code comparison of C1 time is claimed.

## Launch (report 44)

Release builds, load 3.9-7.3, before and after interleaved. "Ready" is the first composer that takes keys. The after
arm is the after2 bundle with the page fix (`f4f0d4b9b07`) patched in, which equals the committed code apart from the
removed exploration switch; a clean build of the branch tip was not timed.

| Test | Before | After | Target |
|---|---|---|---|
| A2 relaunch: first window (n 4) | 595 ms | **363 ms** | |
| A2 relaunch: Ready (n 4) | 944 ms | **773 ms** | under 0.67 s: not met |
| A2 relaunch: real composer | 1,126 ms | 1,037 ms | |
| A1 cold: first window (n 3) | 422 ms | **356 ms** | under 0.29 s: not met |
| A1 cold: Ready (n 3) | 757 ms | 797 ms | |
| A1 cold: real composer | 862 ms | 1,056 ms | |

- The last window now opens at Electron `ready` and paints the last screen's picture, with a live text area, before
  the main bundle loads (`ec41f576f82`, `bd48ebaf054`). The page was being thrown away until `f4f0d4b9b07`: Electron
  writes `show` into the view's preferences, so the adoption check never matched.
- **Cost on cold start:** the full workbench starts about 190 ms later, because main builds the launch window before
  its own (`willOpenNewWindow` 387 to 563 ms). Next to try: import the main bundle before creating the launch window,
  or create it off the critical path.
- Floor: Volt's own Electron with an empty main shows a window at a median 441 ms by the window watcher (n 6, a
  different timer from the rows above), so 0.29 s is not reachable on this Mac by that timer.
- The launch agent was stopped after its final timed runs; the coordinator wrote report 44 from its rows and notes.

## First word (report 42)

| Test | Before | After | Target |
|---|---|---|---|
| A4 Enter to first word, new chat (DOM, n 15, load 4-6) | 102 ms | 100 ms | below Diri's 256 |
| Bare Claude CLI control, same method (n 10) | 214 ms | | |
| Reopened chat, click straight in (n 6) | 718 ms | **379 ms** | 0.4 s: **met** |
| Restored chat after relaunch, click straight in (n 4) | 1,125 ms | 1,023 ms | 0.4 s: **not met** |
| Restored chat, pointer moved first (n 4) | 704 ms | 788 ms | 0.4 s: **not met** |
| Adapter spawn to `initialize` (n 10, load 12-13) | 521 ms | **331 ms** | |

- Volt's A4 is about 100 ms below the bare CLI on this Mac and did not move; it is not a ranking number (DOM time,
  not pixels).
- Claude Code is busy for about 1.1 s after its session is ready, and a prompt sent in that window waits. Warming the
  agent 0.4-1.1 s before the send is worse than not warming it at all; the fix the data points to (warm at least
  1.2 s ahead, or not until the send) was not made.
- Fixes: Node's compile cache for the adapter (`9e11c638ca2`); warm on intent: click-open at once, pointer entering
  the composer, window focus, short-lived (`2db7ce0d91e`). No agent runs at rest (0 processes in 16 runs).
- Measured, not built: Claude Code through the Agent SDK without the adapter is ready in 229 ms instead of 519 with
  one process fewer per chat, but means rebuilding permissions, tool cards, plans, compaction and resume. The user's
  call.

## Tokens (report 43)

| Test (Opus 5.5, n 3) | Before | After | Bare CLI 2.1.322, this Mac | Paseo (site) | Target |
|---|---|---|---|---|---|
| B1 "hi" | 14.1K | **12.2K** | 18.1K | 22.2K | 10.5K: not met |
| B3 real prompt | 53.1K | **46.4K** | 61.1K | 73.2K | 35.4K: not met |
| B3 cost | $0.0614 | **$0.0583** | $0.0764 | $0.150 | under $0.069: met |

- Against the bare CLI on this Mac (ADEMark's own-Mac rule) Volt went from 0.78 to 0.67 on "hi" and 0.87 to 0.76 on
  the real prompt; Paseo is at 0.58 and 0.43 on the site. About 9K of "hi"'s 12.2K is Claude Code's own content.
- Each later code turn is about 930 tokens smaller: the visuals note, IDE guide and workspace scope go once per
  session. Two cache breakers fixed (a `<volt_context>` file list and the bypass-mode reminder came and went between
  runs, costing $0.117 instead of $0.062). The Tab predictor's `<task>undefined</task>` is fixed.
- Kept by the user's decision: Claude Code's Skill tool stays loaded and skill descriptions stay at 400 characters.
- Nothing lost: Volt's tools used in 10 of 11 families (8 of 11 before), the AGENTS.md canary obeyed in 24 of 24.

## Memory (report 45)

Release builds, load 4-11.

| Test | Before | After (`1f9c93b49cf`) | Leader |
|---|---|---|---|
| A5 at rest | 661 MB (n 2) | 630 MB | super.engineering 134 |
| A7 under load, total p95 (n 1) | 3,337 MB | 3,016 MB | super.engineering 969 |
| A9 left after quit | 0 | 0 | 0 |
| A10 per thread | 55.1 MB | 57.3 MB | Zeron 2.1 |

- A5 and A10 did not move beyond the 62 MB spread between two runs of the same build. A7 is 321 MB lower on one run
  per side: not a measured gain. Ranks: A5 4th, A7 near the back, A10 last.
- Fixes: idle plugin host stops after 90 s instead of 5 min (`f55379a6fc2`); the new chat's Orbit canvas becomes a
  still picture at rest (`ab157fe66a7`); the dictation glow leaves the layout at rest (`62a18ec2510`); the agent
  server's event log keeps frames, not sliced data (`1f9c93b49cf`).
- Not checked: whether the plugin host's earlier stop slows the first reply 120 s after launch (the main regression
  risk). Not built: one adapter shared by all chats (about half of A10; the sandbox, account overlay and brokers are
  per adapter). Not viable: a lazy extension host (the branch chip needs the git extension).

## Idle CPU and typing (report 46)

Dev builds, load 5.5-8.3, n 2 per arm.

| Test | Before | After |
|---|---|---|
| A6 idle, window in front | 1.70 % | **0.69 %** (target 0.18 %: not met) |
| Wakeups per second | 28.4 | 19.1 |
| Sandbox `log stream` | 0.66 % | gone |
| Sandbox helper | 0.26 % | 0.03 % |
| A8 typing, key to pixels | no valid run | no valid run |

- Sandbox refusals are now read on demand; the "Blocked by the sandbox" card still shows in the same turn.
- Left at rest: main 0.31 %, two Node utility processes 0.22 %, agent server 0.09 %.
- A8 never ran at quiet load, so the keystroke-first frame gate was reverted (`ce91ce68668`). Two typing-path fixes
  (native scroll adoption, draft meter throttle) stay on profile evidence only.

## Code intelligence (report 47)

Haiku 5.5 on openclaw (4.2k TypeScript files), 8 tasks, n 3 per task per arm.

| | Before | After |
|---|---|---|
| Answers right | 23.5 / 24 | 23 / 24 |
| Tokens (sum of task medians) | 827K | **691K** (-16 %) |
| Tool calls (sum of medians) | 67 | **52** (-22 %) |
| Cost | $0.0326 | $0.0315 |
| "hi" tokens | 14,709 | 14,709 (+0) |

- New: a tree-sitter structure layer with an import graph, `code_nav impact` (callers, users, tests to run, errors in
  one call), `code_nav body` / `path#symbol`, `code_nav structural` (ast-grep patterns), and errors returned with an
  edit's result when the edit adds them.
- Where they fit they win: "what would a new parameter break" -35 % tokens, 7.5 to 4 calls, 6/6 right; structural
  search -47 % tokens on t5 but chosen in 2 of 6 runs.
- Cost: the edit-check hook adds a median 379 ms per edit (58 ms before). Wall times were taken at load 14.7-47.4 and
  are indicative only.

## Merge notes

Merged in order tokens, code intelligence, memory, first word, idle, launch, orchestration (`ad111faecb3` to
`df261fae73d`).

- `claudeWorkRules.test.ts` (tokens + code intelligence): import lists only; both kept.
- `agentEditor.ts` (first word + idle): both changed when an opened chat warms its agent. Kept both rules: a chat drawn
  from its first screen warms once the transcript replaces it (idle), otherwise a click warms at once (first word).
- `voltHostMcpMainService.test.ts` (orchestration + tokens): kept orchestration's checks of the "task tools are loaded
  already" line with the looser size ratio (half). Together the instructions came to 1,814 characters, over the test's
  1,800 cap; two words were trimmed elsewhere ("to the user" after ask_question, "commits" repeated in the
  propose_commits rule), now 1,799.
- `agentThreadView.test.ts` (from idle) failed in the full run and passed alone: the thread's stylesheet, loaded by
  another suite, makes the inner element a flex column, so the test's 1000 px content shrank and nothing scrolled.
  Fixed in the test (`62aeb78a6e9`).

## Verification

On the merged tree (`df261fae73d`):

- Type check (`tsgo --noEmit`): 0 errors.
- Full unit suite (`scripts/test.sh`, Electron, browser and node): **16,193 passing, 213 pending, 0 failing** (7 min).
  The first full run, before the orchestration and launch merges, had the one `agentThreadView` failure fixed above.
- Targeted after their merges: `earlyWindow.test.ts` 8 passing, `voltHostMcpMainService.test.ts` 10 passing, the 845
  voltAgent browser tests passing.
- Not run on the merged tree: a release build, the sandbox adversarial suite, and a live test window. Each area's live
  checks ran on its own branch and are in its report.

## Open after round 5

- First word: Claude Code's 1.1 s busy window after its session is ready; warm at least 1.2 s ahead or not at all.
  A relaunched chat's first message is still 0.8-1.0 s.
- Launch: the 190 ms cold-start cost of building the launch window first; a clean release build of the tip; A1 with
  `purge`.
- Memory: one adapter shared by all chats (about half of A10), the GPU process's growth with threads, and the check
  that the 90 s plugin-host stop does not slow the first reply.
- Idle and typing: A8 key to pixels at quiet load; main and the two Node utility processes at rest.
- Tokens: about 9K of "hi" is Claude Code's own; Paseo's ratios to the bare CLI (0.58, 0.43) are still ahead of
  Volt's (0.67, 0.76).
- Orchestration: C1 against Claude Code and the before build at quiet load (n 1 so far).
- The user's call: talking to Claude Code through the Agent SDK without the adapter (ready 229 ms instead of 519,
  one process fewer per chat, but permissions, tool cards, plans, compaction and resume to rebuild).
