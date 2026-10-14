# Volt agent server: architecture and build plan

Started 2026-10-05. Branch `volt/agent-server` (worktree `../volt-server`).

## 1. Goal

Today the agent runtime runs in the agent window's renderer. Closing the window kills every run. We move the runtime
into one long-running Node process per Volt profile, the **agent server**. The desktop window and a new web app are both
clients of it.

Constraints from the brief:

- Same orchestrator, same runtime code. The server *hosts* the existing services. It does not reimplement them.
- The desktop shows no visible change.
- The web app looks and feels like the agent window and reuses Volt's components and CSS wherever they run outside the
  workbench.

## 2. What the research found

**T3 Code** (`.aInsp/t3code/apps/server`, `packages/client-runtime`):

- One server process per machine. The desktop spawns it with Electron as Node (`ELECTRON_RUN_AS_NODE=1`). It binds
  `127.0.0.1` in desktop mode. Opt-in launchd/systemd keep-alive comes from `t3 service install`.
- There is one WebSocket. Every command is `dispatchCommand` with a client `commandId`, which makes it idempotent.
- Events are stored in SQLite under one global `sequence`. A client resubscribes with `afterSequence`. The server
  subscribes before it reads the high-water mark. It then either replays the gap or, when the gap is too big or the
  cursor is invalid, sends a snapshot.
- Streaming text is not a raw delta channel. The server folds it into messages and publishes throttled
  `message.updated` events.
- On restart, running work is reconciled to cancelled/interrupted. Pending approvals expire.
- The client reconnects with jittered exponential backoff and resets after a stable connection. It dedups with
  `sequence <= last`.

**Volt runtime** (`services/voltRuntime`):

- `common/**` is pure. The orchestrator core (`runOrchCommand`, projector, codec) has no DI.
- `browser/**` services need the following:
  - Node-capable: IFileService, IRequestService, ILogService, IEnvironmentService.
  - Owned by the main process: IStorageService and ISecretStorageService.
  - Workbench-only: ISearchService, ITextFileService, code intel (markers/LSP), and ICommandService for browser tools.
  - `voltStdio`, `voltGit`, `voltPullRequests`, `voltUsage` and `voltHostMcp` already have Node implementations
    (`platform/volt*/node|electron-main`) that the renderer reaches over IPC.
- **Turn running and transcript recording live in the UI layer.**
  - `AgentTurnHostContribution` starts turns through a headless `AgentEditorInput`.
  - `AgentSessionController` folds `IVoltEvent`s into `IAgentMessage`s and is the only writer of chat history.
  - Checkpoints, PR watches and the host MCP bridge are also UI-layer contributions.
  - All of these have to run in the server.

**Volt UI** (`contrib/voltAgent/browser`):

- These are plain DOM and need only a hand-built render context:
  - transcript rows (`agentTranscript` model and view)
  - block renderers
  - markdown, KaTeX, mermaid and code cards
  - to-do card
  - question tray
  - home model
  - menus
- The composer input (Monaco), the diff card (Monaco diff editor) and the home tree (`WorkbenchObjectTree`) are tied
  to the workbench. They have to be rebuilt in DOM on top of the same CSS and pure models.

## 3. Architecture

```text
             ┌──────────────── Volt desktop (Electron) ─────────────────┐        ┌──────── Web app (browser) ────────┐
             │ main: VoltAgentServerMainService                          │        │ out-volt-web/ (esbuild bundle of   │
             │   ensureRunning() → launchd job, token, runtime.json      │        │ src/vs: transcript view, block     │
             │ renderer (agent window, same UI)                          │        │ renderers, markdown, tasks card,   │
             │   Remote* services implement the SAME interfaces:         │        │ question tray, home model, CSS)    │
             │   IAgentRuntimeService · IAgentOrchestratorService ·      │        │ + DOM composer / picker / sidebar  │
             │   IAgentHistoryService · IVoltSessionContextService ·     │        │   / diff card on the same CSS      │
             │   session mirror behind AgentEditorInput.controller       │        │                                    │
             │   client capabilities: browser tools, code intel, open    │        │                                    │
             └──────────────────────────────┬────────────────────────────┘        └────────────────┬───────────────────┘
                                            │ ws://127.0.0.1:<port>/ws  (token, protocol v1)         │ same protocol
                                            ▼                                                        ▼
 ┌──────────────────────────────── Volt agent server (Electron-as-Node, launchd KeepAlive) ─────────────────────────────┐
 │ HTTP: /ws · /health · /  (web app assets)            runtime.json + token in <userData>/agentServer/                  │
 │ ┌ Protocol layer (platform/voltAgentServer) ─────────────────────────────────────────────────────────────────────────┐ │
 │ │ hello/welcome (epoch, head seq, resume) · call/result · server→client call (capabilities)                         │ │
 │ │ EventLog: one seq per server epoch, ring buffer (count + bytes); replay gap or tell client to resync             │ │
 │ │ Replicated collections (catalog/profiles/status, orchestrator threads+tasks, history index, projects,            │ │
 │ │ questions) → put/delete events; session streams → message patches (throttled 50 ms)                             │ │
 │ └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
 │ ┌ Hosted services (the existing code, instantiated with Node DI) ──────────────────────────────────────────────────┐ │
 │ │ AgentRuntimeService (+ agentPool, ACP/Codex/OpenCode/DeepSeek providers) · AgentOrchestratorService (decider)    │ │
 │ │ AgentHistoryService · VoltSessionContextService · VoltHostToolService · AgentWorktreeService                      │ │
 │ │ Session host: AgentTurnHost + AgentSessionController + history recording (headless, today's code)                 │ │
 │ │ Checkpoints · PR watches · host MCP HTTP (in-process) · usage                                                     │ │
 │ └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
 │ Node platform: disk IFileService · node IRequestService · stdio (child_process) · git · gh · ripgrep search ·       │
 │ SQLite IStorageService (imported once from the desktop's state.vscdb) · Keychain secrets · settings.json config     │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   Files shared with today's desktop: <userData>/User/agentSessions/**, User/voltOrchestrator/**, refs/volt/*, ~/.volt/worktrees
   (the server becomes the single writer; the client never instantiates them)
```

### 3.1 Process and lifecycle

- **Entry:** `src/volt-agent-server-main.ts`. It bootstraps like `server-main.ts` and then loads
  `vs/server/volt/agentServerMain.js`.
- **How it runs:** Electron as Node, so native modules (`@vscode/sqlite3`, `node-pty`) match the app's ABI.
- **One server per user-data dir.** The launchd label is `com.volt.agent-server.<hash(userDataDir)>`. A test profile
  gets its own server, port and token and never touches the main profile's.
- **macOS:** the main process writes `~/Library/LaunchAgents/<label>.plist` and boots it with
  `launchctl bootstrap gui/<uid>`:
  - `RunAtLoad`
  - `KeepAlive: { SuccessfulExit: false }`: launchd restarts a crash, while a requested stop (exit 0) stays stopped.
  - logs go to `<userData>/logs/agent-server.log`.
- **Other platforms:** a detached child process.
- **Discovery:** the server writes `<userData>/agentServer/runtime.json` = `{pid, port, host, epoch, version, startedAt}`
  atomically after it starts listening. `ensureRunning()` reads it, checks the pid and `GET /health` (which needs the
  token), and otherwise (re)bootstraps the job and waits for the file.
- **Restart in place:** `launchctl kickstart -k`. The desktop has commands to restart and stop the server.

### 3.2 Auth and binding

- **Token:** 32 random bytes in hex, stored in `<userData>/agentServer/token` (mode 0600) and created on first start.
- **Binding:** `127.0.0.1` by default; `--host` widens it.
- **WebSocket upgrade:** checks `Origin`. It accepts:
  - no origin (Node clients)
  - the server's own origin (the web app)
  - `vscode-file://vscode-app` (the desktop renderer)

  The first frame must be `hello` with the token. Anything else closes with 4401.
- **Web app:** opened as `http://127.0.0.1:<port>/#token=<token>`. The hash never reaches the server in a request. The
  app moves it to `sessionStorage` and strips it from the URL.
- **Assets:** `/` and the asset paths are public, because they are only code. Everything that touches state goes over
  the authenticated socket.

### 3.3 Protocol (v1, JSON text frames)

```ts
// client → server
{ t: 'hello', protocol: 1, token, client: { kind: 'desktop'|'web'|'test', capabilities: string[] }, resume?: { epoch, seq } }
{ t: 'call', id, method, params }                 // method = '<service>.<member>' from the allowlist
{ t: 'ret', id, ok, result?, error? }             // answer to a server→client call
// server → client
{ t: 'welcome', epoch, seq, resumed, serverVersion }  // resumed=false ⇒ client must load snapshots
{ t: 'ret', id, ok, result?, error? }
{ t: 'evt', seq, topic, data }                    // seq is contiguous within an epoch
{ t: 'call', id, method, params }                 // capability calls (browser tools, code intel, open surface)
```

- **Epoch:** a random id per server boot. Durable state lives in the history and orchestrator files, so after a
  restart clients resync from snapshots instead of replaying a log.
- **Within an epoch:** `seq` is contiguous. A client that sees `seq != last + 1` reconnects with `resume`, which is
  how gaps are detected.
- **Resume:** the server answers `resumed: true` and replays `(seq, head]` from the ring buffer when it still holds
  that range. Otherwise it answers `resumed: false`.
- **Snapshots:** `state.snapshot` returns every replicated collection plus the `seq` it was taken at. Node is
  single-threaded and the socket is ordered, so the snapshot and the events after it can never interleave wrongly.
  That gives the same guarantee as T3's subscribe-before-read.
- **Topics:**

| Topic | Payload |
|---|---|
| `col` | `{ col, put?: Record<key, value>, del?: key[] }`. Collections: `runtime`, `questions`, `access`, `orch.threads`, `orch.tasks`, `history`, `projects` |
| `session` | `{ id, rev, len, set: [{ i, message }] }` (message patches) and `{ id, change }` (turnStart / runEnd / usage) |
| `runtime.event` | `IVoltEventEnvelope` |
| `hostTools` | tool-invoked events |

  `runtime.event` is only sent to clients that subscribe to raw events. Desktop parts such as the status line and the
  edits tracker still read raw events.
- **Methods:** `<service>.<member>` from a server-side allowlist that maps 1:1 onto the existing interfaces, for
  example:
  - `orchestrator.submit`, `orchestrator.dispatch`, `orchestrator.cancel`
  - `runtime.respondToQuestions`, `runtime.respondToAccessRequest`, `runtime.setModeProfile`
  - `history.rename`, `session.open`

  A typed wrapper (`AgentServerApi`) covers the brief's verbs: send, steer, queue, interrupt, approvals, questions,
  model and mode.

### 3.4 Transcript ownership: the server folds, clients render

The server runs today's `AgentSessionController` for every live session, headless as it already can. It also writes
history, as it does today.

After each controller change the server publishes a patch: the messages that changed (diffed by serialized JSON),
coalesced to at most one patch every 50 ms. `turnStart` and `runEnd` flush immediately.

A client opening a chat calls `session.open(id)`, which returns `{messages, rev, seq, contextUsed, contextWindow}`,
then applies patches. On the desktop, `AgentEditorInput.controller` becomes a `RemoteSessionController` that keeps
`input.messages` in sync and fires the same `onDidChange` kinds. That way `agentEditor.ts` renders exactly what it
does today.

Desktop and web render the same message objects, which is why their rendering matches.

### 3.5 Replicated state (client mirrors behind the existing interfaces)

`Remote*` services answer synchronous getters from mirrored collections and send writes as calls. The getters are
`listCatalog`, `getThread`, `list()`, `getPendingQuestions`, `canSteer`, and so on. `whenReady` resolves after the
first snapshot.

The server publishes collection deltas from the services' own `onDid*` events. It diffs by JSON so a value that did
not change is not sent again.

### 3.6 Things that only a client can do (capabilities)

The server asks a connected client that advertised a capability. When none is connected, the call fails with a clear
error.

| Capability | Used for |
|---|---|
| `browser` | `browser_*` host tools and snapshots (desktop webview) |
| `codeIntel` | markers and LSP for the code-intel tools |
| `surface` | opening a preview or file when a run asks for one |

`ITextFileService` writes go straight to disk on the server. The desktop's file watcher reloads the open editors.

### 3.7 Node services in the server

| Service | Server implementation |
|---|---|
| IFileService | `FileService` + `DiskFileSystemProvider` |
| ILogService | file logger in `<userData>/logs/agent-server.log` |
| IRequestService | node `RequestService` |
| IConfigurationService | file-based, reads `User/settings.json` |
| IStorageService | SQLite (`vs/base/parts/storage/node`) in `<userData>/agentServer/` |
| ISecretStorageService | macOS Keychain (`security`) |
| IVoltStdioService | main-process implementation with the window lifecycle removed |
| IVoltGitService, IVoltPullRequestService, IVoltUsageService | their `node/` implementations |
| voltHostMcp | the existing HTTP server, called in-process |
| ISearchService | adapter over `RawSearchService` (ripgrep) |
| IWorkspaceContextService | empty workspace (roots come from projects) |
| IPathService, ILifecycleService | small server versions |

- **Storage import:** on first start, `volt.runtime.*` and `volt.agent.*` keys are imported once from the desktop's
  `globalStorage/state.vscdb`.
- **Secrets import:** the desktop client pushes the provider keys it holds once (`secrets.import`).

### 3.8 Restart behavior

The orchestrator's existing `recover` command runs. Active turns settle as interrupted, queues pause, and open inputs
close, which matches today's window-reload behavior. History keeps the partial reply, which is flushed every second.
Clients see a new epoch, resync, and show the chat with its progress and an interrupted turn they can resume.

## 4. Stages

| # | Stage | Done when |
|---|---|---|
| 0 | Worktree, own watcher, plan | builds in `../volt-server` without touching the main checkout |
| 1 | Protocol: frames, EventLog + replay decision, client connection (backoff, resume, gap detection), WS server, replicated collection store | unit tests for protocol, ring buffer, resume/resync, gap → reconnect, backoff |
| 2 | Server host: Node DI composition, platform services, hosted runtime + session host, launchd, auth, runtime.json | Node test client sends a prompt; events stream; history written; survives client disconnect |
| 3 | Desktop client mode: main-process `ensureRunning`, `Remote*` services, `RemoteSessionController`, UI contributions skip runtime work, capability handlers | test window renders the same; run continues after ⌘Q; reopen shows full progress |
| 4 | Web app: bundle, shell (home, sidebar, transcript, composer, pickers, approvals, questions, to-do, diff card) | side-by-side screenshots match; web starts tasks and follows threads live |
| 5 | E2E: ⌘Q mid-task, web→desktop live stream, server restart mid-task, resync after reconnect | all pass on a fresh profile with seeded chats |

## 5. Testing rules

- Fresh `--user-data-dir` under `/tmp/vas-*`, CDP port 9777, seeded chats.
- The test window is named in every report.
- The main window and the main profile's server are never touched.
- Remove the test launchd jobs afterwards (`launchctl bootout` and delete the plist).

## 6. Status (2026-10-05)

All five stages are built on `volt/agent-server` (uncommitted).

**What deviated from the plan**
- In dev, launchd can't run the server: macOS privacy (TCC) blocks a launchd job from reading a checkout under Desktop, Documents, Downloads or iCloud. When the app root is in one of those folders, Volt spawns the server as a detached child instead. It still outlives the window, but nothing restarts it after a crash until a window reconnects. `VOLT_AGENT_SERVER_LAUNCHD=1|0` forces the choice.
- Client mode is behind `volt.agentServer.enabled` (default off). With it off, the window runs the in-process runtime as before.

**Packaging**
- `volt-agent-server-main.js` is a bundled bootstrap entry point.
- `compile-volt-web` (`build/volt/buildAgentWeb.mjs --minify`) runs in every `vscode-<platform>-<arch>` task, and `out-volt-web/**` ships next to `out/`.
- The server finds both through `FileAccess`, so it works bundled and from a checkout.

**Verified end to end** (test profile `/tmp/vasd`, desktop CDP 9851, headless Chrome 9852)
- ⌘Q mid-task: the task keeps running and the web app follows it live. Reopening Volt shows the full progress.
- A task started on the web streams live in the desktop window.
- `kill -9` of the server mid-task: Volt respawns it under a new epoch and both clients resync. The run shows as Interrupted, keeps its progress, and Resume works from either client.
- Desktop and web screenshots of the same chats match: markdown, KaTeX, tables, mermaid, code highlighting, to-dos, the worked fold and file cards.

**Known gaps**
- Code intelligence (`codeIntel`) isn't forwarded from a window yet, so the agent can't use LSP results through the server.
- Image resizing uses `OffscreenCanvas`, which Node doesn't have. Images are sent at their original size.
- The web app has no git-backed composer chips ("Changes +N", "Commit & Push"), no macOS vibrancy, and none of the window's titlebar icons.
- The composer to-do card and other uncommitted work in the main checkout aren't on this branch; merge before shipping.

## 7. Third client: the Volt mobile app (2026-10-05)

The clients are **Volt** (desktop), the **web app**, the **mobile app** and **Volt Agents** (the standalone Electron app, §8), all connected to the same server.

```
            Volt agent server (one per profile)
     ws /ws  ─────────┬────────────────┬──────────────────┐
                      │                │                  │
   Volt (desktop)  ───┘   web app ─────┘   mobile app ────┘ (Expo, iOS/Android)
   remote services        remote services   AgentClientServices (same code, bundled DOM-free)
   window's components    window's components  native shell: home, pickers, composer, pairing
                                             transcript: the web app's thread view in a WebView (?embed=thread)
```

**What the clients share**
- **Client logic:** `services/voltAgentServer/common/agentClientServices.ts` holds the connection, the mirrored services, the send path, home rows and the status label. Web and mobile both use it; mobile gets it as a bundle built by `build/volt/buildMobileCore.mjs`.
- **Transcript:** the mobile app embeds the web app's thread view, so markdown, KaTeX, mermaid, code cards, tool rows, approvals and the question tray are the same components on all three clients.
- **Brand:** Geist Mono for all typography (desktop agent window, web and mobile) and the Volt logo (`brand/volt-icon.svg`) as the app icon, the web favicon/sidebar mark and the mobile header/pairing mark.

**Taken from T3 Code's mobile app (MIT)**
- The pairing URL format (`http://host:port/#token=…`), parsed by T3's `pairing.ts` logic.
- Foreground and network wake-ups that skip the reconnect backoff.
- The layout of the home rows, thread screen, composer and the pairing screen.

T3's screens are bound to its Effect atoms and native modules (nitro markdown, native composer), so they are rebuilt against Volt's client services instead.

**Pairing**
- In the simulator, the app reaches the server at 127.0.0.1.
- A phone needs the server to listen on the network: setting `volt.agentServer.host` = `0.0.0.0`. **Volt: Pair Mobile App** then shows the pairing URL as a QR code.

**Tests**
- Simulator iPhone 16, driven with agent-device.
- Start and follow a task from each of the three surfaces and check the other two stay in sync live.
- Quit Volt mid-task, then follow it from web and mobile.
- Restart the server mid-task and check all three come back.

## 8. Volt Agents (standalone Electron app) and usage-limit recovery (2026-10-05)

### Volt Agents (`apps/desktop`)

A small Electron app that shows the web app in a native window, without the editor or workbench. Tasks started in it run on
the shared server, so Volt, the browser and the phone see them live.

- **Server:** `AgentServerLauncher` (`platform/voltAgentServer/node/agentServerLauncher.ts`) finds or starts the profile's
  server. Volt's main process uses the same class (`VoltAgentServerMainService` delegates to it), so whichever app comes
  first starts the server and the other reuses it (same `appRoot` → same server, checked in the e2e test).
- **Profile:** the same folder Volt resolves (`code-oss-dev` out of sources, `VOLT` packaged). Override with
  `--volt-user-data-dir=` or `VOLT_USER_DATA_DIR`; `--volt-app-root=` / `--volt-electron=` point it at another Volt build.
- **Window:** `hiddenInset` traffic lights and `under-window` vibrancy like the agent window. The preload exposes only
  `window.voltShell` (platform + menu commands); the page adds `volt-shell` (transparent page, mark moved right of the
  traffic lights, draggable title strip).
- **Taken from T3 Code's desktop app (MIT):** `parseSafeExternalUrl`, same-origin navigation guard, restart backoff
  (`navigation.ts`), and its window-bounds persistence pattern (`windowState.ts`). Single-instance lock added (T3 has none).
- **Watchdog:** while a window is open, a dead server is started again (the page's own socket reconnects).
- **Run:** `node build/volt/buildAgentDesktop.mjs && node_modules/.bin/electron apps/desktop` (or `npm start` in
  `apps/desktop`). Menu: File › New Chat, Server › Open in Browser / Restart Agent Server / Show Server Log.

### Usage-limit recovery (T3 Code's "Resume at reset" / "Snooze until reset")

- **Detection** (orchestrator observer, on the server): an error-level limit notice or a limit error marks the run.
  The reset comes from Claude's `_claude/rateLimit.resetsAt` (now carried on the `notice` event as `resetAt`) or from the
  sentence (`parseUsageLimitReset`: "resets 12:40am (Asia/Dubai)", "resets Oct 7, 3pm", "try again in 2h 30m").
- **State:** `IOrchThread.limit {turnId, resetAt, message, mode, modelRef, autoResume, snooze}`, set by `limit.reached`
  when the turn fails, changed by `limit.configure` (stale turn ids and snoozes after the reset are refused), cleared by
  any new turn. Persisted; a pending auto-resume keeps its root live across restarts.
- **Resume:** a server timer sends "Continue where you left off." (turn id `limit-resume:<thread>:<turn>`, so once) in
  the limited turn's mode and model. It goes ahead of queued prompts, which drain after it.
- **Snooze:** the chat's history snooze until the reset (sidebar Snoozed group, wakes at the reset).
- **UI:** `AgentLimitBanner` (desktop + web, same DOM/CSS, tucked behind the composer) and `LimitCard` (mobile), all on
  `limitRecoveryView`. Failure trays for limits are titled "Usage limit reached".
- **Verified end to end** (profile `/tmp/vag/profile`, a fake `claude-agent-acp` that answers with Claude's limit
  sentence until a reset time): limit from a task started in Volt Agents → banner in Volt Agents, the browser and the
  Volt desktop window; Snooze moved it to Snoozed everywhere; at the reset the server resumed it, the two queued prompts
  ran after, and the chat woke into Done in all clients.
