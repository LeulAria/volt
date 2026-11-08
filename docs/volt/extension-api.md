# Building a Volt extension (`vscode.volt`)

A Volt extension is a normal VS Code extension. It installs from Open VSX, a `.vsix` or a folder, and it can use every VS Code API. Running in Volt, it also gets `vscode.volt`: Volt's chats and agents, agent tools, memory, the in-app browser, charts and the Scratch board, automations, usage and pull requests.

Volt's own features are built the same way. The 30 `extensions/volt-*` folders are built-in extensions: they ship with the app (no download, no `.vsix`), can't be uninstalled, are enabled by default and can be disabled in Extensions. They get their access from a ceiling compiled into Volt (below). Third-party extensions get theirs from what they declare and what the user allows.

The example in [`examples/volt-hello/`](examples/volt-hello/) registers a tool, listens for turn events and uses memory.

## 1. `package.json`

```jsonc
{
  "name": "notes",
  "publisher": "acme",
  "engines": { "vscode": "^1.105.0", "volt": "^1.0.0" },
  "main": "./out/extension.js",
  "activationEvents": ["onStartupFinished"],
  // Required: turns on vscode.volt for this extension.
  "enabledApiProposals": ["volt"],
  "contributes": {
    // Agent tools: listed to agents before the extension starts; a call activates it (onTool:<name>).
    "voltTools": [{
      "name": "notes_search",              // snake_case, unique; never one of Volt's own tool names
      "class": "reads",                    // what it does outside a chat's sandbox (see 3.2)
      "title": "Searched notes",
      "description": "Search the team's notes.",
      "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }
    }],
    // What the extension may do, by Volt's capability catalog.
    "voltCapabilities": {
      "required": [{ "id": "tools.register", "class": "low" }, { "id": "files.read:workspace", "class": "low" }],
      "optional": [{ "id": "agents.send", "class": "medium", "reason": "Posts search results to the chat you pick." }]
    }
  }
}
```

- **`enabledApiProposals: ["volt"]`** is all it takes. VS Code's own proposals stay limited to built-ins and development mode; Volt's `volt` proposal is open to every extension, including ones installed from Open VSX.
- **Types.** Copy [`apps/volt-extension-api/vscode.proposed.volt.d.ts`](../../apps/volt-extension-api/vscode.proposed.volt.d.ts) into your project next to `@types/vscode` (or add it to `files` in `tsconfig.json`). It is the same file as `src/vscode-dts/vscode.proposed.volt.d.ts`; a test keeps them equal.
- **Outside Volt** (in VS Code) there is no `vscode.volt`. Check before using it:

```ts
const volt = (vscode as Partial<typeof vscode>).volt;
if (!volt) { return; }
```

- `contributes.voltCapabilities` entries: `id` (from the catalog), `class` (never lower than the catalog's), optional `targets` (`*` globs: hosts, chat ids, setting keys) and `reason` (shown to the user as *your* claim, beside Volt's own text). An invalid entry is reported on the extension and left out.

## 2. Capabilities and consent

Every `vscode.volt` call needs a capability. Volt decides from the method and its target, never from anything the call carries about who it is.

| Class | Examples | Third-party extension | Built-in `volt.*` extension |
|---|---|---|---|
| none | `storage.own`, `config.own`, `ui.contribute` | always | always |
| low | `tools.register`, `agents.read:current`, `usage.report`, `files.read:workspace`, `net.connect` | declared → allowed while enabled | declared ∩ ceiling, no prompt |
| medium | `agents.read:any`, `agents.send`, `browser.read`, `hosting.read`, `files.write` | declared → asked once | declared ∩ ceiling, no prompt |
| high | `agents.create`, `agents.context`, `browser.drive`, `automations.schedule` | declared → asked once | declared ∩ ceiling, no prompt |
| critical | `spawn.unsandboxed`, `secrets.read`, `desktop.control`, `full` | never through the API | never through the API |

- **Undeclared**: refused with `deniedBy: 'manifest'`. Nothing is asked.
- **Consent.** The first call that needs a declared medium or high capability opens a Volt dialog: "Allow Notes to act in your chats?", Volt's description of the capability, then your `reason` marked "The extension says". *Don't Allow* has focus. The answer is kept per extension and capability (any target), and shown on the extension's page in Extensions (Features), where the user can revoke or allow it again. A refused or revoked capability is not asked again: calls fail with `deniedBy: 'consent'`.
- **Built-ins** get what their manifest declares within their ceiling (`src/vs/platform/voltPlugins/common/firstPartyCeilings.ts`), with no prompt. A manifest that declares more is refused at call time (`deniedBy: 'ceiling'`) and fails CI (`EXT-CEIL-CI-1`). Only an extension shipped with the app counts as built-in; one installed under the `volt` publisher does not.
- **Errors.** A refusal rejects with an `Error` whose `name` is `'VoltCapabilityError'` and which carries `capability`, `target` and `deniedBy` (`manifest`, `consent`, `critical`, `catalog`, `ceiling`):

```ts
try {
  await volt.chats.send(chatId, 'Run the tests');
} catch (err) {
  const refusal = err as Partial<vscode.volt.CapabilityError>;
  if (refusal.name === 'VoltCapabilityError') {
    console.log(`Volt refused ${refusal.capability} (${refusal.deniedBy})`);
  }
}
```

**What this does not protect.** The capability check binds what an extension does *through `vscode.volt`*. A VS Code extension runs in a Node extension host with the user's rights unless the user turned on its sandbox; it can read files and open sockets itself. Extensions that share an extension host can't be told apart from each other (Volt checks that the extension a call names runs in the calling host). See the sandbox spec for the per-extension hosts that close this.

## 3. The API

Every function returns a `Thenable` unless noted. The capability each needs is in brackets.

### 3.1 `volt.chats`

```ts
const chats = await volt.chats.list({ query: 'login', limit: 20 });   // [agents.read:any] newest first
const current = await volt.chats.current();                          // [agents.read:current] the chat in front
const transcript = await volt.chats.read(current!.id);                // [agents.read:current] (another chat: agents.read:any)
await volt.chats.send(current!.id, 'Also update the changelog.');     // [agents.send]
await volt.chats.start({ title: 'Release notes', message: 'Draft the notes for 0.0.3' }); // [agents.create]

volt.chats.onDidStartTurn(turn => { /* { chatId, turnId, kind } */ });            // [agents.read:any]
volt.chats.onDidEndTurn(turn => { /* { chatId, turnId, kind, outcome } */ });  // outcome: done | failed | cancelled | interrupted
```

`Chat` is `{ id, title, status, createdAt, updatedAt, turnCount, project? }`. A message you send shows in the chat as coming from your extension ("Notes (extension)"), and the agent is told it isn't the user. Starts and sends are rate-limited like other outside callers. Turn events need `agents.read:any`; the check runs when you add the first listener, and a refusal is logged (no events arrive).

### 3.2 `volt.tools`

```ts
context.subscriptions.push(volt.tools.registerTool('notes_search', async (input, call, token) => {
  // call.chatId: the chat whose agent called it
  return { text: await search(String(input.query)) };
}));                                                                  // [tools.register + the class's capability]

const result = await volt.tools.invokeTool('scratch_read', {}, { chatId }); // [agents.send + the class's capability]
```

- Declare each tool in `contributes.voltTools`; `registerTool(name, handler, { title, description, inputSchema })` fills in what the entry leaves out. An undeclared tool, or one that takes the name of a Volt tool (`memory_write`, `browser_navigate`, ...), is refused.
- The `class` says what the tool does outside a chat's sandbox and implies a capability: `safe` (nothing more), `reads` → `files.read:workspace`, `network` → `net.connect`, `writes` → `files.write`, `browser` → `browser.drive`, `persists` → `agents.context`, `delegates` → `agents.send`, `spawns` → `agents.create`, `escapes` → `spawn.unsandboxed` (critical: refused).
- A tool returns `{ text?, image? (base64 PNG), error?, visual? }`. `visual` must be one Volt published for your extension (`volt.visuals.renderChart`); any other is dropped.
- `invokeTool` runs Volt's own tools only (another extension's tool is that extension's to call). Each call is classed per action, so `manage_automations` with `action: 'create'` is `escapes` and refused.

### 3.3 `volt.storage` (no capability)

```ts
await volt.storage.set('turns', { 'chat-1': 3 });     // JSON values, per profile, private to the extension
const turns = await volt.storage.get<Record<string, number>>('turns');
await volt.storage.delete('turns');
const keys = await volt.storage.keys();
```

### 3.4 `volt.settings`

```ts
const width = await volt.settings.get<number>('acme.notes.width');   // [config.own] your contributes.configuration keys
await volt.settings.update('acme.notes.width', 320);
volt.settings.onDidChange(e => { if (e.affects('acme.notes.width')) { /* ... */ } });
```

Other settings (Volt's, other extensions') are refused through this API.

### 3.5 `volt.memory`

Notes every later chat recalls, whatever the provider.

```ts
const notes = await volt.memory.list('all');                          // [agents.read:any] scope: user | project | all
const note = await volt.memory.read('prefers small diffs');           // [agents.read:any]
await volt.memory.write({                                             // [agents.context]
  name: 'prefers small diffs', description: 'How to change code', body: 'Keep diffs under 200 lines.',
  type: 'feedback', scope: 'user',                                    // type: user | feedback | project | reference
});
await volt.memory.delete('prefers small diffs');                      // [agents.context]
```

### 3.6 `volt.browser`

```ts
await volt.browser.open('https://example.com/docs');                 // [browser.drive] http(s) only
const page = await volt.browser.readPage({ chatId });                 // [browser.read] default: the chat in front
// page = { url?, snapshot: { text: accessibility snapshot } }
```

The browser keeps the user's sign-ins, which is why both are medium or high.

### 3.7 `volt.visuals`

```ts
// Inside a tool: the chart shows in the chat, above the agent's reply.
volt.tools.registerTool('notes_chart', async () => volt.visuals.renderChart({   // [ui.contribute]
  title: 'Notes per week',
  charts: [{ type: 'bar', data: [{ week: 'W1', notes: 4 }, { week: 'W2', notes: 7 }], x: 'week', y: 'notes' }],
}));

await volt.visuals.drawOnScratch({ title: 'Login flow', mermaid: 'flowchart LR\nA[Form] --> B[API]' }, { chatId }); // [agents.send]
```

Chart specs are the ones the `render_chart` tool takes; Scratch drawings take what `scratch_draw` takes (`mermaid`, `diagram`, `page`, `elements`, `notes`, `cards`).

### 3.8 `volt.automations`

```ts
const automations = await volt.automations.list();                  // [agents.read:any]
await volt.automations.schedule({                                     // [automations.schedule]
  name: 'Morning triage',
  instructions: 'Triage the issues opened since yesterday.',
  schedule: { type: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00' },
  // chatId: run in this chat instead of a new one each time (also needs agents.send)
});
```

Schedules: `hourly {minute}`, `daily {time}`, `weekly {weekdays, time}`, `cron {expr}`, `interval {everyMs}`, `once {at}`. An automation made by an extension has no tools or secrets of its own; it runs in the active project.

### 3.9 `volt.usage`

```ts
const usage = await volt.usage.get();                                 // [usage.report]
// { generatedAt, since, sessionCount, costUsd, models: [{ provider, model, inputTokens, outputTokens, costUsd }] }
const limits = await volt.usage.limits();                             // [usage.report]
// [{ provider: 'claude', plan?: 'Max 5x', windows: [{ label: 'Current session', usedPercent: 42, resetsAt?: 1767... }], error?, checkedAt }]
```

`limits()` returns each signed-in subscription's limits as Volt last read them (the Usage page in Settings shows the same). It never names the account. To open the Usage page, run the public command `workbench.action.voltAgent.usage`.

### 3.10 `volt.pullRequests`

```ts
const links = await volt.pullRequests.list(chatId);                   // [hosting.read]
// [{ url, number, repository: 'owner/name', title?, state?, watched }]
await volt.pullRequests.link(chatId, 'https://github.com/acme/app/pull/12'); // [hosting.read + agents.send]
```

### 3.11 `volt.code`

```ts
const hits = await volt.code.grep('createServer', { glob: 'src/**/*.ts', limit: 20 }); // [files.read:workspace]
const defs = await volt.code.findSymbol('UserService', { kind: 'class' });             // [files.read:workspace]
const files = await volt.code.findFiles('settings editor');                             // [files.read:workspace]
```

Volt's code index over the open project, from the Code Intelligence feature (`volt.code-intelligence`): the same `instant_grep`, `find_symbol` and `find_files` agents use, answered as the text an agent gets. A `path` option is a folder under the project root; an absolute path or one with `..` is refused (`deniedBy: 'workspace'`). With Code Intelligence turned off, or in a browser window, the calls fail with an error.

### 3.12 `volt.agentResources`

```ts
const files = await volt.agentResources.list();                       // [files.read:workspace]
// [{ group: 'skills', ecosystem: 'claude', kind, path: '.claude/skills/deploy/SKILL.md', scope: 'project' | 'nested' | 'local', name?, description? }]
```

What each agent harness loads from the open project (instructions, skills, subagents, commands, hooks, MCP configs), as the Agent Resources page shows it. Only the project's own files: what lives in the home folder, in plugin folders or under an organization's management is not listed. To open the page, run the public command `volt.agent.openAgentResources` (args: a section id such as `skills`, and a folder).

## 4. Developing and testing

- Run your extension with **Run Extension** (`--extensionDevelopmentPath`) in Volt, or install its folder or `.vsix` from the Extensions view. `vscode.volt` works the same in both.
- A refusal says which capability and which layer refused it. The Volt dialog is the only consent path; your extension can't grant itself anything.
- In Volt's own repository, `src/vs/workbench/api/test/browser/mainThreadVolt.test.ts` runs every namespace through the real extension host and renderer halves; copy its setup to test against fakes.

## 5. How it is built

| Part | File |
|---|---|
| Public types | `src/vscode-dts/vscode.proposed.volt.d.ts` (copy: `apps/volt-extension-api/`) |
| Open proposal | `src/vs/platform/voltPlugins/common/voltApiProposals.ts`, used by `extensionsProposedApi.ts` |
| Extension host half | `src/vs/workbench/api/common/extHostVolt.ts` (`ExtHostVolt`) |
| RPC shapes | `MainThreadVoltShape`, `ExtHostVoltShape` in `extHost.protocol.ts` |
| Renderer half | `src/vs/workbench/api/browser/mainThreadVolt.ts`: identity (`hostsExtension`), argument checks, consent retry, visual check |
| Facade | `src/vs/workbench/services/voltPlugins/common/voltApi.ts` (`createVoltApi`): names each method's capability |
| Policy | `services/voltPlugins/common/extensionCapabilityPolicy.ts` (`VoltExtensionCapabilityPolicy`, behind `ICapabilityReporter`, to be replaced by the Policy Authority) |
| Ceilings | `src/vs/platform/voltPlugins/common/firstPartyCeilings.ts` |
| Backend, consent store and dialog | `contrib/voltCustomize/browser/voltExtensionApiService.ts`, `voltExtensionConsent.ts` |

In-process feature code keeps using `IVoltPluginService.getContext` (trusted core, report mode, spec B-21); the enforcing policy applies to code in extension hosts.
