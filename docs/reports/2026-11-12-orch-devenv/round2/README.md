# Round 2 (2026-11-12/13): beat the other harnesses, finish round 1's open items

Round 1 (the reports one folder up) merged main and the open PRs and measured orchestration, the
sandbox, code intelligence and IDE tooling. Round 2 took its "Still open" list, added a serious
benchmark against Hermes Agent, Claude Code, Cursor and T3 Code, and swept the agent window's UI.
Five agents worked in parallel, each in its own worktree and branch off `81563ca39e4`; all five
branches are merged into `feat/orch-and-devenv-revamp`.

Every number is measured, with N, median and range in the report it comes from. Five agents shared
one machine, so the 1-minute load average is recorded with each run (it ranged from about 8 to
244); arms were interleaved so load drift hit both sides.

## Reports

| # | Report | Area | Branch |
|---|---|---|---|
| 10 | [10-harness-benchmark.md](10-harness-benchmark.md) | Volt vs Hermes Agent, Claude Code, Cursor CLI and T3 Code on four tasks | `e2e2/cmp` |
| 11 | [11-orchestrator.md](11-orchestrator.md) | Subagent size, spin-up, councils, teams, a 6-step job, titles | `e2e2/orch` |
| 12 | [12-ide-and-code-intel.md](12-ide-and-code-intel.md) | Code questions on the hotel app with and without Volt's tools; debug, tests, HTTP, DB, Docker, profiler, notebook, rename, Scratch, canvas | `e2e2/ide` |
| 13 | [13-sandbox.md](13-sandbox.md) | Sandboxed git, attack matrix, adversarial suite, live install/Stop/Security page checks, Agent Lab | `e2e2/sbx` |
| 14 | [14-ui.md](14-ui.md) | Round 1's five UI defects and a pixel sweep of the orchestration UI (dark/light, 100 %/120 %) | `e2e2/ui` |

Raw data is in `data/<area>/`, the scripts that produced it in `scripts/<area>/`, screenshots in
`img/<area>/` (sandbox: `data/sbx/shots/`).

## Headline numbers

### Against the other harnesses (report 10)

Same model (Haiku 5.5) in every arm, N = 3 per arm and task, median; **Volt final** is the merged
branch. Cost at Haiku list for every arm.

| Task | Claude Code | T3 Code | Hermes Agent | Volt before | **Volt final** |
|---|---|---|---|---|---|
| t0 "Reply OK" | 7.3 s | 5.8 s | 5.2 s | 2.9 s | **2.4 s** |
| t1 3 research subagents + synthesis | 29.6 s, $0.020 | 38.6 s, $0.023 | 35.7 s, $0.007 | 63.4 s, $0.020 | **35.9 s, $0.017** |
| t2 3 parallel bug fixes, tests | 33.8 s, $0.019 | 32.5 s, $0.019 | 37.7 s, $0.009 | 41.7 s, $0.020 | **31.8 s, $0.020** |
| t3 writer + reviewer | 48.4 s, $0.018 | 68.2 s, $0.016 | 135.3 s, $0.014 | 79.0 s, $0.019 | **49.0 s, $0.017** |
| Volt's own overhead per run (t1-t3) | | | | 15.6 s | **1.2-1.6 s** |

Every Volt run was correct. Volt went from the slowest Claude-backed harness to fastest on t0 and
t2 and level with Claude Code on t3; Hermes stays the cheapest (its prompts are about half of
Volt's). On Cursor's own models Volt answers better than the Cursor CLI but is slower (its agent
cannot be warmed ahead; report 10).


| Area | Before | After | Where |
|---|---|---|---|
| Subagent's first request (research/review subagents) | 28.3k tokens | 9.3k tokens (−67%); Claude Code's own Explore subagent: 14.8k here | 11 |
| B1: 4 Haiku 5.5 subagents, end to end (N=3 per arm) | 46.2 s (41.9–48.5) | 36.5 s (34.7–44.2), 1.26× | 11 |
| B1 cost per run | $0.650 | $0.460 (−29%; subagents −45%) | 11 |
| Wait before a subagent's prompt is sent | 1.55 s | 0.13 s | 11 |
| Sandbox denial rows per run under Full access | 12 (9–24) | 0 | 11 |
| 6-step job with dependencies + model fallback / team / council (N=3 each) | — | right 3/3, 114 s / right 3/3, 49 s / verdict 3/3, 136 s | 11 |
| Chat titles taken from the agent's own words | 1 of 3 | 0 of 19 | 11 |
| Code questions on the hotel app, Volt vs plain Claude Code, median per answer (9 questions × 3) | 1.87× slower (59.9 vs 32.0 s) | even (40.9 vs 40.9 s) | 12 |
| Same, cost relative to Claude Code / approval cards | 1.27× / 65 | 1.15× / 0 | 12 |
| Same, blind-graded correctness out of 27 (Volt / Claude Code) | 25.5 / 26.5 | 24.5 / 27 | 12 |
| IDE tools on 10 natural requests × 3: right tool picked / tool did the job | 9/30 / 4/30 | 24/30 / 21/30 | 12 |
| Sandboxed `git --version`, load 8 (N=7 each) | 2,349 ms (2,263–4,269) | 185 ms (157–249), 12.7× | 13 |
| Same, load 41–93 (N=5 each) | 32,288 ms | 2,199 ms, 14.7× | 13 |
| Attack matrix, network-on agent chats: POST to an unallowed host, connect to a local listener | got through 3/3 | blocked and reported 3/3 | 13 |
| Adversarial sandbox suite | 40 passing | 46 passing, 2 Linux-only pending, 0 failing | 13 |
| Agent Lab's mock malware in the sandbox | — | 15 attempts, 0 requests at the exfil server, canary never read | 13 |
| Agents chip appears after the first subagent starts | 25.4 s (N=1) | 0.69 s (0.47–1.09, N=5) | 14 |
| Finished subagent row's outcome line contrast (light / dark) | 2.28:1 / 3.08:1 | 4.65:1 / 6.39:1 | 14 |

### Was the 10× / 100× / 10,000× target reached?

Not end to end, and the reports show why with numbers rather than picking a flattering metric:

- **The model is most of the time.** In B1, about 29 of the 36.5 s is model time (11). In the code
  questions about half of every run is the model thinking and most of the rest is the language
  server's call-hierarchy answers, 10–45 s each under load (12). No change in Volt can make the
  model's own time 10× shorter.
- **Where Volt controls the cost, the gains are large:** subagent context −67%, prompt dispatch 12×
  faster (1.55 → 0.13 s), sandboxed git 13–15× faster, agents chip 37× sooner, IDE tool success
  5× (4 → 21 of 30), approval cards 65 → 0, denial rows 12 → 0.
- **Against the other harnesses** Volt's own overhead fell about 10-13x (15.6 → 1.2-1.6 s), which
  moved it from last to the front on wall time; it does not beat the others by 10x end to end
  because the model is 95-99% of every run. The gap left is tokens: Volt's parent prompt is
  44-47k against Hermes' 20k (10).

## Merge notes

The five branches overlapped in a few places; each was resolved by keeping both fixes, and checked:

- `agentTurnHost.ts` (orch + cmp): both stopped read-only turns waiting for the before-snapshot,
  orch for research/review subagents, cmp for any mode that cannot write; kept orch's flag through
  `turnWritesGated` and set it for either case (`76244e26f64`).
- `voltRuntimeService.ts` (orch + cmp): cmp's subagent warm-up predates orch's two lean subagent
  profiles; spares now start as `readonly` in an Ask or Plan chat and `work` elsewhere.
- The merged tree exposed one regression that neither branch had alone: the IDE branch's `tests`
  tool, preferred by agents in a sandboxed chat, waited 60 s on a sandbox ask for a project with
  nothing to run (t2: 94 s). Fixed in `ae5cfb05919` (t2: 31.8 s).

- `sandboxPolicy.ts` (sbx + orch): the sandbox branch's agent package-registry host rules and the
  orchestrator branch's start-up housekeeping (path-walk folders, shell rc files) are independent
  additions; both kept.
- `acpProvider.ts` (orch + ide): both branches fixed Volt's code tools being stopped by the agent's
  own permission prompt. Combined first, which let `code_action` (it writes files) skip the prompt
  too and failed an IDE test. Kept the IDE branch's rule, by sandbox class: the read tools
  (`find_symbol`, `instant_grep`, `find_files`, `code_nav`, `diagnostics`) skip the prompt,
  `code_action` still asks (`9e78fd6335c`).
- `voltHostMcpMainService.test.ts` (orch + ide): both assertions kept.
- `agentEditor.ts`, `agentLineageDock.ts` (orch + ui): both branches fixed the agents chip and side
  list lagging the subagents. One `syncAgentViews` now drives the bar, the card and the chip; the
  UI branch's deduped re-render replaces the orchestrator branch's unconditional one; the side list
  refreshes on a task whose root or parent is in this chat's tree.

## Verification (merged tree)

On `feat/orch-and-devenv-revamp` at `a4c868a2a77` (all five branches merged, plus the fixes the
merged-tree benchmark found: `ae5cfb05919`, `41a7d176e32`, `d5fb672528c`):

- Type check (`tsgo --project src/tsconfig.json`): 0 errors.
- Full unit suite (`scripts/test.sh`): **15,996 passing, 0 failing**, 213 pending (7 min).
- Volt's CI lints, all passing: listener lint, spawn audit, authority gate, manifest ceiling,
  feature-import fence, command visibility, git-spawn lint, the ESLint diff against `origin/main`,
  layers check, class-fields check.
- Live: the merged tree ran the harness benchmark's 12 Claude runs plus 3 after the `tests` fix,
  every answer correct (report 10).

## Still open

Each report's "Bugs found and not fixed" and "Open issues" has the detail; the ones that need a
decision or the most work:

- **Volt's parent prompt** is the largest of the five harnesses (44-47k per request; Claude Code
  28-30k, Hermes 20-22k): the biggest token cost left (10).
- **Warm spares miss two cases**: research subagents in an Agent chat (the profile is picked before
  the roles are known; 1.3-1.4 s each) and every subagent on Cursor (its agent names Volt's MCP calls
  only once they run) (10).
- **A stuck subagent restarts from the top** after its process dies, redoing its edits after the
  parent has moved on; and a settings change took over 20 s to reach the agent server (10).
- **Council seating on a fresh session** seats providers that cannot run (1 of 4 seats answered,
  twice). Recommended: remember provider health and quota reset times across sessions, and replace
  a seat that fails to start (11).
- **Cold agent start** is Volt's largest remaining cost: 7–12 s for three parallel Claude starts vs
  2.9–3.6 s bare (sandbox launch, `session/new` with Volt's MCP server) (11).
- **Review subagents cannot run tests**: their mode refuses shell commands while Volt's prompt asks
  them to; needs a read-only mode that allows non-mutating commands (11).
- **Other agents' start-up denials** (Grok, Cursor, Codex) still show as rows: 22 per council with
  a Grok seat; `AGENT_HOUSEKEEPING` covers Claude Code only (11, 13).
- **Notebooks have no kernel in the agent window** (0/3), and `code_nav callers` / complex
  `instant_grep` are 10–61 s under load (12). The A/B was not re-run on the final code (12).
- **Test windows write the user's real `~/.volt/trust/grants.json`**; this round's test grants were
  removed from it by hand (13).
- **Extensions are not told when Volt refuses their tool registration**; no "Start again" after
  Stop; Linux and a live Antigravity turn untested (13).
- **Muted text is below 4.5:1 window-wide** (the shared 36 % muted token: 3.08 dark / 2.25 light):
  a design decision, left as is (14). Council and team views were not swept (14).
