# Round 3 (2026-11-13): ADEMark, app speed, long threads, tokens, orchestration

Round 2 (`../round2/`) left Volt level with Claude Code on wall time and the largest prompt of the five
harnesses. Round 3 took the user's targets: come first on ADEMark (`ademark.dev`), beat Claude Code on the
orchestration tasks, and get past Capy, T3 Code, Zeron, Paseo and super.engineering where they lead. Five
agents worked in parallel, each in its own worktree and branch off `82ae771c1d9`; all five branches are
merged into `feat/orch-and-devenv-revamp`.

**ADEMark method, unofficial.** ADEMark's harness only measures inside a dedicated macOS user `ademark` on
its reference Mac mini M4, with the file cache purged and the screen captured. Everything here uses
ADEMark's own replay server, native sampler, prompts and procedures, but in a normal account on a shared
laptop (Apple M4 Max, 14 cores) with DOM timing over CDP. None of it is an ADEMark result. Official numbers
need the user to create the `ademark` account (admin password) and start the run by hand.

Every number is measured, with n, median and range in the report it comes from. Five agents shared one
machine and a reboot stopped them once, so timed rows were taken only at a 1-minute load of 14 or less and
before/after arms were interleaved; rows above the gate are kept in the data and left out of the medians.

## Reports

| # | Report | Area | Branch |
|---|---|---|---|
| 20 | [20-ademark.md](20-ademark.md) | Volt on ADEMark's Track A and Track B next to Zeron, Paseo, T3 Code, MonoCode, Claude.app and super.engineering on this Mac, and the published field; a Volt adapter and profile for ADEMark | `e3/ade` |
| 21 | [21-app-speed.md](21-app-speed.md) | Track A targets in a dev-build A/B: idle CPU, Enter to first word, new thread, typing with 5 streams, memory | `e3/speed` |
| 22 | [22-long-threads.md](22-long-threads.md) | T3 Code's long-thread tests: 41k/45k/75k-item threads, A11's 2,000 messages, reasoning previews, phone launch, slow links | `e3/thread` |
| 23 | [23-tokens.md](23-tokens.md) | Prompt size for "hi" and a real prompt (Track B), with a check that every Volt tool family is still reachable | `e3/tokens` |
| 24 | [24-orchestration.md](24-orchestration.md) | Volt before/after vs Claude Code on round 2's four orchestration tasks | `e3/orch` |

Data is in `data/<area>/`, the scripts in `scripts/<area>/`; `ademark-volt/` is the adapter and profile
for submitting Volt to ADEMark.

## Where Volt comes first, and where it does not

### ADEMark (report 20, Volt next to the published field)

| Test | Volt | Published leader | Volt's place |
|---|---|---|---|
| A3 new thread to typing | **127 ms** (0.0.6), 154 ms (dev) | Emdash 183 ms | **1st of 11** |
| A11 open a 2,000-message thread | **30 ms** (dev) | Zeron 77 ms | **1st of 12** |
| A6 idle CPU, in front | 0.52 % of a core (0.0.6) | super.engineering 0.18 % | 2nd of 15 |
| A4 Enter to first word | 331 ms (dev) | Diri 256 ms | 3rd of 12 |
| A1 cold start to typing | 1.26 s (0.0.6; warm files, no `purge`) | super.engineering 1.76 s | not a fair 1st: by first window on this Mac 4th of 7 |
| A2 relaunch to typing | 1.62 s (0.0.6) | Diri 0.67 s | 10th of 14 |
| A5 weight, 5 idle threads | 788 MB (0.0.6) | super.engineering 134 MB (total) | 4th of 14 by total; heaviest of the 7 apps on this Mac |
| B1 "hi" (Track B) | 21.1K tokens, $0.0057 (tokens branch); 23.2K, $0.0061 merged (see Merge notes) | Paseo 22.1K, $0.006 | tokens branch would tie 1st; merged tree just behind (two rigs, not one race) |
| B3 real prompt | $0.151 (tokens branch) | Paseo $0.150 | 2nd |

DOM times are lower bounds of ADEMark's pixel times (a screen capture adds at least a frame, 8-17 ms); the
margins on A3 and A11 are larger than that. A1 and A5 are where Volt, an Electron app with a GPU process and
one Claude Code CLI per thread, cannot reach a native app (super.engineering is Rust and Metal in one
process).

### Before and after this round

| Area | Before | After | Where |
|---|---|---|---|
| "hi", tokens sent (Opus 5.5) | 31.1K | 21.1K (Claude Code alone 18.1K); 23.2K on the merged tree | 23, Merge notes |
| Real prompt (read two files, list the bugs) | 127.7K | 74.0K (Claude Code alone 61.0K) | 23 |
| Volt's tokens on top of Claude Code for "hi" | 13.0K | 3.0K | 23 |
| Idle CPU, new chat's page | 20.2 % of a core | 3.4 % | 21 |
| Idle CPU, finished chat | 6.7 % | 4.3 % | 21 |
| Enter to first word, end to end (dev, replay) | 402 ms | 360 ms; Volt's own part about 130 → 40 ms | 21 |
| Model's first token to first word on screen | 84 ms | 30 ms | 21 |
| Home to first message, 45k-item thread | not within 60 s | 615 ms | 22 |
| Reopen a 41k / 75k-item thread | 102.7 / 198.9 ms | 38 / 18.3 ms | 22 |
| Sent message on screen, 75k-item thread | 103 ms | 17 ms | 22 |
| Renderer work idle on a long thread | 20.9 ms/s | 7.9 ms/s | 22 |
| Long reasoning preview | cut at 99K characters | all 222K drawn | 22 |
| Phone's first web launch download | 7.16 MB | 5.45 MB | 22 |

### Against Claude Code on the orchestration tasks (report 24)

Haiku 5.5 for the parent and every subagent, medians of runs started at load 14 or less, seconds.

| Task | Claude Code | Volt before | Volt after |
|---|---|---|---|
| t0 Reply "OK" | 3.2 | 4.3 | **3.0** |
| t1 3 research subagents + synthesis | **30.2** | 44.5 | 36.6 |
| t2 3 parallel bug fixes + `npm test` | **24.5** | 33.8 | 27.8 |
| t3 writer + reviewer | **40.8** | 73.3 | 46.3 |

Every answer in every arm was right. Volt after uses fewer tokens than Claude Code on t1 (177k vs 247k) and
t3 (201k vs 377k). **Volt does not beat Claude Code on t1-t3 yet**: it is 3.3-6.4 s behind. The two causes
are measured: Volt's parent takes 1.3-3.6 s longer to start the first subagent (a larger prompt, and one
`delegate_task` call holds every part until it is written), and 9 of 24 editing subagents end with a 3.0 s
wait for a code-intelligence check that never gets an answer (root-caused, not fixed). Round 2's medians came
from another day's machine and are not compared with these.

## Merge notes

- `hostTools.ts` and `voltHostMcpMainService.test.ts` (tokens + orch): tokens took every Volt tool out of
  the always-loaded set to shrink "hi"; orchestration made `delegate_task`, `wait_tasks` and
  `message_task` always loaded in top-level chats (not subagents) to save the 2-3 s tool-search request
  before the first delegation. Kept orchestration's three as `top` and tokens' rule for every other tool;
  the test keeps tokens' 2,200-character cap on the server instructions and orchestration's three-tool
  fixture. Measured on the merged tree with report 23's rig (Opus 5.5, n 3, `data/tokens/merged/`):
  "hi" is **23.2K** tokens (23.1-23.2K; $0.0061 with a warm cache) against 21.1K on `e3/tokens`. The
  prompt grew by 2,040 tokens, all of it the three task tools (`delegate_task` about 1.9K of it); nothing
  else changed. That trades Track B's "hi" (now about 1.1K above Paseo's published 22.1K) for the 2-3 s
  before the first subagent. The user chose to keep the three loaded (2026-11-14).
- `acpProvider.ts` and its test (speed + ade): both branches sent Volt's lead as its own prompt block (ADEMark's
  replay server matches the user's text block). Kept one copy plus the ADEMark branch's `lastLead`, which
  drops an agent title cut from the lead, and both branches' tests.
- `agentEditor.ts` (speed + thread) merged without conflict.

## Verification (merged tree)

On `e3/merge` at `f2cfdbe4d13` (all five branches merged onto `82ae771c1d9`):

- Type check (`npm run compile-check-ts-native`): 0 errors.
- Full unit suite (`scripts/test.sh --run`): **16,045 passing, 0 failing**, 213 pending (7 min).
- Volt's CI lints, all passing: the ESLint diff against `origin/main`, listener lint, spawn audit,
  authority gate, manifest ceiling, feature-import fence, layers check, class-fields check, command
  visibility, git-spawn lint.
- Live: "hi" on the merged tree, 3 runs on Opus 5.5 through report 23's rig, every answer right (Merge notes).
  The timing numbers above come from each branch's own build, not the merged tree.

## Still open

- **Orchestration vs Claude Code** (24): the 3.0 s end gap on editing subagents (`CodeIntelHost.freshen`
  waits out `MARKER_WAIT_MS` when no marker change comes; fix in `freshen`), and the parent's lead before
  its first subagent (prompt size, one call holding every part).
- **First word** (20, 21): 225-285 ms of Enter to first word is Claude Code's CLI under the ACP adapter
  building its request (a side request at about 200 ms); the bare CLI sends in 57 ms on ADEMark's Mac.
- **Memory and relaunch** (20, 21): one shared ACP adapter instead of one per thread (about 240 MiB), idle
  threads' CLIs exiting and resuming on demand (most of 0.9 GiB), and a release bundle.
- **Task tools in every top-level prompt** (Merge notes): kept by the user's choice for the 2-3 s before a
  chat's first delegation; they cost 2.0K tokens per request. A shorter `delegate_task` schema (about 1.9K
  of the 2.0K) is the way to win back Track B's "hi" without losing the speed.
- **Tokens** (23): "hi" could drop to 13-15K by turning off some of Claude Code's own tools in Volt's main
  chat (Workflow, ScheduleWakeup, Agent, ReportFindings, ListAgents) and shortening the skills list; the user
  uses those tools directly, so this needs the user's decision.
- **Not measured** (20, 22): A1 with a purged cache (needs `sudo purge`), the other apps' Ready/A3/A4/A8/A11
  (never set up with a project and threads), loading earlier turns, Slow 3G launch, reconnect and terminal
  attach on a slow link (no usable before/after; report 22 says why for each).
- **Official ADEMark numbers** need the `ademark` macOS account on the reference hardware.
