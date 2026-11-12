# 10 · Cross-harness benchmark: Volt vs Hermes Agent, Claude Code, Cursor and T3 Code

Status: in progress (runs going). Numbers below are filled in as they land.

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
