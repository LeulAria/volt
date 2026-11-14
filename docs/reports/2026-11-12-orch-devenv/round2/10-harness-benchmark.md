# 10 · Cross-harness benchmark: Volt vs Hermes Agent, Claude Code, Cursor and T3 Code

Status: final (2026-11-13). 204 runs in `data/cmp/runs.jsonl` (9 excluded, see below). Tables:
`node scripts/cmp/analyze.mjs`; prompt sizes: `reqsize.mjs`; Volt's time split: `breakdown.mjs`.

## Results in one table

Median of N = 3 per arm and task; Haiku 5.5 everywhere; cost repriced at Haiku list for every arm
(the harnesses' own numbers differ, see "What each number means"). **Volt final** is the merged
round-2 tree (`feat/orch-and-devenv-revamp` with all five branches) plus the `tests` fix found in
this bench (`ae5cfb05919`); its t2 column is `volt-final-fix`, the other columns `volt-final`.
**Volt before** is this branch's start (`81563ca39e4`).

| Task | Measure | Claude Code | T3 Code | Hermes | Volt before | **Volt final** |
|---|---|---|---|---|---|---|
| t0 "Reply OK" | wall | 7.3 s | 5.8 s | 5.2 s | 2.9 s | **2.4 s** |
| t1 3 research subagents + synthesis | wall | 29.6 s | 38.6 s | 35.7 s | 63.4 s | **35.9 s** |
| | tokens / cost | 225k / $0.020 | 244k / $0.023 | 158k / $0.007 | 414k / $0.020 | **229k / $0.017** |
| | score (per run) | 0.88 ×3 | 0.75 ×3 | 0.88 ×3 | 1 ×3 | **0.88 / 1 / 1** |
| t2 3 parallel bug fixes, tests | wall | 33.8 s | 32.5 s | 37.7 s | 41.7 s | **31.8 s** |
| | tokens / cost | 360k / $0.019 | 368k / $0.019 | 242k / $0.009 | 531k / $0.020 | **425k / $0.020** |
| | score | 1 ×3 | 1 ×3 | 1 ×3 | 1 ×3 | **1 ×3** |
| t3 writer + reviewer | wall | 48.4 s | 68.2 s | 135.3 s | 79.0 s | **49.0 s** |
| | tokens / cost | 359k / $0.018 | 384k / $0.016 | 290k / $0.014 | 492k / $0.019 | **373k / $0.017** |
| | score | 1 ×3 | 1 ×3 | 1 ×3 | 1 ×3 | **1 ×3** |
| t1–t3 | Volt's own overhead on the critical path (median) | – | – | – | 15.6 s (3.4–44.5) | **1.2–1.6 s** (0.8–2.0) |
| t1–t3 | cost Volt reports for the run | – | – | – | $0.57–0.92 (wrong) | **$0.016–0.028** (right) |

What this says:

- **Volt went from slowest to level.** Before this round Volt was the slowest Claude-backed harness on
  t1 and t3 (63 s and 79 s). Final: fastest on t0 and t2, level with Claude Code on t3 (49.0 vs
  48.4 s) and 6 s behind it on t1, ahead of T3 Code on t1 and t3, ahead of Hermes on t2 and t3
  and level with it on t1 (35.9 vs 35.7 s). Every Volt answer was correct (t1: two perfect runs of
  three; Claude Code and Hermes 0.88 in every run, T3 Code 0.75).
- **Volt's own overhead is now 1-5% of a run**: 15.6 s → 1.2-1.6 s median (about 10-13x), so the
  rest is the model and the tools it runs. That is the part a harness controls; no harness can make
  Haiku's own time 10x shorter.
- **Tokens: Volt is level with Claude Code and T3, Hermes uses the fewest.** Hermes' parent prompt
  is about 20k tokens against Volt's 44-47k and Claude Code's 28-30k (table below). Volt's
  subagents are now the smallest of the Claude Code-based arms (t1 research: 11.2k per request vs
  Claude Code 16.0k, Hermes 13.5k), but its parent prompt is the largest. That is the next lever.
- **It is not 10x, let alone 10,000x, faster than the others end to end.** Volt now spends 95-99%
  of a t1-t3 run in the model and the tools it calls (the others cannot be split the same way). On
  the same model the slowest Claude-backed harness takes 1.2x (t2), 1.3x (t1) and 2.8x (t3) the
  fastest's time; Volt is at or near the front of that range on every task.

### Prompt size per model request (median, `reqsize.mjs`)

| Task | Claude Code parent / subagent | Hermes | T3 Code | Volt before | Volt final |
|---|---|---|---|---|---|
| t0 | 24.5k / – | 17.0k / – | 29.5k / – | 34.6k / – | 35.4k / – |
| t1 | 28.4k / 16.0k | 20.1k / 13.5k | 33.3k / 19.8k | 43.7k / 28.8k | 44.6k / **11.2k** |
| t2 | 29.6k / 20.9k | 20.8k / 14.4k | 34.2k / 22.3k | 44.2k / 32.1k | 46.1k / 21.0k |
| t3 | 29.5k / 20.9k | 21.5k / 14.9k | 36.2k / 23.1k | 41.3k / 30.5k | 43.3k / 16.9k |

Volt's subagent prompts fell 37-61% (the orchestrator branch's lean read-only and work profiles,
report 11). The parent grew by 1-2k: the IDE branch puts the `tests`, `debug` and `tasks` tools in
the prompt instead of behind Claude Code's tool search (report 12: agents picked them 1 run in 13
when deferred).

### How each change moved Volt (Claude Code harness, Haiku 5.5, median wall s)

| Arm | What changed | t1 | t2 | t3 | Overhead (t1-t3) |
|---|---|---|---|---|---|
| `volt` | this branch's start | 63.4 | 41.7 | 79.0 | 15.6 s |
| `volt-after` | warm subagent spares while the parent writes its `delegate_task` call; read-only turns skip the checkpoint wait | 34.5 | 32.1 | 67.6 | 1.2 s |
| `volt-after2` | + Claude ACP adapter 0.81.2 → 0.106.0 | 34.3 | 28.9 | 72.1 | 0.8 s |
| `volt-final` | merged round-2 tree (lean subagent profiles, IDE tools in the prompt, sandbox and UI fixes) | 35.9 | 94.0 | 49.0 | 1.6 s |
| `volt-final-fix` | + `tests` answers without the sandbox ask when there is nothing to run | – | 31.8 | – | 1.2 s |

`volt-after-cold` (warming off) was meant as the A/B for warming, but the setting did not reach the
agent server in time (see Bugs) and its runs adopted spares too; it is shown in the per-task tables
only for completeness.

The `volt-final` t2 regression is a bug the merge exposed, now fixed: in all three runs an agent
called Volt's `tests` tool (the IDE branch tells agents to prefer it), Volt asked the user to let
it run outside the chat's sandbox (Full access keeps the workspace sandbox), nobody answered, and
the agent's MCP client gave up after 60.4-60.6 s; the agent then ran `npm test` in the shell.
The project uses `node --test`, which no test controller covers, so the call had nothing to run
anyway. The ask now comes after the tests are selected, so such a call answers at once
(`ae5cfb05919`, unit test `ideTests.test.ts`), and the tool's description says a run asks in a
sandboxed chat while the shell does not.

In `volt-final` the research subagents of t1 start cold again (1.3-1.4 s each on the critical path)
while t2's work subagents adopt spares: the merged warm-up starts spares of the kind the chat's mode
implies (`work` in an Agent chat), and research subagents use the `readonly` profile. Deciding the
kind from the `delegate_task` arguments as they stream would close that gap.

### Cursor: the CLI against Volt driving the same Cursor agent

Same binary (`cursor-agent`), same models; median wall s. `-after` arms: Cursor's ai-tracking
database writable in the sandbox (`7b9e2ad7bb1`) and warm subagents.

| Task | Cursor CLI, Sonnet 5 | Volt on Cursor, Sonnet 5 | Cursor CLI, Grok 4.7 | Volt on Cursor, Grok 4.7 |
|---|---|---|---|---|
| t0 | 17.1 | 12.9 | 19.6 | 16.7 |
| t1 | 74.2 | 101.6 (before) | 105.9 | 129.2 (before) |
| t2 | 61.7 | 104.6 (after) | 68.2 | 81.6 (after) |
| t3 | 198.5 | 262.6 (after) | 149.1 | 148.5 (after) |
| Score t1 (per run) | 0.88 / 0.75 / 0.88 | 1 / 0.88 / 1 | 0.79 / 0.67 / 0.67 | 1 / 1 / 1 |

Volt answers better on Cursor (t1) but is slower than Cursor's own CLI on t1-t3. Volt's overhead
in these runs is 10-17 s median (`breakdown.mjs`): Cursor's agent takes 2.4-11.7 s to become ready
even from Volt's pool, and its subagents still start cold (every wave `cold/cold/cold`). The
warm-up spots a `delegate_task` call as its arguments stream; Cursor's agent reports Volt's MCP calls
as a generic "MCP: tool" with no name and only once the call already runs (tool start to the first
subagent's `run.start`: 0.2 s in `volt-cursor-grok-after-t2-2`), so there is nothing to spot early. Volt-on-Cursor also records no token usage (Cursor's ACP agent
sends none), so its cost cannot be compared.

## Setup

### Machine and method

- The user's Mac (Apple Silicon), shared with four other agents. Load average 18–58 during the runs;
  every row in `data/cmp/runs.jsonl` carries the load at its start.
- Arms run one at a time, interleaved: for each repetition, for each task, every arm once, and the
  arm order rotates by one per repetition (`scripts/cmp/bench.mjs`). N = 3 per arm and task.
- A run over 10 minutes counts as a failure (the runners kill it).
- Fixtures, all under `/tmp/vcmp/w`, one git repo per task, reset with `git reset --hard && git clean -fdx`
  before every run:
  - **t0**: empty folder.
  - **t1**: round 1's `/tmp/voltbench/fx` (4-file TypeScript shop with the discount bug).
  - **t2**: the same shop with `.ts` imports, a `node:test` suite of 7 tests (`npm test`, no
    dependencies) and three planted bugs, one per file: `applyDiscount` uses the percentage as a
    fraction, `reserve` refuses to take the last units (`<=`), `checkout` skips (instead of throwing)
    an out-of-stock SKU. 3 tests fail at the start; the reference fix makes all 7 pass.
  - **t3**: `SPEC.md` plus a draft `src/money.ts` whose `formatCents` has the planted issue (no
    zero padding of the cents, minus sign in the wrong place). The writer must add `formatReceipt`;
    only a reviewer that checks the whole file against the spec finds the planted bug. Scored by a
    hidden check (`/tmp/vcmp/check-t3.mjs`, 7 cases, the agents never see it).
- Prompts: `scripts/cmp/prompts/` (one text per task; `delegation.json` holds the one sentence
  that names each harness's own delegation tool). Ground truth: top of `scripts/cmp/score.mjs`,
  written before the first run.

### Harnesses

| Arm | Version | How it ran | Model |
|---|---|---|---|
| `cc` Claude Code | 2.1.322 | `claude -p … --model claude-haiku-5-5 --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions`, the user's normal settings (their MCP servers and skills load) | Haiku 5.5, native `Agent` subagents |
| `hermes` Hermes Agent | v0.23.1 (2026.9.24, commit `3b42157`), plugin `claude-subscription-directsdk-experimental` 0.3.5 | `hermes chat -q … --format stream-json --yolo`; tokens and estimated cost of the parent and every child from Hermes' own `~/.hermes/state.db` (sessions linked by `parent_session_id`) | Haiku 5.5 on the Claude subscription (the plugin drives the official `claude` CLI, one process per model call); children inherit it |
| `cursor-sonnet`, `cursor-grok` | cursor-agent 2026.10.16-e3cb207 | `cursor-agent --print --output-format stream-json --stream-partial-output --trust --force --model …` | `claude-sonnet-5-thinking-high`, `grok-4.7-medium`; Task subagents |
| `t3` T3 Code | Nightly app 0.1.6-nightly.20261029.3892 (commit `08a463e`) | A separate server from the app's own bundle (`serve --base-dir /tmp/vcmp/t3home --port 9981`), driven over its WebSocket RPC (`projects.mutate`, `orchestration.launchThread` with `runtimeMode: full-access`, `orchestration.subscribeThread`); it runs Claude Code through the Agent SDK with the user's `claude` 2.1.322 | Haiku 5.5, Claude's native subagents |
| `volt` | this branch (`e2e2/cmp` = `81563ca39e4`), dev build, profile `/tmp/v2-cmp-ud`, CDP 9941 | `scripts/cmp/runvolt.mjs`: new chat, Full access (sandbox kept), prompt typed into the composer; numbers from `User/voltTraces/<chat>.jsonl` and the task tree | Haiku 5.5 through the Claude Code harness; `delegate_task` subagents on the same model |
| `volt-cursor-sonnet`, `volt-cursor-grok` | same Volt | same, with the chat on Cursor's harness | Cursor's `claude-sonnet-5` and `grok-4.7` (Volt's catalog ids), subagents on the same model |

Installing Hermes (`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`, read
first, run as `bash install.sh --non-interactive --skip-browser --skip-computer-use`, 7 min) changed:

- `~/.hermes/` (2.7 GB): the git checkout (`hermes-agent`, 1.0 GB), its own toolchain under
  `~/.hermes/tools` (Python 3.14.9, Node 26, npm, pnpm, uv 0.13.5, ripgrep, ffmpeg; 457 MB),
  `config.yaml`, `.env`, `state.db`, logs, skills, plugins.
- `~/.local/bin/hermes`, `hermes-acp`, `hermes-agent` (launchers).
- A new `~/.zprofile` with one guarded `PATH` line for `~/.local/bin`. `~/.zshrc` was not changed
  (it already has a `~/.local/bin` PATH line, which the installer checks for).
- Nothing system-wide: no sudo, no launchd service (`--non-interactive` skips the gateway service),
  shared-metrics telemetry off by default.

Hermes configuration used (`hermes config set`): `model.provider claude-subscription-directsdk-experimental`,
`model.default claude-haiku-5-5`, and `delegation.oneshot_max_children 10`. The last one matters:
Hermes' default for one-shot runs is **2 children per run**, and a batch of 3 is refused outright
("Delegation budget for this one-shot run is exhausted (0/2 subagents used)"), so the parent did the
work itself (seen in a smoke run). With the cap raised, batches of 3 run as documented. The
Claude plugin worked fully non-interactively.

### Changes to the setup during the run (read before the tables)

- **Claude subscription outage, 17:27Z to at least 17:47Z.** Every Claude-backed arm failed in that
  window ("Claude Code can't use your Claude subscription, usually because a payment is past due";
  Hermes: OAuth 403). The nine rows it broke stay in `runs.jsonl` but are listed in
  `data/cmp/excluded.json` and left out of every table; all nine were re-run at 18:53-19:22Z once
  `claude -p` worked again. Their raw files were overwritten by the re-runs (same id).
- **Cursor CLI updated itself during the run**: `cursor-agent` 2026.10.16-e3cb207 installed
  2026.11.11-b912975 at 16:33Z, three minutes into the first batch. Every Cursor row after
  `cursor-grok-t0-1` (both the CLI arms and Volt's Cursor arms, which run the same binary) is on
  2026.11.11.
- **One T3 row excluded for contamination**: `t3-t2-2` (19:09Z) ran while Volt restarted the hung
  Cursor subagents of `volt-cursor-sonnet-t2-1` (see Bugs), which edited `/tmp/vcmp/w/t2` under it.
  Re-run in the after batch.
- **Volt on Cursor, t2/t3**: the first run (`volt-cursor-sonnet-t2-1`) hung (the sandbox bug fixed
  below); the second was stopped by hand after the cause was clear. Those two arms were then run
  on the fixed code only, as `volt-cursor-*-after`.
- **Load.** Five agents shared the machine. 1-minute load average at the start of each run: 8-134
  over all rows; per arm: cc 8-124, hermes 8-115, t3 8-58, volt 14-114, cursor-sonnet 11-90,
  cursor-grok 8-134, volt-cursor-* 17-79; the after batch ran at 69-120. Interleaving spreads it
  over the arms of a batch, but compare batches with care.

### What each number means

- **Wall**: send (or process spawn) to the end of the last run of the root and every subagent
  (Volt: the trace's last `run.end`; CLIs: process exit; T3: the thread's final `run.updated`).
- **First output**: first streamed token of any kind (text, thinking, tool input). T3's
  WebSocket stream only carries the assistant text when the turn ends, so its column is the end
  of the turn, not a first token: not comparable.
- **Tokens**: input + output + cache read + cache write of the parent and all subagents.
  Volt-on-Cursor has none: Cursor's ACP agent reports no usage (`n/r`).
- **Cost reported**: the harness's own number. Volt's is what the Claude ACP adapter reports, which
  is wrong for Haiku 5.5 (see Bugs); compare with **Cost at Haiku list** (same rate card for every
  Haiku arm).
- **Tool calls**: all calls of the parent and its subagents, except Cursor CLI (`*`: its
  `--print` stream shows only the parent's calls).
- **Score** (per run, 0-1): t0 reply is exactly OK; t1 graded answers / 4; t2 all 7 tests green and
  no stray file; t3 all 7 hidden checks pass incl. the planted bug.
- **Volt overhead** (`scripts/cmp/breakdown.mjs`, from Volt's own traces): on the critical path,
  Enter → `run.start`, `run.start` → prompt written to the agent (spare adopted or cold start), per
  delegation wave the last-ending subagent's task start → its `run.start` and its agent start, and
  the delay before the parent sees the reports. Everything else is "model + tools" (model requests,
  file reads, tests). Harness overhead of the other arms cannot be split out the same way (no
  equivalent traces), so only end-to-end numbers are compared across harnesses.

### App memory and CPU (`scripts/cmp/memrig.mjs`, `data/cmp/memory.jsonl`)

Separate instances with their own temporary profiles (never the user's running apps), macOS
`footprint` summed over each app's process tree plus its out-of-tree servers, median of 3 samples,
45 s after the window appeared, load 5-10. Volt here is the released 0.0.6 (a copy of
`/Applications/Volt.app`), not this branch.

| App | Idle footprint | Processes | Idle CPU |
|---|---|---|---|
| T3 Code (Nightly) | 381 MiB (r1) | 6 | 3% |
| Volt 0.0.6 | 605 / 598 MiB (r1 / r2) | 7 / 6 | 11-12% |
| Cursor | 1,670 / 1,589 MiB | 17 / 14 | 19-20% |

Volt idles at 1.6x T3 Code's memory and 0.37x Cursor's; its GPU process is the largest part (320
of the 605 MiB). The rig records CPU per app, not per process, so where Volt's 11-12% idle CPU goes
is not measured here.

Not comparable, so left out of the table: T3's second idle sample (72 MiB, 3 processes: its server
had not started) and both "one agent running" samples. T3's running sample has no `claude` process
in its tree (the rig's prompt never started a turn); Volt's (2,034 MiB, 177% CPU) does: GPU 715 MiB,
extension host 335 MiB, three `claude` processes (the agent, a one-off `claude -p` side call and a
hook shell). Volt round 2 "running" was cut by the rig's 25-minute limit.

## Fixed on the way

| Commit | What | Measured |
|---|---|---|
| `6485b1103a1` | Subagent spares start while the parent is still writing its `delegate_task` call (a tool search that loads it, or the call starting to stream); the pool holds a burst of 3 per key with a 90 s life. Setting `volt.agent.multitask.warmSubagents` (default on) | t1-t3 overhead 15.6 → 1.2 s median; child start 8-21 s → 0.1-1.3 s |
| `a90367e29e0` | Read-only turns (Ask, Plan; research and review subagents) skip the before-snapshot wait; ACP request metrics count each request once | 1.5-2.4 s per research subagent |
| `7b9e2ad7bb1` | Cursor's agent may write `~/.cursor/ai-tracking` in the sandbox: its Edit tool hung 10 minutes on the denied SQLite file | `volt-cursor-*` t2 hung → done in 60-126 s |
| `53aa2c49945` | Claude ACP adapter 0.81.2 → 0.106.0. 0.81.2's Agent SDK (0.3.280) does not know `claude-haiku-5-5` and priced it 35-130x over list: $0.049-0.178 for "Reply OK", $0.57-0.92 per t1-t3 run. 0.106.0: $0.0014-0.0028 and $0.016-0.028, matching the list price; its first session is about 5.5k tokens smaller (24.3k vs 29.8k, `data/cmp/acp-cost.jsonl`) | `volt-after2`: t2 32.1 → 28.9 s |
| `76244e26f64` (merge) | The warm-up predated the orchestrator branch's two lean subagent profiles and passed `true`: spares now start as `readonly` in an Ask or Plan chat and `work` elsewhere, the key a delegated chat looks up | `volt-final` t2: every subagent adopted a spare |
| `ae5cfb05919` | `tests run` with nothing to run answers without the sandbox ask (see Results) | t2 94.0 → 31.8 s |
| `41a7d176e32` | Fired timers in the agent window and every Volt menu row's label were never disposed (the dev build's leak tracker logged about 3,100 over the bench's sessions) | `volt-final` session: 364 reports in 12 runs; the fixed build: 1 in 3 runs (the IDE tab's close listener, fixed after) |

## Bugs found and not fixed

- **Volt's parent prompt is the largest of the five** (44-47k per request vs Claude Code 28-30k,
  Hermes 20-22k): Volt's instructions, its MCP tool list and the always-loaded IDE tools. It is now
  the biggest token cost left; the subagents were cut 37-61% this round.
- **Research subagents start cold in an Agent chat** (1.3-1.4 s each on t1's critical path): the
  warm-up has to pick a profile before the `delegate_task` arguments arrive and picks `work`.
- **Subagents on Cursor never get a warm spare** (see the Cursor section): its agent names Volt's
  MCP calls only once they run.
- **A settings change does not reach the agent server's runtime in time.** `runvolt.mjs` flipped
  `volt.agent.multitask.warmSubagents` to false 0.8 s before each `volt-after-cold` send; the agent
  server still warmed spares for the next delegate_task call (spawns 4-8 s before the tasks
  existed, `agent-server.log` 19:46:06-10Z). Its ConfigurationService watches `settings.json`
  through the server's own file service; either the watch does not fire for this path or it is
  slower than 20 s. Not chased further; the A/B was replaced as described in Results.
- **Volt restarts a stuck subagent from the top.** After the hung Cursor subagent processes were
  stopped, Volt said "Agent process died. Restarting and retrying." and ran each task again from
  the start, edits included, 12 minutes after the rig had timed the run out and moved on. Its
  edits landed in the next run's fixture (`t3-t2-2`, excluded). A task whose parent turn already
  ended, or whose last tool call never returned, should not silently redo its side effects.
- **Cursor-on-Volt shows sandbox denials of Cursor's own housekeeping as "Blocked by the sandbox"
  cards** on every turn: `~/.cursor/agent-cli-state.json` (read and write),
  `~/.local/share/cursor-agent/versions/<v>/.running/<pid>`, `~/.cursor/skills-cursor/.sync-manifest*.tmp`,
  and reads of other agents' skill folders (`~/.claude/skills/*`, `~/.codex/skills`, `~/.agents/skills`).
  Claude has an `AGENT_HOUSEKEEPING` list that hides its own; Cursor has none. Left to the sandbox
  owner, who decides what is housekeeping and what a real denial.
- **Volt-on-Cursor records no token usage** (Cursor's ACP agent sends none), so those chats show 0
  tokens and $0; the same CLI's `--print` result carries usage (cursor-sonnet t1: 111k tokens).

## Published benchmarks of the other harnesses

None of them publishes harness overhead or orchestration latency. What exists measures task
success of model + harness, or app memory:

- **Hermes Agent**: the Hermes Index (Nous Research, Oct 2026) scores models inside Hermes on Hermes
  Bench (150 tasks, 25 categories), Terminal-Bench 4, Terminal-Bench Science and SkillsBench:
  Claude Opus 5.5 63.31 at $4.99/task, GPT 6.1 Sol 57.09 at $1.19/task, GPT 6 Astra 56.25 at
  $11.61/task. No timing. <https://portal.nousresearch.com/bench>
- **Cursor**: the Composer 2 post: CursorBench 61.3, Terminal-Bench 2.0 61.7, SWE-bench
  Multilingual 73.7; $0.50/M input, $2.50/M output (fast variant $1.50/$7.50). It mentions a
  tokens-per-second snapshot without numbers. <https://cursor.com/blog/composer-2>
- **Claude Code subagents**: Anthropic's multi-agent research write-up: an Opus 4 lead with Sonnet 4
  subagents beat single-agent Opus 4 by 90.2% on their research eval; agents use about 4x the tokens
  of chat, multi-agent systems about 15x; parallel tool calls cut research time by up to 90%.
  <https://www.anthropic.com/engineering/multi-agent-research-system>
- **T3 Code**: no benchmark page. Theo on X: T3 Code 350.9 MB vs the Claude Code CLI 635.5 MB of
  RAM <https://x.com/theo/status/2035531539581485151>. Issue #695 (closed 2026-10-21): T3 20+ min
  vs Codex about 3.5 min on one task, traced to per-token event streaming and auto-approve, fixed in
  #11678 <https://github.com/pingdotgg/t3code/issues/695>.
