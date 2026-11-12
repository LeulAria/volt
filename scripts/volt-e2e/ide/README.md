# Volt e2e review: code intelligence and IDE tooling benches

Drivers behind `docs/volt-e2e-review/02-code-intelligence.md`. Results go to
`docs/volt-e2e-review/data/ide/`. No script holds a key or token: the volt MCP config
(below) is written by hand from a running test instance and stays in `/tmp`.

## Paths

| Path | What |
|---|---|
| `/tmp/volt-e2e/ide/hotel` | The project: `git clone https://github.com/TelivityAI/haip` at `83f88e5`, `pnpm install`. Every driver defaults to it (`--repo` on `abRun.mjs`, the first argument of `indexBench.mjs` and `ideFixtures.mjs`). |
| `/tmp/volt-e2e/ide/mcp-volt.json` | `{ "mcpServers": { "volt": { "url", "headers" } } }` for a Supervised (sandboxed) chat of a test instance on the hotel folder: the URL and `Authorization` header Volt hands its agents. Copy it from a live agent's MCP config. Secret, never commit it. |
| `/tmp/volt-e2e/ide/mcp-volt-full.json` | The same for a Full access chat (`ideTasks.mjs`). |
| `/tmp/volt-e2e/ide/runs/` | Raw `stream-json` of every headless Claude Code run (`rescore.mjs` re-grades from these). |
| `out/` | A transpiled tree (`npm run transpile-client-oxc`): `indexBench.mjs` and `lead.mjs` import Volt's code from it. |

The chat behind an MCP config must have run a turn since its agent server started: host tools
find a chat's folder from its run, and until then answer "this chat has no folder".

## Drivers

| Script | Needs | Does |
|---|---|---|
| `indexBench.mjs <repo> [out.json]` | `out/`, `rg` | Builds Volt's code index in-process and times grep, symbol and file queries against ripgrep. No window, no model. Run with `node --expose-gc`. |
| `toolBench.mjs [mcp.json] [out.json] [--runs 5]` | a test instance | Times every code tool through the volt MCP server, as an agent calls it. No model. |
| `mcp.mjs <mcp.json> <tool> '<json>'` | a test instance | One MCP tool call; also the client the benches import. |
| `abRun.mjs --arm own\|volt --tag <tag> [--model] [--n 3] [--q Q1,Q2] [--jobs 4]` | `claude` CLI signed in | The 12-question A/B: `own` = Read/Grep/Glob/Bash only, `volt` = the same plus the volt MCP read tools and the `[Volt]` lead. Appends to `ab-<tag>.jsonl`. |
| `questions.mjs` | | The 12 questions and their hand-verified key facts; `score()` grades an answer. |
| `lead.mjs "<prompt>"` | `out/` | The `[Volt]` lead Volt's classifier and context pack prepend to that prompt. |
| `summarize.mjs ab-*.jsonl` | | Markdown tables from A/B results. |
| `rescore.mjs ab-<tag>.jsonl` | `runs/` | Re-grades after a change to `questions.mjs`. |
| `ideFixtures.mjs [repo] [--reset]` | `sqlite3` | Writes the five IDE-task fixtures into the hotel repo (slow script, broken state-machine rule, mock API, SQLite copy) or removes them. |
| `ideTasks.mjs --tag <tag> [--mcp] [--model] [--t T1,T2]` | `claude` CLI, a test instance | Runs the five IDE tasks and records which tools the agent reached for. Appends to `ide-tasks-<tag>.jsonl`. |

The drivers drop `ELECTRON_RUN_AS_NODE` and `CLAUDECODE` from the environment of the `claude`
runs they spawn, so they work from inside a Volt or Claude Code terminal.
