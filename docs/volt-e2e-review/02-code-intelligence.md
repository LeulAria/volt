# Volt e2e review 02: code intelligence and IDE tooling

Branch `e2e/ide` (from `feat/orch-and-devenv-revamp`), worktree `volt-e2e-ide`, 2026-11-12.
Raw data: [`data/ide/`](data/ide/). Drivers and how to re-run them: [`scripts/volt-e2e/ide/`](../../scripts/volt-e2e/ide/README.md).

## Summary

- **The first finding was a blocker.** In a Supervised (sandboxed) chat, which is the default, every Volt code tool
  failed. `instant_grep`, `find_symbol`, `find_files`, `code_nav` and `diagnostics` all answered "this chat has no
  folder" or "Volt cannot tell which files this sandboxed chat may read"
  ([`mcp-before-no-folder.txt`](data/ide/mcp-before-no-folder.txt)). Agents in Volt had none of Volt's code
  intelligence. Three fixes made the tools work.
- **The code index is 10x to 900x faster than ripgrep per query** (in-process, 1,856 files): 0.04 to 6.8 ms against
  37 to 82 ms. Through the MCP server, which is how an agent reaches it, a call takes 8 to 170 ms warm. That is about
  the same as running `rg` from a shell.
- **The agent A/B (Claude Haiku 4.5, 12 relationship questions, 3 runs each)** after all the fixes, compared with an
  agent using only its own Read/Grep/Glob/Bash:

  | | Change |
  |---|---|
  | Mean wall time | 7% lower |
  | Median wall time | 19% lower |
  | Tool output read | 36% less |
  | Accuracy | 96.1% to 99.0% (within noise) |
  | Tokens | 51% more |
  | Cost | 8% more |

  These were measured before the last three fixes (one-file grep, off-by-N `code_nav` lines, non-capturing groups),
  which remove 11 of the 13 Volt-tool errors in the final arm. No A/B was run after them.

- **The 100x goal was not reached** for agent answers, and it cannot be reached by faster tools alone. An answer's time
  is model turns, not tool time; see [What fell short of 100x](#what-fell-short-of-100x-and-why).
- **Agents almost never use the IDE tools** (debugger, test runner, profiler, HTTP client, Docker). They used them in
  1 of 13 task runs: Sonnet ran the CPU profiler once. Haiku never did. All 13 runs still reached correct answers with
  shell commands (`npm test`, `curl`, `sqlite3`).

## Project

- **Repo:** [HAIP](https://github.com/TelivityAI/haip) (TelivityAI's hotel PMS) at `83f88e5`, cloned to
  `/tmp/volt-e2e/ide/hotel` with `pnpm install`.
- **Stack:** a pnpm monorepo with a NestJS API (`apps/api`), Drizzle schema (`packages/database`), shared packages and
  a dashboard.
- **Size:**
  - 1,845 files tracked by `rg --files`
  - 1,167 TypeScript files, 813 of them in `apps/api/src`
  - 1,856 files and 9.1 MB in Volt's index, with 17,742 symbols
- **Why this repo:** the domain is rich in relationships. A reservation state machine, about 20 services injecting each
  other, ORM tables with foreign keys, event emitters and listeners, nine payment gateways behind one interface. It is
  also large enough that grep-and-read takes several turns.

## Method

All runs used one test instance of Volt built from this branch (`--user-data-dir /tmp/ve-ide`, CDP 9972) with the
hotel folder open.

1. **Index bench** (`indexBench.mjs`, no model and no window). Builds Volt's `CodeIndexEngine` in-process on the repo.
   Then it runs 6 greps, 4 symbol lookups and 3 fuzzy file lookups 15 times each, and the same searches with `rg` 5
   times each. Medians are reported.
2. **Tool bench** (`toolBench.mjs`, no model). Calls 16 code tools 5 times each through the volt MCP server of a real
   Supervised chat, which is the path Claude Code and Codex take. "First" is the first call (the language server may be
   cold); "warm" is the median of the other 4. The size of each answer is in characters, and tokens are estimated as
   characters / 4.
3. **Agent A/B** (`abRun.mjs`). Headless Claude Code (`claude -p`, model `claude-haiku-4-5`) ran 12 relationship
   questions (`questions.mjs`), 3 runs each, 36 runs per arm. Every run used a fresh session, project settings only,
   no subagents, no web and no edits.
   - **own:** Read, Grep, Glob and Bash only, with no MCP servers.
   - **volt:** the same tools, plus the volt MCP read tools (`instant_grep`, `find_symbol`, `find_files`, `code_nav`,
     `diagnostics`, `ide`, `workspace_status`), plus the `[Volt]` lead that Volt's real classifier and context pack
     prepend to the prompt (`lead.mjs`).
   - **Grading:** each question has 4 to 18 key facts, checked by hand with `rg` and by reading the code. A fact counts
     when its regex matches the final answer. The score is the share of facts found.
   - **Tokens** are input + output + cache read + cache write, from Claude Code's `result.usage`. Cost is
     `total_cost_usd`.
4. **IDE tasks** (`ideTasks.mjs` + `ideFixtures.mjs`). Five tasks that an engineer would solve with IDE tools, run in a
   Full access chat with every volt tool allowed:
   - **T1:** profile a slow script and fix it
   - **T2:** debug a failing spec
   - **T3:** call a mock reservations API
   - **T4:** query a SQLite copy of some tables
   - **T5:** draw the reservation lifecycle

   The bench records which tools the agent picked.

**When each A/B ran:**

| Tag | Ran (+04:00) | Volt code live |
|---|---|---|
| (none) | 12:01 | Before any fix: every volt tool refused (`mcp-before-no-folder.txt`). No A/B was run in this state; it would have been own tools only. |
| `before` | 12:30 | The folder, read-rule and warm-index fixes (`f85d4135116`, `dfc1614eab4`, `22358d38d5e`). Both arms ran. |
| `after1` | 12:41 | Also routing, grouped `code_nav` and the brace message (`6dfe80b27da`, `541fd776055`, `069bc77b120`). Volt arm only. |
| `after2` | 12:48 | Also the grep filters and implementations fallback (`fc12d4b010c`, `8aaec91e8b9`). Volt arm only. |

The own arm does not touch Volt code, so it was run once, as `before/own`, and is the baseline for every volt arm.

## Results

### Code index vs ripgrep (in-process, no model)

Files: [`index-bench-before.json`](data/ide/index-bench-before.json) and
[`index-bench-after.json`](data/ide/index-bench-after.json).

| Measure | Before (11:56) | After (13:34) |
|---|---|---|
| Cold build, 1,856 files / 9.1 MB / 17,742 symbols | 289 ms | 684 ms |
| Index on disk | 6.2 MB | 6.2 MB |
| RSS added | 73 MB | 78 MB |
| Reopen from disk | 42 ms | 42 ms |
| First query after the build | 4.3 ms | 9.1 ms |

| Query (median of 15) | Index before | `rg` before | Index after | `rg` after | Same files as `rg` |
|---|---|---|---|---|---|
| literal, rare (`reservationStatusEnum`) | 0.45 ms | 37.7 ms | 1.11 ms | 54.3 ms | yes (2) |
| literal, common (`propertyId`) | 1.63 ms | 37.8 ms | 1.88 ms | 82.5 ms | 14 of 697: the index stops at 100 matches in all (`rg -m 100` caps each file) |
| regex `insert\(reservations\)` | 0.69 ms | 39.5 ms | 3.05 ms | 64.9 ms | yes (5) |
| regex `@(Post\|Patch\|Put)\(` | 1.33 ms | 41.6 ms | 1.47 ms | 41.5 ms | 20 of 54 (100-match cap) |
| regex, wide alternation | 4.69 ms | 40.2 ms | 6.77 ms | 51.1 ms | yes (31) |
| literal, no match | 0.04 ms | 37.3 ms | 0.05 ms | 40.7 ms | yes (0) |
| symbol `ReservationService`, exact | 0.24 ms | 48.3 ms* | 0.30 ms | 64.6 ms* | 1 |
| symbol `Reservation`, prefix | 1.54 ms | 41.0 ms* | 1.94 ms | 92.3 ms* | 30 |
| symbol `resSvc`, fuzzy | 1.73 ms | 43.5 ms* | 4.37 ms | 76.9 ms* | 1 |
| fuzzy file `reservation service` | 0.15 ms | 20.4 ms** | 0.45 ms | 26.4 ms** | top hit right |

\* `rg` with a declaration regex. \*\* `rg --files` alone, with no ranking.

Between the two runs the index engine changed only in an error message (`069bc77b120`). The "after" run is slower
because the machine was busy with other agents, not because of a regression: `rg` slowed by the same 1.1x to 2.2x, and
the index's p90 jumped to 22 to 32 ms on several queries. Read the "before" column for the engine's speed on an idle
machine. A clean re-run on an idle machine was not done.

### Volt code tools through MCP, as an agent calls them (no model)

- **Before the fixes:** every call was refused ([`mcp-before-no-folder.txt`](data/ide/mcp-before-no-folder.txt)). For
  example, `instant_grep` took 328 ms to say "this chat has no folder".
- **Mid:** after the folder and read-rule fixes ([`tool-bench-mid.json`](data/ide/tool-bench-mid.json)).
- **After:** all fixes ([`tool-bench-after.json`](data/ide/tool-bench-after.json)).

| Call | Mid: warm ms / chars | After: first ms | After: warm ms | `rg` ms | After: chars | What changed |
|---|---|---|---|---|---|---|
| `find_symbol` exact | 18.6 / 121 | 20.5 | 18.1 | | 121 | |
| `find_symbol` fuzzy | 44.0 / 119 | 13.3 | 72.0 | | 119 | |
| `find_files` | 30.3 / 58 | 6.8 | 8.3 | | 58 | |
| `instant_grep` literal | 49.5 / 1,363 | 19.2 | 58.6 | 72.1 | 1,693 | matches name their declaration `(in Class.method)` |
| `instant_grep` regex, `type: ts` | 94.2 / 2,156 | 77.5 | 167.9 | 105.2 | 2,963 | the same, which costs time (index lookup, 1.5 s budget) |
| `instant_grep` files | 337 / 3,518 | 30.9 | 63.6 | 98.2 | 3,518 | |
| `instant_grep` glob + type | 45.9 / 1,772 **wrong** | 13.3 | 9.9 | 37.8 | 369 | glob was ignored when type was set; now both apply |
| `instant_grep` `!**/*.spec.ts` | 10.4 / 67 **wrong** ("no matches") | 21.5 | 15.5 | 119.1 | 248 | `!glob` searched only spec files; now it excludes them |
| `code_nav` definition | 10.2 / 107 | 898 | 9.9 | | 146 | |
| `code_nav` references (`assertTransition`) | 337 / 1,301 | 117 | 101 | | 638 | grouped by file. The LS was cold in the after run and reported 1 reference; the index added the other files |
| `code_nav` references (ORM column) | 65.3 / 1,415 | 225 | 18.3 | | 1,415 | the LS reports 1 reference; the index lists the uses in other files |
| `code_nav` callers | 377 / 888 | 10,016 | 86.9 | | 888 | first call with a cold LS |
| `code_nav` implementations (`PaymentGateway`) | 23.7 / 87 **"none"** | 1,169 | 86.2 | | 1,105 | 9 implementations from the index, marked as matched by name |
| `code_nav` inspect | 711 / 1,400 | 291 | 242 | | 1,400 | |
| `code_nav` workspace_symbols | 71.8 / 795 | 191 | 86.9 | | 795 | |
| `diagnostics` (one file) | 7.5 / 69 | 3,167 | 9.5 | | 69 | first call opens the file in the LS |

Things to note in this table:

- **MCP adds most of the cost.** A 1 ms index query takes 10 to 170 ms as a tool call because it goes agent →
  agent server → window → index process and back. So the agent-visible speedup over `rg` is about 1x to 8x, not 100x.
- **First calls into the language server cost 0.9 to 10 s.** In the after run tsserver had just reloaded. Its definition
  answer pointed at an import line and its references answer was 1 location. The new index fallbacks made those
  answers still useful.
- **A follow-up re-run of this bench at 13:33 could not run.** The test instance's agent server had restarted at about
  12:53, and the benchmark chat had not run a turn since. Host tools learn a chat's folder from its run, so every call
  answered "this chat has no folder". Real agents always run inside a turn, so they do not hit this. The bench needs a
  turn first (see the scripts README). No live turn was started for this report.

### Agent A/B: own tools vs Volt's tools (Claude Haiku 4.5, n = 36 per arm)

Files: [`ab-before.jsonl`](data/ide/ab-before.jsonl), [`ab-after1.jsonl`](data/ide/ab-after1.jsonl) and
[`ab-after2.jsonl`](data/ide/ab-after2.jsonl). Tables made with
`node scripts/volt-e2e/ide/summarize.mjs ab-before.jsonl ab-after1.jsonl ab-after2.jsonl`.

All A/B numbers were measured before the last three fixes (`b3092eb8245`, `b9e5d9d12c8`, `3c2165b815e`: one-file
grep, off-by-N `code_nav` lines, non-capturing groups). Those fixes come from the errors in these runs and were
checked with unit tests only. No A/B was run after them.

| Arm | Accuracy | Fully right | Wall s, mean ± sd | Wall s, median | Cost / run | Tokens / run | Output tokens | Tool calls | Volt calls | Tool output chars |
|---|---|---|---|---|---|---|---|---|---|---|
| own (baseline) | 96.1% | 30/36 | 23.9 ± 15.8 | 18.7 | $0.0370 | 103,274 | 1,481 | 4.9 | 0 | 25,500 |
| volt `before` | 96.8% | 32/36 | 26.3 ± 17.5 | 17.8 | $0.0460 | 157,286 | 1,899 | 6.5 | 0.8 | 21,826 |
| volt `after1` | 96.7% | 31/36 | 34.5 ± 24.2 | 26.4 | $0.0493 | 177,134 | 2,150 | 7.7 | 3.1 | 20,347 |
| volt `after2` (final) | **99.0%** | 32/36 | **22.2 ± 17.4** | **15.2** | $0.0399 | 156,267 | 1,878 | 6.6 | 2.1 | **16,229** |
| final vs own | +2.9 pt | | -7% | -19% | +8% | +51% | +27% | +35% | | -36% |

**Per question** (accuracy % / wall s / tool calls, with Volt calls in brackets):

| Question | own | volt `before` | volt `after1` | volt `after2` |
|---|---|---|---|---|
| Q1 writers to `reservations` | 100 / 27 / 5.7 | 100 / 21 / 7.3 (2.3) | 100 / 40 / 15.7 (11.3) | 100 / 31 / 11.7 (3.7) |
| Q2 callers of `assertTransition` | 100 / 19 / 7.7 | 100 / 13 / 4.0 (0) | 100 / 47 / 12.0 (3.3) | 100 / 21 / 7.0 (2.0) |
| Q3 rename `maxOccupancy` | 100 / 18 / 1.7 | 100 / 13 / 1.0 (0) | 100 / 14 / 1.7 (0.3) | 100 / 11 / 1.7 (0.3) |
| Q4 status routes | 93 / 25 / 2.3 | 96 / 33 / 5.7 (0.3) | 96 / 27 / 2.7 (0.3) | 96 / 18 / 3.7 (1.3) |
| Q5 `PaymentGateway` implementers | 100 / 13 / 2.7 | 100 / 33 / 5.3 (1.3) | 97 / 29 / 6.3 (2.3) | 100 / 9 / 3.0 (2.0) |
| Q6 night audit | 100 / 20 / 2.3 | 100 / 18 / 2.0 (0) | 100 / 28 / 5.3 (2.7) | 100 / 15 / 4.0 (1.3) |
| Q7 `ReservationModule` importers | 100 / 9 / 1.0 | 100 / 10 / 1.0 (0) | 100 / 22 / 4.3 (2.3) | 100 / 14 / 5.3 (3.0) |
| Q8 FKs to `rooms.id` | 95 / 25 / 6.3 | 100 / 25 / 7.3 (0) | 71 / 20 / 5.3 (2.0) | 95 / 12 / 2.7 (1.3) |
| Q9 cancel event chain | 100 / 46 / 10.0 | 100 / 48 / 11.7 (0) | 100 / 44 / 14.3 (5.7) | 100 / 35 / 14.0 (6.3) |
| Q10 check-in chain | 100 / 54 / 10.0 | 100 / 51 / 16.7 (5.7) | 100 / 61 / 13.0 (4.3) | 100 / 48 / 16.3 (3.0) |
| Q11 status enum in sync | 100 / 20 / 7.3 | 100 / 20 / 6.0 (0) | 100 / 27 / 6.0 (0) | 100 / 14 / 6.3 (0) |
| Q12 `FolioService` injectors | 65 / 12 / 2.0 | 65 / 30 / 9.7 (0) | 96 / 55 / 6.0 (2.3) | 96 / 39 / 3.0 (0.7) |

How to read these results:

- **Accuracy is close to the ceiling for both arms, and the gain is mostly luck.** Haiku answers these questions well
  with grep and read. The baseline's misses are one run per arm on Q12: that run answered "only `PosService`" after one
  narrow grep, scoring 6% instead of 94% (both `before` arms had such a run). Add a few single-fact misses
  (`assign-room` on Q4, `door_lock_credentials` on Q8). The final arm's +2.9 points come mostly from not having a Q12
  collapse. That is within the noise of 3 runs per question.
- **Speed improved a little.** The final arm is 7% faster on the mean and 19% on the median. It reads 36% less tool
  output, because grouped `code_nav` answers and declaration-named grep lines replace reading whole files. It is
  faster on 8 of 12 questions (most on Q8, Q3 and Q9), and slower on Q1, Q2, Q7 and Q12, where the agent mixed Volt
  calls with its own greps.
- **`after1` was worse than `before`.** The routing fix took Volt calls from 0.8 to 3.1 per run, but the agent then
  fought the grep filters, because `glob` + `type` and `!glob` were broken. In one Q1 run the agent ran the same
  `instant_grep` 10 times, each with a one-file `glob`. With `type: ts` set, the glob was ignored, so every call
  returned the same full answer. Q8 got 71% because one run listed schema files instead of tables. The
  filter fix (`fc12d4b010c`) and the declaration names on grep matches turned `after1`'s losses into `after2`'s gains.
- **Tokens went up 51% and cost 8%.**
  - **Where the tokens come from:** almost all of the extra is cache reads (91.6k to 146.6k per run). The volt MCP
    server's tool list, `ToolSearch` loading deferred tool schemas (0.9 calls per run in the final arm), and the
    2.3k-character `[Volt]` lead are re-read on every turn.
  - **Why cost grew less:** cache reads are cheap, so cost grew 8%, not 51%.
  - **Output tokens rose 27%:** the volt arm's answers were longer.
- **Tool errors in the final arm: 16 in 36 runs, 15 of them from Volt tools.** Two came from the bench, not Volt: the
  lead invites `scratch_draw`, which this read-only bench does not allow. The other 13, with the same errors in
  `after1` for comparison:

  | Error | `after2` | `after1` | Cause | Status |
  |---|---|---|---|---|
  | `code_nav`: "does not appear on line N" | 7 | 3 | the agent passed a line off by 1 to 30, or line 1 | fixed after the A/B, `b9e5d9d12c8` |
  | `instant_grep` with `path` set to one file: "not indexed" | 3 | 5 | the index only took folders | fixed after the A/B, `b3092eb8245` |
  | `instant_grep` "needs ripgrep" on `(?:…)` | 1 | 0 | a sandboxed chat's search does not run `rg` | fixed after the A/B, `3c2165b815e` |
  | `instant_grep` "needs ripgrep" on `['\"]` | 2 | 0 | `\"` is not a valid escape; ripgrep rejects it too | still open: the message should say so |

  So 11 of the final arm's 13 Volt-side errors (and 8 of `after1`'s) are fixed by the three commits that landed after
  the A/B. Their effect on time and tokens is not measured.

### IDE tools: did agents use debug, Docker, DB, HTTP and the profiler?

Files: [`ide-tasks-t0-wrong-guide.jsonl`](data/ide/ide-tasks-t0-wrong-guide.jsonl) (Haiku, given the sandboxed
chat's guide by mistake), [`ide-tasks-t-before.jsonl`](data/ide/ide-tasks-t-before.jsonl) (Haiku, Full access guide)
and [`ide-tasks-t-sonnet.jsonl`](data/ide/ide-tasks-t-sonnet.jsonl) (Sonnet, T1 to T3 only).

| Task | Volt tool that fits | Haiku (wrong guide) | Haiku | Sonnet | Answer right? |
|---|---|---|---|---|---|
| T1 profile `occupancy-report.mjs` | `ide` profile cpu | Bash + Edit, 68 s, 9.4 s → 44 ms | Bash + Edit, 34 s, 8.0 s → 3 ms | **`ide` profile help + cpu**, then Bash, 60 s, 11.7 s → 39 ms, named the hot spot (91% in `isInHouse`) | all 3 |
| T2 failing spec, "step through it in the debugger" | `tests`, `debug` | Bash (`npm test`), 131 s | loaded the `tests` schema, then ran `npm test` in Bash, 42 s | Bash, 31 s | all 3 restored `assigned → no_show` |
| T3 call the mock API, check it against the state machine | `ide` http | Bash (`curl`), 43 s | Bash (`curl`), 25 s | Bash (`curl`), 18 s | all 3 found the illegal `confirmed → checked_in` |
| T4 query `hotel.db` | none (no database capability) | Bash (`sqlite3`), 15 s | Bash (`sqlite3`) ×9, 28 s | not run | both right (STE, 6; res-7 and res-22) |
| T5 draw the lifecycle | `scratch_draw` | `scratch_draw`, 20 s | `scratch_draw`, 16 s | not run | both drew it |
| Docker | `docker_ensure`, `ide` docker | not tested: no task needed a container (the repo's `docker-compose.yml` runs Postgres, Redis, Keycloak and MinIO) | | | |

Why the IDE tools were not used:

1. **The shell was enough, and the shell is what models know.** Each task was small enough that `node`, `npm test`,
   `curl` or `sqlite3` gave the answer in one or two calls. An IDE tool costs a `ToolSearch` round trip to load its
   schema, plus an `op: help` call. Haiku loaded the `tests` schema in T2 and still ran `npm test` in Bash.
2. **The guide was wrong for a while.** The first Haiku run got the sandboxed chat's guide, which tells the agent to
   "run tests, debuggers and other processes with your own shell". The Full access guide, which names debug, tests and
   the profiler, did not change Haiku's choices. Sonnet, given the same guide, used the profiler: following tool
   guidance depends on the model.
3. **T1 was routed partly as a UI task.** The classifier gave "Profile it … tell me the time" a `ui` signal, so the
   lead opens with in-app-browser instructions instead of "measure first with `ide profile`".
4. **There is no database capability.** `ide` has analyze, ci, coverage, docker, editor, extensions, git, http,
   notebook, profile and remote. For SQLite or Postgres the agent has only its shell.
5. **The debugger's value never came up.** T2's cause is visible from the test's message, so stepping through it adds
   nothing. A task that needs runtime state (a wrong value deep in a call chain) would be a fairer test. It was not
   built.

No "after" run of the IDE tasks was made. The only change aimed at them is the sandbox-aware IDE guide in
`6dfe80b27da`. Whether IDE-tool use improved is not measured.

## Fixes (all on `e2e/ide`)

| Commit | Fix | Evidence |
|---|---|---|
| `f85d4135116` | A chat on its project folder (not a worktree) gets that folder for host tools. The agent server has no workspace to fall back on, so every relative path was refused. | `mcp-before-no-folder.txt`; a unit test in `hostSessionResolver.test.ts` |
| `dfc1614eab4` | A sandboxed chat's read rule is relayed to the window's search tools. It was a function and was dropped on the socket, so every search said "Volt cannot tell which files this sandboxed chat may read". | `mcp-before-no-folder.txt`; `serverClientTools.test.ts` |
| `22358d38d5e` | The confined index that sandboxed chats search is warmed when the chat starts. The first search waited 4 s and then refused with "indexing". | |
| `6dfe80b27da` | Questions that name code (backticked names, camelCase, PascalCase, members) are routed as workspace questions, and chat-lane code questions get a code-intelligence hint. Before, 7 of 12 questions got no hint, and "which methods call `assertTransition`" was routed as a web lookup. Sandboxed chats get an IDE guide without the tools their sandbox refuses. | Volt calls per run: 0.8 → 3.1 → 2.1 |
| `541fd776055` | `code_nav` groups locations by file (5.8k instead of 7.4k characters for 60 locations). When the language server's references stay in one file, it also lists the files where the index sees the name, marked as not type-checked. tsserver reported 1 reference for an ORM column with 81 uses. | Tool bench, ORM column row |
| `069bc77b120` | A sandboxed search that refuses a pattern with a lone `{` says to escape it, instead of "needs ripgrep" (ripgrep rejects it too). | `regexBraces.test.ts` |
| `fc12d4b010c` | `instant_grep` and the native grep apply `glob` and `type` together, as ripgrep does, and a leading `!` excludes. Content matches in up to 25 files end with `(in Class.method)`. | Tool bench glob rows; A/B `after1` → `after2` |
| `8aaec91e8b9` | `code_nav` implementations and inspect fall back to the index (classes that name the interface after `implements` or `extends`) when the language server has not loaded the implementing project. | `PaymentGateway`: "none" → 9 implementations |
| `312a28a64ff` | The bench drivers and raw data. | |
| `b3092eb8245` | `instant_grep` with `path` set to one file inside the root searches that file. The index took only folders, so a sandboxed chat's search (no ripgrep) answered "not indexed". Made after the A/B. | 8 calls in `after1` + `after2`; `codeIndexSingleFile.test.ts` (fails before, passes after) |
| `b9e5d9d12c8` | When `code_nav`'s line misses the symbol, it tries the lines 1 and 2 away, then the file's declaration of that name nearest the line, then the nearest whole-word use. The answer starts with `"X" is on line N, not M.` Made after the A/B. | 10 calls in `after1` + `after2` (lines off by 1 to 30, or 1); `codeTools.test.ts` |
| `3c2165b815e` | Patterns with `(?:…)` run in-process. The inline-flag check also caught non-capturing groups and sent them to ripgrep, which a sandboxed chat's search does not run. `(?i:…)` and other inline flags still go to ripgrep. Made after the A/B. | 1 call in `after2`; `textMatchUnicode.test.ts` compares 12 cases against ripgrep |

**Checks on this branch:**

- `npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck` reports 0 errors.
- `scripts/test.sh --run` passed 170 tests across the code index, grep, `code_nav`/codeTools, voltSearch (confined),
  host session resolver, server client tools, intent, context pack, codeIntel, workspacePath and hostToolService
  tests.
- The voltHostMcp main service and requestShape tests: 20 passing.
- After the last three fixes: tsgo still reports 0 errors. 126 tests pass across the code index (single file,
  confined, search, braces, FFF, Unicode matching), codeTools, searchTools, voltSearch and hostToolService.
  Before the fixes, 19 of the new tests failed.

## What fell short of 100x, and why

- **Per query, the index is often 100x faster.** It answers in 0.04 to 6.8 ms where `rg` takes 37 to 82 ms: about 930x
  for a miss, 84x for a rare literal and 9x for a wide regex.
- **An agent does not see that speed.**
  1. **Transport.** Each call crosses agent → MCP → agent server → window → index process, which takes 10 to 170 ms
     warm. On a 1,845-file repo `rg` is already 40 ms, so the agent-visible gain per search is about 1x to 8x. Calls
     that add declaration names are sometimes slower than `rg` (168 ms vs 105 ms).
  2. **Model time dominates.** A run averages 6 to 9 model turns at about 3 to 4 s each (mean wall time divided by
     mean turns). By the tool bench's numbers, tool time is well under a second of a 15 to 50 s run. Even instant
     tools would save little; fewer turns is what saves time.
  3. **Fewer turns did not happen.** The final arm averaged 7.6 turns against 5.9 for the baseline. It reads less per
     turn but takes more turns, partly because deferred MCP tools cost a `ToolSearch` call before first use.
  4. **The ceiling on quality is low.** Haiku with grep already scores 96% on these questions, so tools cannot raise
     accuracy much on this set. A harder set (deeper chains, rename safety across packages, implicit DI wiring) would
     separate the arms better.
- **Where large factors are realistic:**
  - **Questions that need a type-aware answer.** For example, "is it safe to rename this ORM column", where grep gives
    81 lines to read and `code_nav` gives the list.
  - **Repos 10x to 100x larger,** where `rg` takes seconds.
  - **Fewer turns.** One call that answers a relationship question, instead of grep, read and grep again.

## Not measured, and follow-ups

**Not measured:**

- A/B with a stronger model (Sonnet or Opus). Haiku only.
- More than 3 runs per question.
- A re-run of the own arm after the fixes.
- An A/B after the last three fixes (`b3092eb8245`, `b9e5d9d12c8`, `3c2165b815e`).
- A final tool bench after the 12:53 restart, because the chat had no run (see above).
- IDE tasks after the fixes, and Sonnet T4 and T5.
- Docker.
- A clean index bench on an idle machine.
- Codex or other harnesses.

**Follow-ups found in the data:**

1. **A pattern with an escape ripgrep rejects (`\"`)** is refused as "needs ripgrep" in a sandboxed chat (2 calls in
   `after2`). Like the lone-brace case (`069bc77b120`), the message should say the pattern is invalid and how to
   write it (`"` needs no escape).
2. **Re-run the A/B** to measure the three fixes that landed after it.
3. **Token overhead (+51% per run).** Shorten the `[Volt]` lead for read-only questions (it carries UI, browser and
   visuals guidance that these questions do not need), and expose the four code tools without deferral so `ToolSearch`
   is not needed.
4. **The classifier gives "Profile it…" a `ui` signal,** and slowness prompts get the browser lead. Route them to
   "measure with `ide profile` first".
5. **Warm tsserver when a chat on a TypeScript project starts.** The first `code_nav` callers call took 10 s and the
   first `diagnostics` call took 3.2 s.
6. **Add a database capability** (SQLite and Postgres schema and query), or say plainly that the shell is the path.
7. **Build harder IDE tasks** where the IDE tool is the shorter path (runtime state for the debugger, a container for
   Docker, an authenticated `.http` file for HTTP), and re-run them on Haiku and Sonnet.
8. **The bench allowlist omits `scratch_draw` and `render_chart`,** which the lead invites (2 to 3 errors per arm).
   Either allow them in the bench or drop the visuals guidance for short read-only answers.
