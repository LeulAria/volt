# Round 8, agents (82): one adapter process for every Claude chat; A10 and A7's agent side

Status: **final** (release `r8` rows taken by the coordinator on 16 November). Branch `e8/agents` from `3b41bdb483f`. ADEMark method,
unofficial. No live model turn was used: every run is on ADEMark's replay server.

## What changed

### One adapter process for every Claude chat (`253d3f4a90b`, `0b2bd1dbb92`, `50a46a12e8d`, test `d86b1ca3d9a`)

Before: every chat started its own `claude-agent-acp` Node process, inside the chat's sandbox, and that process
started the chat's Claude Code CLI. Five chats streaming = five adapters, about 384 MB of A7.

Now: Volt's stdio service runs **one adapter host** (`node --import <preload> --input-type=module -e <host> <entry>`)
per adapter launch and spawn environment. The host loads the adapter once and opens one ACP connection per chat over
in-memory streams, each with the adapter's own agent object. The stdio service gives every chat a **virtual process
id**, so `acpProvider.ts` still sees a process per chat (`write`, `kill`, `onData`, `onExit`, and every sandbox call by
id); its only change is passing `acpHost: { entry }` on the spawn.

Files: `src/vs/platform/voltStdio/common/acpSharedHostSource.ts` (the host program), `node/acpSharedHosts.ts` (the
service side), `node/voltStdioService.ts` (`spawnFor`, `startChild`, the delegate), `common/voltStdio.ts` (the spawn
option and the setting), `voltSandbox/node/sandboxLauncher.ts` + `agentStateOverlay.ts` (`joinState`),
`voltRuntime/browser/agents/cliAgents.ts` (`acpSharedHostEntry`) and `acpProvider.ts` (one line).

What keeps the chats apart, with the adapter now outside every chat's sandbox:

| Concern | How it is held |
|---|---|
| The chat's CLI and every tool it runs | Started by the stdio service through **the chat's own sandbox launch**, by the same code that started the chat's adapter before (`startChild`: prepare, attest, confirm before the go byte). The host only relays its stdio. |
| The host starting anything itself | It cannot: `child_process.spawn` and `execFile` are replaced before the adapter and the Agent SDK load. A spawn in a chat's context (the CLI, `claude auth status`, `git worktree list`) goes to the service and into that chat's sandbox; a spawn outside a chat's context, and every synchronous or shell spawn, is refused (`EPERM`). |
| Sandbox calls by process id (ACP `fs/*` broker, `sandboxAllows`, denial reads, state sync after a turn, allowed domains) | Registered under the chat's virtual id, pointing at the launch of the chat's CLI. A sandboxed chat with no CLI running is refused (fails closed), as an unknown process was. |
| The chat's config overlay (`CLAUDE_CONFIG_DIR` per sandboxed chat) and environment | `process.env` and `process.cwd()` in the host read those of the chat whose code is running (`AsyncLocalStorage`): for a sandboxed chat, its sandbox launch's environment, resolved when its connection opens. Every process of the chat joins the overlay that open prepared (`joinState`: no fresh seed under a running CLI). |
| Another account (another config folder in the spawn environment) | Another host: the host's key is the launch plus its spawn environment. |
| The adapter's own file access (settings, session files, diff previews) | `fs` calls in a sandboxed chat's context are checked against that chat's resolved policy (reads exactly as `resolvedPolicyAllows`, plus what the OS sandbox adds: metadata of any path not denied, and the policy's `list` folders; writes a subset). After startup, code outside any chat's context may only read. |
| One chat's CLI dying | Its exit is relayed to its own connection only (the adapter reports the lost transport for that session, as before). |
| An exception nobody caught in one chat's adapter code | Closes that chat's connection; the host and the other chats stay. |
| The host dying | Every chat it served ends as its own adapter process would have; each resumes on a new host at its next message. |
| An adapter version that cannot be served this way | The host exits before `ready`; that launch runs a process per chat, as before. `volt.agents.sharedAdapterHost: false` does the same for every launch. |

The host is stopped 2 s after its last chat closed, so with round 7's 20 s idle stop nothing of it is alive in A10's
window.

What the design does not hold, stated plainly: the adapter (third-party code) now runs unconfined for sandboxed
chats too, as it always did for unsandboxed ones. Its inputs from a sandboxed chat are the CLI's messages. The two
ways those could reach outside the sandbox are closed in the host itself (no process starts there, file access by
the chat's policy), by replacing Node's `child_process` and `fs` entry points, not by the OS. A second OS-level
profile around the host (no exec, no network, no write) would make that independent of the JavaScript layer; it is
not built (see "Left open").

### Proof

- `src/vs/platform/voltStdio/test/node/acpSharedHosts.test.ts` (a stand-in adapter, fake service): two chats on one
  host with their own environment, folder, CLI and file rules; `execFile` relayed and marked a helper; what the
  adapter writes before its process is up is not lost; another environment is another host; an adapter that cannot
  be shared falls back; an uncaught exception ends one chat; the host's file check against `resolvedPolicyAllows`
  over a matrix of policies and paths.
- `src/vs/platform/voltStdio/test/node/acpSharedHostSandbox.test.ts` (the real stdio service and the real Seatbelt
  sandbox, `ISOLATION-1`): three chats on one host, two sandboxed with their own workspaces and one unconfined.
  Each sandboxed chat's process writes its own workspace, **cannot write** the other's workspace or the home folder,
  **cannot read** the policy's sentinel; `sandboxAllows`, `sandboxReadFile` and `sandboxWriteFile` judge by the
  chat's own launch; the adapter's own read and write in the host follow the chat's policy; one chat's process
  killed leaves the others running; a stopped chat ends alone and its resumed connection is sandboxed again; the
  host stops with its last chat. The setting off starts a sandboxed process per chat as before.
- The existing sandbox suites still pass (`voltStdioSandbox`, `voltStdioSandboxFiles`, `voltStdioBuildEntry`: 23).
- In the app (dev build, sandbox on by default, ADEMark's replay): seeded threads and A7's five streams run through
  one host; the log shows every CLI attested by Seatbelt under its chat's id (`[volt-sandbox-spawn] <id> attested`).

## Numbers

ADEMark method, unofficial. Release arms: `base` (`039a70b7208`, before round 7), `r7` (`3b41bdb483f`, this round's
base), `r8` (the combined round 8 build). Medians; n, range and the 1-minute load with every row. Rows:
`data/agents/{a5,a7,followup}.jsonl`.

`r8` = `3c920df8444` (built 16 November 01:29). Rig `r8run.sh <arm> ["a5 a10"]`, every sample gated on a 1-minute
load of 14 or less. r7 and r8 interleaved on 15-16 November; r7's row of 10:08Z is from the first r7 session.

| Column (ADEMark formula) | r7 | r8 | T3 Code (board) |
|---|---|---|---|
| **A10 per thread**, (app with 20 threads - app with 5) / 15 | 6.5 MB (n 3; 4.9-16.8) | **3.1 MB** (n 3; 2.9-3.2) | 5.3 MB |
| A5 at rest, app (this rig) | 554 MB (n 3; 543-597) | 539 MB (n 3; 539-539) | |
| A10's 20-thread sample, app | 651 MB (n 3; 616-849) | 586 MB (n 3; 582-587) | |
| A7 total p95 (this rig, one row each tonight) | 3,120 MB (and 2,882 on 15 Nov) | 2,314 MB | 2,289 MB |
| A7 app / agents at the p95 tick | 2,254 / 891 | 1,555 / 800 | |

- **A10 beats T3 Code's 5.3 MB on every r8 pair** (2.9, 3.1, 3.2). On the board it would be second, behind Zeron's 2.1.
  r7's 16.8 pair is the one where 149 MB of agent processes were still alive at the 20-thread sample (its stop had
  not run yet); r8 had none alive in any pair.
- **A7 (render's block, n 3 per arm, 02:27-03:13 +04): 2,830 to 2,295 MB.** The adapters at A7's p95 tick: r7 402
  MB (5 processes), r8 90 MB (one host). The 5 Claude CLIs are 795-802 MB on both; MonoCode's whole A7 is 1,533.
- First word of a new chat's first prompt 120 s after launch (`fwblock.sh r7 r8 3`): r7 397 ms (n 3; 383-410), r8
  383 ms (n 3; 378-405); no regression. Memory at rest with the new chat's landing in front: r7 597, r8 596 MB.
- A4 (new chat, Enter to first word, typing's rig): r7 1,029, r8 719 ms (n 12 each): the shared host takes about
  330 ms off a cold start. Every A4 run started a cold agent: see 81-typing.md.

### Follow-up after the 20 s agent stop

Enter to the answer's first word painted, for a message sent 30 s after the chat's last reply (`followup.mjs`):
`gap 400` clicks the composer, types and presses Enter 400 ms later (the warm-up's head start); `gap 0` presses
Enter at once; `reading` is `gap 0` with the pointer moving over the reply during the 30 s.

| Arm | gap 400 | gap 0 | gap 0, reading | Agent at Enter |
|---|---|---|---|---|
| base (15 min keep) | 198 ms (n 4, 193-235) | 193.5 ms (n 4, 191-197) | not run | live |
| r7 (20 s stop) | 381.5 ms (n 4, 338-410) | 825 ms (n 4, 755-865) | not run | stopped, resumed (pool) |
| devbase (dev build of r7) | 468.5 (n 2, 462-475) | 1059.5 (n 2, 937-1182) | 817.5 (n 2, 797-838) | resumed |
| dev (this branch) | 310.5 (n 2, 304-317) | 780 (n 2, 633-927) | 293 (n 2, 274-312) | resumed; reading: live |
| **r7, release, 16 Nov** | 650.5 ms (n 4, 641-702) | 1,003 ms (n 4, 993-1,061) | 996.5 ms (n 4, 982-1,040) | stopped, resumed (pool) |
| **r8, release, 16 Nov** | **407.5 ms** (n 4, 343-454) | **807 ms** (n 4, 773-852) | **298 ms** (n 4, 295-301) | resumed; reading: live |

The last two rows are one block (`FUBLOCK_READER=1 fublock.sh "r7 r8" 2 2`, 02:08-02:26 +04 on 16 November, loads
4.2-8.8), r7 and r8 interleaved; `r8` is `3c920df8444` (all three round-8 branches).

Loads 5.1-13.9. Rows of 11:53-11:58Z (base and r7, round 1) are marked invalid: another agent's test windows
were in front then; they were taken again.

On the release builds, r8 takes 243 ms (gap 400) and 196 ms (gap 0) off r7's follow-up, and for someone reading the
reply with the pointer it is back at base's level (298 against 996.5 ms on r7, base 193.5-198 with its agent live).

**Round 7's 20 s stop costs a follow-up 184 ms (gap 400) to 632 ms (gap 0) on release builds** (r7 against base).
What it costs is Claude Code's cold start: the adapter's `session/resume` waits for the CLI's initialization. The
shared host shortens the resume (dev against devbase: 158 ms at gap 400, 280 ms at gap 0: no adapter process to
start). `da2ce56e59d` removes the cost for someone who reads the reply with the pointer or the wheel (293 against
817.5 on the dev builds, the agent still live). A follow-up pasted and sent without touching the window for 30 s
still pays the resume; keeping the agent 15 minutes again would give A10 back (the host and a CLI alive at rest).

## Left open

- **An OS-level profile around the shared host** (no exec, no network, no writes outside Volt's own folders): the
  host's limits are enforced in JavaScript today, by replacing `child_process` and `fs` before the adapter loads.
- **A7's agent side is the 5 Claude CLIs** (795-802 MB at the p95 tick): the adapters are down to one host (about
  90 MB). What is left is the CLI's own weight (brief item 4, not reached this round).
- **The follow-up after the 20 s stop** without pointer movement: 407.5 ms (gap 400) and 807 ms (gap 0) on r8,
  against 198 / 193.5 ms before round 7. Closing it means resuming faster or warming on a signal other than the
  pointer; going back to the 15-minute keep-alive would give A10 back.
