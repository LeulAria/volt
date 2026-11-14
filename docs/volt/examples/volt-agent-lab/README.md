# Agent Lab: a Volt extension example

Agent Lab scouts the open project's npm dependencies and hands the upgrade to an agent:

1. **Agent Lab: Scout Dependencies** reads `package.json` in the open project, asks `registry.npmjs.org` for each dependency's latest version and keeps the report in the extension's own storage.
2. **Agent Lab: Hand the Upgrade Plan to an Agent** asks who should do it: the chat in front, another of your chats, or a new chat on a model you pick from Volt's model list. It sends the plan, draws it on the Scratch board, saves a memory note with the outdated packages, and tells you when that chat finishes a turn.
3. Agents in every chat can call the **`agent_lab_dependencies`** tool for the report (`onlyOutdated`, and `chart` for a bar chart in the chat).
4. **Agent Lab: Open a Package Page** opens a dependency's npm page in Volt's browser.

It uses `vscode.volt` for chats (`current`, `list`, `start`, `send`, `onDidEndTurn`), tools (`registerTool`, `invokeTool('list_models')`), storage, memory, visuals (`renderChart`, `drawOnScratch`) and the browser, and the network for one declared host. See [`docs/volt/extension-api.md`](../../extension-api.md).

## What it asks for

| Capability | Class | Why |
|---|---|---|
| `tools.register` | low | serves `agent_lab_dependencies` |
| `files.read:workspace` | low | reads `package.json` (the tool's class is `reads`) |
| `net.connect` on `registry.npmjs.org` | low | latest versions |
| `agents.read:current` | low | offers the chat in front first |
| `agents.read:any` (optional) | medium | lists chats to pick from; turn events |
| `agents.send` (optional) | medium | sends the plan, lists models, draws on Scratch |
| `agents.create` (optional) | high | starts a chat on the model you pick |
| `agents.context` (optional) | high | the memory note |
| `browser.drive` (optional) | high | opens npm pages |

Installing it shows Volt's permission sheet with these, by class, with the reasons above as the extension's claim. Allow grants the medium ones; Volt asks for the high ones the first time they are used.

## Build

```sh
node build.mjs              # dist/volt-agent-lab-0.1.0.vsix: the published build
node build.mjs --no-pack    # out/ only, for Run Extension or installing the folder
```

Install the `.vsix` from the Extensions view (... > Install from VSIX) or `code --install-extension dist/volt-agent-lab-0.1.0.vsix`.

## Test fixture: mock misbehavior (never publish)

`src/testFixture/fixture.ts` acts out what a malicious extension does, so Volt's sandbox and its install-time code scan can be tested against a real extension. **Only the test build has it:**

```sh
node build.mjs --fixture    # dist/volt-agent-lab-0.1.0-fixture.vsix
```

The published build compiles without it and passes Volt's code scan clean. In the test build nothing misbehaves until the setting `agentLab.testFixture.mode` names behaviors; then **Agent Lab (Test Fixture): Run the Misbehavior Switches** acts them out (`delayed` runs on its own timer):

| Switch | What it tries |
|---|---|
| `readCanary` | reads `agentLab.testFixture.canaryPath` (default `~/.ssh/volt-agent-lab-canary`, a fake secret the test creates) with `fs` |
| `exfiltrate` | POSTs what it read to `agentLab.testFixture.exfilUrl` (default `http://127.0.0.1:47913/collect`, the test's local server: an undeclared host) |
| `spawnShell` | runs `/bin/sh -c` with `cat` on the canary, `curl` to the test server and `id -un` |
| `readSecrets` | lists secret-looking environment variable names; checks whether `~/.volt/trust/grants.json`, `~/.aws/credentials` and `~/.npmrc` are readable (size only, never sent) |
| `undeclaredApi` | `vscode.volt` calls it never declared: `automations.schedule`, `usage.get`, `browser.readPage`, registering Volt's own `memory_write` |
| `criticalApi` | Volt tools no extension may run: `terminal_start`, `manage_automations` create |
| `delayed` | benign at install; `agentLab.testFixture.delaySeconds` after its first activation it does `readCanary`, `exfiltrate` and `spawnShell` |
| `obfuscated` | the same, hidden: `eval` reached through a computed global name, `new Function`, `require` of a name built from pieces (`child_process`), a base64-encoded host |

It is harmless by design: it reads only the canary, sends only to the local test server, and never reads out a real secret. Each attempt is written to `fixture-results.json` in the extension's global storage and the **Agent Lab** output, with `blocked`, `succeeded` (it got through) or `error`.

A minimal test server:

```sh
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{console.log(new Date().toISOString(),q.method,q.url,b);s.end('ok')})}).listen(47913,'127.0.0.1')"
echo "VOLT-CANARY-$(date +%s) not a real key" > ~/.ssh/volt-agent-lab-canary
```

What Volt should do with the test build: its install sheet lists the code scan's findings and recommends the sandbox; in the sandbox each switch is `blocked` (the canary is unreadable, the test server gets no request, the Volt API refuses undeclared and critical calls), and the user is told.
