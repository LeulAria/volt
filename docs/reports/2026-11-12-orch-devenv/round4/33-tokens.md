# Round 4: prompt size (tokens)

Status: **final** (2026-11-14). Branch `e4/tokens`, worktree `volt-e4-tokens`. ADEMark Track B method, unofficial
(our laptop, Claude Code 2.1.323, a clean config dir instead of ADEMark's `ademark` macOS user).

## Summary

- A "hi" in a Volt Claude chat now sends **15.6K tokens** (n=3, all 15.6K), down from **23.1K** on the round-3
  merged tree, in one request with no side calls. Claude Code by itself (`claude -p`) sends 18.1K on the same rig,
  so Volt's main chat is now 2.5K **below** the bare CLI. ADEMark's best published "hi" is Paseo's 22.2K.
- The real read-and-explain prompt (B3) fell from **80.2K to 57.3K** (n=3 each). Bare CLI here: 81.4K
  (61.2-81.8K). Paseo on ADEMark's site: 73.2K.
- Cost: B1 $0.0059 to **$0.0045** (Paseo $0.0058). B3 cost did **not** fall: $0.0688 base vs $0.0706 after
  (medians, n=3). B3's cost is mostly output and cache writes; the tokens we removed were cheap cache reads.
- Lever 1: Claude Code's own Agent, Workflow, ScheduleWakeup, ReportFindings and ListAgents (6.5K tokens of
  schema in every request) are **lazy-loaded, not cut**, through Claude Code's own `tool.describe` hooks module,
  plus one rules line naming them and the exact ToolSearch `select:` that loads them.
- Lever 2: the skills list uses 400-character descriptions (Claude Code's default cut is 1,536): 2,640 to 1,608
  tokens per request, every skill still listed by name.
- Capability: each of the five tools was still used on a task that asked for it, 6 of 6 tasks on Opus 5.5 and
  6 of 6 on Haiku 5.5, on both builds. Loading one costs one extra model request (2.6-3.8 s, all timed under load)
  when the model loads it alone, and usually none when it loads it in the same message as other calls.
- Found, not changed: with **Permissions: Full access** shown, Volt's Claude chat still runs Claude Code in
  `auto` permission mode, so every request carries the safeguards classifier context (~800 tokens of B2
  "params"; the bare CLI sends 253, ADEMark's leaders 131), and one B3 run hung 300 s waiting for that classifier.

## Before / after (Opus 5.5, medians, n and range)

Base = `b2db4e7f605` (round 3 merged, `volt-e4-base`, run as is). After = `e4/tokens` at `39d043bbf77`
(both fixes). Bare = `claude -p --effort high` in the same arena copy, same proxy, same config dir. Matrix `r4c`:
base, after, bare interleaved per repetition, Volt chats on Full access with the sandbox off. Load 53-113 during
the matrix: token counts do not depend on it. Data: [`analysis-r4c.md`](data/tokens/analysis-r4c.md),
[`matrix-r4c.log`](data/tokens/matrix-r4c.log).

| Test | Base | After | Bare CLI, this rig | Paseo (ADEMark site) | Bare CLI (ADEMark site) |
|---|---|---|---|---|---|
| B1 "hi": total | 23.1K (23.1-23.1K, n=3) | **15.6K** (15.6-15.6K, n=3) | 18.1K (18.1-18.1K, n=3) | 22.2K (n=3) | 38.2K (n=3) |
| B1: $ | 0.0059 (0.0057-0.0060) | **0.0045** (0.0044-0.0045) | 0.0050 (0.0049-0.0052) | 0.0058 | 0.0963 |
| B3 real prompt: total | 80.2K (80.1-80.6K, n=3) | **57.3K** (57.2-57.4K, n=3) | 81.4K (61.2-81.8K, n=3) | 73.2K (n=1) | 168.3K (n=1) |
| B3: $ | 0.0688 (0.0672-0.0852) | 0.0706 (0.0634-0.1305) | 0.0825 (0.0775-0.0839) | 0.150 | 0.210 |
| B3: main requests | 3 (3-3) | 3 (3-3) | 4 (3-4) | | |
| B3: side calls | 1.3K (Volt's title) | 1.3K (Volt's title) | 0 | | |
| B4 AGENTS.md canary in request / obeyed | yes, 6 of 6 runs | yes, 6 of 6 | yes, 6 of 6 | yes | yes |

Prices: ADEMark's `prices/2026-10.json` on the captured usage. After's B3 $ maximum ($0.1305, rep 1) is a cold
prompt cache: its first request wrote 7.8K tokens to the cache (the build had changed since the last B3 run);
reps 2-3 read it. Bare's 61.2K minimum is a run where Claude Code took 3 requests instead of 4.

Intermediate build (`2005cfb4282`, lazy tools only, matrix `r4b`, [`analysis-r4b.md`](data/tokens/analysis-r4b.md)):
B1 16.7K (16.7-16.7K, n=3), B3 60.1K (59.6-61.3K, n=3; rep 1 invalid, replaced by rep 4, see Method). So the lazy
tools took 6.4K off "hi" and the skills cap another 1.0K.

**Against ADEMark's numbers.** The site's runs used Claude Code 2.1.303, whose own tools were 17.3K tokens; ours
(2.1.323) are 10.2K, so absolute numbers come from two different Claude Code builds. ADEMark's rule off the
reference Mac is to compare gaps to the Bare CLI measured on the same Mac:

| | Volt after / bare CLI, this rig | Paseo / bare CLI, ADEMark site |
|---|---|---|
| B1 | 15.6K / 18.1K = 0.86 | 22.2K / 38.2K = 0.58 |
| B3 | 57.3K / 81.4K = 0.70 (0.70-0.94 over bare's range) | 73.2K / 168.3K = 0.43 |

By that rule Volt is not ahead of Paseo: much of Paseo's gap on the site is Claude Code 2.1.303's larger tool set,
which 2.1.323 has already dropped for everyone. Volt was not run on ADEMark's Mac and Paseo was not run here.

### B2 request anatomy ("hi", first request; ADEMark's split, `b2.mjs`)

One request per arm from matrix r4c (rep 1; every rep sends the same prompt). The after split matched the
earlier pilot within 6 tokens. Files: [`b2-base-r4c-b1.json`](data/tokens/b2-base-r4c-b1.json),
[`b2-after-r4c-b1.json`](data/tokens/b2-after-r4c-b1.json), [`b2-bare-r4c-b1.json`](data/tokens/b2-bare-r4c-b1.json).

| Part | Base | After | Bare CLI, this rig | ADEMark leader | Bare CLI (site) |
|---|---|---|---|---|---|
| system | 2,755 | 2,868 | 2,345 | 1,894 (Paseo) | 2,268 |
| tools | 10,098 | **3,633** | 10,200 | 7,637 (super.engineering) | 17,280 |
| mcp-tools | 1,945 | 1,945 | 0 | 0 | 0 |
| injected | 808 | 808 | 808 | 401 (Cloudroom) | 550 |
| params | 1,142 | 1,046 | 253 | 131 | 131 |

- tools: Bash, Edit, Read, Skill, ToolSearch, Write remain; the five lazy tools left the list.
- system: +113 for the lazy-tools rules line.
- mcp-tools: Volt's three task tools (delegate_task 1,948, message_task 485, wait_tasks 503). Their schemas
  belong to the orch area; not touched here.
- injected: the same 808 on all three arms (Claude Code's own reminders on this build).
- params: the `safeguards` block (Claude's auto-mode classifier context, 1,671-2,475 characters) that the bare
  CLI does not send. See "Not done".

### Where the B3 tokens go, per request

Input-side tokens of each main request (fresh + cache write + cache read), r4c reps 1-3
([`analysis-r4c-b3-rows.md`](data/tokens/analysis-r4c-b3-rows.md)):

| Request | Base | After | Bare CLI |
|---|---|---|---|
| 1 | 24.2K | 16.7K | 18.1K |
| 2 | 25.7K | 18.1K | 19.5K |
| 3 | 26.7K (26.7-26.8K) | 18.9K (18.9-19.1K) | 20.6K (20.3-20.9K) |
| 4 | | | 20.6-20.8K (reps 1, 3) |
| output, whole turn | 2.2-2.5K | 2.1-2.3K | 2.7-2.9K |
| side calls | 1.3K title | 1.3K title | 0 |

The first B3 request is 1.1K larger than "hi" on the after build: Volt's turn lead (962 tokens) and the
`<volt_workspace>` block (156) go with a coding prompt and not with small talk
([`anatomy-r4c-2637.txt`](data/tokens/anatomy-r4c-2637.txt)). Against the bare CLI, every after request carries
+1,945 task-tool schemas, +1,824 in the deferred tool list (the names of Volt's MCP tools), +733 Volt MCP
instructions, +523 system rules, +793 safeguards params and the 1.1K turn lead, and 6.6K less of Claude Code's
tool schemas and 0.9K less of skills list.

## Method

- Rig: `round4/scripts/tokens/` ([README](scripts/tokens/README.md)). A capture proxy (`proxy.mjs`, port 19943)
  sits in `ANTHROPIC_BASE_URL` for every Claude Code process of both test instances and the bare CLI and logs
  every request with its usage. Config dir `cfg-clean`: the login's access token only, no user settings, MCP
  servers, skills or memory. Arena: ADEMark's `arena/` (Ledger, with its AGENTS.md canary), `git init`, one commit.
- Instances: after on CDP 9943 (`/tmp/v4-tokens-ud`), base on CDP 9947 (`/tmp/v4-tokens-ud-base`, run from the
  read-only `volt-e4-base`). `runtok.mjs run` opens a new chat on the arena, turns the sandbox Off (it blocks the
  proxy's loopback port), picks Full access (`TOK_ACCESS=full`), sends the prompt, waits for the end plus ADEMark's
  30 s for side calls. `matrix.sh r4c claude-opus-5-5 high 3` with `B3_N=3`.
- B3 prompt: ADEMark's "Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug
  you find with the line number. Do not change any file."
- B4: the canary line counts as "in request" when the arena's AGENTS.md text is in the request, and "obeyed" when
  the answer ends with `ledger-ok`.
- `analyze.mjs` splits requests into main thread and side calls (titles, predictor, subagents) by the run windows.
  Rows marked invalid are left out: r4b after-B3 rep 1 hung 300 s on Claude Code's auto-mode classifier
  ("unavailable") and was replaced by rep 4; three `r4opus` pilot rows whose bare arm bypassed the proxy (fixed in
  `matrix.sh`).
- Effort: Volt's arms ran at effort `medium`, Volt's default here (`output_config` in the captured bodies); the
  bare CLI ran at `high` as ADEMark sets it. This changes output and thinking only (2-3K of a 57-81K B3 turn),
  and base and after alike.
- Access check (2026-11-14 05:07, after build, one "hi", [`access-check-r4d.json`](data/tokens/access-check-r4d.json)):
  `runtok.mjs` now fails when the Full access pick fails and prints the shown access. The chat showed
  "Permissions: Full access"; the request was the same 15,556 tokens and carried `permission_mode: auto`.

## Fixes

### 1. Lazy-load Claude Code's Agent, Workflow, ScheduleWakeup, ReportFindings and ListAgents (`2005cfb4282`)

Cause: these five built-ins are 8.1K tokens of schema counted one by one (Workflow 2,265, Agent 2,024,
ScheduleWakeup 1,981, ReportFindings 1,107, ListAgents 691) in every request of the main chat. The user decided
they are to be lazy-loaded, not cut.

How Claude Code defers a built-in: Claude Code 2.1.322+ runs plugin "hooks modules" (`hooks/hooks.json`
`{"modules": ["./register.js"]}`) whose `tool.describe` handler can return `isDeferred: true`. Its other switches
(GrowthBook flags) are server-side and not settable. A tool deferred this way leaves `tools[]` and is reachable
through ToolSearch; in `claude -p` it does not appear in the deferred-tools message, so the model would not know
it exists. In ACP sessions it does appear there, and the rules line makes it explicit either way.

Change: Volt writes a three-file plugin (`~/.volt/claude-plugins/volt-lazy-tools-<hash>`, named after its
content) and passes it with the SDK `plugins` option for the main chat only (`claudeWorkRulesMeta`,
`acpProvider.setClaudePluginsRoot`). Rules line: "Load on demand: Agent (subagents), Workflow (multi-agent
scripts, only when asked for one), ScheduleWakeup (resume later), ReportFindings (code-review findings),
ListAgents (running agents). Before the first use, call ToolSearch "select:<exact names, comma-separated>" in the
same message as your other first calls." The folder is readable, never writable, inside Volt's sandbox
(`sandboxPolicy.ts`). Without the plugin (hooks disabled by policy, tool search off) the tools stay loaded as
before. Unit tests in `claudeWorkRules.test.ts` and `sandboxCore.test.ts`; numbers written back into the code
comments in `ce6b2a0f2de`.

Numbers: B1 23.1K to 16.7K (n=3 each, r4b), B3 79.9K to 60.1K (n=3 each, r4b). B2 tools 10,098 to 3,633.

Capability and load cost (`lazycheck.mjs`: one task per tool, Agent twice, explicit and natural wording; Workflow
only on a task that asks for a workflow, kept tiny; both builds; n=1 per task and model;
[`lazycheck-opus-report.jsonl`](data/tokens/lazycheck-opus-report.jsonl),
[`lazycheck-haiku-report.jsonl`](data/tokens/lazycheck-haiku-report.jsonl),
[`analysis-lazycheck.md`](data/tokens/analysis-lazycheck.md)):

| | Opus 5.5 | Haiku 5.5 |
|---|---|---|
| Tool used when the task needs it, base | 6 of 6 | 6 of 6 |
| Tool used when the task needs it, after | 6 of 6 | 6 of 6 |
| After: ToolSearch alone in its message | 4 tasks (Agent x2, ScheduleWakeup, ListAgents) | 3 (Agent x2, ListAgents) |
| Need to available, ToolSearch alone | 3.44 s median (3.14-3.80 s, n=4) | 2.88 s (2.58-3.21 s, n=3) |
| Extra main requests, ToolSearch alone | +1 each (2 to 3) | +1 each (2 to 3) |
| Extra main-thread tokens, ToolSearch alone | +2.7K to +5.8K (n=4) | +3.1K to +9.3K (n=3) |
| After: ToolSearch batched with other calls | 2 (Workflow with Skill, ReportFindings with Bash) | 3 (Workflow, ScheduleWakeup, ReportFindings) |
| Extra requests, batched | 0 (Workflow 4/4, ReportFindings 4/4) | Workflow 0, ScheduleWakeup +1, ReportFindings -1 |

"Need to available" is from the request whose answer calls ToolSearch to the next request, which already has the
schema. All of these timings were taken at load 59-106 on a 14-core machine, above the brief's limit of 14, so
they are not clean medians; most of the time is the model's own round trip, not Volt's. When batched, the load
rides on a step that needed a round trip anyway (the measured 3.4-10.9 s there is that step's Skill, Bash or Read).
Loading keeps the prompt cache: the API appends a loaded tool as a deferred tool instead of changing `tools[]`.
Main-thread token deltas are n=1 per task, and the batched tasks differ from base mostly by how many requests the
model chose, so only the unbatched rows say something about the load's own cost (one more read of a 16-19K
prefix, about $0.004 at Opus cache-read prices).

### 2. Skills listed with 400-character descriptions (`39d043bbf77`)

Cause: Claude Code cuts each skill's listed description at 1,536 characters (`skillListingMaxDescChars`). Four of
its bundled skills ran past 400: dataviz 1,447, code-review 1,242, claude-api ~1,170, update-config 707. The list
was 7.07K characters, 2,640 tokens per request.

Change: `skillListingMaxDescChars: 400` in the main chat's session settings (`CLAUDE_MAIN_SESSION_SETTINGS`). No
skill is hidden; each is listed by name and callable.

Numbers: skills list 2,640 to 1,608 tokens (B2 anatomy); B1 16.7K to 15.6K; B3 60.1K (r4b) to 57.3K (r4c).

Check (`skillcap.mjs`, `claude -p` on Haiku 5.5, one task per skill, through a separate proxy;
[`skillcap-run1.jsonl`](data/tokens/skillcap-run1.jsonl) 2 reps, [`skillcap-run2.jsonl`](data/tokens/skillcap-run2.jsonl) 3 reps):

| Skill loaded on its task | Default (1,536) | 400 | 250 |
|---|---|---|---|
| dataviz | 4 of 5 | 5 of 5 | 2 of 2 |
| claude-api | 5 of 5 | 5 of 5 | **0 of 2** |
| update-config | 5 of 5 | 5 of 5 | 2 of 2 |
| code-review | 0 of 5 | 0 of 5 | 1 of 2 |
| loop | 0 of 2 | 0 of 2 | 0 of 2 |

250 lost claude-api, so 400 was kept. code-review and loop were not picked on their tasks at any cap, including
the default, so this check says nothing about them either way (their names and first 400 characters stay listed).

## Not done, and why

- **Full access still runs Claude Code in auto mode.** The UI shows "Permissions: Full access", but every request
  has `permission_mode: auto` and the safeguards classifier context (~800 tokens of params over the bare CLI, and
  one B3 run hung 300 s when the classifier was unavailable). `ClaudeAccessBridge` maps only "shell allow and
  edit allow" to `bypassPermissions`. Whether Full access should drop Claude's classifier is a safety decision,
  not a token fix; left for the user.
- **Effort**: Volt's arms ran at Volt's default `medium`, ADEMark sets `high`. An official-method run needs the
  chat's effort set to high.
- **Volt's per-request share** (B3, after build): deferred tool list 1,992 tokens (bare 168), turn lead 962,
  MCP instructions 733. Not cut this round: the turn lead and MCP instructions were already halved in round 3,
  and a cut needs a capability check per tool family (`capcheck.mjs`), which did not fit after the final matrix.
- **mcp-tools 1,945**: the three task tools' schemas belong to the orch area.
- **B3 cost**: no gain measured ($0.0688 vs $0.0706, n=3, overlapping ranges); output and cache writes dominate.
- Not run on ADEMark's Mac or as their `ademark` user; Paseo not run on this machine.

## Commits

| Commit | What |
|---|---|
| `2005cfb4282` | perf(acp): Claude main chat loads Agent, Workflow, ScheduleWakeup, ReportFindings and ListAgents on demand |
| `39d043bbf77` | perf(acp): Claude main chat lists skills with 400-character descriptions |
| `516bcfe7a79` | docs(reports): round 4 token rig (lazycheck, skillcap, b2, prefixdiff) and lazy-tool check data |
| `ce6b2a0f2de` | docs(acp): measured numbers for the lazy tools and the skill listing cut |
| `a78be949280` | docs(reports): round 4 token data (r4b/r4c matrices, B2 counts, anatomies, lazy-tool and skill-cap checks) |

Typecheck (`compile-check-ts-native`) clean; `claudeWorkRules.test.ts` and `sandboxCore.test.ts` pass (45 tests).

## Data

`data/tokens/`: `windows.jsonl` (every run window), `analysis-r4b.md`, `analysis-r4c.md`, `analysis-r4c-b3-rows.md`,
`analysis-lazycheck.md`, `b2-*-r4c-b1.json`, `anatomy-r4c-*.txt` (finer split: 2123 base hi, 2167 after hi, 2195
bare hi, 2637 after B3 request 1), `lazycheck-*`, `skillcap-run*.jsonl`, `matrix-r4b.log`, `matrix-r4c.log`,
`access-check-r4d.json`, `capture.jsonl.gz` (every request's metadata and usage; bodies are not committed, they
carry the account's e-mail).
