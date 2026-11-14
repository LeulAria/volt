# Round 5: code intelligence that beats grep

Status: **final** (2026-11-14). Branch `e5/codeintel`, worktree `volt-e5-codeintel`, from `9bbb8818c60`.
Model Haiku 5.5 through Volt's Claude Code chat (Claude Code 2.1.322, ACP adapter 0.106.0), Full access.

## Summary

- New in the code index and `code_nav`: a **tree-sitter structure layer** (exact outlines, symbol ranges, an
  **import graph** resolved to files, no language server needed), **`code_nav impact`** (callers 3 levels up with
  the procedures they end in, every file using or importing the symbol or file, the **tests to run** from the
  import graph, current errors: one call), **`code_nav body`** and `path#symbol` (one symbol's source with line
  numbers instead of the file), **`code_nav structural`** (ast-grep style `$X` / `$$$` patterns, now with
  `where` regex filters on bindings, `!glob` excludes and nested matches), and **diagnostics returned with each
  edit's result** when the edit adds errors (Claude Code `mcp_tool` hooks; nothing added when there are none).
- **"hi" cost: +0 tokens.** 14,709 prompt tokens on both builds (n=2 each, r5h). Volt's tools reach Claude Code
  deferred (names only), and no tool name was added.
- On 8 real tasks on openclaw (4.2k TypeScript files), final code, n=3 per task per arm (r5c): answers right
  **23/24 after vs 23.5/24 before**; the sum of per-task median tokens **827K to 691K (-16%)**; median tool calls
  summed over the tasks **67 to 52 (-22%)**; cost $0.0326 to $0.0315 (-3%). Pooled with r5b (n=6 per cell,
  r5b had longer hint text): 47.5/48 vs 46/48 right, tokens 803K to 713K (-11%), cost +5%.
- Where the new ops fit, they win clearly: **t1 "what would a new parameter break" -35% tokens (94.6K to
  61.5K), 7.5 to 4 tool calls, 6/6 right vs 5.5/6** (impact chosen in 5 of 6 runs). Structural search finds
  calls by shape across lines (**t5 -47% tokens**), but Haiku chose it in only 2 of 6 runs, and the two wrong
  t5 answers were grep-only runs that stopped early.
- **Edits cost more time.** The edit-check hooks add a median **379 ms per edit** (58 ms before; 75 vs 71
  edits, range 58-1,254 ms), so the two edit tasks were slower (t7 14.4 to 19.0 s, t8 27.5 to 42.8 s, both
  untimed: load above 14). The hook did its job: an edit that broke three returns came back with the three
  errors in its own result (r5e); the base build's edit said "no errors".
- New ops chosen over grep: 13 of 48 after-arm runs (t1 5/6, t3 4/6 via `body`, t4 2/6, t5 2/6; never on t2,
  t6-t8, where references/implementations/grep already answer in one or two calls).
- Wall times: every bench run but one was taken at load 14.7-47.4, above the brief's 14, so **no timing here is a
  measured gain**; they are listed as indicative only. A timed rep under the timing lock was not possible in
  the time left (the lock was held by another area when the load finally dropped).

## Before / after

Rig: two dev instances on the same fixture, interleaved per task and rep with alternating order (`bench.mjs`):
before = `volt-e5-codeintel-base` (detached at `9bbb8818c60`, CDP 9985), after = this branch at `8b2b579b309`
(CDP 9975). Each run is a new chat, Haiku 5.5, Full access. Read tasks end with "Answer concisely with
file:line references. This is a read-only question: do not modify any files." Tokens = every model request of
the run (main thread and side calls; input + cache write + cache read + output), from a request-capture proxy.
"grep-like" = instant_grep, find_symbol, find_files, Grep, Glob, rg/grep/find/git in Bash.

### Final code (r5c, n=3 per cell; medians, range)

| Task | Arm | Right | Tokens | $ | Tool calls | grep-like | Reads | New op used | Wall median, untimed (load range) |
|---|---|---|---|---|---|---|---|---|---|
| t1 impact of a new parameter | before | 2.5/3 | 88.1K (86.6-101.2K) | 0.0038 | 7 (6-12) | 6 | 1 | 0/3 | 23.2 s (17.9-47.4) |
| | after | 3/3 | **62.6K** (58.6-62.8K) | 0.0042 | **4** (4-6) | 2 | 1 | 2/3 | 25.6 s (17.0-29.1) |
| t2 importers of a file | before | 3/3 | 56.6K (42.2-75.5K) | 0.0028 | 3 (2-4) | 2 | 0 | 0/3 | 22.7 s (17.3-36.0) |
| | after | 3/3 | 58.5K (58.4-84.6K) | 0.0029 | 3 (3-4) | 2 | 0 | 0/3 | 22.7 s (18.6-31.4) |
| t3 callers and the route chain | before | 3/3 | 79.1K (74.8-80.2K) | 0.0029 | 6 (6-7) | 3 | 2 | 0/3 | 16.4 s (16.5-27.0) |
| | after | 3/3 | 83.6K (73.6-121.2K) | 0.0047 | 5 (4-9) | 2 | 0 | 2/3 | 20.8 s (19.5-35.6) |
| t4 one function's logic | before | 3/3 | 52.2K (51.7-54.7K) | 0.0013 | 2 (1-2) | 0 | 1 | 0/3 | 10.4 s (19.0-23.0) |
| | after | 3/3 | 55.1K (53.8-56.4K) | 0.0015 | 2 (1-3) | 0 | 1 | 0/3 | 10.8 s (17.1-20.5) |
| t5 multi-line calls by shape | before | 3/3 | 255.3K (199.2-266.8K) | 0.0118 | 19 (9-29) | 4 | 14 | 0/3 | 59.0 s (17.9-25.6) |
| | after | 2/3 | **126.6K** (64.7-168.4K) | 0.0078 | **7** (4-12) | 3 | 0 | 1/3 | 38.8 s (17.4-25.1) |
| t6 implementations | before | 3/3 | 54.6K (52.6-54.6K) | 0.0013 | 4 (3-4) | 2 | 0 | 0/3 | 10.5 s (15.1-26.4) |
| | after | 3/3 | **34.4K** (34.4-37.8K) | 0.0006 | 2 (2-2) | 1 | 0 | 0/3 | 6.5 s (14.7-26.0) |
| t7 rename (edit) | before | 3/3 | 90.7K (90.0-90.7K) | 0.0020 | 9 (9-9) | 2 | 3 | 0/3 | 14.5 s (17.0-26.5) |
| | after | 3/3 | 90.4K (75.5-91.7K) | 0.0024 | 9 (5-9) | 2 | 3 | 0/3 | 20.5 s (15.8-27.5) |
| t8 change a signature and 7 call sites (edit) | before | 3/3 | 150.9K (126.9-205.8K) | 0.0067 | 17 (17-19) | 3 | 5 | 0/3 | 32.5 s (16.4-23.7) |
| | after | 3/3 | 179.5K (132.4-199.0K) | 0.0074 | 20 (16-20) | 2 | 5 | 0/3 | 38.6 s (15.6-25.0) |
| **All 8** | before | **23.5/24** | **827.4K** (sum of medians) | **0.0326** | **67** | | | 0/24 | |
| | after | **23/24** | **690.7K (-16%)** | **0.0315 (-3%)** | **52 (-22%)** | | | 5/24 | |

Pooled r5b + r5c (n=6 per cell; r5b ran with the first, longer hint text; `data/codeintel/summary-r5bc.md`):

| Arm | Right | Sum of median tokens | Sum of median $ | Sum of median tool calls | Runs using a new op |
|---|---|---|---|---|---|
| before | 47.5/48 | 802.5K | 0.0324 | 57.5 | 0/48 |
| after | 46/48 | 712.8K (-11%) | 0.0340 (+5%) | 54 | 13/48 |

Per task, pooled: t1 94.6K to 61.5K tokens, 6/6 vs 5.5/6 right; t5 224.5K to 119.1K, 4/6 vs 6/6 right, 51.5 s
to 34.6 s untimed; t6 54.3K to 36.3K; t2 66.6K to 84.6K (no new op used; noise of request count, ranges
overlap); t7 90.3K to 92.1K; t8 139.2K to 180.1K (one to three more model requests per run, see below).

### Prompt cost of the new text (count_tokens, `count-tool-tokens.mjs`)

| Text | When it is in the prompt | Before | After |
|---|---|---|---|
| "hi" request (measured, r5h, n=2) | every chat's first request | 14,709-14,795 | 14,709 (both) |
| IDE guide | code turns (once per session on `e5/tokens`) | 419 | 483 (+64) |
| CODE_QUESTIONS | chat-lane questions about the workspace | 137 | 198 (+61) |
| `code_nav` definition | only after ToolSearch loads it | 586 | 866 (+280) |
| `instant_grep` definition | only after ToolSearch loads it | 519 | 564 (+45) |

The brief's limit (+150 tokens on "hi") holds with +0. The +64 and +61 are code turns only.

## Method

- Fixture `~/.volt-r5/codeintel/fx/openclaw`: openclaw at `d2a729374` with `AGENTS.md`/`CLAUDE.md` removed
  (4,217 TypeScript files, 1,362 tests, no `node_modules`), reset with `git checkout`/`clean` before each run.
- Tasks and ground truth: `scripts/codeintel/tasks.json`, `ground-truth.md`, graded by `grade.mjs` (1 right,
  0.5 partly). t1 has a trap (the mattermost extension's own `resolveThreadSessionKeys`); t5's twelve calls
  include seven that span lines and two nested in another `setTimeout`.
- Runner `bench.mjs` (both arms interleaved, alternating which goes first), `runtok.mjs` (CDP driver, round 4's,
  ported), `proxy.mjs` (request capture), `codebench.mjs` (tokens, tool calls of the main thread, ops),
  `summary.mjs`, `editgap.mjs` (Volt-side time of edit steps: from a response's end to the next request).
- Runs: r5a (n=1, before the structural fixes), r5b (n=3, all fixes, longer hints), r5c (n=3, final), r5h ("hi"),
  r5e (edit-check capability), r5p/q/r (single after-arm probes while fixing t5).
- Raw data: `data/codeintel/` (`windows-r5.jsonl` answers, `codebench-r5.jsonl` per-run tokens and calls,
  `grades-r5.jsonl`, `summary-r5*.md`, `hi-tokens.md`, `edit-step-times.txt`, `diffs/`). The capture itself
  (requests and bodies, 2k files) stays in `~/.volt-r5/codeintel/run`.
- Grader fixes found while reading answers (each re-applied to every run): t8 counted 4 changed files where 5
  is right (the declaration's file), and missed a signature wrapped one parameter per line; t1 judged the
  mattermost trap by the first "Mattermost" word (often src/'s Mattermost resolver) instead of the file's own
  mention. t5's first ground truth had ten calls: it came from structural search, which then skipped matches
  nested in a match (fixed below); Haiku's answers found the other two.

## What Claude Code sees

Claude Code 2.1.322 gets Volt's MCP tools deferred: only their names are in the prompt, and a tool's schema
arrives when the model loads it with ToolSearch. So `code_nav`'s text costs nothing on "hi"; it costs its
definition (866 tokens after, 586 before) from the request after it is loaded. The model reaches for it
through the IDE guide (code turns) or CODE_QUESTIONS (questions in the chat lane), which name the ops.

## Fixes (in order; each commit has its test)

1. **Tree-sitter structure layer in the code index** (`0d99da7477a`, test `codeStructure.test.ts`): the
   grammars VS Code ships (`@vscode/tree-sitter-wasm`) parse files on demand: declarations with whole ranges,
   imports resolved to project files (relative, `.js` for `.ts`, tsconfig paths, workspace packages, Python, Go,
   Rust, C includes), the reverse import graph, structural search. openclaw at load ~70: importers of
   `src/logger.ts` 1.06 s cold, 22 ms warm; a structural search 1.3 s. `dc175dea699`: loads without
   `node:module` and ships the TSX/JS/Python/Go/Rust/Java grammars (about 4 MB) in release builds.
2. **`code_nav` impact, body, structural, `path#symbol`** (`dc51aada117`, test `codeNavImpact.test.ts`):
   impact is one call where the base build's agent spent 6-12 (t1: find_symbol, instant_grep, Read and seven
   find_files in one run). Its test list comes from the import graph (t1's answers listed the 11 test files).
3. **Diagnostics on files outside editor tabs** (`bc87a18234c`, test `codeIntelHost.test.ts`): models that code
   intelligence opened kept the text they were opened with after Claude Code wrote the file on disk, and the
   TypeScript extension publishes errors only for files open in a tab, so `diagnostics` and the end-of-turn
   check saw nothing after a CLI agent's edit. Models are now compared with disk and tsserver is asked directly.
4. **Errors returned with the edit** (`ec7cc087fd6`, tests `editDiagnostics.test.ts`, `claudeWorkRules.test.ts`):
   `mcp_tool` hooks around Edit/Write/Read call `diagnostics` with a `hook` phase; the edit's PostToolUse
   context lists the errors it added, nothing when there are none. r5e: changing `sanitizeAgentId`'s return
   type to `number` came back with `99:5`, `102:5`, `104:3 Type 'string' is not assignable to type 'number'`
   in the same step (before: "the tool reported no errors"). Cost: median 379 ms per edit (58 ms before).
5. **Hints name the ops** (`b873f7829bf`, `85c272bf42a`, then shortened in `8b2b579b309`; test
   `contextPack.test.ts`): impact, body and structural (with `setTimeout($F, $MS)` as the example) in the IDE
   guide and CODE_QUESTIONS, +64 and +61 tokens on code turns.
6. **Structural search that finishes the job** (`1fc72b7701a`, test `codeStructure.test.ts`,
   `codeNavImpact.test.ts`): asked for literal delays of 1000 ms or more outside tests, Haiku's first structural
   call returned 60 matches including tests with 80-character callback bindings, hit the cap, and it went back
   to eleven rg/awk rounds (r5p: 82 s, 494K tokens). `where` (`{"MS":"^\\d"}`) now keeps only matches whose
   binding fits, `glob` takes `!` excludes (and is in the schema, which allows no other keys), bindings print on
   one line cut at 40 characters. In r5b rep 3 the model used it in a 23-call run that got 12/12.
7. **Nested matches** (`a019ac2a2e2`, `6d66330f774`): `setTimeout($F, $MS)` returned an outer call and never the
   one inside its callback; inner matches are searched too, as ast-grep does (a bare `$X` still reports the
   outermost node; a statement and its expression count once).
8. **instant_grep points to structural** (`e4c3e501202`): one sentence in its deferred description; Haiku had
   tried multi-line regexes instead. Free on "hi", +45 tokens once loaded.

Also changed outside the core files (minimal, noted for the owners): `contextPack.ts` (IDE guide and
CODE_QUESTIONS wording, tokens' file; codeintel owns that wording), `claudeWorkRules.ts` and `acpProvider.ts`
(the edit-check hooks; the hooks are added beside the existing SubagentStart/Stop hooks, not through a helper
inside Volt's Claude Code plugin).

## Not done, and why

- **Timed numbers.** All 48 r5c runs ran at load 14.7-47.4 (median 19.3), r5b at 13.1-31.8 (median 20.8, one run at 14 or less), so wall times are indicative only;
  none is claimed as a gain. When load fell to 6-13 at 18:03, the timing lock was taken by firstword.
- **Haiku often picks grep anyway.** New ops ran in 13 of 48 after-arm runs. On t2 (importers of a file) and
  t6 (implementations) grep or `implementations` already answer in two to four calls, so that is fine. On t5,
  2 of 6 runs used structural (both right); two grep-only runs stopped at 4 of 12 calls. The hints and the
  instant_grep description name structural search; making Haiku choose it more needs either the lead hint
  (`INDEXED_SEARCH`, owned by tokens) to mention it or Opus-class models; not tried.
- **Edit-check latency.** The PostToolUse hook waits for tsserver to re-check the edited file (median 379 ms,
  up to 1.25 s per edit). A non-blocking variant (report a slow check's errors on the next tool's hook) would
  remove most of it; not built. This is a trade the user may want to decide: errors in the same step vs
  ~0.4 s per edit when an edit breaks nothing.
- **t8 tokens up 29% (pooled).** Not caused by tool text: the after arm made one to three more model requests
  per run; in three of six runs the model first called `code_nav` with no `op` to get its schema printed
  (Claude Code returns the schema with the error) instead of loading it with ToolSearch.
- **Related tests by runner** (`vitest related`, `jest --findRelatedTests`): impact's test list comes from the
  import graph only; a runner-backed list was not added.
- One t8 run (r5b rep 3, after) took 179 s: a single model request stalled 123 s at the API
  (`ms` in the capture), not Volt.
