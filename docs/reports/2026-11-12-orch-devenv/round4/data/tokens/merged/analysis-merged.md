# Round 4 merged tree: Track B tokens

Tree: `volt/8fb8291c` after `e4/tokens`, `e4/orch`, `e4/c1`, `e4/firstword`, `e4/coldstart` (before the
`<volt_context>` ordering fix). Rig: report 33's `runtok.mjs` as `runtok-merged.mjs` (adds
`VOLT_AGENT_SERVER_LAUNCHD=0`: a tree outside the Desktop starts its agent server under launchd, which skips the
proxy and the rig's config dir; the first B1 run did that and is kept apart in `windows-invalid-launchd.jsonl`).
Opus 5.5, Full access, sandbox off, Claude Code 2.1.322 / agent-sdk 0.3.322 (same as r4c). Medians (range), n=3.

| Test | Merged | e4/tokens (r4c) | Base | Bare CLI |
|---|---|---|---|---|
| B1 "hi": total | **14.1K** (14.1-14.3K) | 15.6K | 23.1K | 18.1K |
| B1: $ | 0.0483 (0.0041-0.1150), cache writes | 0.0045 | 0.0059 | 0.0050 |
| B3 real prompt: total | **53.6K** (52.9-55.6K) | 57.3K | 80.2K | 81.4K |
| B3: main thread | 51.6K (51.6-51.7K) | 56.0K | 78.9K | 81.4K |
| B3: $ | 0.1311 (0.1310-0.1401), cache writes | 0.0706 | 0.0688 | 0.0825 |
| B3: main requests | 3 (3-3) | 3 | 3 | 4 (3-4) |
| B3: side calls | 1.3K title; rep 1 also a 2.8K Haiku predictor call | 1.3K title | 1.3K title | 0 |
| B4 AGENTS.md canary in request / obeyed | 12 of 12 requests / 6 of 6 runs | 6 of 6 | 6 of 6 | 6 of 6 |

B1 per run: 14,224 (rep 1), 14,055, 14,055. B3 main requests: 15.2-15.3K, 16.6-16.7K, 17.3-17.7K (e4/tokens:
16.7K, 18.1K, 18.9K).

## B2 split (B1 rep 1, `b2-merged-b1.json`)

| Part | Merged | e4/tokens | Base | Bare CLI |
|---|---|---|---|---|
| system | 2,868 | 2,868 | 2,755 | 2,345 |
| tools | 3,633 | 3,633 | 10,098 | 10,200 |
| mcp-tools | **702** | 1,945 | 1,945 | 0 |
| injected | 808 | 808 | 808 | 808 |
| params | **260** | 1,046 | 1,142 | 253 |

- mcp-tools: `delegate_task` 459, `message_task` 131, `wait_tasks` 126 (e4/orch: 2,078 to 740).
- params: the `safeguards` key every r4c Volt request carried is gone; Full access now runs Claude Code in its
  bypass-permissions mode (e4/orch `f59e930366d`), so report 33's "Full access still runs auto mode" no longer shows.
- B2 parts counted one by one fell 2,029; the billed request fell 1,501 (15,556 to 14,055).

Present in all 12 main requests: the lazy-tools line ("Load on demand: Agent ..., Workflow ..., ScheduleWakeup ...,
ReportFindings ..., ListAgents ...") and `isolation: {"type":"string","enum":["shared","worktree"]}` on
`mcp__volt__delegate_task`.

## Cost: why it is not comparable with r4c

- B1: rep 1 wrote the whole prefix to the cache ($0.115); rep 1 also carried a 169-token bypass-mode reminder that
  reps 2-3 did not, so rep 2 rewrote 5.6K. Rep 3, fully cached: **$0.0041** (r4c after: $0.0045).
- B3: every rep wrote 9.8-10.1K to the 1-hour cache (about $0.08 of each $0.13) because the first message differed
  every rep (`prefixdiff`): rep 1 had no `<volt_context>`; reps 2-3 had one with the same files but the reasons in a
  different order. r4c sent no `<volt_context>` at all, so its identical prompts read that message from the cache.
- The order came from `headline()` in `contextRetrieval.ts` listing evidence in the order the parallel searches
  finished. Fixed on this tree after the run: evidence is sorted (strongest kind first, then weight, term, line)
  before scoring and before the headline, with a unit test that shuffles the search order. Not re-measured.
