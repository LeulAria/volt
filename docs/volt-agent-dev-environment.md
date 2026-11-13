# Volt Agent Development Environment

Agents in Volt use the IDE the way a developer does: language servers for meaning, the Testing
service for verification, the debugger for runtime state, tasks for the project's own workflows.
The agent and the user share one state. A test run an agent starts shows in the Test Explorer, a
breakpoint it sets shows in the gutter, and its edits land in the open buffers and the change set.

## Principles

1. **One state, two interfaces.** Every agent tool runs on the VS Code service the user's UI runs
   on (`ITestService`, `IDebugService`, `ITaskService`, `ILanguageFeaturesService`). There are no
   agent-only copies of IDE features.
2. **Complementary mechanisms, not one.** Index search, ripgrep, language servers, document
   symbols, files, git, terminals, tests and the debugger each answer a different question. The
   tool map in the system prompt tells the model which one answers which question. Each tool falls
   back on its own (`code_nav` falls back to the code index by name when a language server is
   silent).
3. **Few tools, many ops.** The tool list is part of every cached prompt. One op-based tool per
   service (`tests`, `debug`, `tasks`, `code_nav`, `code_action`) keeps it short, and each op
   returns what the agent needs next. A debugger step returns the new location, stack and locals,
   and `code_nav op=inspect` returns hover, definition with body, references by file and
   implementations in one call.
4. **Adapters on one registry.** A capability is an `IVoltHostToolProvider`. It serves Volt's own
   loop (wrapped as `IVoltTool`) and, over the volt MCP server, Claude Code, Codex and other ACP
   agents. Adding Docker or an HTTP client means adding one more provider plus its UI.

## Architecture

```
            Volt native loop                     ACP agents (Claude Code, Codex...)
                  |                                        |
      IVoltTool (registry.ts)                   volt MCP server (host tools)
                  \______________________________________/
                                    |
                       IVoltHostToolService (providers)
      ______________________________|_______________________________________
     |                     |                     |                         |
 code intelligence      AgentIdeService       terminals / jobs        browser, devices,
 (codeTools +           tests | debug | tasks (existing)              visuals... (existing)
  CodeIntelHost)           |       |      |
     |                 IdeTests IdeDebug IdeTasks
 ILanguageFeatures     ITestService IDebugService ITaskService  <- VS Code services
 + hierarchy registries   + VoltTestController (vitest/jest/mocha/pytest/go/cargo)
 + Volt code index
```

| Layer | Files |
| --- | --- |
| Tool contracts (pure) | `services/voltRuntime/common/ide/ideTools.ts`, `browser/tools/codeTools.ts` |
| Test runner logic (pure, unit-tested) | `common/ide/testFrameworks.ts`, `common/ide/testReports.ts`, `test/common/ideTests.test.ts` |
| Language servers | `browser/host/codeIntelHost.ts` (+ `setCodeIntelHierarchy`), `contrib/voltCodeIntelligence/browser/codeIntelHierarchy.ts` |
| Agent server bridge | `server/node/voltAgent/serverCodeIntel.ts`, `contrib/voltAgent/electron-browser/agentServerClient.contribution.ts` (`codeIntel.*` handlers) |
| IDE adapters (window) | `contrib/voltAgent/browser/ide/{agentIdeService,ideTests,ideDebug,ideTasks,voltTestController}.ts` |
| Native wrappers | `browser/tools/ideTools.ts`, `browser/tools/registry.ts` |
| UI | `contrib/voltAgent/browser/ide/agentIdeCard.ts` (card above the composer), VS Code's Testing / Run and Debug / Terminal views |
| Model guidance | `common/deepseek/prompt.ts` (native tool map), `common/harness/contextPack.ts` (`IDE_TOOLS_GUIDE` for ACP agents) |

### Code intelligence

`code_nav` ops: `definition`, `references`, `implementations`, `type_definition`, `hover`,
`inspect`, `symbols`, `workspace_symbols`, `callers`, `callees`, `supertypes`, `subtypes`. All ops
run on the editor's text models, so unsaved buffers count. Every provider call is bounded
(10 s). Definition, references, outline and workspace symbols fall back to the code index, and the
result says when it is name-matched rather than type-checked.

`code_action` ops: `rename`, `format`, `organize_imports`, `fixes`, `fix`. Edits are computed from
the provider's `WorkspaceEdit` against the text the editor has, then written through
`writeComputedEdit`, the same path as `edit_file` (open buffer, file ledger, `file.change` into the
chat's change set). If the buffer changed while the edit was computed, the write is refused.
Actions that only run an editor command are reported instead of half-applied.

Call and type hierarchies and workspace symbols come from workbench contributions, which
`services/voltRuntime` may not import (the agent server loads that layer too). The window's code
intelligence contribution sets them with `setCodeIntelHierarchy`. The agent server forwards
every new op to the window that has the file's folder open.

Language servers are on by default (`volt.codeIntelligence.lsp.enabled`), for a project the user
opened whether or not it is one of the window's folders (the agent window has none). A chat's own
worktree checkout (`~/.volt/worktrees/...`) is the deliberate exception: its language servers are
opt-in (`volt.codeIntelligence.lsp.worktrees`, "Enable LSPs for Worktrees", off by default, as in
Cursor), because each checkout loads another copy of the project into the language server. There,
and when language servers are off, `diagnostics` and `code_action` say which setting applies and
what to run instead, and `code_nav` answers from the code index (`lspPolicy`, DEV-LSP-1).

### Testing

`tests` works on every test controller: installed extensions plus `VoltTestController`, which is
registered with `ITestService` like an extension's controller would be.

- **Discovery** is static: test files are found by glob and parsed for
  describe/it/test, pytest classes and functions, `func TestX` and `#[test]` in mods. Project
  code never runs during discovery. Files are re-parsed on change, and a file a test extension
  already covers is dropped (`volt.testing.runner`: auto / always / off). Besides the window's
  folders, the calling chat's folder is discovered before `tests` lists or runs
  (`voltTestRoots`), so a chat's project outside the window's folders (the agent window has
  none) gets its tests (DEV-LIVE-1).
- **Runs** use the project's runner with a machine-readable report: vitest/jest JSON, mocha
  JSON, JUnit for pytest, `go test -json`, libtest text. Output streams into the run's terminal.
  Outcomes, messages, expected/actual and stack frames become real `LiveTestResult` entries, so
  the peek view, gutter, Test Results and the agent see the same thing. Generated tests (it.each,
  parametrize) are added to the tree as they are reported. Profiles: Run, Debug (JS through
  js-debug's debug terminal) and Coverage.
- **Agent results** are compact: a pass/fail line, then each failure (up to 12) with message,
  expected/actual and the workspace frames. `failed: true` reruns only failures, and
  `results target=` gives one test's full output.

### Debugging

`debug` starts sessions from launch.json (`config`), a file (`program`: Node, TS via tsx, Python,
Go), or a shell command (`command`: js-debug's JavaScript Debug Terminal attaches to every Node
process it starts). It also attaches by port or pid. Sessions are ordinary VS Code sessions, and
the paused frame is focused (with `preserveFocus`), so the user sees the line highlighted.
`continue`, `step`, `run_to` and `pause` wait for the next pause and return its state.
Breakpoints support conditions and logpoints. `clear` removes only the agent's breakpoints and
never the user's. Exception breakpoints map to the adapter's filters.

### Tasks

`tasks` lists tasks.json entries and detected tasks, runs one in its task terminal, waits for exit
(or for a watch task's first build), and returns the exit code, problem-matcher findings and the
output tail.

### Permissions

The IDE tools sit in the `shell` capability group, so they are off in Ask and Plan, which cannot
run code. `IVoltTool.readOnly(args)` lets read-only ops (`list`, `results`, `state`, `variables`,
`output`, breakpoint `list`) run without approval. Running ops go through the chat's access mode
like any command. For ACP agents, `approvalInReadOnlyModes` does the same through the host tool
gate.

### Sandboxed chats

A chat in Volt's sandbox (docs/security/sandbox) uses the same tools, but each is classified op by
op in `HOST_TOOL_SANDBOX_CLASSES` (every `ide` op carries its class in `ideCapabilities.ts`), and
what would run outside the sandbox is refused with what to do instead. Programs an op starts run
in the chat's sandbox, as the chat, never as Volt.

| Tool | In a sandboxed chat |
| --- | --- |
| `tests` | Volt's runner only, its command in the chat's sandbox; the report goes to the chat's temp folder and is read through the gate's read rule. A test extension's tests are not run (its extension host is outside the sandbox): run them with the shell tool. Lists only tests in files the chat may read and shows only its own results. A run the sandbox refused reads "Not run (sandbox)", not failed; the Debug profile starts nothing. |
| `debug`, `tasks` | Starting, attaching, resuming, stepping, evaluating, watches, conditional breakpoints and logpoints, and `tasks run` are refused: the debugger and task terminals run outside the sandbox. Listing tasks, plain breakpoints, and reading the state, variables and output of sessions and tasks the chat itself started still work (`ide/ideSandbox.ts`). |
| `code_nav`, `diagnostics`, `code_action` | Answers cut to files the chat may read; an edit is refused whole unless every file it changes is one the sandbox lets it write. Language servers themselves run outside the sandbox (05-limitations item 36). |
| `ide` gateway | Programs (docker, kubectl, gh, analyzers, profilers) run through the chat's shell in its sandbox, git through `runChatGit`; a chat without a folder runs nothing. Notebook kernels, `remote exec`/`hosts` and `extensions run` are refused, by the gate and again by the gateway (DEV-SBX-18). |
| `ide http` | See "HTTP client" below: the chat's network rules apply to each send. |
| `watch_job` | The check runs in the asking turn's sandbox. |

Tests: `contrib/voltAgent/test/browser/agentIdeSandbox.test.ts` (DEV-SBX-4..11, 18),
`contrib/voltCodeIntelligence/test/browser/codeIntelConfinement.test.ts` (DEV-SBX-12, 13, 16,
DEV-LSP-1), `contrib/voltHttp/test/browser/voltHttpSandbox.test.ts` (DEV-SBX-14, 15, 17).

## The `ide` gateway: every other capability behind one tool

The native loop sends every tool on every turn, so ten more tools would cost real tokens. The
`ide` tool takes `capability` + `op` + `args`. Its description is one line per capability, and
`op: "help"` returns a capability's arguments only when the agent needs them (progressive
disclosure). Specs live in `common/ide/ideCapabilities.ts` and adapters in
`contrib/voltAgent/browser/ide/capabilities/`. Read-only ops skip approval. Ops marked `confirm`
(k8s restart/scale/apply/delete, editor commands, remote exec) ask the user every time through
the host tool provider's `needsApproval`.

| Capability | Ops | Backed by |
| --- | --- | --- |
| editor | state, open, highlight, clear | `IEditorService`, code editor decorations (cleared when the chat's run ends), `ITextFileService` dirty state; scoped to the chat's folder |
| git | branches, conflicts, blame, history, show, stage, unstage, commit, switch, stash | git CLI in the chat's folder (Source Control and the change set see the result); conflict regions parsed from markers |
| notebook | cells, outputs, kernel, create, edit, insert, run | `INotebookEditorModelResolverService`, `INotebookKernelService`, `INotebookExecutionService` (waits on `INotebookExecutionStateService`); kernel state persists across calls |
| docker | ps, images, logs, inspect, stats, exec, start, stop, restart, compose | docker CLI (JSON formats); inspect gives state, restarts, health log, env with secrets masked |
| k8s | contexts, get, describe, logs, events, rollout, restart*, scale*, apply*, delete* | kubectl (*: confirm) |
| ci | runs, view, logs, rerun | gh CLI; failed logs cut down to errors plus each step's tail |
| http | list, envs, send | `IVoltHttpService`, shared with the HTTP client UI (same history, environments, chained responses) |
| profile | cpu, bench, summary | `node --cpu-prof` via `NODE_OPTIONS`, summarized (self/total per function); hyperfine when installed, else timed runs |
| analyze | tools, run | eslint, tsc, ruff, mypy, semgrep (repo rules only, metrics off), golangci-lint, clippy; findings go to the Problems view under `volt-analyze/<tool>` |
| coverage | report | newest coverage-final.json / lcov / Cobertura / Go cover profile: totals, least covered files, a file's uncovered lines |
| remote | info, hosts, exec*, devcontainer | remote authority, `.devcontainer`, `~/.ssh/config`, ssh in BatchMode, the devcontainer CLI |
| extensions | list, commands, run* | `IExtensionService`, `CommandsRegistry`/`MenuRegistry` |

The debugger also gained `watch` (adds to the Watch view and reads every watch at the pause).

## HTTP client (`contrib/voltHttp`)

A first-party HTTP client, built in the workbench rather than as an extension, so it shares state
and components with the agents:

- **Request editor:**
  - name, method (Volt dropdown, colored), URL with `{{variables}}`, environment picker, Send
    (Enter in the URL sends), Save
  - tabs: Params (synced with the URL), Headers, Body (JSON with Format, text, XML, form
    URL-encoded, GraphQL with variables) and Auth (Bearer, Basic, API key in header or query)
  - response: status pill, time, size, Body (pretty JSON in a read-only code editor), Headers,
    Raw, Copy
- **Files:** `.http` / `.rest` in REST Client / JetBrains syntax (`common/ide/httpFile.ts`):
  - `###` separators, `# @name`, file variables, multi-line query strings
  - `http-client.env.json` (+ private file, `$shared`)
  - dynamic values (`$guid`, `$timestamp`, `$isoTimestamp`, `$randomInt`)
  - chaining (`{{login.response.body.$.token}}`)
  - Save writes back in place, or appends to `requests.http`
- **Where it shows:**
  - an HTTP Client view container (Requests tree, History list; VS Code lists, edge to edge)
  - CodeLens "Send Request | Open in HTTP Client" in `.http` files
  - the agent window's "+" menu ("HTTP Client", Ctrl+Option+H), opening beside the chat
  - the IDE editor area
- **Transport (`IVoltHttpTransport`):**
  - desktop: the main process sends (`platform/voltHttp/electron-main`, Electron's `net` over the
    `voltHttpTransport` channel), outside any page: no CORS check (a local API without CORS
    headers answers), every response header comes back (`Set-Cookie`, custom ones) and no
    `Origin` is added; the user's proxy settings and system certificates apply (DEV-LIVE-3)
  - web workbench: the window's request service (its fetch), so the server must allow the page's
    origin
  - `Basic user:pass` is encoded on the wire
- **Agents:** `ide http list`/`send` use the request files and environments of the calling chat's
  folder, also outside the window's folders (watched, up to 8 such folders; DEV-LIVE-2).
- **Sandboxed chats:** before anything is sent, the URL that goes out (variables filled in) is
  judged by the chat's network rules (the in-app browser's: allowed hosts, granted loopback ports).
  Redirects are not followed: the main process asks `net` for manual redirects and returns the 3xx
  with its `location`, never requesting it (DEV-SBX-19); a browser fetch's opaque redirect is
  explained. Only request and environment files the chat may read are used, named responses are
  kept per chat (never the user's login token), and an environment picked for a send applies to
  that send only. The check is on the host name (05-limitations item 37).

## Tabs that open themselves

When an agent uses the IDE from a chat, what it works on opens as a tab beside the chat (in the
IDE layout, as a background tab), without taking focus. It opens once per chat and capability,
and updates live after that. A tab the user closes stays closed for that chat. Setting:
`volt.agent.ide.autoOpenTabs`.

- Notebook ops open the notebook itself.
- HTTP sends open the request editor with the response.
- The debugger opens the paused source line and its activity tab.
- Tests, tasks, git, Docker, Kubernetes, CI/CD, coverage, analyze, profile and extensions open an
  activity tab (`agentIdeActivityEditor.ts`). It shows the agent's ops newest first (op,
  arguments, time, result as the agent read it), with buttons into the native views: Test
  Explorer / Test Results, Run and Debug / Debug Console, Source Control / Git Graph, the
  Containers view, Test Coverage, Problems, Extensions.
- Remote connections open nothing, and neither does `editor`, which shows its file itself.

Every call is logged by `AgentIdeService.invokeLogged`, which then runs
`volt.agentIde.openActivityTab`. It is a command so the service never imports the agent window's
tab host.

## Agent Sessions view

A sidebar view (`agentIdeSessionsView.ts`) lists every test run, debug session and task agents
started, across chats, with live state. Opening a row reveals it in Test Results, Run and Debug, or
the task terminal.

## Docker built in

`ms-azuretools.vscode-containers` 2.4.5 (Container Tools, the successor of the Docker extension) is
a built-in extension in `product.json`. It downloads from Open VSX (no `repo`), pinned by sha256
(checked against the Open VSX package). It gives the Containers view (containers, images,
registries, compose), and the agent's `docker` capability talks to the same daemon.

## Not done yet

- Coverage percentages in the Explorer and gutter for Volt's own runner: the Coverage profile runs
  the tool's coverage, but its report is not yet turned into `TestCoverage` on the live result.
  Extensions that provide coverage do show it.
- Semantic tokens, folding ranges and CodeLens as agent ops (low value per token).
- Local history (Timeline) entries; git history covers committed versions.
- A Postman collection import for the HTTP client.

## Validation

- `test/common/ideTests.test.ts` (19 tests, run with the fast esbuild + mocha recipe) covers
  static discovery for all four languages, command building, all five report formats, stack
  parsing, the read-only gate, the gateway specs, four coverage formats, CPU profile summaries and
  the `.http` parser (variables, chaining, environments, serialization).
- Sandboxed chats: the suites listed under "Sandboxed chats" above, plus
  `platform/voltHttp/test/electron-main/voltHttpTransportMain.test.ts` (DEV-LIVE-3, DEV-SBX-19:
  the main-process transport against real local servers).
- tsgo, eslint and hygiene are clean on every touched file.
- **Not yet verified at runtime:** none of the window-side adapters, the HTTP client UI, the
  sessions view or the Container Tools download has run in the app. The first runtime pass should
  check:
  - vitest/pytest discovery and a failing test's peek
  - `debug start command="npm test"` with a breakpoint
  - `code_action rename`
  - an HTTP send with an environment and chaining
  - a notebook run with a kernel
  - `ide docker inspect` on a restarting container
  - the "+" menu's HTTP Client entry
  - the build fetching Container Tools
