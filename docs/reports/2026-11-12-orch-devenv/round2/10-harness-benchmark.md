# 10 · Cross-harness benchmark: Volt vs Hermes Agent, Claude Code, Cursor and T3 Code

Status: in progress (baseline complete; after-fix runs going). Numbers below are filled in as they land.

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
