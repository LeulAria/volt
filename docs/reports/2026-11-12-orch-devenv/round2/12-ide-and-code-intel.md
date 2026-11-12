# 12 - IDE tooling and code intelligence, round 2

Branch `e2e2/ide` (from `81563ca39e4`), worktree `volt-e2e-ide`, 2026-11-12. Raw data in
[`data/ide/`](data/ide/), drivers in [`scripts/ide/`](scripts/ide/).

**Status: in progress.** Sections are filled in as runs finish.

## Summary

(pending)

## Setup

- Machine: Apple M4 Max, 14 cores, 36 GB, macOS 26.6. Five test agents ran at once; every timing
  row carries the `uptime` load at its start.
- Volt: a dev instance of this branch, `./scripts/code.sh --user-data-dir /tmp/v2-ide-ud
  --extensions-dir /tmp/v2-ide-ext --remote-debugging-port=9946 ...` (9943 from the brief was held
  by another agent's proxy). Project picked in the agent window by typing `/private/tmp/vbench-hotel`
  into the project picker. Default model `agent:seed-claude-code:claude-haiku-5-5` (Haiku 5.5
  Medium through claude-agent-acp). Access: **Supervised** (sandboxed), the default, unless a row
  says Full access.
- Arm 1 (agent without Volt): Claude Code 2.1.322, `claude -p <q> --model claude-haiku-5-5
  --output-format stream-json --strict-mcp-config --mcp-config=<empty> --allowedTools
  Bash,Read,Grep,Glob,Task,Agent,LS`, cwd `/private/tmp/vbench-hotel`.
- Arm 2 (agent in Volt): the same model in a fresh Volt chat per question (Cmd+N), driven over CDP.
  The driver clicks "Always Run" when an approval card appears and counts the clicks.
- Both arms run the same question at the same time (pairs Q1..Q9, three rounds), so load drift
  hits both. Question text + "Answer concisely with file:line references. This is a read-only
  question: do not modify any files."
- Usage: arm 1 from Claude Code's `result` (`total_cost_usd`, `modelUsage`); arm 2 from the
  agent's Claude Code transcripts under `~/.volt/sandbox/agent-state/*/claude-code/config/projects`
  (subagents included), priced with the Haiku 5.5 rates `usage.mjs` derived from `claude -p`.
- Warm-up before the "before" runs: one Volt chat that called `code_nav` and `diagnostics` on the
  hotel copy (code index built, 3,758 files). The tsserver could **not** be warmed: Volt answered
  "language servers are off for this checkout" (see Bugs, B2).
