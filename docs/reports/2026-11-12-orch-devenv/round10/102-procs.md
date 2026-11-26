# Round 9, procs (92): every process except the GPU and the renderer, under load

Status: **draft** (numbers being taken). Branch `e9/procs` from `7312123ce14`. ADEMark method, unofficial. No live
model turn was used: every run is on ADEMark's replay server (port 18996).

The ask: "Under load make it match with super engineering make it super super low and amazingly efficient". A7
under load, total p95: r8 = 2,295 MB; super.engineering = 969 MB. This area's share is every process except the GPU
and the renderer: 5 Claude CLIs, agent server, shared adapter host, main, extension host, shared process, network.

## Commits

| Commit | Change |
|---|---|
| `4caca26bdfc` | perf(agent-server): cap V8's young generation in the agent server (`--max-semi-space-size=4`) |

## The first r8 baseline was invalid, and why

The previous procs agent's run of 21:34 (`~/.volt-r9/procs/run-r8-1.log`) seeded and streamed on **Grok 4.6**, not
Claude: "no seed reply in 30 s" for all five threads, agents p95 0, ten processes in role `other: grok`. The A5/A10
part of the same run (21:25) was on Claude.

Cause: Claude's model list is not built in. `claudeCatalog.ts` reads it with `claude auth status` plus a `curl` of
`downloads.claude.ai/model-catalog/v1/catalog.json` at launch. In that launch it came back empty (the profile's
`volt.runtime.catalog` had Grok and Codex rows, no Claude row), so `projectSettingsService` could not apply
`volt.agent.defaultModel = agent:seed-claude-code:claude-haiku-5-5` (it applies a default only when the catalog has it)
and every new chat kept the active model, `agent:seed-grok:grok-4.6`. The catalog fetched fine a few minutes later.
This is a transient network/auth failure at launch, not a Volt regression; the rig now refuses to measure through it:

- `lib.requireClaudeModel()`: the front composer's model label must read Haiku/Sonnet/Opus/Claude before a seed or an
  A7 prompt is sent (60 s for a seed, 10 s per A7 prompt), else the step fails.
- `seed.mjs` fails on the first thread with no seed reply; `prep.sh` retries the launch once.
- `a7.mjs` writes a row with fewer than 5 Claude CLIs alive at the median tick to `a7-rejected.jsonl`, not `a7.jsonl`.
  The invalid row is there, marked.

## Fix: the agent server's young generation (`4caca26bdfc`)

Under five streaming chats V8 grows a Node process's young generation to two semi-spaces of its maximum and keeps it
there while the burst lasts. Measured with a JSON-parsing loop: 32 MB in Electron 37's Node 22 (the agent server),
64 MB in Node 25 (`/opt/homebrew/bin/node`, which runs the shared adapter host); with `--max-semi-space-size=4`, 8 MB.
The agent server relays short-lived messages (ACP updates, transcript patches), so the cap means more frequent, not
larger, scavenges. Its round-7 idle collection (`ServerMemoryReducer`) never runs during a run, so under load nothing
else gives that memory back.

`src/vs/base/node/voltNodeHelperHeap.ts` holds the flag; `agentServerProgram()` puts it before the entry. Tests:
`voltNodeHelperHeap.test.ts` (a real Electron-as-Node child: capped young generation <= 8 MB after a burst, larger
without) and `serverMemoryReducer.test.ts` (the flag is on the server's command line, before the entry).

DEV_A7_TABLE

TODO_RELEASE_ROWS

## Tried and dropped (measured, no gain)

| Idea | Result |
|---|---|
| The same cap on the shared adapter host (Node 25) | Its young generation shrinks back after the first burst by itself; with the cap it ended A7 at 86 / 82 MB against 76 / 80 without (n 2 each): more promotion, no gain at the p95 tick. Not shipped. Across all 7 dev rows the host was 76-105 MB with or without, run to run. |
| `--heap-growing-percent=25` on top of the cap (agent server) | 213 MB at the p95 tick against 190-196 with the cap alone (n 1): worse. Not shipped. |
| `--optimize-for-size` | Micro only: 8-14x slower on an allocation loop. Not tried in the app. |
| Bun/mimalloc knobs in the Claude CLI's environment: `MIMALLOC_PURGE_DELAY=0`, `MIMALLOC_PURGE_DECOMMITS=1`, `MIMALLOC_ARENA_EAGER_COMMIT=0`, `BUN_GARBAGE_COLLECTOR_LEVEL=1`, `BUN_OPTIONS=--smol`, `BUN_JSC_forceRAMSize=256M`, idle GC | One CLI on A7's stream (`cliweight.mjs`, untimed, loads 15-134): run-to-run spread of Volt's own CLI is 140-180 MB peak. `MIMALLOC_PURGE_DELAY=0` interleaved with plain (n 3 pairs, median while streaming): 129 vs 150, 142 vs 140, 153 vs 153. No knob gave a gain larger than the noise; none shipped (they would also leak into every command the agent runs). |

## Where each process stands, and its floor

CLI_SECTION

OTHERS_SECTION

## Milestones

MILESTONES

## Rerun

- Rig: `round9/scripts/procs/` (round 8's agents rig with `~/.volt-r9` paths, CDP 9986, replay 18996, window
  1500x930). One arm: `./r8run.sh <arm> [app path] ["a5 a10 a7"]` (fresh seeded profile, holds
  `~/.volt-r9/timing.lock`, every sample gated on a 1-minute load <= 14). Tables: `node a7roles.mjs 14 <arms>`,
  `node summarize.mjs 14 <before> <after>`, `node a7cpu.mjs <arms>`.
- The checks around a change: `./block9.sh <before> <after> [a7reps]` (A7, A5+A10, follow-up, first word).
- r9 release: `./r8run.sh r9 ~/.volt-r8/min/r9/VOLT.app a7` (or any app path), against `./r8run.sh r8 a7`.
- Dev A/B of the flag: arms `dev-yg-off` / `dev-yg-on` (arm.sh rewrites the dev build's compiled
  `voltNodeHelperHeap.js`; `./ygflag.sh on` restores it).
- One CLI: `node cliweight.mjs <reps> bare mcp mcp1 volt volt-noplugin volt-nosettings volt+mi0 ...`
  (`CLIWEIGHT_FP=40` adds footprint categories, `CLIWEIGHT_NO_ROWS=1` for exploration).
