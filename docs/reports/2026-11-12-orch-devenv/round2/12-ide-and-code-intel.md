# 12 - IDE tooling and code intelligence, round 2

Branch `e2e2/ide` (from `81563ca39e4`), worktree `volt-e2e-ide`, 2026-11-12. Raw data in
[`data/ide/`](data/ide/), drivers in [`scripts/ide/`](scripts/ide/).

**Status: in progress.** Sections are filled in as runs finish.

## Summary

(pending: the after runs)

## Setup

- Machine: Apple M4 Max, 14 cores, 36 GB, macOS 26.6. Five test agents ran at once; every timing
  row carries the `uptime` load at its start (1-minute load ranged 7 to 135 over the day).
- Volt: a dev instance of this branch, `./scripts/code.sh --user-data-dir /tmp/v2-ide-ud
  --extensions-dir /tmp/v2-ide-ext --remote-debugging-port=9946 ...` (9943 from the brief was held
  by another agent's proxy). Project picked in the agent window by typing `/private/tmp/vbench-hotel`
  into the project picker. Default model `agent:seed-claude-code:claude-haiku-5-5` (Haiku 5.5
  Medium through claude-agent-acp). Access: **Supervised** (sandboxed), the default.
- "Before" = base `81563ca39e4`; "after" = this branch with every fix below compiled into `out/`,
  window reloaded and agent server restarted on the new `out/`.
- Arm 1 (agent without Volt): Claude Code 2.1.322, `claude -p <q> --model claude-haiku-5-5
  --output-format stream-json --strict-mcp-config --mcp-config=<empty> --allowedTools
  Bash,Read,Grep,Glob,Task,Agent,LS`, cwd `/private/tmp/vbench-hotel`.
- Arm 2 (agent in Volt): the same model in a fresh Volt chat per question (Cmd+N), driven over CDP.
  The driver clicks "Always Run" when an approval card appears and counts the clicks.
- Both arms run the same question at the same time (pairs Q1..Q9, three rounds), so load drift
  hits both. Question text + "Answer concisely with file:line references. This is a read-only
  question: do not modify any files." Questions: [`scripts/ide/questions.json`](scripts/ide/questions.json),
  ground truth: [`scripts/ide/ground-truth.md`](scripts/ide/ground-truth.md).
- Grading: answers copied to files named by a random id (`blind.mjs`), graded against the ground
  truth by a separate grader that sees neither the arm nor the run (1 / 0.5 / 0), then joined back
  with `key.json` (`scores.json`).
- Usage: arm 1 from Claude Code's `result` (`total_cost_usd`, `modelUsage`); arm 2 from the
  agent's Claude Code transcripts under `~/.volt/sandbox/agent-state/*/claude-code/config/projects`
  (subagents included), priced with the Haiku 5.5 rates `usage.mjs` derived from `claude -p`.
- Live IDE checks (`ide.mjs`): ten natural requests in a Volt chat on the fixture
  `/private/tmp/vbench-ide-fx` (a cart module with a failing test, `server.mjs` + `requests.http`,
  `docker-compose.yml` with a crash-looping service, `shop.db`, `scripts/slow.mjs`,
  `analysis.ipynb`), three runs each. "Picked" = the agent called the Volt tool that fits; "worked"
  = that call returned without an error.
- Commands:
  `node scripts/ide/ab.mjs /tmp/v2-ide-ab/<tag> <tag> all 3 9946 /tmp/v2-ide-ud`,
  `node scripts/ide/blind.mjs ...`, `node scripts/ide/summarize.mjs <summary.jsonl> <scores.json> <tag>`,
  `node scripts/ide/ide.mjs /tmp/v2-ide-ide/<tag> <tag> all 3`, `node scripts/ide/ideSummary.mjs`.

## Fixes made

| commit | file(s) | what | why | test |
|---|---|---|---|---|
| `5064b66c4d0` | `voltRuntime/common/codeIntelligence.ts`, `browser/tools/codeTools.ts`, `searchTools.ts`, `voltHostMcp.ts` | Language servers for every project chat (only Volt worktree checkouts follow the worktrees setting); `code_nav` finds the line from path + symbol or symbol alone; `callers`/`callees` take `depth` and return the chain to the entry points with module-level calls named by their procedure; outline skips locals; `implementations` lists places typed as the interface; `instant_grep` takes several paths; `code_nav`, `instant_grep`, `find_symbol` always-loaded (MCP `_meta anthropic/alwaysLoad`) | The agent window has no folder open, so every project chat was taken for a worktree: "language servers are off for this checkout" (12 of 46 code_nav calls in the before runs); 22 of 46 failed with "needs line" | `codeTools.test.ts`, `searchTools.test.ts`, `voltHostMcpMainService.test.ts` |
| `1bdc1c5da28` | `common/hostToolSandbox.ts`, `access/providerAccessBridge.ts`, `browser/agents/acpProvider.ts` | Volt's own read tools (code_nav, instant_grep, find_symbol, diagnostics) answered by Volt in a Supervised chat; tests, debug, tasks, ide classed sandboxed (files they name judged as reads); code_action rename is a write in the chat's folder; docker's "cannot connect" in a sandbox says why | 65 approval cards in 27 before runs (Claude Code could not save "Always Run": `.claude/settings.local.json` is sandbox-protected); debug and rename refused with "not cleared to run from a sandboxed chat" (6 of 6 debug/rename calls before) | `hostToolSandbox.test.ts`, `providerAccessBridge.test.ts`, `acpProvider.test.ts` |
| `69443cb8546` | `common/harness/intent.ts`, `contextPack.ts`, `ide/databaseQuery.ts`, `browser/ide/capabilities/databaseCapability.ts` | One `[Volt]` line naming the fitting tool and op for IDE work in every lane; tests/debug/ide always-loaded; the IDE guide names http, db, docker, profile by what they answer; new `ide db` capability (SQLite `sqlite3 -readonly`, Postgres in a read-only transaction) | Agents picked the IDE tools 1 run in 13 (round 1), 9 of 30 before | `contextPack.test.ts`, `databaseQuery.test.ts` |
| `f74f1e2b795` | `contrib/voltAgent/browser/scratchBoard/scratchAgentTools.ts` | `scratch_read` with no board yet answers "nothing on it; scratch_draw starts one" | It threw "The user has no Scratch board yet", which agents took as Scratch being unavailable and answered in text (2 of 3 before runs) | live: scratch rows of ide-after |
| `5962c6aa224` | `services/voltAgentServer/common/agentServerClient.ts`, `remoteVoltHostToolService.ts`, `contrib/voltAgent/browser/remote/agentServerWindow.ts`, `terminals/remoteAgentTerminals.ts` | `onDidConnect` fires on every welcome, resumed or not; the window's host tools and turned-off features, its code-intel folders, unsaved documents and terminal viewers are sent again on it | Found by this round's after runs: after "the network is back; reconnecting" (21:44) the window resumed, the server had dropped the old socket's tools, and the window re-sent them only on a snapshot resync. Every chat after that had 77 volt tools instead of 132 (no code_nav, diagnostics, code_action, tests, scratch, canvas, devices, workspace_status) and no IDE guide; Haiku answered with rg alone (first two after pairs, discarded) | `agentServerClient.test.ts` (new: a resumed connection is announced, no snapshot); live: `online` event dispatched over CDP, next chat had all 132 |
| `af7eb657091` | `common/harness/intent.ts` | IDE hints only for IDE work: whole-word verbs, "non-test"/"test-only" are not tests, a database's schema/columns are code, a path's dots do not end a rename | Q1 ("each non-test implementation ... passes it into runCommand") got the tests hint (`run\w*` matched `runCommand`); Q3 ("renamed in the database schema") got the db hint; the rename task got none (`src/cart.ts`'s dot ended the sentence) | `intent.test.ts` (new case with the bench prompts) |

## Bugs found and not fixed

(pending)

## Open issues

(pending)
