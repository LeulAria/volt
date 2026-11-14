# Volt orchestrator and sandbox: analysis and target architecture

**Date:** 2026-11-11 · **Branch read:** `feat/agent-dev-environment` · **Depth:** a 15 minute high-level read

**How to read this.** Findings come from reading the code, not from running it. Each one is marked:

- **[read]** I read the lines that show it.
- **[inferred]** it follows from the code I read, but I did not trace every path. Verify before acting.

Nothing here was tested at runtime.

---

## 1. The short version

The orchestrator core is good. It is a pure `decide / apply / schedule / effectsFor` state machine with command
receipts, an outbox rule and seeded chaos tests. Most agent products do not have this. The sandbox is also ahead
of the usual approach: it confines the whole agent process tree instead of single shell commands, and it treats
"code that runs later outside the sandbox" as a first-class threat.

The two features do not know about each other, and that is the biggest gap. The orchestrator decides who runs,
with what model, in which checkout. The sandbox decides what a process may touch. Neither one passes anything
to the other. `grep -i sandbox` over both orchestration folders under `services/voltRuntime` returns nothing
**[read]**.

The step change is not more features on either side. It is three structural moves:

1. **Make the orchestrator a durable execution kernel.** The event log becomes the source of truth, effects
   become durable and acknowledged, and one daemon owns each chat tree under a lease.
2. **Make the sandbox a capability system.** Deny by default, secrets brokered instead of readable, all egress
   through an authenticated proxy, and the same guarantee on every platform and every harness.
3. **Join them through the task.** Every task carries an execution environment (checkout, filesystem policy,
   network policy, secrets, budget). A child can only receive a subset of what its parent holds. A sandbox
   denial becomes an orchestrator event the parent or the user can answer.

Sections 2 and 3 say what exists and where it is weak. Section 4 is the target design. Section 5 is the order
to build it in. Section 6 lists small fixes worth doing this week regardless.

---

## 2. Orchestrator

### 2.1 What exists

| Piece | File | Size |
|---|---|---|
| Model, commands, events, effects, limits | `services/voltRuntime/common/orchestration/orchestrator.ts` | 847 lines |
| Decider (all policy) | `.../orchestratorDecider.ts` | 1993 lines |
| Projector | `.../orchestratorProjector.ts` | 373 lines |
| Codec, views, queries, rescue, limits, spend | same folder | about 2000 lines |
| Service (everything impure) | `services/voltRuntime/browser/orchestration/agentOrchestratorService.ts` | 2313 lines |
| Store | `.../orchestratorStore.ts` | 160 lines |
| Remote proxy | `services/voltAgentServer/common/remoteAgentOrchestratorService.ts` | 145 lines |
| Tests | `test/common/orchestration/*` | about 2700 lines, including chaos |

What it does well **[read]**:

- One owner of thread, turn, queue and task state. The UI derives status from one function.
- Idempotent commands (512 receipts), so a retried wake-up is acknowledged and not sent twice.
- One task shape for Volt subagents and harness subagents.
- Doom-loop guards: spawns per turn, brief repeats, rounds, wake-ups, restart resumes.
- Budgets in USD and tokens per request, model fallbacks per task, `after` dependencies between tasks.
- Per-root persistence with individual validation, so one damaged thread does not lose the tree.

### 2.2 Weak points

**O1. The log is an audit trail, not the source of truth. [read]**
Each root is one JSON file, rewritten whole after each command batch, carrying the newest 200 events
(`orchestratorStore.ts`, `apply` keeps 200 to 400 in memory). State cannot be rebuilt from history, a bad
projector change cannot be repaired by replay, and the write cost grows with the tree. For a days-long run with
hundreds of tasks, every progress tick rewrites the whole tree.

**O2. The outbox waits for a write attempt, not a write. [read]**
In `apply`, effects run in `persisted.then(...)`. `persistNow` resolves after `Promise.all(writes)` whether the
writes landed or not, and schedules a retry on failure. So when the disk write fails, `startTurn` still runs.
A crash in that window leaves a running agent that the saved state does not know about. `stopStrayRun` and the
watchdog cover some of this, but the rule the plan states ("effects run only after the batch is written") is
not what the code does.

**O3. Effects are not durable. [read]**
Effects exist only in memory between `apply` and `runEffect`. There is no stored row per effect with a status.
After a crash, recovery marks active turns `interrupted` instead of knowing "startTurn for turn X was issued
and never acknowledged". That is safe, and it is why recovery has to be conservative: it cannot tell a turn
that never started from one that was half done.

**O4. One process, one global state, no lease. [inferred]**
`this.state` holds every loaded root. `runningTotal` is "per window". Memory notes say one workbench per
project loads the same state and that `DurableClaims` exists for timed work. I did not find a fencing token on
root writes, so two processes that load the same root can both write it and both run its effects.

**O5. The service is a 2313 line class with eight jobs. [read]**
Effect running, runtime event ingestion (`observeEvent` alone is about 170 lines), liveness watchdog, limit
timers, rescue timers, usage accounting, the MCP task tool implementations, delegation and worktree
preparation all live in `AgentOrchestratorService`. The decider at 1993 lines has the same shape. Both are
hard to change safely, and the service has almost no tests compared to the core.

**O6. Liveness is guessed from silence. [read]**
`WATCHDOG_MS = 20s`, `START_STALL_MS = 180s`, `SILENT_RUN_MS = 10 min`, `SILENT_TOOL_RUN_MS = 30 min`,
`CANCEL_SETTLE_MS = 6s`. These are tuned constants standing in for a real signal. A long build looks the same
as a hung agent for 30 minutes.

**O7. The scheduler is caps plus FIFO. [read]**
Limits are `runningPerParent`, `runningTotal`, `maxDepth = 2`. There is no priority, no fairness between
roots, and no model of the things that actually run out: provider rate limits, the account's usage window,
CPU and memory on the machine, free worktrees.

**O8. Conflicts are found after they happen. [read]**
In a shared checkout, two writers on one file raise a `conflict` on the card. `scope` claims are advisory.
Worktree isolation is opt-in per task.

**O9. Results are prose. [read]**
A child reports back as text injected into a notification turn, plus a file list. `ITaskContract` exists
(goal, constraints, done-when) and the proof-of-done branch adds evidence, but the orchestrator itself does
not check a result against its contract before waking the parent.

**O10. Subagents may not inherit the parent's sandbox. [inferred]**
`getSandboxSettings` returns `sandboxChats[sessionId] ?? sandboxDefaults` (`voltRuntimeService.ts:2198`), and
the default is `{ level: 'off', network: true }`. The plan says a child "never gets more than the parent" for
access mode. I found no code that copies sandbox settings to a child chat. If that is right, a read-only
sandboxed parent can delegate to a child that runs unconfined. **This is the first thing to verify.**

---

## 3. Sandbox

### 3.1 What exists

| Piece | File |
|---|---|
| Policy and plan (pure) | `platform/voltSandbox/common/sandboxPolicy.ts` (479 lines) |
| macOS profile | `.../common/seatbelt.ts` |
| Linux helper (C source, compiled on first use) and bwrap args | `.../common/landlock.ts` |
| Denial parsing and wording | `.../common/sandboxDenials.ts` |
| Launcher and macOS log watcher | `.../node/sandboxLauncher.ts` |
| Filtering proxy | `.../node/sandboxProxy.ts` |
| Call sites | `platform/voltStdio/node/voltStdioService.ts`, `voltRuntime/browser/agents/acpProvider.ts` |

What it does well **[read]**:

- Wraps the whole agent tree, so the agent's own file tools are confined, not only its shell.
- Per-agent footprints (state folders, protected config, API hosts) for ten harnesses.
- Denies writes to git hooks, git config, shell rc files, and each CLI's hook and MCP config.
- Applies the same plan to writes that go through Volt's own process (`planAllowsWrite` for ACP file writes).
- Shows denials in the transcript and lets the user allow a folder or host.
- The plan is a pure function with tests.

### 3.2 Weak points

**S1. Off by default, absent on Windows, and fail-open on Linux. [read]**
`DEFAULT_SANDBOX_SETTINGS = { level: 'off', network: true }`. `sandboxStrategy` returns `none` for `win32`.
On Linux without Landlock, bwrap or a C compiler, the agent runs unsandboxed with a warning line.

**S2. Reads are open. [read]**
The Seatbelt base is `(allow default)`. Reads are denied for nine paths (`.aws`, `.gnupg`, `.kube`, gcloud,
azure, docker config, `.netrc`, `.npmrc`, `.pypirc`). Everything else in the home folder is readable,
including `~/.ssh` private keys (kept readable on purpose so git over SSH works), `~/.config/gh/hosts.yml`,
`~/.git-credentials`, browser profiles, other apps' data under `~/Library/Application Support`, and `.env`
files in every other project. A deny list for secrets can never be complete. With network on, anything
readable can leave.

**S3. The agent inherits the user's environment. [inferred]**
`voltStdioService.ts:119` builds `{ ...await this.env(), ...options.env, ...sandboxEnv }`. If `this.env()` is
the user's shell environment, then `GITHUB_TOKEN`, `AWS_*`, `OPENAI_API_KEY` and similar are handed to the
sandboxed process. The file deny list in S2 is then beside the point.

**S4. The "runs later" deny list has known holes. [read]**
Writable today, and all run outside the sandbox later:

- `.husky/` in repos whose `core.hooksPath` already points there, `package.json` scripts, `Makefile`,
  `.envrc`, `.github/workflows/`.
- `CLAUDE.md`, `AGENTS.md`, `.claude/skills`, and under the home folder `~/.claude/CLAUDE.md`,
  `~/.claude/skills`, `~/.claude/plugins`. These are instructions and code for every future unsandboxed
  session, which makes them a persistence path for prompt injection.
- `~/.npm`, `~/.cache`, `~/Library/Caches`, `~/.bun/install/cache`. A poisoned package cache is picked up by
  later installs that run unsandboxed.

This list cannot be closed by adding entries. The fix is structural (section 4.2, isolated checkouts).

**S5. Loopback and unix sockets are wide open in network-off mode. [read]**
The profile allows `(remote ip "localhost:*")` and `(remote unix-socket)` with no path filter. That reaches:

- the Docker socket, which gives a container with the host disk mounted, which is a full escape;
- local databases and dev servers;
- other chats' filtering proxies. The proxy has no authentication, so a chat with a narrow allow list can
  use another chat's port with a wider one.

On Linux the helper limits connects to named ports, so macOS is the weaker platform here.

**S6. Network on means unobserved. [read]**
With `network: true` the plan is `all`: no proxy, no log of where the agent connected. With the proxy, rules
are by host only. Allowed hosts include `registry.npmjs.org` (publishing is an upload), `*.googleapis.com`
(storage uploads), `sentry.io`, `*.vercel.com`. Any of these is a way out for data. DNS likely still resolves
through the system resolver under Seatbelt, which is another channel **[inferred]**.

**S7. The proxy is minimal. [read]**
No authentication, no connect timeout, no check that an allowed name resolves to a public address, and the
plain HTTP path does not look at the port. On bwrap the proxy is advisory: only clients that honour
`HTTP_PROXY` use it.

**S8. Guarantees differ by harness. [read]**
Codex at `workspace-write` uses its own per-command sandbox (`native`), every other harness is wrapped, and
Cursor's own sandbox is switched off so Volt can wrap it. The native model loop does not appear to pass
through the launcher at all **[inferred]**: only `acpProvider` sends a `sandbox` to `stdio.spawn`. The user
sees one "Sandbox" control with three or four different meanings behind it.

**S9. No resource limits. [read]**
Nothing bounds CPU, memory, process count, disk or wall time for a sandboxed tree.

**S10. Fixed at launch, no scoped escalation. [read]**
A level change needs a new process (`sandboxLaunchKey`). Allowing a folder is permanent for the chat. There
is no "allow this one command" or "allow for ten minutes".

**S11. Denials are only observed on macOS. [read]**
`log stream` gives real denials on macOS. On Linux the only source is matching "Operation not permitted" in
command output.

**S12. `sandbox-exec` is deprecated by Apple, and the profile travels on the command line. [read]**
It works today. It is a platform risk to plan around, not an emergency.

**S13. No adversarial tests. [read]**
482 lines of tests cover plan construction and the launcher. There is no suite that runs real escape attempts
against a real sandbox.

---

## 4. Target architecture

```text
                        clients (desktop, web, mobile, MCP tools)
                                      │ commands (idempotent)
                                      ▼
┌──────────────────────────── Volt agent daemon ─────────────────────────────┐
│                                                                            │
│  Root actor (one per chat tree, holds a lease with a fencing token)        │
│   ├─ decide / apply            pure core, as today                         │
│   ├─ event log                 append-only, SQLite WAL, source of truth    │
│   ├─ effect outbox             durable rows: pending → issued → acked      │
│   └─ snapshot                  cache only, rebuilt from the log            │
│                                                                            │
│  Scheduler          resources: provider rate, usage window, CPU, slots     │
│  Supervisor         heartbeats and leases, not silence timers              │
│  Accounting         spend per task, tree, account                          │
│  Capability broker  issues an environment per task, child ⊆ parent         │
│                                                                            │
└───────────────┬────────────────────────────────────────┬───────────────────┘
                │ startTurn(env)                         │ grants, denials
                ▼                                        ▼
┌──────── Execution environment (one per task) ───────────────────────────────┐
│  Checkout     copy-on-write clone or worktree, merged back through a gate   │
│  Filesystem   deny by default; workspace, toolchains, own state allowed     │
│  Network      all egress through an authenticated per-environment proxy     │
│  Secrets      never readable; the proxy adds credentials per host           │
│  Limits       CPU, memory, processes, disk, wall time; tree kill            │
│  Tier         OS policy → local container or VM → remote                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Orchestrator: a durable execution kernel

**K1. Event log as the source of truth.** One append-only log per root in SQLite (WAL mode). A command's
events and its effect rows commit in one transaction. Snapshots become a cache that is safe to delete. This
fixes O1 and O2, and it gives time travel, replay after a projector fix, and cheap progress writes. The pure
core and the codec already make this a storage change, not a redesign.

**K2. Durable effects with acknowledgement.** Each effect is a row with an idempotency key
(`turnId`, `steerId`, `taskId`). The runner marks it `issued`, the runtime's first event for that key marks it
`acked`. After a crash the runner knows exactly which effects to reissue, which to reconcile and which to
drop. Recovery can then be precise: resume what was acked and still alive, restart what was never issued, and
ask the user only about what is ambiguous. This fixes O3.

**K3. One daemon, one actor per root, a lease per root.** The agents-out-of-window work already moves the
runtime into the agent server. Finish that for the orchestrator: every window is a client. Each root is owned
by one actor holding a lease with a fencing token that every write and every effect carries. This fixes O4
and makes "the same chat open in two windows" correct by construction.

**K4. Split the service along its jobs.** Six small units behind the same interface:

| Unit | Takes from today's service |
|---|---|
| `EffectRunner` | `runEffect`, `startTurn`, `steer`, `cancelTurn`, `prepareWorktree`, `moveWorkspace` |
| `RuntimeIngest` | `observe`, `observeEvent`, `observeHarnessCall`, `settleRun` |
| `Supervisor` | `checkLiveness`, silence handling, rescue and limit ticks |
| `TaskToolsApi` | `invokeTaskTool`, `delegate*`, `waitTasks`, `messageTask`, `handoff` |
| `Accounting` | `trackTaskUsage`, `flushTaskUsage`, rates |
| `RootStore` | persistence, restore, adopt |

Split the decider the same way by command family (threads, tasks, limits, rescue, moves). Each unit gets the
simulation treatment the core already has. This fixes O5.

**K5. Heartbeats instead of silence timers.** The runtime sends a heartbeat per live run and per live tool
call, carrying what it is waiting on (model stream, tool, approval, network). The supervisor acts on a missed
heartbeat or an expired lease. A 40 minute build with a live heartbeat is healthy. A run with no heartbeat
for 30 seconds is not. This fixes O6 and removes most of the tuned constants.

**K6. A scheduler that models what runs out.** Admission asks for a resource vector: provider and model rate,
account usage window (the limit recovery code already knows the reset times), CPU and memory, a checkout
slot. Add priority classes (user-facing turn, wake-up, background task) and fairness across roots. Park a
task before it hits a limit instead of after. This fixes O7.

**K7. Isolated checkouts by default, merged through a gate.** Every writing task gets its own copy-on-write
checkout (APFS `clonefile` on macOS, reflink or overlayfs on Linux, worktree as the fallback). Results come
back as a patch through a merge queue per root that rebases, runs the task's done-when checks, and only then
applies to the parent checkout. Conflicts become a merge result the parent can act on. This fixes O8, and it
is also the real answer to S4: build scripts and instruction files an agent wrote reach the user's checkout
only as a reviewed diff.

**K8. Typed results checked against the contract.** A task ends with a structured result: status, summary,
patch reference, evidence for each done-when item, open questions. The orchestrator checks it before waking
the parent, and sends a task that claims done without evidence back for one more round. The proof-of-done
branch has most of the pieces. This fixes O9.

**K9. Observability from the log.** Derive spans (root, turn, task, tool call) with cost and duration from
the event log, and export them. The trajectory panel becomes a view over the same data.

**K10. Simulation testing for the whole kernel.** Extend the seeded chaos harness to the store, the effect
runner and the lease: injected write failures, torn writes, crashes between commit and effect, duplicate
daemons, clock jumps. The invariant to hold is: no effect runs twice, no acked work is lost, and one root has
one writer.

### 4.2 Sandbox: a capability system

**C1. One abstraction, tiers behind it.** An `IExecutionEnvironment` that every harness and the native loop
launch through:

| Tier | Mechanism | Use |
|---|---|---|
| 0 | none | explicit opt-out |
| 1 | OS policy: Seatbelt, Landlock plus seccomp plus cgroups, Windows AppContainer plus job objects | default |
| 2 | local container or lightweight VM (Apple Virtualization framework, Firecracker or gVisor on Linux, WSL2) | untrusted repos, network-heavy work |
| 3 | remote environment | long unattended runs |

The UI states the guarantee actually in force, per platform, in one line. This fixes S1 and S8.

**C2. Deny by default for the home folder.** Allow reads of the workspace, toolchains (`/usr`, `/opt`,
Homebrew, version managers), the agent's own state and a short list of dotfiles. Everything else under the
home folder is denied and each denial is a prompt-able grant. Keep `(allow default)` for the system services
an agent CLI needs. Only the file rules flip. This fixes S2.

**C3. A secrets broker.** The sandboxed process gets a scrubbed environment: an allow list of variable
names, not the user's shell. Credentials stay in the daemon. The proxy adds the API key or token for each
allowed host. Git gets a credential helper that asks the daemon for a short-lived, repo-scoped token. The
agent can use a credential and cannot read it. This fixes S3 and most of what S2 puts at risk.

**C4. All egress through an authenticated proxy.** One proxy per environment, reached over a unix socket or
with a per-environment token, so no chat can borrow another's. "Network on" also goes through it, in
allow-all mode, so every connection is logged. Add: DNS through the proxy, refusal of private and link-local
addresses, connect timeouts, method and path rules for hosts that double as upload targets, and a byte
budget for uploads per task. This fixes S6 and S7.

**C5. Narrow loopback and sockets.** On macOS allow only the named loopback ports the plan lists (the proxy,
Volt's MCP server, dev servers the task started) and only allow-listed unix socket paths. The Docker socket
is never on the list at tier 1. Tasks that need Docker run at tier 2. This fixes S5.

**C6. Fail closed, ship the helper, prove it at start.** Ship a prebuilt, signed Linux helper. Add a setting
that refuses to start an agent when the asked level cannot be enforced. At launch run canary probes inside
the sandbox (write to `~/.zshrc`, read `~/.aws`, connect to a blocked host) and show "sandbox verified" only
when all three fail as expected. This fixes the rest of S1.

**C7. Resource limits and a guaranteed tree kill.** cgroups v2 on Linux, job objects on Windows, process
groups plus `setrlimit` on macOS. Cancel in the orchestrator kills the whole tree. This fixes S9.

**C8. Scoped, expiring grants.** A grant has a target (path, host, command), a scope (this command, this
turn, this task, this chat) and an expiry. Network grants already apply live through the proxy. Filesystem
grants at tier 1 need a restart, so route "this one command" through a broker process that runs it under a
wider profile. This fixes S10.

**C9. Real denial events everywhere.** Linux: an audit or seccomp-notify source instead of matching output
text. Feed all denials into one stream with a stable shape. This fixes S11.

**C10. An escape corpus in CI.** A suite of real attempts run against the real sandbox on each platform:
hook planting, rc files, cache poisoning, Docker socket, AppleScript, `open`, launchd, symlink and rename
races, proxy borrowing, DNS tunnelling, credential reads. Each finding from section 3 becomes a test first.
This fixes S13 and guards S12 when the macOS mechanism changes.

### 4.3 The join: the task carries its environment

This is the part neither feature can do alone.

**J1. `IOrchTask.env`.** Each task gets a capability record issued by the broker:

```ts
interface ITaskEnvironment {
	readonly tier: 0 | 1 | 2 | 3;
	readonly checkout: 'shared' | 'worktree' | 'clone';
	readonly fs: { readonly write: readonly string[]; readonly read: readonly string[] };
	readonly network: { readonly mode: 'off' | 'allowlist' | 'logged'; readonly hosts: readonly string[] };
	readonly secrets: readonly string[];   // names the proxy may use, never values
	readonly limits: { readonly cpu?: number; readonly memoryMb?: number; readonly wallMs?: number; readonly usd?: number };
}
```

**J2. Attenuation is checked in the decider.** `task.spawn` is rejected when the child's environment is not a
subset of the parent's. It is a pure check, so the chaos suite covers it as one more invariant. This closes
O10 by construction.

**J3. Denials are orchestrator events.** A denial puts the task in `waiting` with `waitingOn: 'capability'`.
The parent can grant from what it holds. Anything wider goes to the user, on the same card and through the
same durable approval path as today's inputs. A grant is an event in the log, so there is a complete record
of who allowed what and when.

**J4. Roles pick defaults.** Research and review tasks get read-only and network allow list. Implementation
tasks get a clone and no network beyond package registries. Tasks that read untrusted web content lose the
ability to send data out.

**J5. The three-way rule.** Private data, untrusted content and outbound communication are never all granted
to one task. The broker tracks which of the three a task holds and refuses the third. This is the one rule
that makes prompt injection survivable instead of merely unlikely.

**J6. Budgets and limits in one place.** The USD and token budgets the orchestrator already tracks sit beside
CPU, memory, wall time and upload bytes, enforced by the same supervisor.

---

## 5. Order of work

| Phase | What | Why this order |
|---|---|---|
| 0 | Verify O10, S3, S5. Fix what is confirmed (section 6) | Possible real holes today, each a small change |
| 1 | J1 and J2: environment on the task, subset check in the decider, sandbox on by default at `workspace-write` for subagents | Joins the two features with little new machinery |
| 2 | C3 and C4: scrubbed environment, authenticated proxy for all egress, secrets added by the proxy | Largest security gain per line of code |
| 3 | K1 and K2: SQLite log and durable effects | Unblocks precise recovery and everything in phase 4 |
| 4 | K3, K4, K5: daemon ownership with leases, service split, heartbeats | Structural, lower risk once the log exists |
| 5 | K7 and K8: clone checkouts, merge gate, typed results | Removes conflicts and the "runs later" problem |
| 6 | C1 tier 2, C2, C6 to C10, K6, K9, K10 | Hardening and scale |

Phases 1 and 2 are independent of phase 3 and can run in parallel.

---

## 6. Small fixes worth doing now

Each is a small change and does not wait on the larger design.

1. **Child sandbox inheritance.** When a child chat is created, copy the parent's sandbox settings and
   refuse a wider level. (O10, verify first.)
2. **Scrub the environment** for sandboxed spawns: drop variables matching `*_TOKEN`, `*_KEY`, `*_SECRET`,
   `AWS_*` and similar, except the ones the harness footprint names. (S3, verify first.)
3. **Unix sockets:** replace `(allow network-outbound (remote unix-socket))` with an allow list of socket
   paths, without `/var/run/docker.sock`. (S5)
4. **Proxy token:** require a per-launch token (proxy URL with credentials) so chats cannot share proxies.
   (S5, S7)
5. **Proxy hygiene:** connect timeout, refuse private and link-local addresses after resolution, check the
   port on the plain HTTP path. (S7)
6. **Widen the deny lists:** read denies for `~/.ssh/id_*`, `~/.config/gh`, `~/.git-credentials`, browser
   profile folders. Write denies for `.husky`, `.github/workflows`, `.envrc`, `~/.claude/CLAUDE.md`,
   `~/.claude/skills`, `~/.claude/plugins`. A stopgap until C2 and K7. Git over SSH then needs the agent
   to reach `ssh-agent`, not the key files. (S2, S4)
7. **Outbox:** in `apply`, run effects only when `persistNow` reports that the writes landed. On failure,
   keep the effects queued behind the retry. (O2)
8. **Fail-closed setting:** `volt.agent.sandbox.require`, which refuses to start an agent when the level
   cannot be enforced. The Linux helper already has `--require`. (S1)
9. **Log connections when network is on:** start the proxy in allow-all mode and record hosts. (S6)
10. **First three escape tests:** Docker socket, proxy borrowing, `.husky` write. (S13)

---

## 7. What I did not look at

- The decider's rules line by line, the projector, or the chaos test's invariants in detail.
- `agentSubagentChats.ts` and `harnessSubagentChats.ts` under `contrib/voltAgent`, where child chat setup
  may already copy sandbox settings.
- How the native model loop runs terminal commands, and whether those are confined some other way.
- What `voltStdioService.env()` returns.
- The Landlock helper's C source beyond its header comment.
- Any runtime behaviour. No sandbox was launched and no test was run.

---

# Part 2: what to implement next

Added in a second 10 minute pass. It covers ten items each for the sandbox, the orchestrator and the agent
dev environment (`feat/agent-dev-environment`), then the plugin system. Sources for the last two are
`docs/volt-agent-dev-environment.md` and `docs/volt/customize.md`. I read those documents, not the code
behind them, so findings about them are **[inferred]** unless marked otherwise.

Each item names what it buys: **S** security, **R** reliability, **P** performance, **T** token efficiency,
**I** integration.

## 8. The one finding that crosses all three

**The IDE tools run outside the sandbox. [inferred]**
A sandboxed agent reaches Volt's MCP server over loopback (the plan allows that port on purpose). The host
tools it calls there (`tests`, `debug`, `tasks`, `ide` with `docker exec`, `k8s apply`, `remote exec`,
`git commit`, `extensions run`) execute in Volt's own process and terminals, which are not sandboxed. The
gate on them is the chat's access mode, not its sandbox level.

So a chat set to read-only with network off can still:

- run project code through `tests run` or `tasks run`, with full disk and network access;
- run `git commit`, which fires the repo's hooks outside the sandbox;
- run `docker exec` or `remote exec`, which leave the machine's policy entirely.

The agent dev environment made the agent much more capable, and every one of those capabilities is a path
around the sandbox. This is the most important thing to fix, and it is item 1 in each list below.

## 9. Sandbox: ten things to implement

| # | Item | Buys | Notes |
|---|---|---|---|
| 1 | **Sandbox-aware host tools.** Every host tool call carries the calling chat's sandbox plan. A tool that starts a process starts it through `VoltSandboxLauncher` with that plan. A tool that cannot be confined (`docker`, `k8s`, `remote`, `extensions run`) is refused or needs approval when the chat is sandboxed | S, I | Closes section 8. One choke point: `IVoltHostToolService` |
| 2 | **Environment scrubbing with an allow list** per harness footprint | S | Section 6 item 2 |
| 3 | **Authenticated per-launch proxy, always on.** Token in the proxy URL, allow-all plus logging when network is on, private address refusal, timeouts | S, R | Section 6 items 4, 5, 9 |
| 4 | **Unix socket and loopback port allow lists on macOS** | S | Section 6 item 3 |
| 5 | **Read deny by default under the home folder**, with toolchain and dotfile allow lists per harness footprint | S | C2. Ship behind a setting first and collect denials to tune the allow list |
| 6 | **Startup self-test.** Three canary probes inside the sandbox before the agent starts. Cache the result per launch key. Show "verified" or the exact probe that failed | S, R | C6. Also catches a macOS update that breaks `sandbox-exec` |
| 7 | **Prebuilt signed Linux helper and a fail-closed setting** | S, R | Removes the C compiler dependency and the 60 s first-run compile |
| 8 | **Warm sandboxed spares.** The spare-agent pool already keys on `sandboxLaunchKey`. Make sure a spare is prepared for the default sandboxed key so sandbox on costs no start-up time | P | Keeps "sandbox on by default" from feeling slower |
| 9 | **Denial coalescing for the model.** One line per turn listing blocked targets and how to ask, instead of a failure per call the agent retries | T, R | Agents burn turns retrying denied writes. A `VOLT_SANDBOX` hint in the system prompt with the writable roots avoids the first attempt |
| 10 | **Escape corpus in CI**, starting with section 8's three paths plus Docker socket, proxy borrowing and `.husky` | S, R | C10 |

## 10. Orchestrator: ten things to implement

| # | Item | Buys | Notes |
|---|---|---|---|
| 1 | **Environment on the task and the subset check in the decider** (J1, J2), including which host tool capabilities the child may call | S, I | A research child gets `code_nav` and read-only ops only. Fewer tools in its prompt also saves tokens |
| 2 | **Effects wait for a landed write** | R | Section 6 item 7. A few lines in `apply` |
| 3 | **SQLite event log with a durable effect table** (K1, K2) | R, P | Ends whole-tree rewrites on every progress tick |
| 4 | **Root lease with a fencing token** on every write and effect | R | K3. Makes two windows on one chat safe |
| 5 | **Heartbeats from the runtime** per run and per tool call, replacing the silence constants | R | K5. A running test or build under `tests` and `tasks` reports a heartbeat, so a 40 minute suite is not "silent" |
| 6 | **Split the service into six units** and give each a simulation test | R | K4. Do this before adding features to the 2313 line class |
| 7 | **Typed task results with evidence refs.** A child returns `{status, summary, patchRef, evidence[], openQuestions[]}`. Evidence points at test run ids and diagnostics from the IDE services, not pasted output | T, R, I | The parent reads a 200 token result and fetches detail by id only when needed |
| 8 | **Shared context store per root.** Files read, symbols resolved, test results and decisions, keyed and addressable. A child's brief carries references, not copies | T, P | Today each child rediscovers the repo. This is the largest token saving available in delegation |
| 9 | **Prompt cache aware scheduling.** Keep the tool list and system prefix byte-identical across siblings. Start siblings after the first has written the cache. Prefer `message_task` to a warm child over a new spawn when the cache is still live | T, P | The plan already notes "warm agent, cache hit". Make the scheduler decide it instead of the model |
| 10 | **Verification gate before wake-up.** When a task's contract has done-when checks, the orchestrator runs them (`tests`, `analyze`, `code_action fixes`) and attaches the result. A failing check sends the child one more round instead of waking the parent | R, T | Joins proof-of-done with the IDE tools. The parent never spends a turn discovering the child's work is broken |

## 11. Agent dev environment: ten things to implement

What the branch has: `code_nav`, `code_action`, `tests`, `debug`, `tasks`, and the `ide` gateway with
thirteen capabilities, all on the VS Code services the user's UI uses. The design is sound: one state, few
tools with many ops, progressive disclosure through `op: "help"`. The gaps are confinement, proof at
runtime, and feeding results back into the loop automatically.

| # | Item | Buys | Notes |
|---|---|---|---|
| 1 | **Run every process-starting op under the chat's sandbox** | S | Section 8. `VoltTestController` runs, task terminals, `debug start command=`, `profile`, `analyze`, `git commit` |
| 2 | **First runtime pass with a recorded checklist.** The doc lists five checks that have never run. Automate them as a smoke suite on a fixture repo per language | R | Nothing window-side on this branch has run in the app. This comes before any new capability |
| 3 | **Edit-time diagnostics loop.** After each `edit_file` or `code_action`, return the new diagnostics for the touched files in the same tool result, as a diff from before the edit | R, T | The single highest value use of the language servers. The agent sees a type error in the edit's own result instead of three turns later |
| 4 | **Impact-based test selection.** `tests op=affected` uses `code_nav` references and callers plus coverage data to run only tests that touch the changed symbols | P, T | Seconds instead of minutes, and a short result. Falls back to the file's own tests |
| 5 | **Result handles with paging.** Every large result (test output, logs, references, stack) returns a summary and a handle. `results handle= range=` reads more. Hard cap per result, by tokens not characters | T | The doc already caps failures at 12. Make it uniform across all capabilities |
| 6 | **Timeouts, cancellation and cleanup on every op.** A turn cancel in the orchestrator stops the agent's test runs, debug sessions, tasks and containers. Sessions left by a dead chat are reaped | R | The Agent Sessions view already lists them. The orchestrator's `cancelTurn` should own them |
| 7 | **Language server readiness.** `code_nav` reports `indexing` with progress instead of an empty answer, and waits up to a bound when the server is still loading. Name-matched fallbacks stay labelled | R | An empty reference list during indexing reads as "no callers" and causes wrong edits |
| 8 | **Per-role capability sets.** Research: `code_nav`, read-only `ide` ops. Review: plus `tests`, `analyze`. Implement: all but `confirm` ops. Sent as the child's tool list | S, T | Pairs with orchestrator item 1 |
| 9 | **Secrets hygiene in results.** The `docker inspect` masking exists. Apply one redaction pass to every capability's output (env dumps, CI logs, HTTP responses, k8s describe) | S | One function at `AgentIdeService.invokeLogged`, which every call already passes through |
| 10 | **Debugger recipes.** One op that sets a breakpoint, runs a test under the debugger, and returns locals at the pause. One that captures the state at an uncaught exception | T, P | Turns a six call sequence into one. Models use the debugger far more when it is one step |

## 12. Plugin system

### 12.1 What exists

The plugin system is "Volt Customize" (`contrib/voltCustomize/`, `docs/volt/customize.md`). It has five
layers:

| Layer | State | Trust |
|---|---|---|
| VS Code extensions (Open VSX) | built | full, once installed |
| Volt UI contributions: `voltLooks`, `voltLayouts` | built | data only, window-scoped settings |
| `voltPanels` slots, replace, error boundaries | designed | panels get `postMessage` only |
| Files in `~/.volt/customize` with `extends` | built | the user's own |
| Playground drafts an agent edits | built | isolated to one window until Apply |
| Volt extension API with `voltCapabilities` | designed | per-capability, shown on install |

Separately, agent capabilities are extended through `IVoltHostToolProvider` (in-tree) and MCP servers.

What is good: looks and layouts are data, so they cannot run code. Inheritance by `extends` keeps user
changes across updates. A bad file keeps its last good value. The Playground is a real sandbox for UI
changes. The precedence chain reuses VS Code's configuration defaults instead of a new mechanism.

### 12.2 Weak points

**P1. The plugin system extends the window, not the harness.** A plugin can restyle and rearrange Volt. It
cannot add a tool, a subagent role, a hook on the agent loop, a context provider or a verification check
without either an MCP server or editing Volt's source. Those are the extension points that make the model
better.

**P2. Three unrelated ways to add agent capability.** Host tool providers (in-tree only), MCP servers
(separate configuration), VS Code extensions (reachable through `ide extensions run`). None shares a
manifest, a permission model or a lifecycle with the others.

**P3. Extensions are fully trusted, and an agent can drive them.** `extensions run` lets an agent invoke any
extension command, behind a confirm. Extension code runs outside every sandbox. An agent can also write a
draft extension in the Playground and the user can install it with one click. That is a path from prompt
injection to permanent code on the machine.

**P4. `rightPanel.commands` in a layout runs commands.** A layout is described as data, and this field makes
it not quite data.

**P5. No capability gating is built yet.** `voltCapabilities` is designed. Until it ships, there is no
Volt API in the extension host at all, so the gap is absence, not exposure.

### 12.3 Recommendations

1. **One manifest for agent plugins.** Add `contributes.voltTools`, `voltRoles`, `voltHooks`,
   `voltContext`, `voltChecks` and `voltSkills` beside `voltLooks`. A plugin is still a VS Code extension
   package, so install, update, rollback and the gallery come for free.
2. **Tools as declared providers.** A `voltTools` entry names the tool, its ops, which ops are read-only,
   which need confirmation, and the capabilities it needs. Volt registers it on `IVoltHostToolService`, so
   it serves the native loop and ACP agents alike. MCP servers become one kind of provider under the same
   manifest instead of a parallel system.
3. **Hooks on the loop, as events with bounded power.** `preTool`, `postTool`, `preTurn`, `postTurn`,
   `taskSpawn`, `taskResult`. A hook can annotate, block with a reason, or request approval. It cannot
   rewrite a prompt silently. Hooks run with a timeout, and a failing hook is skipped and reported.
4. **Run plugin code in the sandbox by default.** A tool or hook plugin runs as a process launched through
   `VoltSandboxLauncher` with the capabilities its manifest declares, and nothing else. This is where the
   sandbox work pays off a second time. Extension host code stays for UI only.
5. **Capabilities checked in one place and tied to the task environment.** A plugin tool's capabilities are
   intersected with the calling task's environment (J1). A read-only research task cannot gain network
   through a plugin.
6. **Roles and checks as data.** A role is a system prompt fragment, a tool set, a default environment and
   a model preference. A check is a command plus a pass rule the orchestrator's verification gate can run.
   Both are JSON, so they are safe to share and safe for an agent to draft.
7. **Context providers with a token budget.** A `voltContext` provider returns ranked items with a token
   cost. Volt packs them under a budget and keeps the order stable so the prompt cache holds.
8. **Token cost on the label.** Show each plugin's standing cost in tokens per turn (tool descriptions,
   context, prompt fragments) on its install page and in settings. Route plugin tools through the `ide`
   style gateway with `op: "help"` so an installed but unused plugin costs one line.
9. **Close the agent-to-extension path.** An extension drafted by an agent installs only after a diff
   review that shows its code and capabilities. `extensions run` is refused in sandboxed chats. Make
   `rightPanel.commands` an allow list of command ids declared in the manifest.
10. **Error boundaries and health for every plugin.** Each tool, hook and panel has a circuit breaker:
    after repeated failures or timeouts it is switched off for the session with a visible notice. A plugin
    can slow or break a turn only once.

## 13. If only five things get built

1. Sandbox-aware host tools (sections 8, 9.1, 11.1). Without it the sandbox does not hold.
2. Task environment with the subset check (10.1), with sandbox on by default for subagents.
3. Effects wait for a landed write, then the SQLite log and durable effects (10.2, 10.3).
4. Edit-time diagnostics and the verification gate (11.3, 10.10). The largest quality gain for the model.
5. The runtime smoke suite for the agent dev environment (11.2). Most of this branch has never run.

---

# Part 3: implemented on `feat/orch-and-devenv-revamp`

Branch `feat/orch-and-devenv-revamp` merges `feat/orchestra` into `feat/agent-dev-environment`
and implements the items below. Unit tests cover each one; none has run in the app yet.

## Sandbox

| Item | What changed | Where |
| --- | --- | --- |
| S3, 6.2 | Sandboxed processes get the user's environment minus credentials: tokens, cloud keys and database URLs are dropped. Model provider keys stay; Claude Code on Bedrock or Vertex keeps its cloud credentials; variables a profile or project sets are added after the scrub. The names held back are logged once. | `scrubSandboxEnv` in `sandboxPolicy.ts`, `voltStdioService.ts` |
| S5, 6.3 | Container engine sockets (Docker Desktop, OrbStack, Colima, Rancher, Lima, Podman, rootless) are denied at every network setting, including where a symlink leads. Checked with `sandbox-exec` against a live OrbStack socket. Linux is not covered: Landlock cannot restrict connects to path sockets. | `seatbelt.ts`, `sandboxLauncher.ts` |
| S4, 6.6 | Never writable: `.husky`, `.envrc`, and each agent's global instruction file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, OpenCode and Pi's). | `sandboxPolicy.ts` |
| S7 | The proxy gives up on a host that does not answer within 20 s (504), and closes the upstream connection when the agent hangs up. | `sandboxProxy.ts` |
| 8, 9.1, 11.1 | **IDE tools no longer bypass the sandbox.** `exec` and `execFile` take a sandbox. Programs an `ide` capability runs (git with its hooks, docker, kubectl, gh, linters, profilers, benchmarks) run in the chat's sandbox, including a worktree's git directory. Ops that run through VS Code services (test runs, debug sessions, tasks, notebook kernels, HTTP sends with network off) ask once per chat, until the chat's sandbox changes. | `voltStdio.ts`, `voltStdioService.ts`, `capability.ts`, `agentIdeService.ts` |
| O10, J2 | **Subagents inherit the sandbox.** Before a subagent's first turn, its sandbox is set to no less than its parent's: the stricter level, network only if both allow it, and only the parent's folders and hosts. The setting `volt.agent.multitask.sandbox: confine` also confines subagents of unsandboxed chats, with research and review subagents read-only. | `attenuateSandbox`, `agentOrchestratorService.ts` |

## Orchestrator

| Item | What changed | Where |
| --- | --- | --- |
| O2, 6.7 | **Durable outbox.** Effects run only once the batch that decided them is on disk. A failed write is retried up to 4 times; after that the effects run anyway and the failure is logged. Effects run in the order they were decided, so a stop never overtakes the start it stops. | `apply`, `persistDurably` |
| 10.10 | **Volt verifies subagents' work.** `delegate_task` takes `verify` commands. When a subagent reports done, Volt runs them in its checkout and sandbox, and the task keeps its slot meanwhile. A failure goes back to the subagent with the output, for up to 3 rounds. The report reaches the parent with the result ("Volt verification: passed", or "FAILED after 3 rounds"). This works for any harness (Claude Code, Codex, Cursor, native), complementing the native loop's proof-of-done gate. It survives restarts: checks re-run, or with resume off the report goes up saying they did not run. `task_status` shows the check state. | `orchestrator.ts`, `orchestratorDecider.ts` (`decideVerified`), `agentTasks.ts`, `agentOrchestratorService.ts` (`verifyTask`), `orchestratorVerify.test.ts` |

## Agent dev environment

| Item | What changed | Where |
| --- | --- | --- |
| 11.9, 11.5 | Every IDE tool result passes one guard: credentials are masked (cloud keys, provider tokens, JWTs, private keys, URL passwords, `*_TOKEN=` lines, JSON secret keys), and output past about 15k tokens is cut to head and tail with a note on how to ask for less. | `toolOutput.ts`, `agentIdeService.ts` |
| 11.3 | **Edits answer with diagnostics.** With language servers, `edit_file` and `write_file` end with the file's errors after the write, or "No errors". No separate diagnostics turn is needed. | `editDiagnostics.ts`, `registry.ts` |
| New | **The Profiler**: see `docs/volt-profiler.md`. | |

## Still open from parts 1 and 2

- Sandboxing for Volt's native loop (its shell can now take a sandbox through `exec`, but the native file tools also need `planAllowsWrite`, and the picker needs to show the sandbox for native chats).
- The SQLite event log, leases and heartbeats (K1 to K5), clone checkouts with a merge gate (K7), a scheduler that models rate limits (K6).
- Deny-by-default reads, a secrets broker, an authenticated proxy for all egress (C2 to C4); Windows and fail-closed Linux (C1, C6).
- The plugin manifest for tools, roles, hooks and checks (section 12).
