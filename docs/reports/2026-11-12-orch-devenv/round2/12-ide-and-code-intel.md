# 12 - IDE tooling and code intelligence, round 2

Branch `e2e2/ide` (from `81563ca39e4`), worktree `volt-e2e-ide`, 2026-11-12. Raw data in
[`data/ide/`](data/ide/), drivers in [`scripts/ide/`](scripts/ide/).

## Summary

- **Code questions (hotel app, 9 questions × 3 runs per arm, Haiku 5.5, Volt Supervised vs Claude
  Code without Volt):** Volt's median time per answer went from **1.87× slower** than plain Claude
  Code (59.9 s vs 32.0 s) to **even** (40.9 s vs 40.9 s). Summed over the 27 runs: 1.43× → 1.10×
  (1.0× without the one run the approval bug below stalled, now fixed). Cost 1.27× → 1.15× of
  Claude Code's. Approval cards 65 → 0. Volt's agents now answer with `code_nav` (240 Volt calls in
  27 runs, all with the tools loaded) instead of grep.
- **Correctness (one blind grader, all 108 answers pooled):** Claude Code 26.5 → 27 / 27, Volt
  25.5 → 24.5 / 27. Volt is not more correct: its fast Q9 answers (19 s vs 37 s) stopped early and
  missed a derived schema 3 of 3 times. No 10× or 100×: on these questions model time is about half
  of every run and the language server's call-hierarchy answers take 10-45 s under load.
- **IDE tools (10 natural requests × 3):** the agent picked the fitting Volt tool **9/30 → 24/30**,
  and the tool did the job **4/30 → 21/30** (tests, debug, HTTP, DB, profiler, rename, canvas all
  3/3). Still 0/3: notebooks (no kernel in the agent window), Docker (agents answer from the
  compose file; correct), Scratch (the board already held the drawing; see Open issues).
- **Bugs fixed in this session (7 commits, on top of the predecessor's 3):** window tools vanished after any reconnect (every chat lost
  `code_nav`, tests, Scratch...); a busy window turned code search into an approval card; tests,
  `.http` files and environments were only looked for in the window's folders (the agent window
  has none); the HTTP client's requests were refused by CORS; CPU profiling never worked in a
  sandboxed chat; IDE hints fired on code questions; `scratch_read` failed with no board.
- Load: five agents shared the machine; 1-minute load was 9-60 (before A/B), 22-244 (after A/B),
  29-134 / 41-107 (IDE checks). Every row has its load in `summary.jsonl`.

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
  `node scripts/ide/ide.mjs /tmp/v2-ide-ide/<tag> <tag> all 3`, `node scripts/ide/ideSummary.mjs`,
  `node scripts/ide/timeSplit.mjs <arm2 dir>` (where a Volt run's time goes).
- Runs that were discarded, not counted: the predecessor's first "after" attempt (run 1 at load
  30-94, then every run of both arms failed with "Claude Code can't use your Claude subscription");
  and the first two pairs of this session's attempt, which ran with the window's tools missing (bug
  fixed in `5962c6aa224`). Both are kept in `/tmp/v2-ide-ab/after-billing-failed` and
  `after-tools-missing`, not in `data/`.

## Results

### A. Code questions on the hotel app (`data/ide/ab-before/`, `data/ide/ab-after/`)

N = 3 per question and arm; arms run in pairs at the same moment. "After" is the branch at
`af7eb657091` (everything but the last three IDE fixes, which do not touch these questions, and the
approval fix `4f6dbf85226`, which removes the one stall in Q6 r2). Scores are from one blind
grading of all 108 answers together (`pool-key.json`, `pool-grades.json`; the predecessor's
before-only grading, `ab-before/grades.json`, gave 25.5 / 25.0, within half a point of it).

| | before: Claude Code | before: Volt | after: Claude Code | after: Volt |
|---|---|---|---|---|
| runs | 27 | 27 | 27 | 27 |
| score (sum / 27) | 26.5 | 25.5 | 27 | 24.5 |
| wall s, median per run | 32.0 | 59.9 | 40.9 | 40.9 |
| wall s, range | 7-157 | 10-88 | 9-269 | 10-419 |
| wall s, total | 1076 | 1542 | 1398 | 1535 |
| cost $, total | 0.2805 | 0.3553 | 0.2686 | 0.3101 |
| tokens, total (in + cache + out) | 7.94M | 9.38M | 7.86M | 8.50M |
| output tokens | 132k | 129k | 137k | 119k |
| tool calls (of them Volt's) | 294 | 335 (183) | 295 | 330 (240) |
| approval cards | - | 65 | - | 0 |
| 1-min load at start, min-median-max | 9-28-60 (both arms) | | 22-48-244 (both arms) | |

End-to-end ratios, Volt ÷ Claude Code (same moment, same model):

| | before | after |
|---|---|---|
| median time per answer | 1.87× | 1.00× |
| total time, 27 runs | 1.43× | 1.10× (0.99× without the Q6 r2 pair) |
| cost | 1.27× | 1.15× |
| tokens | 1.18× | 1.08× |
| score | 25.5 vs 26.5 | 24.5 vs 27 |

Per question (median wall s, score of 3; ratio = Volt ÷ Claude Code median):

| Q | before CC | before Volt | after CC | after Volt | ratio before | ratio after |
|---|---|---|---|---|---|---|
| Q1 implementers + chains | 32 s, 3/3 | 66 s, 3/3 | 39 s, 3/3 | 68 s, 3/3 | 2.06× | 1.74× |
| Q2 procedures → resolveBookingStayRent | 35 s, 3/3 | 62 s, 3/3 | 68 s, 3/3 | 42 s, 3/3 | 1.75× | 0.62× |
| Q3 column rename impact | 35 s, 3/3 | 60 s, 2.5/3 | 44 s, 3/3 | 35 s, 2/3 | 1.73× | 0.78× |
| Q4 booking request path | 89 s, 3/3 | 74 s, 2.5/3 | 68 s, 3/3 | 48 s, 3/3 | 0.83× | 0.71× |
| Q5 tour store | 9 s, 3/3 | 40 s, 3/3 | 11 s, 3/3 | 10 s, 3/3 | 4.35× | 0.90× |
| Q6 CommandDefinition | 29 s, 3/3 | 34 s, 3/3 | 42 s, 3/3 | 24 s, 3/3 | 1.19× | 0.59× |
| Q7 FiscalAdapter.register chains | 48 s, 2.5/3 | 86 s, 3/3 | 43 s, 3/3 | 55 s, 3/3 | 1.79× | 1.28× |
| Q8 StateReader.query calls | 14 s, 3/3 | 46 s, 3/3 | 29 s, 3/3 | 35 s, 3/3 | 3.27× | 1.20× |
| Q9 two insertBookingSchemas | 30 s, 3/3 | 52 s, 2.5/3 | 37 s, 3/3 | 19 s, 1.5/3 | 1.76× | 0.51× |

Where a Volt run's time goes (`timeSplit.mjs`, union of tool intervals, 27 runs each):

| | total s | Volt's lead before the prompt | in Volt tools | in other tools (Read, Bash) | model (the rest) |
|---|---|---|---|---|---|
| before | 1517 | 12 | 776 (incl. approval waits) | 174 | 663 |
| after | 1485 | 30 | 725 | 366 | 687 |

The median Volt call takes 0.9 s; the long ones are `code_nav callers` with `depth` 3-4 on the
monorepo (10-45 s each under load 50-240) and `instant_grep` patterns the index cannot answer
(ripgrep fallback, 11-61 s, 225 s in the stalled Q6 r2). The after Q6 r2 (419 s) also waited 45 s
on an approval card for `instant_grep` (fixed in `4f6dbf85226`) while load peaked at 105-232.

Honest reading of the 100× ask: on read-only code questions with the same small model, Volt now
matches plain Claude Code end to end and does not beat it. About half of each run is the model
thinking between calls, which no harness removes; the other half is tool time, where the language
server's call hierarchy is slower than grep on this repo. What Volt changed is the method (type
checked references and call chains instead of text matches) and the friction (65 → 0 approval
cards), not the order of magnitude. Volt's answers were not more correct here: Haiku stopped
earlier on Q3 (wrong enclosing function, 2 runs) and Q9 (missed `updateBookingSchema`, 3 runs).

### B. IDE tools on natural requests (`data/ide/ide-before/`, `ide-after/`, `ide-after-fixes/`)

N = 3 per task. "After" = the branch at `4f6dbf85226`; "final" re-ran the three tasks fixed after
that (`d17cd37925e`, `0a052e9766a`, `df8b4caa01c`) on the final code, the other seven are the
"after" rows. Picked / worked are of 3 runs.

| task | before picked / worked | after picked / worked | final picked / worked | final wall s median (range) | final cost $ median |
|---|---|---|---|---|---|
| tests (which cart test fails) | 0 / 0 | 2 / 0 | 3 / 3 | 43 (41-43) | 0.0056 |
| debug (values at a line) | 3 / 0 | 3 / 3 | 3 / 3 | 60 (46-128) | 0.0074 |
| http (requests.http, env local) | 0 / 0 | 2 / 0 | 3 / 3 | 9 (9-10) | 0.0049 |
| docker (why it restarts) | 0 / 0 | 0 / 0 | 0 / 0 | 8 (8-13) | 0.0041 |
| db (top sku in shop.db) | 0 / 0 | 3 / 3 | 3 / 3 | 12 (12-13) | 0.0053 |
| profile (slowest function) | 0 / 0 | 3 / 0 | 3 / 3 | 10 (8-10) | 0.0042 |
| notebook (run, last output) | 0 / 0 | 3 / 0 | 3 / 0 | 44 (41-47) | 0.0068 |
| rename (lineTotal → lineAmount) | 2 / 0 | 3 / 3 | 3 / 3 | 21 (12-53) | 0.0051 |
| scratch (sketch the flow) | 1 / 1 | 0 / 0 | 0 / 0 | 15 (10-29) | 0.0067 |
| canvas (design two screens) | 3 / 3 | 3 / 3 | 3 / 3 | 27 (19-51) | 0.0078 |
| **total** | **9 / 4** | **22 / 15** | **24 / 21** | | |

Load (1-min) at the start of the rows: before 29-54-134 (min-median-max), after 41-74-107, final
16-20-35. Notes per task:
- docker: all runs answered correctly from `docker-compose.yml` ("fatal: missing DATABASE_URL",
  `exit 3`, `restart: always`) without calling Docker; in a Supervised chat the docker socket is
  outside the sandbox anyway. Counted as not picked, not as wrong.
- scratch: the test profile's board already held "Login, token and profile flow (server.mjs)" from
  the before runs, so the agent read it, said so and did not redraw (correct behavior, but not a
  test of `scratch_draw`). The no-board path (`f74f1e2b795`) is not exercised by these runs.
- notebook: picked 3/3, every `notebook run` failed with "No kernel can run this notebook" (Bugs).
- profile "after": `profile cpu` picked 3/3 and failed 3/3 ("EPERM: Failed to write file
  .../volt-profiles/..."); final 3/3 name `isPrime` at 82-85 % self time.

## Fixes made

| commit | file(s) | what | why | test |
|---|---|---|---|---|
| `5064b66c4d0` | `voltRuntime/common/codeIntelligence.ts`, `browser/tools/codeTools.ts`, `searchTools.ts`, `voltHostMcp.ts` | Language servers for every project chat (only Volt worktree checkouts follow the worktrees setting); `code_nav` finds the line from path + symbol or symbol alone; `callers`/`callees` take `depth` and return the chain to the entry points with module-level calls named by their procedure; outline skips locals; `implementations` lists places typed as the interface; `instant_grep` takes several paths; `code_nav`, `instant_grep`, `find_symbol` always-loaded (MCP `_meta anthropic/alwaysLoad`) | The agent window has no folder open, so every project chat was taken for a worktree: "language servers are off for this checkout" (12 of 46 code_nav calls in the before runs); 22 of 46 failed with "needs line" | `codeTools.test.ts`, `searchTools.test.ts`, `voltHostMcpMainService.test.ts` |
| `1bdc1c5da28` | `common/hostToolSandbox.ts`, `access/providerAccessBridge.ts`, `browser/agents/acpProvider.ts` | Volt's own read tools (code_nav, instant_grep, find_symbol, diagnostics) answered by Volt in a Supervised chat; tests, debug, tasks, ide classed sandboxed (files they name judged as reads); code_action rename is a write in the chat's folder; docker's "cannot connect" in a sandbox says why | 65 approval cards in 27 before runs (Claude Code could not save "Always Run": `.claude/settings.local.json` is sandbox-protected); debug and rename refused with "not cleared to run from a sandboxed chat" (6 of 6 debug/rename calls before) | `hostToolSandbox.test.ts`, `providerAccessBridge.test.ts`, `acpProvider.test.ts` |
| `69443cb8546` | `common/harness/intent.ts`, `contextPack.ts`, `ide/databaseQuery.ts`, `browser/ide/capabilities/databaseCapability.ts` | One `[Volt]` line naming the fitting tool and op for IDE work in every lane; tests/debug/ide always-loaded; the IDE guide names http, db, docker, profile by what they answer; new `ide db` capability (SQLite `sqlite3 -readonly`, Postgres in a read-only transaction) | Agents picked the IDE tools 1 run in 13 (round 1), 9 of 30 before | `contextPack.test.ts`, `databaseQuery.test.ts` |
| `f74f1e2b795` | `contrib/voltAgent/browser/scratchBoard/scratchAgentTools.ts` | `scratch_read` with no board yet answers "nothing on it; scratch_draw starts one" | It threw "The user has no Scratch board yet", which agents took as Scratch being unavailable and answered in text (2 of 3 before runs) | live: scratch rows of ide-after |
| `5962c6aa224` | `services/voltAgentServer/common/agentServerClient.ts`, `remoteVoltHostToolService.ts`, `contrib/voltAgent/browser/remote/agentServerWindow.ts`, `terminals/remoteAgentTerminals.ts` | `onDidConnect` fires on every welcome, resumed or not; the window's host tools and turned-off features, its code-intel folders, unsaved documents and terminal viewers are sent again on it | Found by this round's after runs: after "the network is back; reconnecting" (21:44) the window resumed, the server had dropped the old socket's tools, and the window re-sent them only on a snapshot resync. Every chat after that had 77 volt tools instead of 132 (no code_nav, diagnostics, code_action, tests, scratch, canvas, devices, workspace_status) and no IDE guide; Haiku answered with rg alone (first two after pairs, discarded) | `agentServerClient.test.ts` (new: a resumed connection is announced, no snapshot); live: `online` event dispatched over CDP, next chat had all 132 |
| `af7eb657091` | `common/harness/intent.ts` | IDE hints only for IDE work: whole-word verbs, "non-test"/"test-only" are not tests, a database's schema/columns are code, a path's dots do not end a rename | Q1 ("each non-test implementation ... passes it into runCommand") got the tests hint (`run\w*` matched `runCommand`); Q3 ("renamed in the database schema") got the db hint; the rename task got none (`src/cart.ts`'s dot ended the sentence) | `intent.test.ts` (new case with the bench prompts) |
| `4f6dbf85226` | `server/node/voltAgent/serverClientTools.ts`, `voltRuntime/common/hostTools.ts`, `remoteVoltHostToolService.ts` | A window marks the tools whose provider never asks (`neverAsks`); the server skips the "needs approval?" round trip for them | Under load the window answered that question after the server's 15 s wait, which counts as "it does": hotel Q6 r2 got an "instant_grep: acts in a Volt window" card (45 s, then denied) | `serverClientTools.test.ts` (2 new cases) |
| `d17cd37925e` | `contrib/voltAgent/browser/ide/voltTestController.ts`, `ideTests.ts` | The tests tool adds its chat's project to Volt's test discovery; "run all" there runs that project's tests | Discovery only searched the window's folders: "No test controller found tests in this workspace" for every project chat (3/3 after runs) | live: tests 3/3 (`ide-after-fixes`) |
| `0a052e9766a` | `contrib/voltHttp/browser/voltHttpService.ts`, `capabilities/workbenchCapabilities.ts`, new `platform/voltHttp/{common,electron-main}`, `code/electron-main/app.ts`, `voltGit.contribution.ts` | `.http` files and `http-client.env.json` are also looked for in the chat's project; on the desktop the main process sends the requests (`net.fetch`) | "No .http or .rest files in the workspace" / "No environment local"; and the window's fetch was refused by CORS for any API without `Access-Control-Allow-Origin` ("Failed to fetch" even for a GET) | live: http 3/3, 9 s, no shell |
| `df8b4caa01c` | `capabilities/profileCapability.ts` | A `node ...` command gets `--cpu-prof` on its command line; a sandboxed recording goes to `/tmp/volt-profiles` and moves into the profiles home; the folder is quoted | The sandbox drops `NODE_OPTIONS` and denies Volt's user data (where recordings went): `profile cpu` never wrote a profile in a Supervised chat (3/3) | live: profile 3/3 |

Typecheck (`tsgo`) 0 errors; every test file the branch touches passes (12 files, 176 tests); CI
lints pass (authorityGate only reports the known `extensionCodeScan.ts:361`).

## Bugs found and not fixed

- **Notebooks have no kernel in the agent window.** `ide notebook run` → "No kernel can run this
  notebook. Install the Jupyter extension (or open it once so a kernel is chosen)", although the
  Jupyter and Python extensions are installed in the test profile. The notebook model is resolved
  but no kernel is ever offered; likely the Jupyter extension only discovers kernels for an open
  notebook editor or a workspace folder. Agents fall back to the saved outputs and say so.
- **`code_nav callers` with depth 3-4 is slow on a big monorepo** (10-45 s per call at load
  50-240; median Volt call 0.9 s). It is the single largest Volt cost in the code questions.
- **`instant_grep` patterns the index cannot answer fall back to ripgrep and can take 11-61 s**;
  one returned "Volt's code index could not answer this for a sandboxed chat (this pattern needs
  ripgrep ...)" instead of results (hotel Q4 r2).
- **Held chats lose their holder on a resumed reconnect.** `5962c6aa224` re-sends a window's tools,
  folders, documents and terminal viewers, but not `session.open`: the server's `held.holders`
  drops the window, so an idle open chat can be trimmed from the server's memory (`trim`, beyond
  `MAX_HELD`). Low impact (it is reopened on demand), not changed.
- **"checkpoint before turn failed TypeError: Cannot read properties of undefined (reading
  'some')"** in the agent server log each time the orchestrator restarted work stopped by "Sign in
  to continue" (orchestrator area, not investigated).
- **Window log spam:** "Method not found: isAvailable" every 2-5 s in `renderer.log` from an IPC
  channel call (`voltDiagnostics/common/ipcActivity.js`); not traced to its caller.

## Open issues

- The A/B "after" ran before `4f6dbf85226` (approval) and the three IDE fixes; only Q6 r2 is
  known to be affected. A re-run on the final code was not done (quota and time).
- Volt's answers to Q3 and Q9 were less complete than plain Claude Code's (3 and 1.5 of 3 lost
  points vs none); with N=3 this is a signal, not a finding. Whether the IDE guide's "Read only the
  lines you need" style of advice makes Haiku stop early is untested.
- The Scratch check needs a fresh profile per run to exercise `scratch_draw` on an empty board.
- The HTTP client in the browser workbench (web) still sends from the page and is subject to CORS;
  only the desktop has the main-process transport.
- Docker from a Supervised chat needs Full access (by design); not measured unsandboxed this round.
