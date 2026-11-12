# 11 · Orchestrator, round 2: subagent size, spin-up, councils, titles

Branch `e2e2/orch` (base `81563ca39e4`), 2026-11-12. Round 1 is in [`../01-orchestrator.md`](../01-orchestrator.md),
[`../06-agent-to-agent.md`](../06-agent-to-agent.md) and [`../parallel/01-orchestrator.md`](../parallel/01-orchestrator.md).

## Summary

<!-- SUMMARY -->

## Setup

| | |
|---|---|
| Build | this worktree, dev build (`scripts/code.sh`), profile `/tmp/v2-orch-ud`, CDP 9942, `scripts/orch/launch.sh` |
| Claude Code | Volt runs `@agentclientprotocol/claude-agent-acp` 0.81.2, whose SDK (0.3.280) bundles Claude Code **2.1.280**. The user's own CLI (native subagent baseline, title calls) is **2.1.322**. |
| Models | parent and subagents Claude **Haiku 5.5** (`claude-haiku-5-5`) through claude-code; council adds Grok 4.7 and Claude Haiku 4.5; the challenge's failing task starts on fx (`fx:openai/gpt-5.4-nano`) |
| Access / sandbox | Full access (no approvals), sandbox at the user's default (Supervised: workspace-write, network on), as in round 1 |
| Fixture | `/tmp/voltbench/fx` (4-file TypeScript shop with the planted discount bug); challenge copies in `fx/runs/<tag>` |
| A/B | `scripts/orch/arm.sh base|new` swaps the 16 non-test source files this branch changes between `81563ca39e4` and HEAD in the same window (out/ rebuilt, agent server restarts, window reloads). `ab.sh` alternates base, new, base, new… so load drift hits both arms. |
| Load | the machine ran four other agents' suites and instances: 1-minute load **28-130** during these runs; every row carries its load |

Measurement sources:

- **Prompt per request, by part**: `scripts/orch/capproxy.mjs` (a logging proxy; Claude Code pointed at it with
  `ANTHROPIC_BASE_URL`) and `breakdown.mjs` (splits a request into system prompt, each tool schema, Claude Code's
  session context: skill listing, deferred tool names, MCP instructions per server, and the messages; part sizes are
  characters scaled to the billed prompt). Behind a proxy Claude Code 2.1.280 turns Tool Search off unless
  `ENABLE_TOOL_SEARCH=true`, and Volt's sandbox passes only listed env keys to the agent, so captures ran with the
  sandbox off (subagent prompts are otherwise the same; the trace numbers below are sandboxed and agree).
- **Timing, cost, wake-ups, failures, denials**: `scripts/orch/b1run.mjs` drives one run over CDP and
  `orchmetrics.mjs` reads Volt's own traces (`User/voltTraces`) and the saved tree (`User/voltOrchestrator/roots`).
  Prompt per subagent = the `used` of its first `usage` event (its first request's context).
- **CLI probes**: `scripts/orch/cliprobe.sh` runs the bundled CLI headless through the proxy, one setting at a time.

The round-2 agent's session ended part way ("Sign in to continue"). Its last four B1 rows were
Claude refusing every turn ("Your organization has disabled Claude subscription access for Claude
Code", no turn ran); they are kept apart in `data/orch/b1ab-aborted.jsonl` with two earlier rows
cut short by a window reload. The restart re-ran the missing pairs; Claude worked again by then.

## Results

### 1. A subagent's first request (item 1)

The first request a Volt research subagent sends, by part (B1 "pricing bug", Haiku 5.5, captured
through `capproxy.mjs`; tokens are characters scaled to the billed prompt):

| Part | Before (`81563ca39e4`) | After (this branch, `readonly` profile) | Claude Code's own Explore subagent (CLI 2.1.322) |
|---|---|---|---|
| System prompt | 5,512 | 704 (Volt's own read-only prompt) | 1,362 |
| Built-in tool schemas | 13,481 (11 tools: Bash 4.2k, Workflow 1.9k, ScheduleWakeup 1.7k, AskUserQuestion 1.4k, Read, ReportFindings, Skill, Edit, ToolSearch, ListAgents, Write) | 4,095 (Bash, Read, Skill, ToolSearch) | 3,187 (Bash, Read, Skill, ToolSearch) |
| Deferred stubs / loaded MCP tools | 792 | 74 | 736 (claude.ai Docs connectors) |
| Session context: skill listing | 2,848 | 2,335 | **8,664** |
| Session context: deferred tool names | 1,486 (138 Volt tools + claude.ai) | 348 (26 Volt tools) | 180 |
| Session context: MCP instructions | 1,419 (volt 741, claude.ai Docs 678) | 346 (volt, tasks/core groups only) | 0 |
| Session context: other | 290 | 96 | 373 |
| First user message (Volt framing + brief) | 2,105 | 1,221 | 259 |
| **Billed prompt** | **27,990** | **9,218 (-67%)** | **14,762** |

- **Item 1 target met for read-only subagents**: 28.0k to 9.2k tokens, below Claude Code's own
  Explore subagent on this machine (14.8k). The comparison is honest only with a caveat: most of
  Explore's size is the user's skill listing (8.7k; CLI 2.1.322 lists every skill in full). With
  Volt's 160-character cap on skill descriptions Explore would be about 8.4k, so Volt is level with
  it, not far ahead. What Volt still carries that Explore does not: a longer Bash description
  (sandbox notes, +0.6k) and the brief's framing (+0.8k).
- Live, over every research subagent of the B1 runs (Volt's own `usage` events, sandbox on), the
  first request is in the table below (B1, section 2).
- A subagent that changes files (`work` profile: implementation, test) keeps Claude Code's prompt,
  file tools and 72 of 138 Volt tools. Its first request is measured in the challenge runs (section 5).
- CLI probes (`data/orch/cliprobes.jsonl`, Claude Code 2.1.280 headless, one-file read) show what
  each setting is worth: round-1 lean session 21.7k; no claude.ai connectors or skill/plugin sync
  19.4k; without the never-used tools 14.4k; no git instructions 11.8k; a short custom system
  prompt with no file-editing tools 6.5k.

<!-- RESULTS -->
