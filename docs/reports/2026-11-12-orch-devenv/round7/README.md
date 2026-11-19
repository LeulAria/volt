# Round 7 (2026-11-15): A7, A10, typing lag, relaunch, idle CPU, stopped before timing

The user's request: "improve Volt on A7 under load and A10 per thread and other missing ones fix". Five agents
started at 11:15 from `039a70b7208` (rounds 1-6 merged), one per area. All five stopped together at 12:27 and could
not be resumed, and the user chose to stop round 7 there.

**Status: stopped.** Every fix below is committed, reviewed by the coordinator, unit-tested and merged into
`volt/8fb8291c`. **None of them has a timed before/after row.** The shared "before" release build of
`039a70b7208` was finished (12:04); the "after" release builds and every timed run were cancelled. The few numbers
below are dev-build probes the agents took while they worked (n 1, no timing lock), not ADEMark results.

The Claude account was at 97 % of its 7-day limit (overage off) when round 7 began; no live model turns were used.

## What is merged, by area

### Agents: A10 per thread, A7's agent processes (`e7/agents`)

| Commit | Change |
|---|---|
| `91e01c51d04` | Claude Code runs Volt's hook module on its own thread (`CLAUDE_CODE_HOOKS_SAME_THREAD=1`) instead of in a Worker, a second JS heap in every CLI |
| `f9c40ecbff1` | An idle agent that can resume stops 20 s after its last turn, **the chat in use's too** (was 15 min); it comes back on the first sign of a message: opening the chat, the pointer on the composer, focus, typing |
| `0aaebae910e` | The agent server collects its heap 10 s after the last run ends (`--expose-gc`) |
| `c0a0b806eed` | A stopped code index answers status from its manifest on disk, without forking |
| `a9c5853c8a7` | A project with under 1,000 git-tracked files finds its send context with ripgrep, without starting the code index |
| `e08c0c78a3a` | The agent server watches chats' work trees in process (FSEvents), without a watcher process |
| `7682fb55e92` | A stale notes block is re-read only when a note file changed |
| `5ec8ad7cf3a` | An empty notes folder is no change to the notes |
| `4955f6bf489` | A paste no longer starts the Tab predictor's agent |

Dev probes (n 1):
- One Claude CLI at rest on ADEMark's A7 stream: 181-190 MiB before, 146 MiB after. The bare CLI is 131-134 MiB.
  The requests to the model are byte-identical.
- The agent server 30 s after 15 seeded chats: 254 MiB before, 231 MiB after. Its heap: 168 MB before, 99 MB after.
- No adapter is left alive 30 s after the last seed.

**Not measured, and the one real trade:** a follow-up sent more than 20 s after a reply now resumes a stopped agent.
The warm-up on intent should hide that resume, but the follow-up timing (`followup.mjs`, before vs after) never ran.
If follow-ups feel slower, revert `f9c40ecbff1` alone.

### Render: A7's GPU and renderer (`e7/render`, draft report [62-render.md](62-render.md))

| Commit | Change |
|---|---|
| `ba677355e66` | The thread's bottom fade mask comes off while only empty space is under it; same pixels, one GPU surface fewer |
| `35879102a0d`, `9ee03e1113b` | The fade stays while the side toolbar's card reaches it, and a toolbar shown as its own column does not hold it |

Found, not changed:
- **The three TypeScript helper processes (about 175 MB in A7) are started by Volt's own edit check.** A `Read` of
  a `.ts` file warms TypeScript so a later edit can tell which errors it added.
  - Moving the warm-up to the edit would leave the first edit in a cold window without its check (cold start to
    first diagnostics 5.7 s here, against the edit's 1.5 s wait).
  - A fallback check limited to the edited lines would miss errors in callers.
- **A 128 MB GPU tile budget cut A7's GPU peak from 748 to 653 MB** (n 1 pair). It is one process-wide cap with a
  blank-tile risk on large displays, so it is not shipped.

Dev probe: GPU shared images at rest 126 -> 101 MiB (1175x705 window).

### Typing: A8 typing lag (`e7/typing`, draft report [63-typing.md](63-typing.md))

| Commit | Change |
|---|---|
| `7f8f1fe21d9` | A key's frame in the composer does not also paint the streaming reply: the reply's paint waits one frame after a keystroke |
| `6f4855e4e13` | Plain prose added to a streaming reply's open block grows it in place, instead of a re-render of the block |
| `6d046f6c06e` | The composer's ghost-text context reads replies only as far as its cut |
| `1df9f9b5f30` | A send or a restored draft does not hold the thread's frame for input first |

Not measured: no release-build A8 row was taken (round 6's dev rows: p95 105.9 -> 97.6 ms, before these).

### Launch: A2 relaunch (`e7/launch`, draft report [64-launch.md](64-launch.md))

| Commit | Change |
|---|---|
| `4e1691b1700` | The launch page's view starts loading before its window is built |
| `4d799b6ca27` | With a launch window, the main bundle loads after the launch page has its files, from Node's compile cache |

Not merged: an uncommitted experiment, the workbench preload after the snapshot's first frame, was left in the
agent's worktree. Not measured: the after build was cancelled at 12:30. Round 6 ended at A2 Ready 701 ms, against
Diri's 670.

### Idle: A6 idle CPU, A5 at rest (`e7/idle`)

| Commit | Change |
|---|---|
| `25327dc003f` | An idle window stops re-sending its awake lease, and main stops ticking without work |
| `c95e8992aa8` | Heartbeat IPC calls (`reportWorkspaceActivity`, `setLease`) no longer wake main's stall monitor (10 Hz for 10 s after any IPC call) |
| `f93f7dffaff` | Background pull-request discovery stops re-reading checkouts it cannot search |
| `7a785c34068` | The launch's first focus keeps the checkout discovery just read |

Dev probe, 5 min after ready: main's stall-monitor callbacks went from 2.28 to 0.51 per second. Found, not traced:
the JSON language server runs in every round-6 release row.

### Coordinator

- `6f93c4a109d`: the work-tree watch test failed on every run on this machine. FSEvents replays what happened just
  before a stream starts, and the test counted that replay as a write under `.git`. The watcher itself is right: a
  write under `.git` reports only `.git/...`, which the filter drops. The test now counts from after the first
  delivery.
- Round 6's index (`../round6/README.md`) is complete. The first-word, launch and idle reports are final.

## Verification

- `npm run compile-check-ts-native`: clean on the merged tree.
- Unit tests of every suite round 7 touched, on the merged tree (`volt-e5-base` at `69073864ed2`, transpiled):
  - 13 browser and common files: 138 passing.
  - 3 Node files: codeIndexStatusOnDisk 2, serverCheckpoints 3 (after the test fix, three runs), serverMemoryReducer 4.
- Not run: the full unit suite, and any check in the app of the merged tree.

## Open

- Time every fix above on release builds: the before build is at `~/.volt-r7/min/base/VOLT.app`, and
  `~/.volt-r7/min/build-all.sh` builds the combined after build.
- The follow-up latency after the 20 s agent stop (`f9c40ecbff1`).
- Decisions for the user: the 175 MB TypeScript warm-up on `Read`, the GPU tile budget, and the thread's fade
  mask while content is under it (60-100 MB GPU per visible chat).
- One adapter process for several chats was not reached: sandbox and account are per adapter process.
- The orchestration C1 queue resumes after the weekly limit resets (Wed Nov 18 17:00).
