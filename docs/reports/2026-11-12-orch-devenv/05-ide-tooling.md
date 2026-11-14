# 05 · IDE tooling at runtime (debug, tests, HTTP, Docker, DB, profiler, Scratch, canvas)

**Status: not finished here. The agent running it was stopped by the user before it recorded any
results.** It had built a fixture in `/tmp/vbench-ide-fx`: a vitest suite with a failing test, a
pytest file, a CPU-heavy script, a local HTTP server with an `.http` file (environment and chaining),
a restarting Docker container and a SQLite database.

The runtime results for these tools come from the parallel review,
[parallel/02-code-intelligence.md](parallel/02-code-intelligence.md):

- In a Supervised (sandboxed) chat, which is the default, every Volt code tool first failed with
  "this chat has no folder" (`instant_grep`, `find_symbol`, `find_files`, `code_nav`,
  `diagnostics`). Three fixes on `e2e/ide`, now merged, made them work.
- Agents rarely chose the IDE tools (debugger, test runner, profiler, HTTP client, Docker) for
  natural requests: 1 run in 13 (Sonnet ran the CPU profiler once, Haiku never). Every run still
  reached a correct answer with shell commands (`npm test`, `curl`, `sqlite3`).

Not verified at runtime in either review: a notebook run with a kernel, `code_action rename`
applied live, the "+" menu's HTTP Client entry, the Container Tools download at build time, and
agent use of the Scratch board and canvas tools. These items from
`docs/volt-agent-dev-environment.md` ("first runtime pass") are still open.
