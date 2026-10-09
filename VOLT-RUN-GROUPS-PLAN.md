# Volt run groups: one prompt, several models, separate worktrees

**Date:** 2026-10-05 · **Status:** built and live-tested (results: VOLT-RUN-GROUPS-REPORT.md)
**Research:** T3 Code #12179 (`.aInsp/t3code` commit 0150c6a53), `.aInsp/research/run-groups-references.md`
(T3, Superset, Paseo, synara, zenith, zeron, prime-agent, deepseek-harness, pi, opencode, zed, cline, Roo),
`.aInsp/research/cursor-parallel-agents.md` (Cursor 2.x/3.x parallel agents and `.cursor/worktrees.json`).

## 1. What we are building

Send one prompt to 2–4 models at once (any mix of Claude, Codex, Cursor, OpenCode, DeepSeek, …). Each model works in
its own git worktree on its own branch from the same base. The runs form a **run group**: one sidebar row that opens
into its runs, a compare view with a tab per model, diffs against the base and between runs, and **Pick winner**
(merge, check out, or open a PR) that archives the others and offers to delete their worktrees.

Hard constraints from the brief and from earlier sessions:

- **No second run path.** Every run is an ordinary Volt chat whose turns go through `IAgentOrchestratorService`
  (`submit`, `cancel`, `thread.block`). Queue, steer, approvals, questions and checkpoints are per chat already, so
  each run keeps all of them without new code.
- **Build on the existing worktrees** (`IAgentWorktreeService`, `~/.volt/worktrees/<repo>/volt-<id>`) and the existing
  "pre-bind a worktree, then unblock" seam the orchestrator uses for worktree subagents (`runtime.rememberWorktree`).
- UI rules: Cursor's look for agent things, no `backdrop-filter`, no broad `:has()`, TS-set classes.

## 2. What the references do (summary; details in the research notes)

| | Selection | Worktree / branch | Setup | Grouping | Compare / winner |
|---|---|---|---|---|---|
| **T3 Code #12179** | Shift-click models in the picker; plain click returns to one | One *independent* thread per model, `requireWorktree` (no fallback to the checkout), temp branch renamed later | `t3.json` `scripts[].runOnWorktreeCreate`, async by default, progress rows, cancel | None: N separate threads | None |
| **Cursor 2.x** | Picker "Use Multiple Models" switch, 1x–4x per model, ≤ 8 runs | `~/.cursor/worktrees/<repo>/<id>`, detached HEAD, branch made at PR/commit time | `.cursor/worktrees.json` `setup-worktree[-unix/-windows]`, one shell, `$ROOT_WORKTREE_PATH`, 300 s, failure does not stop the agent | One parent chat, a card per model, "3 models" badge | Click across cards; **Apply** = per-file three-way merge into the checkout, Undo Apply; losers kept until cleanup (cap 25 worktrees) |
| **Cursor 3.x** | Switch only for cloud agents; locally `/best-of-n a,b,c <task>` | a subagent per model runs `git worktree add -b` | same file | Parent agent | Parent "synthesis mode" combines the best parts; no automatic merge, no cost warning |
| **Synara** | API, 1..20 threads | deterministic path/branch per index, ownership proof before delete | — | Siblings nested under the caller | — |
| Others | Superset (one shared worktree), Paseo (committee), OpenCode/Cline/Roo/Zed/zeron (single worktree flows) — `.aInsp/research/run-groups-references.md` | | | | |

What we copy:

- **T3:** shift/⌘-click toggles models, a plain click goes back to one; a required worktree fails the run instead of
  silently running in the checkout; a request that may have started is never re-sent blindly (idempotent ids);
  the composer is released as soon as the runs are handed off; per-run failure toasts with Retry.
- **Cursor:** `.cursor/worktrees.json` is honoured as is (`setup-worktree`, `-unix`, `-windows`, `$ROOT_WORKTREE_PATH`),
  so repos already set up for Cursor work in Volt; tabs per model; "Apply" semantics for the winner.
- **Synara / Paseo / Cline:** delete only what Volt made (managed root + branches the group recorded); merge runs where
  the base is checked out, refuses dirty trees, aborts on conflicts and lists them; the base is recorded on the branch
  (`git config branch.<b>.volt-base`).
- **New in Volt** (no reference has them): a run-group entity, run ↔ run diffs, Pick winner, pre-start cost warning.
- **Volt's own:** status from `threadStatus()`, the orchestrator's `thread.block` to hold a prompt while its worktree is
  prepared, `voltGit.snapshot` + `diffSummary` for stats that include uncommitted edits without touching any index.

## 3. Architecture

```
composer (multi-select picker) ──start()──▶ IAgentRunGroupService ──▶ IAgentOrchestratorService (per run chat)
                                                │                         thread.upsert / thread.block / submit / cancel
                                                ├─▶ IAgentWorktreeService.create(repo, {new: volt/<task>-<model>, from: base})
                                                ├─▶ worktree setup (IVoltStdioService jobs, streamed progress)
                                                ├─▶ IVoltGitService.snapshot/diffSummary (stats, run↔base, run↔run)
                                                ├─▶ runtime.onDidEmit usage → tokens / cost per run
                                                └─▶ store: User/voltRunGroups/groups.json
sidebar row ◀── onDidChange ──┤          compare view (editor) ◀── onDidChange
```

### 3.1 Pure core — `services/voltRuntime/common/runGroups/runGroups.ts` (unit tested)

- Types: `IRunGroup { id, title, prompt, createdAt, repoRoot, projectId?, base { ref, commit }, runs[], winner?, followUp, archived? }`,
  `IRunGroupRun { id (= chat id), modelRef, modelLabel, family, branch, worktreePath?, setup, stats?, discarded? }`.
- `runBranchNames(task, models, taken)` → `volt/<task-slug>-<model-slug>`, unique (`-2`, `-3`), valid per
  `git check-ref-format`, ≤ 60 chars. Two picks of the same model get distinct names.
- `validateRunSelection(models)` → 2..4 distinct models (`RUN_GROUP_MIN = 2`, `RUN_GROUP_MAX = 4`).
- `runGroupStatus(group, statusOf)` → one row status (needs input > working > setting up > failed > done).
- `stopPlan(group, statusOf)` → which chats to cancel, which setups to abort.
- `winnerPlan(group, runId, action)` → ordered steps: commit the winner's pending edits, merge / checkout / PR,
  archive the losers, offer worktree removal (never the winner's while it is checked out).
- `accumulateUsage(stats, usageEvent)` → tokens and cost per run (ACP `usage_update.cost` is cumulative per
  session; prompt results carry per-turn token totals; native runs carry per-request input/output).
- `estimateGroupCost(models, history)` + `limitWarnings(limits)` → the pre-start warning.

### 3.2 Worktree setup — `services/voltRuntime/common/runGroups/worktreeSetup.ts`

- Config: `.volt/worktrees.json`, else `.cursor/worktrees.json`. Keys `setup-worktree`, `setup-worktree-unix`,
  `setup-worktree-windows`; each is a list of commands or a path to a script. Env: `ROOT_WORKTREE_PATH` (Cursor's
  name), `VOLT_ROOT_PATH`, `VOLT_WORKTREE_PATH`.
- Steps run in order in the worktree through `IVoltStdioService.exec` as background jobs; the service polls
  `jobWait` for output so the compare view shows a live tail. Cancel = `cancelExec`. 10 min per step.
- A failure fails **that run only**: its chat stays blocked (`thread.block 'setup-failed'`) with its prompt queued;
  **Retry** reruns the failed step onward and unblocks the chat.

### 3.3 Service — `services/voltRuntime/browser/runGroups/runGroupService.ts` (`IAgentRunGroupService`)

`start()` per run, all runs in parallel:

1. chat id `agent-<uuid>`; `history.pinSessionWorkspace` + project binding (`attachSessionToProject`).
2. `thread.upsert {title, modelRef, modelLabel}` then `thread.block 'worktree'`.
3. `submit(threadId, prompt{modelRef, options, mode, display}, 'auto', turnId)` → queued behind the block.
   The same frozen display (attachments by reference) goes to every run.
4. `worktrees.create(repo, {kind:'new', name: branch, from: baseCommit})` → `runtime.rememberWorktree` +
   `history.setMeta({worktreePath, worktreeBranch, model})`.
5. setup steps → `thread.block undefined` → the orchestrator dispatches the queued prompt (normal turn).

Other operations: `stop(groupId)` (abort setups, `cancel(cascade:'all')` every live run), `retry(runId)`,
`followUp(groupId, target: runId | 'all', prompt)` (plain `submit`s), `refreshStats(groupId)`,
`pickWinner(groupId, runId, action, {removeOthers})`, `discard(runId)`, `archive(groupId)`.

Winner actions (all through stdio git in the repo, serialized with `withRepoQueue`):

- **merge**: commit the winner worktree's pending edits (`git add -A && git commit`), then in the project checkout
  `git merge --no-ff <branch>`; refuses when the checkout is dirty or not on the base branch.
- **checkout**: commit, detach the winner's worktree (`git checkout --detach`), `git checkout <branch>` in the
  project checkout.
- **pr**: commit, then the existing PR flow (`volt.pullRequest.create` for the winner chat; it pushes the branch).
- then: losers archived (`history.setArchived`), their worktrees removed on confirmation (branches deleted only
  when Volt created them: `volt/` + recorded in the group).

### 3.4 UI — `contrib/voltAgent/browser/runGroups/*`

- **Picker:** a "Compare models" toggle in the picker header and ⇧/⌘-click on a row (T3) switch to multi-select:
  rows show checkboxes, a footer says "3 of 4 · Run in separate worktrees". The trigger shows up to three stacked
  brand icons and "3 models". Last set remembered (`volt.agent.runGroup.models`, application scope). Only a new chat
  in a git project can use it (the composer says why otherwise).
- **Send:** `AgentEditor.send` → `runGroupLaunch` (cost / limit warning dialog when needed) → `start()` → opens the
  compare view; the composer is cleared and released at once.
- **Sidebar:** `AgentHomeElement` gains `runGroup`; its children are the run rows (model icon, status, branch),
  built from the group store so runs show while their worktree is still being made.
- **Compare view:** editor pane `AgentRunGroupEditor`: header (title, base, Stop all), tabs `Overview | <model>…`.
  Overview = side-by-side columns: status, time, tokens, cost, files, +/−, last message, setup progress, actions
  (Open chat, Diff vs base, Pick winner). Select two runs → Diff A ↔ B. Per-model tab = the same card large + its
  file list. Follow-up box at the bottom with a target switch: *selected run* / *all runs*.
- **Diffs:** multi-diff source `volt-run-diff:` over two commits (run snapshot vs base, run vs run), blobs read with
  `voltGit.readBlob` (same pattern as the PR diff).

## 4. Tests

- `test/common/runGroups/runGroups.test.ts`: branch names (slugging, collisions, invalid refs, length), selection
  rules, status roll-up, stop plan, winner plan, usage accumulation, cost / limit warnings.
- `test/common/runGroups/worktreeSetup.test.ts`: config parsing (Volt + Cursor forms, platform keys, script paths).
- `test/browser/runGroupService.test.ts`: with fake orchestrator / worktrees / stdio: creating a group makes N
  chats, N worktrees and N branches and queues one prompt each behind a block; setup failure fails one run and
  Retry resumes it; stopping the group cancels every live run and aborts setups; picking a winner runs the
  right git commands, archives the others and removes only Volt's worktrees.
- Orchestrator suites (`orchestrator.test.ts`, `orchestratorChaos.test.ts`) stay green (no decider change).

## 5. Live test and benchmark

- Fresh profile `/tmp/vrg`, CDP port 9777, repo `~/Desktop/Agent-Git-Test`. The test window is announced by name.
- Run 3 models on one task; confirm 3 worktrees + 3 `volt/<task>-<model>` branches (`git worktree list`), that all
  three stream at once (overlapping `run.start`/`run.end` windows), compare, pick a winner, confirm cleanup.
- Same task in Cursor (`cursor-agent` per model in its own worktree, and the Agents Window if reachable) and a
  benchmark of both: time to first token per run, wall time, files / lines changed, tests passing, Volt overhead
  (worktree + setup + dispatch ms).

## 6. Phases

1. Pure core + setup parsing + tests.
2. Service + store + git winner ops + service tests.
3. Picker multi-select, send path, cost warning.
4. Sidebar group row, compare view, run diffs.
5. Live test, Cursor benchmark, report.
