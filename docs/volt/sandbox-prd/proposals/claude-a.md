# Proposal `claude-a`: plugin host tiers, the Volt API, and moving 30 features out of `contrib/`

Author: `claude-a` (Opus 5.5, Claude Code). Round 1, 2026-11-08.
Emphasis: host tiers (§2), the Volt extension API (§6.2), the migration of all 30 `extensions/volt-*` (§6.3–6.6). The other sections are covered, but more briefly.

Citations: `path:line` refers to **main** (this checkout, Volt 0.0.6) unless marked **(sbx)**, which means `feat/volt-sandbox`, read with `git show`. Guesses are marked **[guess]**.

---

## 0. The position in one page

1. **"Migrate first, then sandbox" is the right order only if "migrate" means "move the boundary", not "move the files".** If code moves into `extensions/volt-*/` while still importing `IVoltRuntimeService`, `IAgentOrchestratorService` and friends, only the folder changes. The first deliverable is the **Volt API facade** (`IVoltPluginContext`, §6.2), with a capability check on every call. Each feature is then rewritten to reach Volt only through it, enforced by an import lint. Where the code physically lives comes last and matters least.
2. **Five host tiers, and Electron main never runs plugin code.**
   - **T0, core:** not a plugin.
   - **T1, first-party in-process modules:** signed with the app, run under the facade.
   - **T2, Volt-native plugins:** an SES worker inside an OS-sandboxed Node process on volt-server, with zero fs and zero net. UI is declarative or iframes.
   - **T3, VS Code extensions:** a sandboxed `bootstrap-fork` extension host on volt-server, or the web-worker host for `browser` entries.
   - **T4, opt-in microVM.**
3. **I reject "first-party = allow all".** I replace it with **"declared, auto-granted by signature, enforced anyway".** Every first-party plugin has a capability manifest. Volt's release signature grants exactly that manifest with no prompt. The user sees no difference from "allow all". A bug or a compromised update is bounded by the manifest, and adding a capability shows up in code review because CODEOWNERS gates manifest diffs.
4. **Honest outcome for first-party code:** most of the 18 features end as **T1**, because they need Electron `<webview>`s, macOS TCC, `utilityProcess` helpers, or are themselves part of the trusted computing base (pairing, accounts, skills install).
   - **T2 dogfood set:** `memory`, the code half of all **12 providers**, `usage` (once the secrets broker exists), and `agent-resources` (read-only).
   - That makes 15 first-party T2 plugins, enough real users to keep T2's API alive. The Android SDK Runtime died from low adoption (brief §4); 15 real plugins from day one is the antidote.
5. **Providers become mostly data.** `CLI_AGENT_DEFINITIONS` (`src/vs/workbench/services/voltRuntime/browser/agents/cliAgents.ts:402`) is already a table.
   - It moves into `contributes.voltAgents` in each provider's `package.json`, together with the provider's **sandbox layer** (its credential dir and API hosts).
   - The ACP client (`acpProvider.ts`, 2,260 lines) stays core.
   - Only model listing and auth probing are code, and those run in T2.

---

## 1. Threat model

**Assets, in order of damage if lost:**
1. Credentials: `~/.ssh`, cloud CLIs, `~/.claude/.credentials.json`, `~/.codex/auth.json`, keychain, `.env*`, Volt's own secrets (OAuth tokens in `voltUsage`/`voltAccounts`).
2. The user's code and git history, including pushing to remotes.
3. Volt's control planes:
   - the host MCP server and its HMAC bearer tokens;
   - the agent server `/ws` API and pairing (`src/vs/server/node/voltAgent/serverPairing.ts`);
   - the tunnels (`serverTunnels.ts`).
4. Other chats' transcripts and queues (cross-chat injection).
5. The machine: persistence (shell rc, LaunchAgents, git hooks), CPU, disk, LAN reachability.
6. The user's attention: prompt fatigue is an asset loss.

**Attackers:**

| Attacker | Entry | What they want | Primary control |
|---|---|---|---|
| Malicious third-party plugin (T2/T3) | marketplace install | creds, code exfil, persistence | tier OS profile + API capabilities + network broker |
| Compromised update of a good plugin | publisher key theft / registry | same, at scale | signature pinning per publisher, capability-diff re-consent (§8.4), revocation feed |
| Compromised first-party update | Volt release key or CI | everything | release-key split, reproducible builds, manifest-diff review, T1 surface kept small |
| Prompt-injected agent | repo text, web page, issue | use tools it has: host MCP, terminals, browser | chat sandbox + host-tool classes (`hostToolSandbox.ts:36` (sbx)) + per-chat grants |
| Malicious repo | `.vscode/`, tasks, hooks, `.claude/settings.json`, policy files | code exec on open, policy widening | untrusted layers only narrow; protected paths; workspace trust |
| Network attacker | LAN, Wi-Fi, DNS | MITM of updates, DNS rebinding to loopback | signed updates; proxy refuses private addresses; loopback Host checks |
| Plugin → plugin | shared process / storage | steal another plugin's grants | identity bound to the channel, not the payload (§2.4) |

**Trust boundaries:**
- OS user ↔ Volt core (T0/T1).
- Core ↔ every plugin host (RPC with capability checks).
- Plugin host ↔ OS (sandbox profile).
- Core ↔ agent CLI / MCP server (chat sandbox).
- Client (desktop/web/phone) ↔ volt-server (pairing token).
- Iframe UI ↔ workbench (`postMessage` only).

**Out of scope:**
- A malicious OS user or root.
- Kernel and hardware side channels.
- Physical access.
- Bugs in Seatbelt, bwrap or the AppContainer kernel. We rely on them, test them (§11) and track advisories.
- Exfiltration by a plugin the user granted `network: *` plus `workspace.read`. That grant is exactly what it says.
- First-party T1 code acting maliciously **at release time**. Covered by supply-chain controls (§7), not by the sandbox.

---

## 2. Trust tiers and host model (deep)

### 2.1 The tiers

| Tier | Who | Process | OS sandbox | Language isolation | IPC to core | UI |
|---|---|---|---|---|---|---|
| **T0 Core** | chats/threads, queue, orchestrator, run groups, questions/plans, worktrees, terminals, workspace context, image inspection (`voltFeatures.ts:97-226`, the features with no `extensionId`), the runtime, SandboxManager, brokers, ACP client, host MCP server, pairing | renderer, Electron main, volt-server | none (it *is* the TCB) | n/a | in-process DI | native workbench |
| **T1 First-party module** | first-party features that need native, Electron, TCC or TCB access (§6.3 table) | same process as today: renderer for UI, Electron main for native, volt-server for tools | none | **facade + import lint**: code reaches Volt only through `IVoltPluginContext`. Capability-checked, so bugs are contained, not malice | in-process facade | native workbench (Volt buttons, lists), registered through the same contribution points as T2/T3 |
| **T2 Volt-native plugin** | third-party Volt plugins, and the first-party dogfood set | one **sandboxed Node process per publisher** on volt-server (`volt` publisher shares one; each third-party publisher gets its own). One `worker_thread` per plugin inside it, running under SES `lockdown()` + a `Compartment` | profile `plugin-host` (§2.3): no fs except its bundle (read-only), no network, no spawn, no unix sockets but the inherited channel | SES: frozen intrinsics, no `require`, no `process`, no `globalThis.fetch`. Only the `volt` object is endowed | `RPCProtocol` over an inherited socketpair on fd 3, with the same framing as the extension host | declarative views rendered by core (§2.5), or `voltPanels` iframes |
| **T3 VS Code extension** | Open VSX / VSIX extensions | **sandboxed `bootstrap-fork` extension host** on volt-server (`src/vs/server/node/extensionHostConnection.ts:277` is a plain `cp.fork`, so SandboxManager can wrap it). Extensions with a `browser` entry and no `main` go to the **web-worker host** (`src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts:89`, iframe + worker) | profile `exthost-default` (§9.1), widened per extension by granted capabilities; the browser sandbox for web-worker extensions | none (Node). The `volt` API is offered here too, capability-checked at the main-thread proxy | VS Code's existing ext-host RPC | VS Code webviews, plus `voltPanels` |
| **T4 VM** | opt-in strict: untrusted repos, plugins shipping native binaries, "YOLO" agent runs | microVM per session (Apple Virtualization.framework / Firecracker / Hyper-V) **[guess on per-OS choice; see `grok`]** | VM boundary + in-guest sandbox | n/a | vsock RPC | none (headless) |
| **Agent CLIs** | claude, codex, cursor-agent, grok… | children of volt-server via `voltStdio` | chat sandbox (existing schema v1) | n/a | ACP over stdio | Volt's transcript |
| **MCP servers** | user/harness MCP | children via `voltExternalMcp` | `mcp-default` profile (§9.3) | n/a | stdio / loopback HTTP | none |

**Rules that hold across tiers:**
- **Electron main runs no plugin code, ever.** Main-process Volt services (`src/vs/platform/volt{Browser,Devices,Desktop,Capture,Speech,Awake}/electron-main`) are **brokers**. They expose narrow, capability-checked methods and are reached only from T0/T1, or through the facade from T2/T3.
- **The renderer runs no third-party code outside iframes.** Customize §6.3 already rejected React-in-the-renderer (`docs/volt/customize.md:185`). The same holds for T2 UI.
- **Every plugin host lives where the agent runtime lives: volt-server.**
  - `agentServerMain.ts:80-94` already instantiates the runtime's browser-layer services (`VoltHostToolService`, `AgentOrchestratorService`, `VoltMemoryService`…) in the server.
  - So tools contributed by plugins are available to every client (desktop, web `/code/`, phone) with no extra work.
  - This is also the one place the decided first sandboxed host can run (brief §2).
- **Desktop with the agent server off** (`volt.agentServer.enabled: false`) runs T2/T3 hosts as children of the **shared process** **[guess: needs a spike]**. Alternatively, it refuses third-party plugins in that mode. I recommend refusing; it is a power-user mode.

### 2.2 Why T2 is a process per publisher with workers inside, not one shared host

- **SES alone** shares a process. One SES escape (a V8 bug, or a missed intrinsic) gives the attacker that process's OS rights.
  - So the process must have **no** OS rights: no fs, no net, no spawn.
  - Then an SES escape yields only the RPC channel, and the core checks every RPC against the plugin's grants.
  - That is two independent layers, and the OS layer is the one we test adversarially (§11).
- **Identity:** core binds the caller's identity to the **channel** (fd 3 of that process). It never trusts a `pluginId` in a payload.
  - Inside one process, a worker that escapes SES can forge another worker's messages.
  - So we only co-host plugins that share a publisher, and therefore a signer and a trust decision.
  - `volt.*` first-party plugins share one host. Each third-party publisher gets its own.
- **Memory:** a bare Node process is ~30–40 MB **[guess, to measure]**. Per-publisher grouping keeps 15 first-party T2 plugins at one process. A user with 5 third-party publishers pays ~200 MB.
  - Hosts are **lazy**: started on first activation event, stopped after 5 min idle with no live UI or registered long-poll.
  - With 100+ agents (memory: `volt-agent-server-scale`), idle hosts must cost nothing.
- **Wasm:** a T2 plugin may ship a WASI component (jco-transpiled) whose imports are only `volt:*` interfaces. Same endowments, same RPC. This is how native-ish third-party code (parsers, formatters) gets in without T3.

### 2.3 OS profiles per tier (as schema v2 layers, §3.2)

```jsonc
// plugin-host (T2): composed at launch, trusted layer from core
{ "schemaVersion": 2, "name": "plugin-host:${publisher}",
  "filesystem": { "read": ["${volt.appRoot}/out", "${plugin.bundleDirs}"], "write": [], "deny": [], "protect": [], "unmask": [] },
  "network": { "mode": "none", "allow": [], "loopbackPorts": [], "listen": false },
  "process": { "limits": { "memoryMB": 512, "processes": 1, "openFiles": 256 }, "spawn": "none" },
  "env": { "inherit": [], "set": { "NODE_OPTIONS": "" } },
  "host": { "unixSockets": [], "systemServices": false, "channels": ["fd:3"] },
  "bestEffort": [] }
```

- `process.spawn: "none"` and `host.channels` are **new v2 fields**.
  - Seatbelt: `(deny process-exec)` after the initial exec. Also `(deny process-fork)`.
  - bwrap: seccomp denies `execve`/`execveat` after a ready marker, as the branch already does for the ready handshake on fd 3. **[guess on the exact seccomp mechanics; `grok` owns this]**.
- The host process is started with **Node's permission model on top** (`--permission`, no `--allow-fs-*`, no `--allow-child-process`, no `--allow-worker`… except that we need workers, so `--allow-worker`). This is a third, in-process layer. It is cheap and catches our own mistakes.
  - Electron 37 ships Node 22.19, where `--permission` is stable **[guess: verify flag status on 22.19]**.
- **T3 `exthost-default`** is in §9.1.
- **T1 has no OS profile.** That is precisely why T1 must stay small and why the migration (§6) is valuable even for code that stays in-process: the facade is T1's only containment.

### 2.4 IPC and enforcement: two checkpoints per call

```
plugin code ──volt.git.log()──▶ RPC (fd 3) ──▶ MainThreadVoltGit (volt-server)
                                                 1. caller = channel identity → IPluginRecord
                                                 2. grantStore.check(caller, 'git.read', {repo})
                                                 3. broker call (IVoltGitService) with caller's scoping
                                                 4. audit event {plugin, capability, target, allowed}
```

- **API-proxy enforcement:**
  - **T2:** a `MainThreadVolt*` customer per namespace, registered like VS Code's `MainThread*` customers.
  - **T3:** the same customers, through the ext host's `RPCProtocol`. The VS Code API itself is *not* capability-checked. That is VS Code's surface, and the OS profile is what bounds it.
  - **T1:** the facade calls the same check in-process.
  - One `IVoltCapabilityService.check()` serves all three.
- **OS enforcement:** the profile of the host process (§2.3).
  - A T3 extension that ignores the Volt API and calls `fs.readFile('~/.ssh/id_ed25519')` hits Seatbelt/bwrap, not our proxy.
  - A T2 plugin cannot even express that call, and if it escapes SES the OS denies it.
- **Denials** from both layers go to one place: the `onDenial` events of `IPreparedSandbox` (`sandboxManager.ts:50` (sbx)) and the capability service's audit feed. That feeds the per-plugin denial log shown in the plugin's page (§8.5).

### 2.5 UI contributions per tier

| Kind | T0/T1 | T2 | T3 |
|---|---|---|---|
| Sidebar item / slot item (`VOLT_SLOT_ITEMS`) | native button | **declarative**: `{id, icon, label, command, badge}` rendered by core with `createVoltButton` | same declarative contribution in `package.json` |
| Volt Settings page (`SettingsSection`) | native page | **declarative from `contributes.configuration`** + optional declarative form; custom pages via iframe | same |
| Side-toolbar dock section (`agentDockSections`) | native | declarative **list/card tree** (§6.2 `volt.ui`): rows rendered by core as `WorkbenchList` (lists-edge-to-edge rule holds automatically) | same |
| Right-panel surface (`agentSurfaceMenuItems`) | native editor pane | `voltPanels` iframe (customize §6.3) | webview panel (works today) or `voltPanels` |
| Transcript block (tool result card) | native renderer (`blocks/agentBlockRenderers.ts`) | **declarative block** (markdown, table, chart spec, image, diff) rendered by core. Custom HTML block = sandboxed iframe, lazily mounted (static snapshot until focused) | same |
| Composer chip / tray | native | declarative chip `{label, icon, value}` only | same |

**Why declarative first:**
1. **Cost.** 100 transcript cards as 100 iframes would cost ~100 renderer frames. Declarative cards cost nothing, and they match the user's look tokens and lists rule for free.
2. **Security.** A declarative tree has no script, so no clickjacking surface inside the window chrome.
3. **Phone.** The phone (memory: `volt-phone-shell`, a WebView around `/code/`) renders the same tree.

Raycast and Figma both converge here: declarative native UI for common cases, iframe for the rest.

**Iframes:**
- They reuse VS Code's webview infrastructure (`IWebviewService`): separate origin, service-worker resource loading, look tokens injected (`contrib/webview/browser/themeing.ts`, customize §4).
- Default CSP is `default-src 'none'; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:`, with **no `connect-src`**. Network goes through `postMessage` → plugin → `volt.net`.
- Iframes never get `allow-same-origin` with the workbench, `allow-top-navigation` or `allow-popups-to-escape-sandbox`.
- Customize §6.3's "Panel stopped · Reload" error boundary applies.

---

## 3. SandboxManager core

### 3.1 API (extends the branch's, does not replace it)

- The branch's `SandboxManager` (`src/vs/platform/voltSandbox/node/sandboxManager.ts:86` (sbx)) has `capabilities()`, `prepare(request) → IPreparedSandbox` (`:149`), `run()` (`:237`) and `dispose()`.
- `IPreparedSandbox` (`:50`) already carries `confirm`, `terminate`, `allowDomains` and `onDenial`. **Keep all of it.**
- Main already has an *older* `voltSandbox` (`common/{landlock,seatbelt,sandboxDenials,sandboxPolicy}.ts`, `node/{sandboxLauncher,sandboxProxy}.ts`) used by `voltStdio`. The merge replaces it.
- `git log main..feat/volt-sandbox` shows 10 commits to bring over.

Add:

```ts
interface ISandboxManager {
  capabilities(): Promise<ISandboxBackendCapabilities>;           // probe, cached per boot
  prepare(req: ISandboxRequest): Promise<IPreparedSandbox>;       // one-shot or long-lived
  run(req: ISandboxRequest, o?: ISandboxRunOptions): Promise<ISandboxRunResult>;
  /** NEW: a long-lived host. Restart policy, health, and live grants. */
  startHost(req: ISandboxHostRequest): Promise<ISandboxHost>;
  readonly onDidChangeEnforcement: Event<ISandboxEnforcementReport>; // attestation feed (§11)
}
interface ISandboxHostRequest extends ISandboxRequest {
  readonly identity: { kind: 'plugin' | 'exthost' | 'mcp' | 'agent'; id: string; publisher?: string };
  readonly channel: 'fd3-socketpair' | 'named-pipe';   // ext host on Windows uses a pipe
  readonly restart: { maxPerHour: number };           // crash loop → mark plugin broken
}
interface ISandboxHost {
  readonly pid: number; readonly status: 'initialized' | 'partial'; readonly unenforced: readonly SandboxDimension[];
  readonly channel: IMessagePassingProtocol;
  grant(g: ILiveGrant): Promise<'applied' | 'needs-restart'>;      // §3.6
  revoke(g: ILiveGrant): Promise<'applied' | 'needs-restart'>;
  terminate(): Promise<void>;
  readonly onDenial: Event<ISandboxRunDenial>; readonly onExit: Event<number | null>;
}
```

### 3.2 Policy schema v2: capabilities → policy, with a target version

- v1 (`sandboxSchema.ts:17,111` (sbx)) stays the **compiled** form. Backends only ever see compiled policies.
- v2 adds a **source** form that plugins and providers declare, and a compiler from capabilities to v1+ fields.

```jsonc
// package.json (any tier)
"engines": { "vscode": "^1.105.0", "volt": "^1.0.0" },
"volt": {
  "target": 1,                      // like Android targetSdk: pins the behaviour rules applied to this plugin
  "tier": "worker",                 // worker (T2) | node (T3, default for VS Code extensions) | inproc (T1, signature-gated)
  "capabilities": {
    "agents.read": true,
    "tools.register": ["gitlog_*"],
    "git.read": true,
    "net": ["api.linear.app"],
    "secrets": ["linear.token"],
    "workspace.read": "picker"     // picker | workspace | none
  }
}
```

**Compiler rules:**
- `net: [...]` → `network.mode: proxy`, with `allow` set to those hosts.
- `workspace.read: workspace` → `filesystem.read += ${workspace}`.
- T2 never compiles fs or net into the OS profile. Its grants are enforced at the broker, and the OS profile stays zero. **This is the main reason T2 is safer than T3.**
- Only T3 and T4 compile capabilities into OS profile widenings.

**Target versioning:**
- A plugin with `target: 1` keeps target-1 behaviour until it raises its target. Example: target 2 might make `net` require explicit ports for non-443.
- **Security fixes ignore target.** Like Android, we may tighten for all, with a release note.
- Volt refuses plugins whose target is lower than `minSupportedTarget`, which rises over the years.

### 3.3 Composition and layering

**Layer order (low → high):**
1. built-in base (credential denies, protected paths);
2. tier profile (`plugin-host`, `exthost-default`, `mcp-default`, agent);
3. **signed provider/plugin layer** (trusted if signed by Volt's release key, untrusted otherwise);
4. user grants (trusted);
5. user policy file `~/.volt/sandbox.json` (trusted);
6. repo policy `.volt/sandbox.json` (untrusted, narrow-only).

This is the branch's rule (`sandboxComposition.ts` (sbx)): untrusted layers can only narrow, and each dropped widening is recorded and shown.

**New rule: a third-party plugin's declared layer is untrusted.**
- Its widenings take effect only through **grants** (layer 4), which the user creates at install (§8).
- So the manifest is a *request*, and the grant is the *authority*.
- For first-party, the signature turns the request into a grant automatically (§7.1).

### 3.4 Probe → enforce → launch → confirm → refuse → terminate

This keeps the branch's lifecycle exactly (brief §3), with two changes for hosts:
- **Confirm before the channel opens.**
  - The plugin host gets fd 3 only after `confirm()` succeeds.
  - Before that, core does not accept RPC on the channel, so a host that started unconfined can never act.
- **Refuse means the plugin does not run**, with a visible state in Extensions:
  - "Blocked: this system can't enforce `network`"
  - Buttons: **Details**, **Run without sandbox (this plugin, until restart)**.
  - The last button is unavailable for T2. T2 *only* runs sandboxed; there's no reason to unsandbox a worker that has no OS needs.

### 3.5 Long-lived hosts

- **Restart budget:** `maxPerHour` (default 5) → the plugin is marked broken with its last stderr.
- **Health:** an RPC ping every 30 s while UI or tools are live. A host that misses 3 pings is killed (tree kill). The macOS double-fork survivor gap (brief §3) is closed by the session-wide `processes` limit plus kill-by-sandbox-tag **[guess; `grok`]**.
- **Updates:** a new plugin version → a new host. The old host drains RPCs for 10 s, then is terminated.

### 3.6 Live grants

| Dimension | Live widening | How |
|---|---|---|
| network (T3, agents, MCP) | yes | `IPreparedSandbox.allowDomains` (exists). **Fix:** `allowSandboxDomains` (`src/vs/platform/voltStdio/node/voltStdioService.ts:219`) has no caller (brief §3). Wire it to the grant store's `onDidGrant`, and add allowed hosts to `sandboxLaunchKey`'s *proxy* identity, not its process identity. |
| network (T2) | n/a | broker check only; nothing to change in the OS |
| filesystem | **no**, by design | widen through the **file broker**: core opens the file and streams it, or passes an fd over the unix socket (`SCM_RIGHTS`, macOS/Linux) for big files **[guess: Windows handle duplication via MXC unknown]**. Re-profiling a live Seatbelt process is impossible anyway |
| process spawn, unix sockets, env | no | `needs-restart`; the UI says "Restart plugin to apply" |
| revocation | yes for net/broker; restart for OS-level | revoke = drop from proxy + broker immediately; OS-level revocations restart the host |

---

## 4. Backends per OS (brief; `grok` goes deep)

| OS | Backend | Minimum | Plugin hosts |
|---|---|---|---|
| macOS | Seatbelt via `sandbox-exec` (sbx `seatbeltBackend.ts`), host-level `deny default` for plugin hosts (T2 needs no `systemServices`) | macOS 12+ (Volt's floor) **[guess on floor]** | T2, T3, MCP, agents |
| Linux | bwrap + seccomp (sbx `bubblewrapBackend.ts`, `seccomp.ts`); Landlock as an extra layer where kernel ≥ 5.13 (main already has `common/landlock.ts`) | bwrap ≥ 0.6, unprivileged userns. If AppArmor blocks userns (Ubuntu 24.04+), ship an AppArmor profile in the .deb **[guess: needs packaging work]** | same |
| Windows | **MXC ProcessContainer via `wxc-exec`** (decided). Hostname rules are kept in Volt's proxy; MXC enforces "loopback proxy port only" with IP/port rules | Windows 11 24H2 26100.9278+ (brief §4) | T2 and T3: yes. On older Windows, **T2 still runs**: Node `--permission` + SES + broker-only APIs is three layers, minus OS. Shown as `partial` with `unenforced: [filesystem, network]`, and allowed only for **first-party** T2. Third-party T2/T3 is refused on old Windows, with "Update Windows to run sandboxed plugins". |

**CI:** macOS 14/15 arm64, Ubuntu 22.04/24.04 (userns on and AppArmor-restricted), Fedora (SELinux), Windows 11 24H2 runner (a self-hosted runner if GitHub's image is older **[guess]**). Windows 10 runs the refusal tests only.

---

## 5. Network broker (brief; `sol` goes deep)

- **One proxy per host process**, not per run, so the **identity** is the proxy port.
  - The proxy (`node/sandboxProxy.ts` (sbx)) gains a per-identity allowlist, and logs every connection with `{identity, host, port, bytes}`.
  - T3 and MCP hosts get their own proxy. T2 hosts get none (mode `none`); `volt.net.fetch` runs in core under the plugin's grant.
- **`volt.net.fetch(url, {auth: secretRef})`:** the broker injects the secret header, and the plugin never sees the token. Example: `{auth: 'secret:linear.token'}` → `Authorization: Bearer …`. Providers' API keys (`anthropic.ts`, `openaiCompat.ts`) work the same way, so a compromised provider plugin can use but not steal a key.
- **DNS:** the proxy resolves and pins (existing). Workloads get no resolver. On macOS, deny the mDNSResponder mach lookup in plugin profiles (the gap in brief §3).
- **Loopback and local network:**
  - Loopback is reachable only for listed ports (Volt's MCP port for agents, never for plugins).
  - LAN/private addresses are refused unless the grant says `net.local: true`. This is a separate permission, like Android 17.
  - That kills the DeepSeek CVE-2026-82533 pattern: an agent reaching an unauthenticated loopback API with a forged Host header.
- **UDP:** none for all plugin tiers. DNS goes through the proxy.
- **TLS:** no inspection. Domain fronting is a known residual risk; mitigate by matching SNI to CONNECT host **[guess: needs a ClientHello peek in the proxy]**.
- **Denial UX:**
  - A denied host appears once per plugin per host in the plugin's denial log.
  - It shows a toast only if the plugin is in the foreground (its panel is visible or its tool is running in the current turn): "Linear wants `uploads.linear.app` · Allow · Allow once · Deny".
  - "Allow" writes a grant and calls `allowDomains` live.

---

## 6. Migration: features → extensions (deep)

### 6.1 What "migrated" means: the definition of done per feature

A feature counts as migrated when **all** of these hold:
1. **Manifest is the source of truth.**
   - Its `extensions/volt-<x>/package.json` declares what `voltFeatures.ts` lists today: tools, commands, settings, items, sections, surfaces, dock entries, providers.
   - These go in new contribution points: `voltTools`, `voltSlotItems`, `voltSettingsPages`, `voltSurfaces`, `voltDock`, `voltAgents`, `voltModelProviders`.
   - `VOLT_FEATURES` (`voltFeatures.ts:96`) becomes a generated fallback for builds without manifests, then is deleted.
2. **Activation goes through the manifest.** Its code registers through `IVoltPluginContext` (§6.2), which is handed to an `activate(ctx)` function the feature module exports.
   - Today the feature's `*.contribution.ts` registers singletons and workbench contributions directly. Examples: `contrib/voltAgent/browser/pullRequests/agentPullRequests.contribution.ts:64-67` and `gitGraph/gitGraph.contribution.ts`.
3. **Import boundary.** The feature folder imports only from:
   - `vs/base/**`;
   - `vs/platform/volt<Own>/common/**` (its own broker interfaces);
   - the facade `vs/workbench/services/voltPlugins/common/voltApi.ts`;
   - UI kit modules (`createVoltButton`, `WorkbenchList`).

   It never imports another feature, the runtime or the orchestrator. This is enforced by a `code-import-patterns` rule in `eslint.config.js` per migrated folder, the same mechanism VS Code uses for layers.
4. **Capabilities declared, tested.** The manifest's `volt.capabilities` lists every capability it uses. A unit test runs the feature's activation against a facade with *only* those grants, and must not hit a denial.
5. **Disabling stays live.** `IVoltFeatureService` (`voltFeatureService.ts:26`) keeps working. Disabling = deactivating the module (disposing the `IVoltPluginContext`), not only hiding parts. That's stronger than today's `isOn` gating (`:65`) plus `setDisabledTools` (`:121`).

### 6.2 The Volt extension API surface

One API, three bindings:
- **T1:** in-process facade object.
- **T2:** SES endowment proxied over RPC.
- **T3:** `import * as volt from 'volt'` in the ext host, the way `vscode` is provided (an `ExtHostVolt*` per namespace + `MainThreadVolt*` customers).

Every method names its capability. Calls without the grant reject with `VoltCapabilityError { capability, target }`, which the host turns into a one-time grant prompt **only if** the call happened inside a user gesture or the plugin's foreground UI (§8.3).

```ts
declare module 'volt' {
  // --- volt.tools: what agents can call (the volt MCP server) -------------------------------
  namespace tools {                                                     // cap: tools.register (+ the tool's own class)
    function register(def: ToolDefinition, handler: ToolHandler): Disposable;
    // def: { name, title, description, inputSchema, class: 'safe'|'reads'|'writes'|'network'|'spawns'|'escapes',
    //        approval?: 'never'|'mode'|'always', groups?: string[], silent?: boolean }
    // `class` maps 1:1 onto HostToolSandboxClass (hostToolSandbox.ts:36 (sbx)) so sandboxed chats keep refusing
    // escapes. A plugin can't declare a class lower than its capabilities imply: a tool registered by a plugin
    // with `terminals.run` is at least `spawns`.
    function invoke(name: string, input: unknown, call?: ToolCallRef): Promise<ToolResult>;  // cap: tools.invoke:<name>
    const onDidInvoke: Event<ToolInvocation>;                           // cap: tools.observe
  }
  interface ToolHandler { (input: any, call: ToolCallContext, token: CancellationToken): Promise<ToolResult>; }
  interface ToolCallContext { chatId: string; runId: string; mode: Mode; cwd?: Uri; sandboxed: boolean;
    askApproval(reason: string): Promise<boolean>; progress(text: string): void; }
  interface ToolResult { content: (TextPart | ImagePart | BlockPart)[]; isError?: boolean; }
  // BlockPart = a declarative transcript block (markdown | table | chart(vega-lite subset) | diff | image | card | html(iframe))

  // --- volt.agents: providers -------------------------------------------------------------
  namespace agents {                                                    // cap: agents.provide
    function registerAgentProvider(id: string, impl: AgentProviderHooks): Disposable;
    // Data comes from contributes.voltAgents (command, acpArgs, adapter, login, sandbox layer);
    // hooks are optional code: detect(), listModels(), probeAuth(), loginCommand(), parseUsage().
    function registerModelProvider(id: string, impl: ModelProviderImpl): Disposable; // IModelProvider (providers.ts:106)
    // ModelProviderImpl.stream gets a broker `net` scoped to the provider's hosts and secret refs, never raw keys.
  }

  // --- volt.chats: threads, queue, subagents (core features, exposed read/send) -------------
  namespace chats {
    function list(filter?: ChatFilter): Promise<ChatSummary[]>;          // cap: agents.read
    function read(id: string, range?: TurnRange): Promise<Turn[]>;      // cap: agents.read
    function send(id: string, text: string, o?: SendOptions): Promise<void>;   // cap: agents.send (queues if busy)
    function create(o: NewChatOptions): Promise<string>;                // cap: agents.create
    function interrupt(id: string): Promise<void>;                      // cap: agents.control
    const onDidChange: Event<ChatChange>;                               // cap: agents.read; rate-limited 1/s per chat
    const onDidFinishTurn: Event<TurnFinished>;                         // cap: agents.read
    function activeChat(): ChatSummary | undefined;                     // cap: agents.read
  }
  namespace queue { function list(chatId): Promise<QueuedMessage[]>; function edit(...); function cancel(...); } // cap: agents.send
  namespace context {                                                   // the <volt_workspace> block
    function contribute(provider: ContextProvider): Disposable;         // cap: agents.context (adds text to prompts!)
  }

  // --- volt.ui: declarative + iframe -------------------------------------------------------
  namespace ui {                                                        // cap: ui.contribute (granted with any UI contribution)
    function registerSlotItem(id: string, impl: { label; icon; badge?: Observable<string>; run(): void }): Disposable;
    function registerDockSection(id: string, tree: DeclarativeView): Disposable;
    function registerSettingsPage(id: string, view: DeclarativeView | PanelRef): Disposable;
    function registerSurface(id: string, factory: (ctx: SurfaceContext) => PanelRef): Disposable;  // right-panel "+"
    function registerBlockRenderer(kind: string, panel: PanelRef): Disposable;   // custom transcript cards (iframe)
    function createPanel(id: string, html: Uri, o?: PanelOptions): Panel;        // iframe, postMessage only
    function showQuick(items: QuickItem[], o?): Promise<QuickItem | undefined>;  // Volt dropdown, never native select
    function notify(msg: string, actions?: string[]): Promise<string | undefined>;
    function addComposerChip(chatId: string, chip: Chip): void;         // cap: agents.send
  }
  // DeclarativeView = { kind: 'list'|'card'|'form'|'markdown'|'stat'|'chart', ... } rendered with WorkbenchList /
  // createVoltButton / createVoltDropdown, so lists-edge-to-edge and the shared-button rules hold without review.

  // --- volt.workspace / volt.files: file broker --------------------------------------------
  namespace files {
    function read(uri: Uri): Promise<Uint8Array>;                       // cap: workspace.read | files.granted(uri)
    function write(uri: Uri, data: Uint8Array): Promise<void>;          // cap: workspace.write | files.granted(uri, 'rw')
    function pick(o: PickOptions): Promise<Uri[] | undefined>;          // no cap: the picker *is* the grant
    function watch(glob: string): Event<FileChange>;                    // cap: workspace.read
    function search(q: TextQuery): AsyncIterable<Match>;                // cap: workspace.read (code index if enabled)
  }
  // Credentials and protected paths are refused here even with workspace.read: same lists as the sandbox base.

  // --- volt.git ---------------------------------------------------------------------------
  namespace git {
    function repos(): Promise<RepoRef[]>;                               // cap: git.read
    function log(repo, o): Promise<Commit[]>; function diff(repo, a, b?): Promise<Diff>;
    function blame(uri, range?): Promise<BlameLine[]>; function status(repo): Promise<Status>;  // cap: git.read
    function commit(repo, msg, paths?): Promise<string>;                 // cap: git.write
    function branch(repo, op): Promise<void>;                           // cap: git.write
    function push(repo, o): Promise<void>;                              // cap: git.push (prompts once per repo)
    function worktrees(repo): Promise<Worktree[]>;                      // cap: git.read
  }
  namespace hosting {                                                   // GitHub/GitLab via gh: PR features
    function pullRequests(repo, q): Promise<PullRequest[]>; function watch(pr): Disposable; // cap: hosting.read
    function createPullRequest(repo, o): Promise<PullRequest>;          // cap: hosting.write
  }

  // --- volt.terminals / volt.process -------------------------------------------------------
  namespace terminals {
    function start(o: { command; cwd?; name?; chatId? }): Promise<TerminalRef>;  // cap: terminals.run (always the chat's sandbox)
    function output(t, o?): Promise<string>; function send(t, text): Promise<void>; function stop(t): Promise<void>;
    function list(): Promise<TerminalRef[]>;                            // cap: terminals.read
    const onDidExit: Event<{ terminal; code }>;
  }
  namespace process {
    function exec(cmd: string, args: string[], o?: { cwd; timeoutMs; policy?: 'chat' | 'plugin' }): Promise<ExecResult>;
    // cap: process.exec:<cmd basename list>; always runs under SandboxManager.run() with the plugin's
    // compiled policy (never the host's). Used by provider auth probes (`codex login status`).
  }

  // --- volt.net / volt.secrets / volt.storage ---------------------------------------------
  namespace net { function fetch(url: string, init?: RequestInit & { auth?: SecretRef }): Promise<Response>; } // cap: net:<host>
  namespace secrets {
    function get(key: string): Promise<string | undefined>;             // cap: secrets:<key> — own namespace only
    function store(key, value): Promise<void>; function ref(key): SecretRef;  // ref() needs no read cap: use without reading
  }
  namespace storage { const global: Memento; const workspace: Memento; const dir: Uri; } // own dir only; no cap
  namespace config { function get<T>(key): T; const onDidChange: Event<string[]>; }      // own `contributes.configuration` keys; others need config.read

  // --- volt.browser / volt.devices / volt.desktop: native brokers (T1 owners expose them) -----
  namespace browser {                                                   // cap: browser.read | browser.drive
    function open(url, o?): Promise<BrowserTabRef>; function snapshot(tab): Promise<A11yTree>;
    function act(tab, steps: Step[]): Promise<ActResult>; function screenshot(tab): Promise<ImagePart>;
  }
  namespace devices { function list(); function snapshot(d); function act(d, steps); }   // cap: devices.drive
  // desktop (computer use) is NOT exposed to plugins in v1: TCC accessibility is all-or-nothing.

  // --- volt.automations / volt.usage / volt.memory: extension points other plugins use ------
  namespace automations { function registerTrigger(id, impl: TriggerImpl): Disposable; }  // cap: automations.trigger
  namespace usage { function report(e: UsageEvent): void; function registerSource(id, impl: UsageSource): Disposable; } // cap: usage.report
  namespace hooks { function on(event: 'preToolUse'|'postToolUse'|'turnStart'|'turnEnd', h: HookHandler): Disposable; } // cap: agents.hooks (can block tools: high)

  // --- volt.commands / volt.events --------------------------------------------------------
  namespace commands { function register(id, fn): Disposable; function execute(id, ...args): Promise<unknown>; }
  // execute() of a non-own command needs commands.execute:<id>; arbitrary VS Code commands are a sandbox escape
  // (e.g. `workbench.action.terminal.sendSequence`), so this cap is never granted by default.
}
```

**The capability catalog** extends customize §8's `agents.read`, `agents.send`, `terminals.run` and `network` (`docs/volt/customize.md:204`). Each capability gets a risk level for the consent UI:

| Risk | Capabilities |
|---|---|
| low (no prompt) | `ui.contribute`, `tools.register` (class ≤ reads), `storage`, own `config`, own `secrets`, `files.picked`, `usage.report` |
| medium (shown at install, grouped) | `agents.read`, `workspace.read`, `git.read`, `hosting.read`, `net:<listed hosts>`, `browser.read`, `terminals.read` |
| high (install + per-use the first time in a project) | `agents.send`, `agents.create`, `agents.context`, `agents.hooks`, `workspace.write`, `git.write`, `git.push`, `hosting.write`, `terminals.run`, `process.exec`, `browser.drive`, `devices.drive`, `net:*`, `net.local` |
| never for third-party in v1 | `commands.execute:*`, desktop control, `secrets` outside own namespace, `tools.invoke` of `escapes` tools |

### 6.3 Migration table: all 30 `extensions/volt-*`

Legend:
- **Wave:** order (§6.4).
- **End tier:** where it lives at the end of the plan. T1 means in-process, with facade and lint.
- **Core keeps:** what does not move.
- Line counts are from `wc -l` on main today.

| # | Extension (`volt.*`) | Feature (`voltFeatures.ts`) | Code today | Volt API it needs | End tier | Core keeps | Wave | Depends on |
|---|---|---|---|---|---|---|---|---|
| 1 | `provider-claude` | `provider.claude` (`:82`, mapped `:268`) | `cliAgents.ts:415` (def), `probeClaudeAuth :279`, `claudeCatalog.ts` (59), `providers/anthropic.ts` (172), `providerBrands.ts` | `agents.registerAgentProvider` (data in `voltAgents`), `agents.registerModelProvider`, `net:api.anthropic.com`, `secrets` (API key ref), `process.exec:[claude]` for probe | data + **T2** hooks | ACP client `acpProvider.ts`, `AcpAgentProvider` construction (`voltRuntimeService.ts:5660`), the chat sandbox | 1 | facade, `voltAgents` contribution point |
| 2 | `provider-codex` | `provider.codex` (`:83`) | `cliAgents.ts:404`, `probeCodexAuth :261`, `codexAppServer.ts` (200), `openaiCompat.ts` `createOpenAIProvider` | same + `net:api.openai.com` | data + T2 | `codexAppServer` protocol client stays core (it's a second agent protocol, like ACP) | 1 | 1 |
| 3 | `provider-cursor` | `provider.cursor` (`:84`) | `cliAgents.ts:428` | `voltAgents` data only (ACP models via `acpModels.ts`) | data only | — | 1 | 1 |
| 4 | `provider-grok` | `provider.grok` (`:85`) | `cliAgents.ts:436`, `grokAcpArgs :111`, `listGrokModels :314` | data + `listModels` hook, `process.exec:[grok]` | data + T2 | — | 1 | 1 |
| 5 | `provider-opencode` | `provider.opencode` (`:86`) | `cliAgents.ts:446`, `probeOpenCodeAuth :374`, `listOpenCodeModels :506` | data + hooks, `process.exec:[opencode]` | data + T2 | — | 1 | 1 |
| 6 | `provider-pi` | `provider.pi` (`:87`) | `cliAgents.ts:456`, `probePiAuth :390` | data + probe hook | data + T2 | — | 1 | 1 |
| 7 | `provider-antigravity` | `provider.antigravity` (`:88`) | `cliAgents.ts:468`, `listAntigravityModels :364`, `providers/gemini.ts` (201), `antigravityIcon.ts` | data + hooks + model provider, `net:generativelanguage.googleapis.com` | data + T2 | — | 1 | 1 |
| 8 | `provider-kimi` | `provider.kimi` (`:89`) | `cliAgents.ts:475` | data only | data only | — | 1 | 1 |
| 9 | `provider-muse` | `provider.muse` (`:90`) | `cliAgents.ts:483` | data only | data only | — | 1 | 1 |
| 10 | `provider-fx` | `provider.fx` (`:91`) | `cliAgents.ts:491`, `listFxModels :354` | data + listModels hook | data + T2 | — | 1 | 1 |
| 11 | `provider-local` | `provider.local` (`:92`) | `providers/ollama.ts` (238), `createLMStudioProvider`, `createCompatProvider` in `openaiCompat.ts` | `registerModelProvider`, **`net.local`** (localhost:11434, :1234) | **T2** | — | 1 | 1, broker `net.local` |
| 12 | `provider-openrouter` | `provider.openrouter` (`:93`) | `createOpenRouterProvider` (`openaiCompat.ts`) | `registerModelProvider`, `net:openrouter.ai`, secret ref | **T2** | shared OpenAI-compatible stream parser moves to a `@volt/provider-kit` package bundled into each provider (no core dep) | 1 | 1 |
| 13 | `claude-accounts` | `claudeAccounts` (`:274`) | `src/vs/platform/voltAccounts/**` (1,529, electron-main+node), accounts UI in `voltSettings/browser/providersPage.ts` | facade `ui.registerSettingsPage`, own broker `IVoltAccountsService` | **T1 forever** | the swap under Claude's locks writes `~/.claude` credentials: TCB by nature | 2 | 1 |
| 14 | `customize` | `customize` (`:280`) | `contrib/voltCustomize/**` (5,722), `voltSettings/browser/customizeVoltPage.ts`, `electron-browser/agentPlayground.contribution.ts` | facade `ui.*`, `config`, `commands` | **T1 forever** (it *is* the look engine, and registers `deltaConfiguration`) | `voltFeatures.ts` → generated from manifests; `IVoltFeatureService` stays core | 0 (hosts the catalog change) | — |
| 15 | `agent-resources` | `agentResources` (`:261`) | `contrib/voltAgent/browser/resources/**` (3,924) | `files.read` of harness dirs (scoped: `~/.claude/{agents,skills,CLAUDE.md}`, `~/.codex/AGENTS.md`… read-only, **never** credentials), `ui.registerSurface`, declarative list | **T2** (UI as declarative tree + one iframe page) | the harness load-order model (`common/harness/**`) stays core: the runtime uses it | 4 | 3, file broker with scoped home reads |
| 16 | `skills-and-plugins` | `skills` (`:254`) | `contrib/voltAgent/browser/customize/**` (7,933), `platform/voltMarketplace` (79), `voltExternalMcp` (2,241) | `ui.*`, files write into harness dirs, `net:skills.sh`, marketplace hosts | **T1 forever** | installing MCP servers and hooks = code exec setup; TCB. MCP *servers* themselves run sandboxed (§9.3) | 3 | 15 |
| 17 | `usage` | `usage` (`:240`) | `platform/voltUsage/**` (3,249, electron-main fetches with OAuth tokens + claude-cli UA), `voltAgent/browser/usage/**` (4,219), `voltAgent/browser/context/agentSessionUsage*.ts` | `usage.registerSource`, `net:` provider usage endpoints with **`auth: secretRef`** (never raw OAuth), `ui.registerDockSection`, `registerSlotItem`, `registerSettingsPage` | T1 → **T2** in wave 4 | per-turn token accounting (`tokenUsage.ts`, `getModelRates`) is runtime: core | 2 (T1), 4 (T2) | secrets broker with header injection |
| 18 | `memory` | `memory` (`:248`) | `services/voltRuntime/{browser,common}/memory/**` (608), served in volt-server (`agentServerMain.ts:83`) | `tools.register` (MEMORY_TOOL_NAMES), `storage.dir`, `context.contribute` (memory index in prompt) | **T2 first** (the first T2 plugin: tools + storage, no UI, no fs) | — | 2 | T2 host on volt-server |
| 19 | `automations` | `automations` (`:229`) | `voltAgent/browser/automations/**` (8,220), `voltRuntime/common/automations/**` (4,814), workflows (`voltAgent/browser/workflows/**` 17,077, `common/workflows/**` 9,354) | `tools.register`, `chats.create/send`, `automations.registerTrigger`, `ui.*` surfaces/settings/dock/item | **T1** (scheduler must run when windows are closed: server-side, starts agents) | scheduler tick in volt-server; `automations.registerTrigger` lets T2/T3 add triggers | 3 | facade `chats.*` |
| 20 | `code-intelligence` | `codeIntelligence` (`:143`) | `contrib/voltCodeIntelligence/**` (363), `platform/voltCodeIndex/**` (6,262, a node child), `server/node/voltAgent/serverCodeIntel.ts` (191) | `tools.register`, `ui.registerSettingsPage`; its **index child** gets an OS profile: read workspace, write `${storage}/index`, net none | **T1** + sandboxed helper process | — | 2 | SandboxManager merged (for the helper) |
| 21 | `git-graph` | `gitGraph` (`:150`) | `voltAgent/browser/gitGraph/**` (4,218), contract with `extensions/git` (`volt.gitGraph.open/askAgent`) | `git.read`, `ui.registerSurface`, `chats.send` (Ask agent) | **T1** (rewrite to iframe isn't worth it; revisit) | — | 2 | facade `git.*` |
| 22 | `pull-requests` | `pullRequests` (`:157`) | `platform/voltPullRequests/**` (9,295), `voltAgent/browser/pullRequests/**` (13,269, shared with commit review) | `hosting.*`, `git.*`, `tools.register`, `ui.*` | **T1** | the shared git-actions control (`agentGitActionsControl.ts`) is core UI (Commit/Push), not PR-specific | 3 | 21, split from 23 |
| 23 | `commit-review` | `commitReview` (`:166`) | `pullRequests/agentCommitPlanService.ts`, `agentCommitPlanTray.ts` | `tools.register` (COMMIT_PLAN_TOOL_NAMES), `git.write`, `ui.addComposerChip`/tray | **T1** | — | 3 | split out of `pullRequests/` folder first |
| 24 | `remote-devices` | `remoteDevices` (`:171`) | `platform/voltAgentServer/**` pairing parts, `server/node/voltAgent/serverPairing.ts` (442), `serverTunnels.ts` (647), `voltSettings/browser/devicesPage.ts`, `addDeviceModal.ts`, `voltAgent/browser/remote/voltRemoteIntro.ts` | `ui.registerSettingsPage`, `commands` | **T1 forever**: pairing and tunnels are the remote attack surface | pairing, tokens, tunnels (core); only the Devices page is the plugin | 2 | — |
| 25 | `browser` | `browser` (`:179`) | `platform/voltBrowser/**` (2,665, electron-main `<webview>`), `voltAgent/browser/preview/**` (13,051), `workspace/agentBrowserMount.ts` | exposes `volt.browser.*` broker to others; uses `tools.register`, `ui.registerSurface` | **T1 forever** (Electron webview + CDP) | the webview broker in main | 3 | facade `browser.*` |
| 26 | `playgrounds` | `playgrounds` (`:188`) | `PLAYGROUND_TOOL_NAMES` in `platform/voltHostMcp/node/voltHostMcpService.ts`, `voltAgent/browser/preview/browserAutomation.ts` | `tools.register`, `browser.drive`, `storage.dir` (pages outside the project) | **T1** (could be T2 once `browser.*` is a stable broker; candidate for wave 5) | — | 3 | 25 |
| 27 | `visuals` | `visuals` (`:193`) | `voltAgent/browser/visuals/**` (21,145), `platform/voltVisualPreview` (989), `electron-browser/agentVisuals.contribution.ts`, `server/node/voltAgent/serverRender.ts` | `tools.register`, `ui.registerBlockRenderer`, `ui.registerSurface` (canvas) | **T1** (block rendering is hot-path transcript UI); agent HTML stays in its sandboxed iframe as today | the declarative block kinds `chart`, `table` and `diagram` move into **core** `volt.ui` so third-party plugins can return them | 3 | `BlockPart` in core |
| 28 | `scratch-board` | `scratch` (`:201`) | `voltAgent/browser/scratchBoard/**` (15,277), `voltSettings/browser/canvasScratchPage.ts` | `tools.register` (`scratch_read/draw`), `ui.registerSurface`, `chats.create` (dock), `storage` | **T1** | "never move a started thread" invariant lives in core chats | 3 | facade `chats.*` |
| 29 | `devices` | `devices` (`:209`) | `platform/voltDevices/**` (2,927), `platform/voltCapture` (292), `voltAgent/browser/devices/**` (3,814), `electron-browser/voltDevices.contribution.ts`, `voltWindowCapture.ts` | exposes `volt.devices.*` broker; uses `tools.register`, `ui.registerSurface` | **T1 forever**; simulator/emulator helper processes sandboxed (net: loopback to sim ports) | device/capture brokers in main | 3 | — |
| 30 | `computer-use` | `computerUse` (`:217`) | `platform/voltDesktop/**` (405), `voltAgent/browser/desktop/agentDesktopTools.ts` (326), `electron-browser/voltDesktop.contribution.ts` | `tools.register` (class `escapes`, approval `always`) | **T1 forever**; never exposed to plugins in v1 | TCC responsible process = Volt.app | 2 | — |

**Tally:**
- Data only: 3 (cursor, kimi, muse).
- Data + T2 hooks: 7 (claude, codex, grok, opencode, pi, antigravity, fx).
- T2: 5 (local, openrouter, memory, agent-resources, and usage from wave 4).
- T1: 15 (claude-accounts, customize, skills-and-plugins, automations, code-intelligence, git-graph, pull-requests, commit-review, remote-devices, browser, playgrounds, visuals, scratch-board, devices, computer-use). Of these, 7 are "T1 forever" (TCB or native).

### 6.4 Order (waves) and how Volt stays shippable after each

Every wave ships on main behind no flag. The **invariant** is that each step keeps today's behaviour when nothing is disabled, using the same "missing manifest leaves the feature on" rule `voltFeatureService.ts:20-21` already applies.

| Wave | What lands | Shippable because |
|---|---|---|
| **W0: facade + catalog from manifests** | `src/vs/workbench/services/voltPlugins/common/voltApi.ts` (types), `common/voltCapabilities.ts` (catalog + risk), `browser/voltPluginContext.ts` (T1 facade; capability checks in **audit mode**: log, never block), `IVoltCapabilityService`. Contribution points `voltTools`/`voltSlotItems`/`voltSettingsPages`/`voltSurfaces`/`voltDock`/`voltAgents`/`voltModelProviders` read by a new `VoltContributionsReader`. The 30 stub manifests get their `contributes` filled from `VOLT_FEATURES`, generated once by a script and then hand-owned. `voltFeatures.ts` merges manifest data over its table. | No feature moves; audit mode can't break anything; unit test asserts manifest-derived catalog == old table |
| **W1: providers (12)** | `CLI_AGENT_DEFINITIONS` → `contributes.voltAgents` per provider manifest; `registerProviders()` (`voltRuntimeService.ts:5647`) iterates contributed definitions instead of the constant. Probe/listModels functions stay core in W1, called by id (T1). Model providers register through the facade. The per-agent sandbox layers from `sandboxProfiles.ts` (sbx) move into each provider's manifest as **signed layers**. | Same objects get constructed from the same data; parity test: contributed defs deep-equal the old constant |
| **W2: self-contained features → T1 under facade, enforce mode on** | memory, usage, code-intelligence, git-graph, claude-accounts, remote-devices (page only), computer-use. Each: an `activate(ctx)` entry, import lint on, its `*.contribution.ts` reduced to "call activate when the extension is enabled". Capability checks flip to **enforce** per migrated feature only. | Each feature is one PR, revertible alone; a capability test per feature runs activation with only its manifest grants |
| **W3: entangled features** | split `voltAgent/browser/pullRequests/` into pull-requests / commit-review / core git-actions; then browser (exposing `volt.browser` broker), devices, visuals (core `BlockPart` first), playgrounds, scratch, automations, skills-and-plugins | Order respects deps in the table; the browser broker lands before playgrounds/visuals consume it |
| **W4: T2 host + first T2 plugins** | needs SandboxManager merged + `startHost` (§12 PR 5–7). Move **memory** first (no UI), then the providers' hooks (probe/listModels as T2 functions with `process.exec`), local/openrouter model providers, agent-resources, usage | A T2 plugin that fails to start falls back to **its T1 build of the same code** for first-party only (same source compiled twice; the T1 path deleted one release after T2 is stable). Third-party has no fallback |
| **W5: third-party opens** | T3 sandboxed ext host default for Open VSX installs on volt-server; Volt API in T3; marketplace capability display | see §9 |

**How the code physically moves:**
- **First-party T1 code stays in `src/vs/workbench/contrib/volt<Feature>/`.** It is split out of the 253,780-line `contrib/voltAgent` into one folder per feature, for example `contrib/voltAgent/browser/gitGraph/` → `contrib/voltGitGraph/browser/`.
  - Moving T1 code into `extensions/volt-*/src` would fight VS Code's build. Built-in extensions are compiled separately and can't import workbench code, and the facade is a workbench service.
  - The **manifest** in `extensions/volt-*` points at it with `"voltModule": "vs/workbench/contrib/voltGitGraph/browser/voltGitGraph.module"`. This is accepted only for `publisher: volt` with a valid built-in signature (§7).
- **T2 first-party code** lives in `extensions/volt-<x>/src/` and builds to `out/` with the extensions build (`gulp compile-extensions`), as an ES module whose default export is `activate(volt)`.
  - It imports only `volt` (types from `src/vscode-dts/volt.d.ts`, new) and `@volt/provider-kit`.
  - This is exactly what a third-party plugin looks like.
- **`voltRuntimeService.ts` (6,224 lines) loses:** `registerProviders` (`:5647`), provider-specific branches in profiles and seeding (`seedProfiles`), and usage reporting. Tracked by a "no provider id string literals in core" lint in W1+ **[guess: some ids leak into compaction and harness code; inventory needed]**.

### 6.5 What stays core (not a plugin, no switch)

These are the `voltFeatures.ts` entries with no `extensionId`:
- threads, queue, subagents, run groups, questions/plans, worktrees, terminals, workspace context, image inspection.

Plus everything that enforces or brokers:
- `voltSandbox`, `voltStdio`, `voltHostMcp`, `voltAgentServer` (minus the Devices page), `voltStorage`, `voltWindowScope`, the ACP and Codex app-server clients, `IVoltFeatureService`, `IVoltCapabilityService`, the grant store, the file/secret/net/git/terminal brokers, and `voltRelay`.

The brokers (browser, devices, desktop, git, hosting) are **core services owned by a feature**. When the feature is disabled, its broker refuses calls with "feature off", and other plugins' uses fail gracefully.

### 6.6 Risks specific to migration

- **Hidden coupling inside `voltAgent`.**
  - `agentEditor.ts`, `agentTranscript.ts` and `agentBlocks.ts` import feature code directly. `agentBlocks.ts` imports `voltSandbox` types, for instance; see the grep: 10 files outside `voltSandbox` import it.
  - Each W2/W3 PR must cut those imports to the facade or to core types.
  - Budget: the PR/commit-review split alone touches ~13k lines.
- **Tool registration timing.** Agents read the tool list at session start (`getMcpServers`, `hostTools.ts:1029`). A lazily activated T2 plugin must contribute tool *schemas* from the manifest (`voltTools`), so the list is complete before activation. Activation happens on first call (`onTool:<name>`).
- **Server vs window.** Today in agent-server mode, server tools "stay on" and only the window's tools are filtered (customize §6.1d). After migration, the feature catalog has to be evaluated **on the server** too. Enablement state must be readable by volt-server; today it's workbench storage. **[guess: needs an enablement mirror in the server, like the window-scope index]**.

---

## 7. Signing and trust

### 7.1 First-party: declared, auto-granted, enforced anyway

- **Built-in extensions** (`extensions/volt-*`, shipped inside the signed app bundle) are trusted by **location + app code signature**. macOS notarization, Windows Authenticode and the Linux package signature cover them.
  - At startup, core verifies a `builtin-manifest.json` that lists each built-in extension and the SHA-256 of its `package.json` + `out/` tree.
  - That file is generated at build and covered by the app signature.
  - A tampered built-in (malware editing `Volt.app/Contents/Resources/app/extensions/volt-usage/out/…`) fails the hash and the plugin is refused. Tampering with the bundle also breaks macOS's own signature check on next launch.
- **First-party plugins updated out of band** (if we ever ship them through a feed) are signed with a **Volt plugin key**. This is distinct from the app release key: an Ed25519 key in an HSM or KMS, used only by the release workflow, and the public key is pinned in the app.
- **The grant:** a valid Volt signature + `publisher: volt` → capabilities in the manifest are granted silently. Nothing else is granted. `voltModule` (T1 in-process) is honoured **only** for built-ins, never for feed updates. An in-process code path is never downloadable.
- **Why not "allow all":**
  1. A logic bug in `usage` (which handles OAuth tokens) can't become a `terminals.run`.
  2. A compromised feed update can only do what the previous manifest allowed, unless the manifest grew. If it grows, that's a **capability diff** that the app shows ("Volt Usage now also wants: run terminals"), even for first-party.
  3. CODEOWNERS on `extensions/volt-*/package.json`'s `volt.capabilities` makes privilege growth a reviewed event.

  Zero friction is preserved: the user never sees a prompt for a built-in.

### 7.2 Third-party signing

- **Open VSX signatures** (`.sigzip`) where present. Volt adds **publisher key pinning (TOFU)**: the first install records the publisher's signing key, and an update signed by another key is blocked with "Publisher key changed".
- **Volt-native plugins** published to Volt's own index must be signed with a publisher key registered there.
- **Revocation feed:** a signed JSON (`revoked: [{id, versions, reason}]`, `minTarget`) fetched daily and on start. A revoked plugin is disabled with a banner, and its grants are frozen, not deleted, so a reinstall after a fix doesn't re-prompt for unchanged capabilities.
- **Reproducible builds:** first-party T2 bundles and `builtin-manifest.json` are built reproducibly in CI (pinned Node and npm lockfile; memory: `volt-ci-pipeline`). A second CI job rebuilds and compares the hashes. Third-party: not required in v1, shown as a badge if the marketplace verifies it.
- **Dev/unsigned mode:**
  - "Load unpacked" (F5 / Extension Development Host / `--extensionDevelopmentPath`) runs **with the same sandbox and the manifest's capabilities**, granted without signature but with a persistent orange "Unsigned dev plugin" badge, and only in a window started for development.
  - **Unsigned never gets T1 / `voltModule`.**
- **Playground drafts** (customize §5): looks and layouts are data and need no signature. A draft with code is loaded as an unsigned dev plugin in T2 only. "Install as Extension" (`local.*`) produces a **locally signed** plugin.
  - The key is generated per machine and stored in the keychain.
  - It is trusted only on that machine.
  - Its capabilities are prompted like a third-party install, because the agent wrote it.

---

## 8. Permissions model and UX

### 8.1 Manifest

- **The manifest is `package.json`'s `volt` block** (§3.2). It does not use `contributes.voltCapabilities`.
- `contributes` is for UI and data contributions. Capabilities are about the code's authority, not about what it contributes.
- A separate top-level block also lets T3 extensions with no `volt` block be recognised as "no manifest" (§9.1).

### 8.2 When grants happen

| Kind | When | Example |
|---|---|---|
| install-time | low + medium risk, one grouped sheet ("Linear can: read your chats · reach api.linear.app · store a token") | most plugins |
| first-use per project | high risk, the first time in a workspace, during a user gesture or a running turn the user started | `git.push`, `terminals.run`, `agents.send` |
| one-time | out-of-manifest requests surfaced from a denial ("Allow once") | an unexpected host |
| picker | `files.pick` | the picker selection is the grant, scoped to those URIs, persisted only if the user ticks "remember" |

### 8.3 No prompt fatigue

1. Never prompt from background code. A denied call outside a gesture or the plugin's foreground UI is denied silently and logged in the plugin's page, with a badge on the Extensions entry.
2. Group by plugin and show once.
3. Low-risk capabilities have no prompt.
4. Built-ins have no prompt.
5. "Allow for this project" is the default button for high-risk capabilities, not "Always".
6. A per-session budget: after 3 prompts from the same plugin in 10 min, further requests are denied and summarised: "Linear asked 5 more times; review in its page".

### 8.4 Storage, update, revocation

- **Grants live in volt-server's storage** (`~/.volt/grants.json` + profile storage mirror), keyed by `{pluginId, publisherKeyFingerprint, capability, scope(project|global)}`. They are on the server because the hosts run there and every client must agree.
- **Update with a capability diff:** the new version doesn't activate until the user accepts the diff. Until then, the old version keeps running if it's still installed. Otherwise the plugin stays off with a "Review new permissions" badge.
- **Revoke:** the plugin's page in Extensions has a **Permissions** tab listing every grant with Revoke. Revocation applies live for broker and network grants, and restarts the host for OS-level grants (§3.6).

### 8.5 What the user sees

- **Extensions entry:** tier chip (`Built-in` / `Sandboxed` / `Sandboxed (partial)` / `Not sandboxed`), publisher verification, capability summary.
- **Plugin page tabs:** Details · Permissions · Activity (denials, network hosts reached, tools it registered, last 7 days).
- **Settings → Capabilities** (the existing Playground Capabilities tree, `voltCapabilities.ts`) gains a per-plugin grant view.

---

## 9. Third-party extensions

### 9.1 VS Code extensions with no `volt` block (T3 default)

**`exthost-default` policy:**
- Read: workspace, the extension's own dir, `${system}` toolchains, and a curated **toolchain read list**: `~/.cargo`, `~/.rustup`, `~/go`, `~/.nvm`, `~/.pyenv`, `~/.local/share/mise`… **[guess: list to derive from the top 200 Open VSX extensions]**.
- Write: workspace, its `globalStorage`/`workspaceStorage`, `${tmp}`.
- Credential denies and protected paths as always.
- Network: `proxy`, with `*` *public* hosts allowed but `net.local` off and **every host logged**.
- Spawn allowed inside the sandbox; children inherit the profile, so language servers work.
- No unix sockets except the ext host pipe.

Why `*` public by default: a deny-by-default network for 60k unmanifested extensions breaks almost everything (telemetry, language-server downloads, docs). The protection that matters, credentials and persistence, is filesystem. That's the honest trade. Network tightening comes from a manifest or from the marketplace's observed-hosts data.

**What breaks** (listed in the T3 compat doc and shown as a hint when a known pattern is denied):
- Extensions reading `~/.gitconfig` / `~/.ssh/config` (GitLens remotes) → offer a `git` broker capability.
- Docker extensions (`/var/run/docker.sock`) → explicit `host.unixSockets` grant.
- Extensions that write outside the workspace (global formatters writing caches in `~/.cache/<x>`) → add `${cache}/<publisher.name>` to the write list by default.
- Debug adapters attaching to processes (ptrace denied) → a high-risk grant.
- Extensions using the keychain directly → VS Code `SecretStorage` already brokers through the main thread; native keytar use is denied.

**Desktop's local ext host** (`extensionHostStarter.ts:77`, a `WindowUtilityProcess`) can't be wrapped.
- **Decision for v1:** with the agent server on (the default), third-party extensions run in volt-server's sandboxed ext host, as remote workspace extensions do. `extensionKind: ui` extensions that need the window's host stay in the local host, unsandboxed, and are labelled "Not sandboxed".
- **v2:** a `SandboxedLocalExtensionHostStarter` in electron-main that spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` + `bootstrap-fork` under SandboxManager, with the named-pipe connection the server already uses (`extensionHostConnection.ts:254-259`). **[guess: needs a spike on renderer↔pipe wiring]**.
- **Env:** the trusted host layer names exactly the variables `bootstrap-fork` needs: `VSCODE_ESM_ENTRYPOINT`, `VSCODE_HANDLES_UNCAUGHT_ERRORS`, `VSCODE_EXTHOST_IPC_HOOK` (or the socket variant), `VSCODE_NLS_CONFIG`, `VSCODE_CODE_CACHE_PATH`, `ELECTRON_RUN_AS_NODE`, `NODE_CHANNEL_FD`. Brief §2's caution applies **[guess on the exact list: derive from `writeExtHostConnection` and `bootstrap-fork.ts`]**.

**Web-worker host:**
- Extensions with only a `browser` entry run there.
- **Hardening:** the iframe CSP for that host (`webWorkerExtensionHostIframe.html`) gets a `connect-src` built from the extension's granted hosts. That needs one host iframe per extension group with the same grants **[guess on feasibility]**.

### 9.2 Volt-native third-party

- **T2 only in v1.** A Volt-native plugin with `"volt": {"tier": "node"}` runs in T3 with the Volt API and its compiled OS profile. That's allowed but shown as "Node plugin: broader access".
- Marketplace sorting ranks T2 above T3, to steer authors to T2.
- **SDK:** `npm create volt-plugin`, a T2 template, `volt.d.ts`, a local runner that loads the plugin in a dev Volt with the real sandbox. Debugging uses `--inspect` on the host process, mapped through the channel. The authoring path must be as easy as a VS Code extension; the SDK Runtime lesson from brief §4 is the reason.

### 9.3 MCP servers

- **stdio MCP servers** launched by Volt (`voltExternalMcp`) run under `mcp-default`:
  - read workspace + own dir;
  - write `${tmp}` + own state dir;
  - network `proxy` with **no hosts** until granted.
  - The MCP server's install sheet asks for the hosts its README or config declares; first-run denials surface as "Allow host".
- **HTTP MCP servers:** Volt is the client, so the broker governs Volt's outbound request. Tool *classes* for MCP tools default to `network` + `writes` unless the server is on the curated list.
- **MCP servers the agent CLI launches itself** (`.mcp.json`, Claude's settings) inherit the **chat sandbox**, because they're the CLI's children. That is the correct boundary and needs no new work.

### 9.4 Agent CLIs

These are not plugins. They're processes under the **chat sandbox** (existing schema v1, provider layer from the provider manifest, §6.4 W1). A third-party provider plugin's `voltAgents` sandbox layer is *untrusted*: its widenings (its credential dir, its API host) become grants at install, shown as "Mistral Agent needs: read/write `~/.vibe`, reach `api.mistral.ai`".

### 9.5 Marketplace review

- **Automated:** manifest lint, capability-vs-code static check (a T2 bundle calling `volt.net.fetch` with literal hosts not in the manifest is flagged), malware scanning, and diffing of capabilities between versions. High-risk capability growth means manual review.
- **Badges:** Verified publisher, Sandboxed (T2), Reproducible.

---

## 10. Brokers instead of raw access

| Resource | Broker | Grant shape | Notes |
|---|---|---|---|
| files | `volt.files` (core, volt-server, `IFileService` on the server) | `workspace.read/write`, picker URIs, `files.granted(uri)` | credential and protected path lists enforced in the broker too, not only in the OS profile |
| secrets | `volt.secrets` over `ISecretStorageService`; namespaced `<pluginId>/<key>` | own namespace free; `ref()` usable by `net.fetch` without read | the OAuth tokens in `voltUsage`/`voltAccounts` move behind refs in W4 |
| network | `volt.net.fetch` (core) / per-host proxy (T3) | `net:<host>`, `net.local` | header injection for refs |
| terminals | `volt.terminals` → existing `ServerTerminals` | `terminals.run` | always launched in the *chat's* sandbox (or a plugin-scoped one when no chat), never in the host's |
| git | `volt.git` over `voltGit` + `extensions/git` | `git.read/write/push` | `push` prompts per repo; hooks are protected paths, so a plugin can't plant one through `files.write` |
| clipboard | `volt.ui.clipboard.write` free, `read` only in a gesture | `clipboard.read` | |
| UI | declarative tree / iframes + `postMessage` | `ui.contribute` | no DOM access ever |
| commands | `volt.commands.execute` | `commands.execute:<id>` allowlist | blocks the `sendSequence`/`runCommands` class of escapes |
| agents | `volt.chats` / `volt.tools` | `agents.*` | `agents.send` text is labelled as plugin-originated in the transcript, so prompt-injection provenance stays visible |

---

## 11. Verification

**Adversarial suite per tier** (extends `sandboxSecurity.test.ts` (sbx)). Each case below is a test plugin in `test/sandbox/plugins/`:
- T2:
  - escape SES via known intrinsic tricks (`Function.prototype.constructor`, `Error.prepareStackTrace`, `import()`);
  - after a simulated escape (a test-only hook that hands the worker raw `process.binding`), try `fs.open('~/.ssh/id_ed25519')`, `net.connect(443)`, `child_process.spawn`, and connecting to the host MCP port.
  - Expect OS denials logged with the plugin identity.
- Identity: plugin A forges `pluginId: B` in an RPC payload. Expect B's grants unused and the call denied.
- T3: a VS Code extension reads `~/.aws/credentials`, writes `.git/hooks/pre-commit`, writes `~/.zshrc`, scans `192.168.0.0/24`, resolves `metadata.google.internal`, and opens `/var/run/docker.sock`.
- **DeepSeek replays** (brief §4): a plugin forging RPC to volt-server's `/ws` with a forged Host header; overwriting `/bin/bash`; recursive `grep /proc`; `yes > file` (expect `fileSizeMB` kill); port-scanning loopback; hunting for other plugins' storage dirs.
- **Android replays:** an update that raises capabilities without consent; a downgrade to an older version with a lower target (refused below `minTarget`); a revoked plugin.
- **Facade tests:** every feature's activation under exactly its manifest grants (§6.1 item 4). An "unused capability" check warns when a manifest lists a capability the feature never calls.

**CI matrix:** as in §4; the T2/T3 suites run on every OS row, the refusal suite on Windows 10.

**Fuzzing:** the v2 manifest parser and the v1 policy parser get `jsfuzz`/property tests (strict parser, `MAX_POLICY_BYTES`, `sandboxSchema.ts:182` (sbx)), plus a differential test: compile → v1 → parse round-trip.

**Attestation:**
- Each host reports `{backend, status, unenforced[], confirmedAt, profileHash}` to `ISandboxManager.onDidChangeEnforcement`. This is shown in the plugin page.
- An opt-in telemetry counter records `partial`/refused per OS build, so we know when Windows MXC rollout lets us stop allowing `partial`.

---

## 12. Phased roadmap (numbered PRs)

| PR | Scope | Files | Accept | Ships to users |
|---|---|---|---|---|
| 1 | Merge `feat/volt-sandbox` (ask user first) | `src/vs/platform/voltSandbox/**` (replaces main's older copy), `voltStdio` | branch tests pass on mac+linux CI; the old `landlock/seatbelt/sandboxLauncher` imports are gone | chat sandbox as on branch |
| 2 | Wire live "Allow host" | `voltStdioService.ts:219` caller, grant store stub | allowing a host reaches a running agent's proxy without restart (test) | fix |
| 3 | **W0** facade + capability catalog (audit mode) + Volt contribution points + manifests filled | `services/voltPlugins/**` (new), `voltCustomize/common/voltFeatures.ts`, 30 `extensions/volt-*/package.json` | catalog parity test; no behaviour change | nothing visible |
| 4 | **W1** providers from manifests | `cliAgents.ts`, `voltRuntimeService.ts:5647`, 12 provider manifests, provider sandbox layers | parity test on definitions; all 12 detect as before (live check with Grok 4.7 per memory) | nothing visible; disabling a provider now also unloads its definition |
| 5 | `SandboxManager.startHost` + `plugin-host` profile + v2 fields `process.spawn`, `host.channels` | `voltSandbox/node/sandboxManager.ts`, backends | host confirmed on mac/linux; spawn and fs denied (adversarial) | — |
| 6 | T2 host process + SES + RPC + `MainThreadVolt*` for `tools`, `storage`, `context` | `src/vs/server/node/voltPlugins/**` (new), `src/vscode-dts/volt.d.ts` | a test plugin registers a tool callable by an agent; identity forging test | — |
| 7 | **W4a** memory as the first T2 plugin | `extensions/volt-memory/src`, remove `VoltMemoryService` from `agentServerMain.ts:83` | memory tools work in desktop, web, phone; T1 fallback path present | memory runs sandboxed |
| 8–14 | **W2** one PR per feature (usage, code-intelligence + sandboxed index child, git-graph, claude-accounts, remote-devices page, computer-use, memory's T1 fallback cleanup) | per table | per-feature capability test; import lint on | no visible change; features disable more completely |
| 15 | Split `voltAgent/browser/pullRequests/` | → `contrib/voltPullRequests`, `contrib/voltCommitReview`, core git actions | lint clean | — |
| 16–22 | **W3** browser broker, devices, visuals (core `BlockPart`), playgrounds, scratch, automations, skills | per table | per feature | — |
| 23 | Grants store + consent UI + Permissions/Activity tabs | `services/voltPlugins/browser/**`, Extensions editor contribution | UX review; prompt budget test | permissions visible for built-ins (read-only) |
| 24 | T3 sandboxed ext host on volt-server, `exthost-default`, env allowlist | `extensionHostConnection.ts:247-277`, `voltSandbox` | top 50 Open VSX extensions smoke-tested; compat doc | **third-party VS Code extensions sandboxed (server mode)** |
| 25 | `mxcBackend.ts` (Windows) | `voltSandbox/node/mxcBackend.ts` | Win11 24H2 CI | Windows sandbox |
| 26 | **W4b** provider hooks to T2; local/openrouter; agent-resources; usage behind secret refs | provider extensions, `voltUsage` | parity per provider | providers sandboxed |
| 27 | Volt-native third-party: SDK, signing, revocation feed, marketplace index | `apps/volt-plugin-sdk` (new), server index | an external sample plugin installs, prompts, runs, gets revoked | **third-party Volt plugins** |
| 28 | Web-worker host CSP per grant; local desktop sandboxed ext host spike | — | spike report | — |

---

## 13. Risks, open questions, decisions for the user

**Risks:**
1. **T1 is still big.** 15 of 30 end in-process. If T1 code has a bug that a prompt-injected agent can reach (e.g. the browser broker's `browser_run` edits), the sandbox doesn't help. Mitigation: the facade's capability checks, plus host-tool classes for sandboxed chats. Accept it explicitly.
2. **SES in worker_threads on Electron's Node 22** has fewer production miles than SES in browsers **[guess]**. Mitigation: the OS profile is the real wall. SES is the second.
3. **The "public `*` network by default" for T3** is a deliberate weakness, called out so no one mistakes T3 for strong exfiltration protection.
4. **Cost of the migration.** W2+W3 touch ~120k lines of `voltAgent`. That's ~20 PRs; each is independently revertible, but the total is months.
5. **Server-side enablement** (§6.6) is a prerequisite I can't size without reading `IGlobalExtensionEnablementService` on the server.

**Open questions:**
- Does T2 need its own UI process for heavy iframes on the phone, or is `/code/`'s webview infra enough? **[guess: enough]**
- Should T2 offer `process.exec` at all? I included it only for provider probes. Alternative: probes become declarative (`"probe": {"command": ["codex","login","status"], "parse": "regex"}`), and `process.exec` disappears from T2 entirely. **I lean declarative**, which would make T2 strictly spawn-free.

**Decisions for the user:**
1. **Replace "first-party allow all" with "declared + auto-granted by signature + enforced".** Same zero friction; bounded blast radius. (Recommended.)
2. **T2 host location = volt-server only.** Desktop with the agent server off refuses third-party plugins. (Recommended.)
3. **T3 default network = public `*` with logging,** versus deny-by-default with breakage. (Recommend public `*` for v1.)
4. **First-party T1 code stays in `src/vs/workbench/contrib/volt<Feature>/`,** pointed at by `voltModule` in the manifest, versus moving it into `extensions/volt-*/src`. (Recommend staying; moving buys nothing and breaks the build model.)
5. **The T2 dogfood set** (memory, 12 provider hooks, local/openrouter, agent-resources, usage): approve it as the commitment that keeps T2 alive.
6. **Old Windows (pre-24H2):** first-party T2 runs `partial`; third-party is refused. Approve or require refusal for all.
