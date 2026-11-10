# Volt orchestra: teams, councils and machines

**Date:** 2026-11-09 · **Status:** implemented (branch `feat/orchestra`) · **Builds on:** `VOLT-ORCHESTRATOR-PLAN.md`

## 1. What it is

The orchestrator already runs any number of agents durably: threads, turns, tasks, parent wake-ups, handoffs,
budgets and fallbacks. The orchestra is the layer on top that turns one request into a coordinated team, without
hard-coding any team shape:

- **"Spawn 34 agents, half Claude and half Codex, one per failing test"** becomes one `spawn_team` call. Volt
  expands the mix (17 + 17), puts the tests on a shared board, and runs as many at once as this machine can hold.
  If that is more than it runs comfortably, Volt first asks the user how many to run at a time.
- **"@Council should we split the agent server?"** becomes one `council` call. Models from different providers
  answer on their own, review each other's answers anonymously, and a moderator writes the decision.
- **"@Mac Studio run the integration tests"** becomes one `machine_run` call. A remote server (a Volt runner) runs
  the work and returns a branch.

The user says what they want in their own words; the agent turns it into structured calls. Nothing in Volt assumes
"a lead plus four specialists".

```text
 chat ──@Agents/@Machines/@Team/@Council, /team, /council──▶ agent (any provider)
                                                              │ orchestra tools (MCP, group "tasks")
                                                              ▼
 ┌──────────────────────── AgentOrchestraService (agent server, or the window running agents) ────────────────────────┐
 │ spawn_team: roster math ─▶ capacity plan ─▶ (ask the user) ─▶ thread.children cap ─▶ spawnTasks(team) ─▶ board     │
 │ council:    answers (quiet) ─▶ blind reviews (after, never own answer) ─▶ verdict (after all)                        │
 │ team_send / team_board: messages via notify/steer, atomic board ops   machine_run: relay cloud tasks + delivery       │
 └──────────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────┘
                                                │ IAgentOrchestratorService.spawnTasks / dispatch / notify / submit
                                                ▼
                       orchestrator core (pure): team-batched delivery · quiet tasks · per-lead caps · blind reports
                                                │
                                                ▼  startTurn effects ─▶ turn host ─▶ runtime (ACP harnesses, native loop)
```

## 2. Concepts

| Concept | What it is | Where |
|---|---|---|
| Team | Tasks with the same `team` id under one lead chat, plus a board on disk | `IOrchTask.team`, `teamBoard.ts` |
| Board | Work items members claim one at a time (`after` dependencies), and notes everyone reads | `teamBoard.ts` (pure reducer) |
| Council | A team whose tasks form 3 stages through `after`: answers → blind reviews → verdict | `orchestra.ts` briefs, service |
| Machine | This one (with its measured capacity) and the relay's runners | `orchestra.ts` machine rows |
| Capacity | How many agents this machine runs comfortably (`recommended`) and at most (`max`) | `machineCapacity.ts` |

## 3. Tools (Volt MCP server, group `tasks`)

| Tool | Purpose |
|---|---|
| `orchestra_status` | One read: models by provider, this machine's capacity and load, the budget, the machines, and this request's teams and councils (with the council's ranking so far) |
| `spawn_team` | `members` groups (`model`, `count` or `share`, `role`, `name`, `brief`), `count`, `items` (board) or `assign: split`, `parallel`, isolation, contract fields, `client_request_id` |
| `team_send` | Message the lead, members by name or task id, or `all`; `wait` for one recipient's reply |
| `team_board` | `claim` / `done` / `release` / `block` / `note` / `read` / `add` |
| `council` | `question`, `participants`, `moderator`, `rounds` (1-2), `files`, `context` |
| `machine_run` | `run` / `status` / `apply` / `cancel` on a remote server |

They sit beside the existing task tools (`delegate_task`, `wait_tasks`, `message_task`, `handoff`) and thread
tools, which still work for team members.

## 4. Mechanisms, and why

Each choice below follows from the research (herdr, T3 Code, Claude Code agent teams, Codex multi-agent, opencode,
Xum, llm-council, and the debate/judge literature). The research notes are in `VOLT-ORCHESTRATION-RESEARCH.md`.

1. **Work flows to whoever is free.** Members claim the next open item whose dependencies are done, one at a time,
   and claim again when they finish. This is work stealing rather than a split fixed up front, so a slow item does
   not hold up a whole share of the work. Claims are applied in order against the latest board, so two members
   never get the same item, and a repeated claim returns the item already held. An item given back too often
   (`MAX_ITEM_CLAIMS`) is blocked for the lead. (Claude Code agent teams' locked self-claim.)
2. **One wake-up per team.** A team member's report waits until its whole team is terminal (`isDeliverable`), then
   every report arrives in one notification. Large batches share one character budget, and the full text stays in
   `task_status` and on the board. Without this, a team of 30 would wake its lead 30 times and hit `maxWakeups`.
3. **Quiet stages.** A council's answers and reviews have `quiet: true` (delivery `none`). Later stages read them
   through `after`, and only the verdict reaches the chat. Pruning never drops a report a live task still waits on.
4. **Blind, own-answer-free, order-shuffled review.** Reviewers see `Response A/B/C`, never their own answer, with
   labels shared across every judge (`IOrchTask.blind` is the label pool) and each judge's own presentation order
   (seeded by its task id). Judges favour themselves (+10-25%) and favour position (swap consistency 24-65%), and
   anonymizing alone is not enough. The default is one review round, because voting gets most of the gain from
   debate. A second round reads the answers again (same labels) alongside the first round's reviews ("Review 1",
   "Review 2"), so every ranking refers to answers.
   A council member that fails does not sink the council: later stages of a team start once at least one of their
   upstream tasks finished, and the brief marks the missing ones. A stage that cannot be spawned cancels the stages
   already started (they are quiet and would otherwise run unseen).
5. **Heterogeneous by default.** A council with no participants named seats one model per provider family (agent
   harnesses first, since they can read the code), at most four. Mixed providers are the dependable fix in the
   debate literature.
6. **Admission control from the machine.** No comparable tool measures the machine. Volt measures it once and
   saves the result. The limits follow it until the user sets them, and a spawn above `recommended` asks first.
7. **A cap per lead.** The user's "8 at a time" is `IOrchThread.maxChildren` (`thread.children`). It replaces
   `runningPerParent` for that chat (still within `runningTotal`) and is lifted when the last of its teams finishes.
8. **Peer messages are not the user.** `team_send` marks every message as coming from an agent that cannot approve
   anything. It always goes as a notification (`thread.notify` with `steer`): it is read between steps when the
   agent takes messages, and otherwise queued as a notification turn. A failed steer is re-queued as a
   notification too, so it never runs as the user's prompt (which would reset the request's budget) and never stops
   the running turn. It refuses to land in a chat waiting on the user's answer. (herdr refuses to type into an
   approval dialog.) A finished team's single report is not held back by the wake-up limit, because teams are
   bounded.
9. **Its own spawn cap.** Team spawns count against `maxTeamAgents` (setting `volt.orchestra.maxAgentsPerRequest`,
   default 100, max 500), not the per-turn delegation guard. Budgets, depth and duplicate briefs still apply.
10. **Private by default.** `task_status` and `wait_tasks` show and acknowledge only the caller's own subagents
   (or those of its request), and a blind reviewer cannot look up the answers it judges.
11. **Durable by construction.** Teams and councils are ordinary orchestrator tasks, persisted per root, and replay,
   recovery and chaos tests cover them. Boards and machine runs are small JSON files written atomically
   (`voltOrchestrator/orchestra/`). A machine run's report is delivered once, also after a restart.

## 5. Capacity model

`computeMachineCapacity` (pure):

- `reserved = max(3 GB, 25% of RAM)`, `free = RAM - reserved`
- `max = min(free / 700 MB, 2 × cores)`, and `recommended = min(max, free / 1.2 GB, cores - 2)`, each clamped to 1..64

The per-agent figures come from reported RSS: Claude Code 280-550 MB active, OpenCode 190-380 MB, Codex 50-60 MB
idle, plus the ACP adapter and 10-135 MB per MCP server. The comfortable figure adds room for the tool runs agents
start (type checks, tests). Examples: 16 GB / 8 cores → 6 recommended, 16 max; 64 GB / 12 cores → 10 and 24;
8 GB / 4 cores → 2 and 7.

The result is saved in `volt.orchestra.machineCapacity` (machine scope, so Settings Sync does not carry one machine's
numbers to another) on the first desktop launch that finds none
(`agentMachineCapacity.contribution.ts`). It is never rewritten on its own. Settings › Orchestration edits it or
measures again, and so does the command "Measure How Many Agents This Machine Can Run". The per-chat and total limits
default to 0, which means "follow the machine". Because the value lives in a setting, the agent server reads the same
numbers.

## 6. Machines and @mentions

- **@ › Agents:** Team, Council, then every connected model by provider. A model chip tells the agent to hand that
  model its part (`delegate_task`). Team and Council chips call `spawn_team` / `council` with the mentioned models.
- **@ › Machines:** This Mac / This PC (capacity and load), then the relay's runners (online, load, agents signed
  in), then "Add Remote Server…". A machine chip tells the agent where the work runs: here, or `machine_run` with
  that machine's id.
- **`/team` and `/council`:** built-in skills with the recipe for each.
- **Settings › Orchestration › Add Remote Server:** with the relay connected, it creates a one-time runner pairing
  code and gives a one-line command for the server (`VOLT_RELAY_URL=… VOLT_RELAY_PAIRING_CODE=… node
  apps/relay/bin/volt-runner.mjs`, or `Dockerfile.runner`). Without the relay, it offers "Connect to Relay…".

Remote work reuses the relay's cloud tasks (bundle → runner → branch). Nothing new listens on the network, and agent
credentials stay on the runner.

## 7. Files

- Core (pure): `common/orchestration/{orchestrator,orchestratorDecider,orchestratorProjector,orchestratorCodec,agentTasks}.ts`
  (maxChildren, team, blind, quiet, isDeliverable, compact batches, pruning guard, limits);
  `machineCapacity.ts`, `orchestra.ts`, `teamBoard.ts` (new).
- Service: `browser/orchestration/agentOrchestraService.ts` (new); `agentOrchestratorService.ts` (`spawnTasks`,
  team/blind/quiet passthrough); `browser/host/hostToolService.ts` (`askUser`).
- Wiring: `server/node/voltAgent/agentServerMain.ts`, `workbench.desktop.main.ts`, `voltWorkbenchWeb.contribution.ts`.
- UI: `composer/agentMentions.ts` and `media/agentEditor.css` (machine and agent mentions; also the device chip
  glyph, which had no rule and fell back to the file icon), `voltSettings/browser/orchestrationPage.ts` and
  `voltSettingsEditor.ts`, `resources/agentHarnessSection.ts`, `electron-browser/agentMachineCapacity.contribution.ts`.
- Settings: `agentWorkflowSettings.ts` (capacity, per-request cap, council defaults; the parallel limits now
  default to 0, meaning "follow the machine").
- Skills: `skills/voltBuiltinSkills.ts` (`council`, `team`).
- Tests: `test/common/orchestration/orchestra.test.ts` (capacity, roster, briefs, board, team batching, quiet stages,
  per-lead caps, team cap, blind reviews, codec round trip, compact batches, machines, mentions).

## 8. Not in this change

- **Live remote chats.** A remote server runs a batch task and returns a branch. A live chat on another desktop's
  agent server would need a desktop client for remote agent servers; the protocol already supports it.
- **Execution graph view.** Team members appear as subagents in the work card and the lineage dock today. A
  dedicated graph or timeline is a follow-up.
- **Executable verifier before review** (run the tests on each attempt, then judge the survivors). This fits
  `spawn_team` with worktree isolation plus a council over the branches, but nothing does it automatically yet.
