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

<!-- RESULTS -->
