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

### Testing

`tests` works on every test controller: installed extensions plus `VoltTestController`, which is
registered with `ITestService` like an extension's controller would be.

- **Discovery** is static: test files are found by glob and parsed for
  describe/it/test, pytest classes and functions, `func TestX` and `#[test]` in mods. Project
  code never runs during discovery. Files are re-parsed on change, and a file a test extension
  already covers is dropped (`volt.testing.runner`: auto / always / off).
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
- **Transport:** requests go through `IRequestService` (node, so no CORS, with the proxy settings).
  `Basic user:pass` is encoded on the wire.

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
