# Round 6: the first message to a relaunched chat, and why it waited

Status: draft (2026-11-15). Branch `e6/firstword`, worktree `volt-e5-firstword`, from `7f07f73d677`.
ADEMark method, unofficial. Live bench turns: none needed (the replay server answers every model request); the
Bare CLI and adapter numbers quote Claude Code 2.1.322, the version Volt's adapter (`claude-agent-acp` 0.106.0) runs.

## Summary

Target: the first message to a relaunched chat at 0.4 s or less from Enter, no agent alive at rest, A4 kept at about
100 ms. Round 5 left the cause open: Claude Code is busy for about 1.1 s after its session is ready, and a prompt that
lands 0.4-1.1 s after ready waits for the end of that window, so warming the agent on intent made the relaunched
chat's first message worse (0.8-1.0 s) unless the warm came 1.2 s or more ahead.

- **Found: the window is Claude Code's first-command MCP wait.** Read from the CLI's own code (2.1.322, the Agent SDK's
  binary): in headless mode the first command waits for every MCP server still connecting before its first model
  request. With an explicit `--mcp-config` (Volt's own server is one) the hold is `explicit_mcp_config`, the deadline
  `MCP_TIMEOUT` (30 s). The account's four claude.ai connectors are fetched over the network about 0.4 s after ready
  and connect 0.4-0.75 s later (the last one, Claude Docs, lists its tools over the network too); a prompt sent in that
  window waits for them. A prompt sent at once goes out in 70 ms because the connector list has not arrived yet, so
  nothing is pending but Volt's server (connected in 11 ms).
- **Fix: Claude Code's host setting `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0`** in the Claude provider's environment (the
  first command waits for no server it does not require), **plus `mcp__volt` in every session's allow rules**, which
  makes Volt's server a required one (waited for up to 2 s, as before in effect; it connected in 11 ms quiet, 223 ms at
  load 60). The connectors' tools join the session when they connect, exactly as they do today for a message sent the
  moment the agent is ready. Volt already answers every permission prompt for its own tools itself
  (`isVoltHostToolPermission`), so the allow rule changes no permission. Numbers: see the tables.
- **Found and fixed: the global adapter skipped Volt's preload.** `claude-agent-acp` 0.106.0 is now on PATH
  (`/opt/homebrew/bin`), and `acpLaunchFor` ran a PATH adapter by name, without the `node --import` preload that gives
  Claude's adapter Node's compile cache (round 5: spawn to `initialize` 521 to 331 ms) and the after-turn patches
  (skill-file read and sign-in probe moved off the prompt's path). The path `which` found now runs through the same
  preload as npx's copy. (The brief said measurements depending on the preload must say so: in the app, both arms of
  this report run the global adapter; only the after arm gets the preload.)
- **No agent at rest:** unchanged (the intent warm stays short-lived; the fix removes the reason to warm 1.2 s ahead).

## Before and after

Medians, (n, min-max), ms, rows at a 1-minute load of 14 or less only. "Before" = `volt-e5-base` (`7f07f73d677`),
"after" = `e6/firstword`, dev builds, arms alternating per round, the shared timing lock held per round.
Tables from `node scripts/firstword/summarize.mjs` (round6 data).

### Adapter alone: prompt sent 400 ms after the session is ready (the window) and at once (A4's case)

PENDING (chain 7: `resumebench.mjs`, default vs `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0` + `allow=mcp__volt`).

| prompt sent after ready | default: prompt to the turn's request | fix: prompt to the turn's request |
|---|---|---|
| 400 ms | | |
| 0 ms | | |

### Restored chat: launch, rest 45 s, click the restored chat's composer, paste, 0.5 s, Enter

PENDING (chain 8 A).

### Reopened chat (A's agent stopped after 40 s idle, open A, 1 s, click, type, Enter)

PENDING (chain 8 B).

### A4 First Word (ADEMark sequence, Opus 5.5, replay)

PENDING (chain 8 C).

## What held the turn: Claude Code 2.1.322's first-command MCP wait

Read from the Agent SDK's bundled CLI (a Bun binary with its JavaScript embedded; `~/.volt-r6/firstword/cli-mcpwait.txt`
holds the extracted functions). In the headless (SDK) entry:

- The policy (`fA` in the extraction) takes `explicitMcpConfigFlag`, `sdkUrl`, `hasStreamingInput`,
  `toolSearchAvailable`. With `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` unset, streaming input and an explicit `--mcp-config`
  the first-turn hold is `explicit_mcp_config`: `waitForDeferrable = true`, `deadlineMs = MCP_TIMEOUT` (30 s). With
  the variable set to 0 the hold is `host_no_wait`: `waitForDeferrable = false`, `deadlineMs = 0`.
- The wait (`Bc`): with a deadline above 0 it waits for every pending server (connectors included) up to the
  deadline; whatever the deadline, it then waits up to 2 s (`Jee`) for pending *required* servers, and up to
  `MCP_TIMEOUT` for the permission-prompt tool's server. Required servers (`YU`) are those named by allow rules from
  `cliArg`, `flagSettings`, `session`, `mcpMount` or `command` sources, by `mcp_tool` hooks on the counted events
  (PreToolUse, PostToolUse, ...), or by the non-deferrable built-ins list. Volt's main chats already named the
  `volt` server through the edit-check `mcp_tool` hooks; subagent sessions did not, hence the allow rule for every
  session.
- The connectors: `[claudeai-mcp] Fetching` starts at process start, `Fetched 4 servers` lands about 0.4 s after
  ready (network), three connect from a cached projection within 3 ms, Claude Docs connects 360-430 ms later, and the
  turn starts about 370 ms after that (its tool listing, not logged). That is the 1.1 s.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` would also remove the wait but loses the account's connectors in Volt: not
  taken (capability loss). `MCP_CONNECT_TIMEOUT_MS` governs the SDK-type servers' first-query wait only.

## Method

- Adapter level (`resumebench.mjs`, round 5's script with `allow=<csv>` added): the adapter spawned as Volt spawns it
  (the npx copy, Volt's preload, Volt's recorded `initialize`/`session/new` params, the MCP stub serving Volt's tool
  list on 18985), the replay server behind a logging tap (18974 -> 18972); the prompt a set time after ready; the turn's
  request at the tap and the first text chunk. `debug` runs the CLI with its debug log (`~/.volt-r6/firstword/cli-debug`).
- In-app (`firstlaunch.mjs`, `resume.mjs`, `a4.mjs`, `ab.sh`): as round 5, profiles `~/.volt-r6/firstword/ud-base` and
  `ud` seeded with three threads on the arena project by `prep.sh`, CDP 9972, replay 18972. Both arms find the global
  adapter on PATH.
- Rows labelled `r6-diag*` were taken at load 27-72 while other areas built; they are in the data and in no table.
- Scripts: `round6/scripts/firstword/` (chain7.sh, chain8.sh are the sequences); data: `round6/data/firstword/`.

## Fixes

1. **perf(acp): Claude's adapter found on PATH runs through Volt's preload** (`cliAgents.ts` `acpLaunchFor`,
   `acpProvider.ts` `launchFor`). Unit test FIRSTWORD-PATH-1 in `cliAgents.test.ts`.
2. **perf(acp): Claude Code's first command waits only for Volt's MCP server** (`extensions/volt-provider-claude/
   package.json` env `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0`, regenerated `voltBuiltinAgents.generated.ts`;
   `claudeWorkRules.ts` `CLAUDE_SESSION_OPTIONS.allowedTools = ['mcp__volt']`). Unit tests FIRSTWORD-WAIT-1
   (`claudeWorkRules.test.ts`) and FIRSTWORD-WAIT-2 (`cliAgents.test.ts`).

## Not done, and why

PENDING.
