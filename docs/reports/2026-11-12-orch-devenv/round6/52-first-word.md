# Round 6: the first message to a relaunched chat, and why it waited

Status: final (2026-11-15). Branch `e6/firstword`, worktree `volt-e5-firstword`, from `7f07f73d677`.
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
  (`isVoltHostToolPermission`), so the allow rule changes no permission. Adapter alone, prompt 400 ms after ready:
  395 to 98 ms from prompt to the model request (n=5 each); restored chat, pointer first: 650 to 218 ms Enter to
  first word (n=6 each); A4 109 to 92 ms (n=9 each).
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

`resumebench.mjs`, default vs `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0` + `allow=mcp__volt`, arms alternating (chain 9,
2026-11-15 04:28-06:36Z). Chain 7's first pass (2026-11-14 22:43-22:48Z, 10 rows) ran the fix arm alone, because zsh
dropped the empty default variant; those rows have no paired default and are in the data but in no table.

| prompt 400 ms after ready | default | fix |
|---|---|---|
| spawn -> initialize | 149 (5, 124-323) | 128 (5, 123-827) |
| initialize -> session ready | 224 (5, 175-876) | 197 (5, 175-1163) |
| prompt -> the turn's request | 395 (5, 91-787) | **98 (5, 69-327)** |
| prompt -> first text | 402 (5, 96-792) | **103 (5, 74-393)** |
| load (kept) | 2.0-7.5 | 3.1-13.6 |

| prompt at once | default | fix |
|---|---|---|
| prompt -> the turn's request | 62 (5, 60-915) | 61 (4, 56-71) |
| prompt -> first text | 70 (5, 68-937) | 67 (4, 64-81) |
| load (kept) | 2.7-13.6 | 2.5-4.9 |

The window is gone: a prompt 400 ms after ready reaches the model 98 ms after Enter instead of 395 ms. A prompt sent
at once was never held and is unchanged.

### Restored chat: launch, rest 45 s, click the restored chat's composer, paste, 0.5 s, Enter

`firstlaunch.mjs restored 45`, 6 rounds per arm (chain 8 A, 3 rounds, and chain 9, 3 rounds). "Click" = CDP click and
Enter, no pointer move first; "pointer first" = the pointer moves over the composer before the click, as a hand does
(Volt warms the agent on that intent).

| metric | before, click | after, click | before, pointer first | after, pointer first |
|---|---|---|---|---|
| Enter -> first word painted, ms | 257 (6, 212-1740) | 318 (6, 208-390) | 650 (6, 610-1590) | **218 (6, 205-235)** |
| agent ready (from the send), ms | 18 (6, 17-26) | 18 (6, 16-208) | 18 (6, 17-19) | 19 (6, 18-22) |
| first text (from the send), ms | 152 (6, 94-1639) | 217 (6, 83-281) | 560 (6, 515-1500) | **100 (6, 90-101)** |
| agents at rest before the click | 0 | 0 | 0 | 0 |
| load (kept) | 1.9-4.2 | 2.4-4.5 | 2.2-3.9 | 1.6-3.8 |

Pointer first (the real case: a hand reaches the composer before it clicks): 650 to 218 ms, every after row under
0.24 s. Strict click is bimodal in both arms (about 210 ms or about 300 ms, depending on where the click-time warm
lands relative to the send): the medians (257 vs 318) are within each other's range and say nothing; the worst row
falls from 1,740 to 390 ms.

### Reopened chat (A's agent stopped after 40 s idle, open A, 1 s, click, type, Enter)

`resume.mjs 2 1 40`, 4 rounds per arm (chain 8 B).

| metric | before, click | after, click | before, pointer first | after, pointer first |
|---|---|---|---|---|
| Enter -> first word painted, ms | 202 (4, 200-202) | 201 (4, 197-206) | 208 (4, 203-222) | 203 (4, 198-208) |
| first text (from the send), ms | 88 (4, 87-92) | 81 (4, 70-95) | 102 (4, 89-121) | 86 (4, 72-101) |
| load (kept) | 2.4-3.7 | 1.9-4.0 | 3.2-4.9 | 2.5-3.6 |

Unchanged (the reopen warms 1 s ahead, past the window, in both arms).

### A4 First Word (ADEMark sequence, Opus 5.5, replay)

`a4.mjs 3`, 9 runs per arm (chain 8 C).

| metric | Volt before | Volt after |
|---|---|---|
| total: DOM poll (round 3 runner), ms | 109 (9, 85-148) | **92 (9, 81-143)** |
| total: two frames after the DOM insert, ms | 121 (9, 99-159) | 106 (9, 95-155) |
| before the request, ms | 87 (9, 75-107) | 72 (9, 60-85) |
| on screen (poll - before), ms | 22 (9, 10-47) | 24 (9, 15-60) |
| load (kept) | 4.2-6.2 | 3.1-5.0 |

A4 kept (slightly better: the preload's compile cache shortens the spawn, 15 ms off the time before the request).

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

- **Strict-click restored chat** stays bimodal (about 210 or 300 ms, worst 390 ms after): the click-time warm and the
  send race. Not chased: a hand moves the pointer first, and that case is 218 ms in every row.
- **Release-build numbers**: all rows here are dev builds; the fixes are config and spawn-path changes that a release
  build runs the same way, so no release pass was taken in round 6.
- **`ENABLE_CLAUDEAI_MCP_SERVERS=false`** would also remove the wait; not taken, it drops the account's connectors.
- Round 6's agent died before the write-up; chain 9 (`chain9.log`, ended 10:49 local) finished on its own and its rows
  are the interleaved ones above. The write-up was finished by round 7's agents agent from the committed data.
