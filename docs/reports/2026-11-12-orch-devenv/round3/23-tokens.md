# Round 3: prompt size (tokens)

Status: **final** (2026-11-13). Branch `e3/tokens`, worktree `volt-e3-tokens`. ADEMark Track B method, unofficial
(our laptop, our Claude Code build, not ADEMark's `ademark` user on their Mac mini).

## Summary

- A "hi" in a Volt Claude chat now sends **21.1K tokens** in one model request and no side calls, down from
  **31.1K** (27.8K main request + 3.2K of title calls) on the same rig. ADEMark's best published "hi" is Paseo's
  22.2K. Claude Code by itself sends 18.1K here, so Volt now adds 3.0K on top of it (was 13.0K).
- The real read-and-explain prompt (B3) fell from **127.7K to 74.0K** tokens. Most of that is a 32K side call
  Claude Code made after every turn (its next-prompt suggestion, which Volt never showed); the rest is the
  smaller prompt carried by each of the turn's three requests.
- The first request of round 2's four orchestration tasks fell by about 6.2K each (Haiku 5.5): t0 28.0K to 21.8K,
  t1 31.9K to 25.7K, t2 32.0K to 25.8K, t3 29.1K to 22.8K.
- Main lever: the six Volt tools that were always loaded (5.8K of schema) and Claude Code's AskUserQuestion
  (1.8K) now load through tool search when a turn needs them; Volt's MCP instructions are half as long; small
  talk gets no turn lead; Claude Code's own title and suggestion calls are off.
- Capability check: every Volt tool family was reached and used on the final build when a task needed it.
  The check caught one loss on the way (with AskUserQuestion gone, Haiku wrote its questions as text instead of
  loading ask_question, 0 of 3); one rules line fixed it (3 of 3 through the question tray, commit `e71cbe3a62b`).
- Not measured: another provider. Codex is over its usage limit until 2026-11-26 and Grok answered "Rate
  limited" (see "Not done").

## Before / after (Opus 5.5, `cfg-clean` config, medians)

Base = `82ae771c1d9` (the round-2 tree). After = `e71cbe3a62b`. Bare = `claude -p` (Claude Code 2.1.323) in the
same arena copy through the same proxy. Runs interleaved base, after, bare. Data: `data/tokens/analysis-opus4.md`.

| Test | Base | After | Bare CLI, this rig | Paseo (ADEMark) | Bare CLI (ADEMark) |
|---|---|---|---|---|---|
| B1 "hi": total sent | 31.1K (30.8-32.4K, n=3) | **21.1K** (21.1-21.1K, n=3) | 18.1K (18.1-40.5K, n=3) | 22.1K | 37.8K |
| B1: main request | 27.8K | 21.1K | 18.1K | 22.1K | 37.8K |
| B1: side calls | 3.2K (Claude Code title, Volt title) | 0 | 0 | 0 | 0 |
| B3 real prompt: total | 127.7K (126.0-130.8K, n=3) | **74.0K** (73.9-105.3K*, n=3) | 61.0K (60.7-105.0K, n=3) | 73.2K | 123.1K |
| B3: main requests | 90.8K | 72.6K | 61.0K | 73.2K | 77.8K |
| B3: side calls | 36.4K (suggestion 32K, titles) | 1.3K (Volt's title) | 0 | 0 | 45.3K |
| B4 AGENTS.md canary | yes (all runs) | yes (all runs) | yes | | |

\* After B3 rep 1's 105.3K includes a 32.7K suggestion call from the base build's B3 rep 1, which had not
ended when its 5-minute window closed (load 376) and is marked invalid; the call carries the base build's 19
tools, the after build sends 12. Without it the run is 72.6K. Bare's 40.5K and 105.0K maxima are Claude
Code's own variance (a forked subagent call; a 5-request B3 run).

ADEMark's columns are their published medians (`data/v1/summary.json`, run `control-2026-11-10`, Claude Code
2.1.303). Their Bare CLI sends 37.8K for "hi" where ours sends 18.1K (their CLI's tools were 17.3K, ours
10.7K), so the Claude Code builds differ and 21.1K vs Paseo's 22.1K is two rigs side by side, not a race on one.
The same-rig comparison is Volt vs the Bare CLI here: +3.0K. Paseo was not measured on this machine.

Round 2 quoted Volt's parent prompt as 44-47K. That was the median over every request of a t1-t3 run (later
requests carry the conversation) on round 2's config dir, so it is a different measure; on this rig the round-2
base sends 28.0-32.0K in the first request of the same tasks (table below). A user's own config (claude.ai
connectors, skills, memory) adds its own share to both builds alike.

### First request of round 2's tasks (Haiku 5.5, n=3 each, `data/tokens/analysis-r2first.md`)

Measured on `50596034d8d` (the rules line of `e71cbe3a62b` adds about 70 tokens).

| Task | Base | After | Tools sent base / after |
|---|---|---|---|
| t0 Reply OK | 28.0K (28.0-28.0K) | 21.8K (21.8-21.8K) | 19 / 12 |
| t1 3 research subagents | 31.9K (31.9-31.9K) | 25.7K (25.7-25.8K) | 19 / 12 |
| t2 3 parallel fixes | 32.0K (31.8-32.0K) | 25.8K (25.8-25.8K) | 19 / 12 |
| t3 writer + reviewer | 29.1K (29.0-29.1K) | 22.8K (22.8-22.9K) | 19 / 12 |

### Where the "hi" request's tokens go (B2 anatomy, `count_tokens` per part)

| Part | Base | After | Bare |
|---|---|---|---|
| System prompt (Claude Code + Volt's rules) | 2,718 | 2,748 | 2,338 |
| Built-in tool schemas | 12,144 (incl. AskUserQuestion 1,834) | 10,596 | 10,698 |
| Volt MCP tool schemas | 4,050 (code_nav, debug, find_symbol, ide, instant_grep, tests) | 0 | 0 |
| Injected text | 8,790 | 7,647 | 4,919 |
| of which: Volt MCP instructions | 1,342 | 697 | 0 |
| of which: Volt turn lead | 569 | 0 | 0 |
| of which: deferred tool list | 1,930 | 1,998 | 168 |
| of which: skills list / agent types | 2,640 / 1,163 | 2,640 / 1,163 | 2,475 / 1,163 |

(Part counts are each counted alone, so they are approximate; the measured totals are in the first table.
Files: `data/tokens/anatomy-base-opus4-b1.txt`, `anatomy-after-opus4-b1.txt`, `anatomy-bare-opus2-b1.txt`.)
The 4,050 shown for the base's MCP tools is the API's count for the six schemas together; counted one by one
they come to 5.8K.

## Method

Rig in `scripts/tokens/` (README there). A local proxy (`proxy.mjs`) records every Anthropic request with its
usage and body. Two dev test instances with their own profiles: after (`/tmp/v3-tokens-ud`, CDP 9954, this
worktree) and base (`/tmp/v3-tokens-ud-base`, CDP 9964, `volt-e3-tokens-base` at `82ae771c1d9`), both on a
throwaway Claude config dir with only the login's token and no claude.ai connectors, skill or plugin sync
(like ADEMark's fresh `ademark` user). `runtok.mjs` opens a new chat in the ADEMark arena copy, sends the prompt
and records the run window; `analyze.mjs` splits each window's requests into the main thread and side calls and
prices them from ADEMark's `prices/2026-10.json`. `matrix.sh` interleaves base, after and bare per repetition.
Token counts do not depend on machine speed, so the load gate (1-minute load at most 14) was not applied; the
load is recorded with every run in `windows.jsonl`. Load ran from 18 to 480 during these runs; it only made two
runs invalid (no answer within the window), which are marked `invalid` in `windows.jsonl` and left out.

## What was cut (one commit each)

| Commit | Change | Effect measured |
|---|---|---|
| `fba23fe5ff3` | Claude sessions get a fixed title and `promptSuggestions: false` | B1: -1.7 to -3.5K (Claude Code's title call); B3: -32K (its next-prompt suggestion after each turn) |
| `9214b59b02f` | no Volt title call for a first message that names nothing ("hi") | B1: -1.3K side |
| `9780a6febbe`, `a5c3e2fdfc6` | small talk gets no turn lead and no `<volt_workspace>` summary | -569 tokens |
| `05d1ebeb170` | no composer prediction call for drafts under six characters | -2.7 to -2.9K side when the draft is "hi" |
| `daa52704c5b`, `899b645f978` | every Volt tool behind tool search (instant_grep, debug, ide, then find_symbol, code_nav, tests); the turn's lead says how to load the ones it needs | -5.8K schema (part counts) |
| `9623cf6e6b6` | Volt's MCP instructions as a short index of jobs and tools | 1,342 to 697 tokens |
| `3b0b15bc44a` | the same five Volt rules in fewer words | shorter system prompt; not measured on its own (landed with `9623cf6e6b6`) |
| `50596034d8d` | main Claude chats ask through Volt's ask_question; AskUserQuestion off when the session has it | -1.8K |
| `e71cbe3a62b` | fix: one rules line naming ask_question and how to load it | +~70; restores asking (below) |

Intermediate totals for "hi" (after build, n=3 each): 23.0K after the first cuts (`analysis-opus-r1.md`), 22.6K
with the shorter instructions (`analysis-opus2.md`), 21.0K with AskUserQuestion off (`analysis-opus3.md`), 21.1K
final (`analysis-opus4.md`). The base stayed at 30.8-31.1K throughout.

## Capability check

`capcheck.mjs`: one Haiku 5.5 request per Volt tool family in a fixture repo (`capfx`, with `shop.db`), on both
builds; "used" means the family's tool appears in the chat's trace (or the question tray showed). Full table:
`data/tokens/capcheck-report-all.md`.

| Family | Prompt (short) | Base | After |
|---|---|---|---|
| code | which functions call parseDay | yes (find_symbol, code_nav) | yes (ToolSearch, code_nav, find_symbol) |
| tests | run the invoice tests | yes (tests, then npm test) | yes (ToolSearch, tests, then npm test) |
| debug | stop at paginate's return line | yes (debug) | yes (ToolSearch, debug) |
| db | top sku by revenue in shop.db | yes (ide) | first run no (sqlite3 in Terminal, right answer); final build 2 of 2 yes (ToolSearch, ide) |
| chart | chart lines per file | yes (render_chart) | yes (render_chart) |
| scratch | sketch the request flow | yes (scratch_draw) | yes (scratch_draw) |
| browser | heading of example.com | yes (browser_navigate) | yes (browser_navigate, browser_evaluate) |
| threads | list my other chats | yes (thread_list) | yes (thread_list) |
| ask | "ask me how it should look" | no (text) | `50596034d8d`: no (text); final: yes (ask_question, tray) |
| ask-mc | "give me multiple-choice questions" | 3 of 3 (AskUserQuestion, tray) | `50596034d8d`: 0 of 2 (text); final: **3 of 3** (ask_question, tray) |

Debug: on both builds the breakpoint never bound (the fixture's tests do not call `paginate`); the tool was
reached and called the same way. The first db miss on the after build was one run with the right answer by
another route; the two reruns on the final build used `ide` (commits between those runs do not touch db).

### The ask_question fix (`e71cbe3a62b`)

Cause: with AskUserQuestion off, Claude Code's prompt no longer mentions any question tool, and the Volt index
line "ask_question: multiple-choice questions to the user" did not get Haiku to load a deferred tool. Change:
when the session has Volt's ask_question, Volt's appended rules gain one line naming it and the exact
ToolSearch call. Result: 3 of 3 "ask-mc" runs and the plain "ask" run went through the question tray. Unit test
in `claudeWorkRules.test.ts`.

## Not done, and why

- **Another provider.** The brief asks for Claude and one more. Codex in this account is over its usage limit
  until 2026-11-26 (Volt's trace: "You've hit your usage limit"), and `gpt-6-astra` is not a listed model here
  (those three runs fell back to Opus 5.5 and are marked invalid). Grok 4.7 answered "Rate limited" on every
  try. The proxy does not see those providers anyway; `traceused.mjs` reads their ACP `used` count when they
  answer. The MCP instruction and small-talk cuts apply to every provider; their effect there is unmeasured.
- **Further cuts in Claude Code's own prompt.** What is left above the Bare CLI is Volt's MCP instructions (0.7K),
  the deferred list of Volt's tool names (1.8K more than bare) and the appended rules (0.4K). Below the bare
  line, Claude Code's own tools Workflow (2.3K), ScheduleWakeup (2.0K), Agent (2.0K), ReportFindings (1.1K) and
  ListAgents (0.7K), and the skills list (2.6K), could be turned off or shortened for the main chat as was done
  for subagents (`CLAUDE_SUBAGENT_DISALLOWED_TOOLS`), which would bring "hi" near 13-15K. These are user-facing
  Claude Code features, so that is the user's call, not done here.
- **AGENTS.md canary on other providers, Paseo on this rig**: not run (Paseo's numbers are the ade area's job).
- **Not official ADEMark numbers**: an official run needs the `ademark` macOS user, which only the user can create.
