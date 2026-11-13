# 24 · Orchestration, round 3: speed, tokens and reliability vs Claude Code, and an ADEMark C1-style build

Branch `e3/orch` (worktree `volt-e3-orch`, base `82ae771c1d9`), 2026-11-13. Round 2: [`../round2/10-harness-benchmark.md`](../round2/10-harness-benchmark.md), [`../round2/11-orchestrator.md`](../round2/11-orchestrator.md).

Status: in progress (written as it goes; the project-mode runs below are still being taken).

Task names: this report keeps round 2's names (the brief counts from 1): **t0** "Reply OK", **t1** 3 research
subagents + a synthesis subagent, **t2** 3 parallel bug fixes + `npm test`, **t3** writer + reviewer.

## Where the seconds went before (round-2 traces, `scripts/orch/tl.mjs`)

Timelines of the round-2 `volt-final` runs on one clock (parent `P`, subagents `1..n`), read event by event:

| Where | t1 (research) | t2 (bug fixes) | t3 (writer + reviewer) | Whose |
|---|---|---|---|---|
| Parent loads `delegate_task` with ToolSearch first (a whole extra request on a 40k prompt) | 2.5-3.4 s | 2.3 s | 2.5-3.6 s | Volt (tool deferred) |
| Parent writes the `delegate_task` arguments (the schema asks for goal/scope/files/constraints/done_when per task; 2.5 KB of JSON) | 7.0 s (4.5 s thinking + 2.6 s JSON) | 4.8 s | 4.9 s | model, shaped by Volt's schema |
| Every editing (`work`) subagent's run ends 3.01 s after its last model event: `syncSandboxState` waits out its 3 s cap before `run.end` | - | 3.0 s per subagent (all 9 of 9) | 3.0 s per writer round (5 of 5) | Volt |
| Read-only subagents start cold (the warm-up made `work` spares) | 1.2-1.4 s (2 of 3 per wave) | - | 1.1-1.5 s per reviewer | Volt |
| A reviewer started in its own call with `after: ["1"]` was refused ("not a task of this chat"); the parent waited for the writer, then started the reviewer a turn later | - | - | 3.4 s + one parent request | Volt (argument handling) |
| The parent tries Volt's `tests` tool, which does not cover `node --test`, then runs `npm test` in the shell | - | 2.0 s + one request | - | Volt (tool description) |
| Reports: fixed four-heading format incl. "## Open issues: None", interim notes included | 0.5-1.4 KB | 0.6-0.9 KB | 1.3-3.4 KB (2-5 s of output) | model, shaped by Volt's report format |

Claude Code on t1 (`cc-t1-2`): its first parent request starts subagents 3.5 s after its first token request,
because its Agent tool is always loaded and each Agent call starts as soon as its block is complete
(400-byte briefs). Volt's parent reached the same point after 12.6 s.
