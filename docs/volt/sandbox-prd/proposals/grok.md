# Grok: OS sandbox core, backends, Windows, escapes

Round 1 proposal. Emphasis: `SandboxManager`, policy v2, the launch lifecycle for one-shot commands and long-lived hosts, and the Windows backend. The other twelve sections are decided here too, at the depth the core forces.

This checkout is `volt/is-everything-plugged-into-volt` (VS Code 1.105.1, Electron 37.6.0 in `package.json`). Sandbox code is on `feat/volt-sandbox` and is not merged. Line refs say which.

## Verdict

1. Keep Volt's own `SandboxManager`. Seatbelt and bubblewrap stay the macOS and Linux backends. Do not adopt MXC or sandbox-runtime (srt) as the cross-platform layer (`feat/volt-sandbox:docs/security/sandbox/01-decisions.md`, ADR-5 and ADR-14). MXC is the Windows backend only ([mxc](https://github.com/microsoft/mxc)); srt is the reference for its Windows user design ([sandbox-runtime](https://github.com/anthropics/sandbox-runtime)).
2. Windows gets a real backend. **MXC ProcessContainer, launched only through the signed `wxc-exec` binary, is the primary.** The Node SDK is not a dependency (it needs Node 24; Electron 37.6.0 is Node 22).
3. **There is no silent fallback.** A failed MXC probe or a failed confirm kills the run and returns `failed` / `unavailable`. It does not retry on another backend and it does not run unsandboxed. That is the fix for F-01 (`feat/volt-sandbox:docs/security/sandbox/03-security-findings.md`).
4. An srt-win-style **sandbox-user** backend is a second, explicit backend. It is selected only when MXC cannot apply to this OS build, or when the program is MSYS2/Git Bash/Cygwin (those crash inside ProcessContainer). It is never the recovery path for a broken MXC trial.
5. If neither backend's probe is `available`, Windows refuses. Windows 10 included.
6. "First-party allow all" must not mean `sandbox: false`. It means a signed manifest whose capabilities are pre-granted, still enforced by this manager. The renderer, the Electron main process, and `SandboxManager` itself stay the trusted computing base and are not plugins inside a sandbox.

---

## 1. Threat model

### Assets

| Asset | Where it sits | What a break costs |
|---|---|---|
| User credentials | `~/.ssh`, cloud CLIs, browser profiles, Keychain, `credentials` files. Denied by `credentialDenyEntries()` (`feat/volt-sandbox:src/vs/platform/voltSandbox/common/sandboxProfiles.ts:20-66`) | Account takeover that outlives the chat |
| Secret env | Anything `isSecretEnvName` matches, including `VSCODE_*` and `ELECTRON_*` (`sandboxProfiles.ts:74-80`) | IPC endpoints and API keys |
| Planted host code | git hooks and config, shell rc, `.vscode`, `.claude/settings.json`, MCP lists (`sandboxProfiles.ts:42-58`) | Next unsandboxed git/shell/task runs the attacker's program |
| Volt IPC | Extension-host pipe and socket (`VSCODE_EXTHOST_IPC_HOOK`, `VSCODE_EXTHOST_WILL_SEND_SOCKET` in `src/vs/workbench/services/extensions/common/extensionHostEnv.ts:18` and `:35` on this checkout). F-03 on the branch | A plugin starts an unsandboxed extension host |
| Other chats, terminals, the workspace | Host tools (`feat/volt-sandbox:src/vs/workbench/services/voltRuntime/common/hostToolSandbox.ts:235`) | The model reads or edits work the user did not hand it |
| The machine | Same-user processes, Docker socket, `wsl.exe`, Launch Services, WFP-unrestricted egress | Sandbox is irrelevant once the attacker is the user |

### Attackers

1. **Malicious plugin.** A VSIX from Open VSX, a Volt-native plugin, an MCP server, or a Playground draft the user installed. It is code the user did not write, running on their machine.
2. **Compromised update.** A signed first-party or a reviewed third-party build that changes its bytes or its capability set. Signing without a capability diff is the same as allow-all.
3. **Prompt-injected agent.** The model is hostile for one turn because the repo, a web page, or a tool result told it to be. It may run shells, call host tools, and write files. This is the attacker the branch already targets (`feat/volt-sandbox:docs/security/sandbox/00-assessment.md`).
4. **Malicious repo.** `.volt/sandbox.json`, `.vscode/tasks.json`, `.mcp.json`, git hooks, `package.json` scripts. Untrusted layer. `composeSandboxPolicy` may only narrow (`feat/volt-sandbox:src/vs/platform/voltSandbox/common/sandboxComposition.ts:12-25`, `narrow` at `:128`).
5. **Network attacker.** SSRF to metadata and loopback, DNS rebinding, a hostile CDN in front of an allowed name. The proxy's job (`feat/volt-sandbox:src/vs/platform/voltSandbox/node/sandboxProxy.ts`).

A sandbox escape is any of these becoming a process that is no longer under the policy, or a later unsandboxed Volt/git/shell action that runs what the sandbox wrote.

### Trust boundaries

```
untrusted: repo files, model output, third-party VSIX, MCP tool results, web pages
    |
    v
reference monitor (trusted): Electron main, workbench TCB, volt-server agent loop,
    SandboxManager, the proxy, the file/secret/git brokers
    |
    v
OS enforcement: Seatbelt | bubblewrap+seccomp | MXC ProcessContainer | sandbox-user job+WFP+token
    |
    v
workload: one-shot command, agent CLI tree, extension host, MCP server, T2 worker process
```

The workload is not trusted to report its own confinement. `confirm` requires evidence from outside the workload (Seatbelt ready line, bubblewrap namespace inodes plus `/proc/self/status`). A Windows backend that cannot show the same kind of evidence is `unavailable`.

### Out of scope

- A malicious Volt build, or a person who can already debug the main process. The sandbox is for code Volt launches, not for a replaced `Volt.exe`.
- The user's own terminal and the user's own git outside Volt (`feat/volt-sandbox:docs/security/sandbox/02-design.md`, "Deliberately not sandboxed"). A hook that fires in iTerm is not something we can interpose. We can refuse to run that hook inside Volt.
- Exfiltration of whatever the policy already allowed the model to read, repeated back through the model's API. Credential denies are the control (`05-limitations.md` item 9).
- Physical access, kernel exploits as a class. We still shrink the syscall surface (seccomp) and we do not claim to stop a kernel bug.
- Other users on the machine. Containment is per process, not a multi-user OS boundary. macOS Seatbelt and a Windows AppContainer do not create a new user by themselves. sandbox-user does, which is why it exists as a separate backend.
- DRM, anti-cheat, and hiding Volt from the user.

### Security goals (testable)

- A policy the chosen backend cannot enforce is refused. No partial run unless every unenforced dimension is in `bestEffort` (`checkEnforcement` in `feat/volt-sandbox:src/vs/platform/voltSandbox/common/sandboxBackend.ts`).
- A child cannot drop the sandbox (Seatbelt inheritance, Linux `NoNewPrivs:1 Seccomp:2`, Windows AppContainer token or sandbox-user SID).
- Unix sockets, named pipes, and the VS Code IPC hook are unreachable unless the parent passed one fd.
- Loopback, RFC1918, link-local, CGNAT, ULA, and metadata are unreachable in `none`, `proxy`, and `public`.
- Git hooks, git config, shell rc, and `.vscode` tasks that appeared or changed during a sandboxed write do not run inside Volt without a prompt.
- Termination kills the tree, or the survivor is still confined and still under the rlimits. A survivor that can fork without limit and write the workspace is a failed goal even if Seatbelt stuck (section 4, E4).

---

## 2. Trust tiers and host model

| Tier | Who | Process | OS sandbox | Policy |
|---|---|---|---|---|
| T0 | Workbench TCB: chats, queue, subagents, run groups, questions, worktrees, the user's terminals, workspace context, image inspection (`src/vs/workbench/contrib/voltCustomize/common/voltFeatures.ts:96-143` and images at `:223`, this checkout). Also `SandboxManager`, brokers, signature check | Renderer, Electron main, volt-server agent loop | None. This is the monitor | Not a plugin |
| T1 | Signed Volt first-party features that we moved out of `contrib/` | Sandboxed host on volt-server, or a T2 worker. UI that must be in the window stays T0 until it is an iframe | Yes | Signed manifest, pre-granted, no prompt |
| T2 | Volt-native third-party plugins | Own process: SES realm, no Node, no `process`, UI in an iframe, Wasm via jco. The process is still an OS sandbox with no ambient mount | Yes, `restricted` plus broker fds | Manifest capabilities, install prompt |
| T3 | Existing VS Code extensions (`main` entry) | One Node extension host per trust label, `spawn` of `bootstrap-fork`, not `utilityProcess` | Yes | Default read workspace, write `${storage}`, network `none` |
| T3-web | Extensions with a `browser` entry | Workbench web worker (already no Node) | Worker isolation plus iframe for UI | Same capability checks on the main-thread proxy |
| MCP | Servers from user config or a plugin | Long-lived host, one per server | Yes | The server's declared capabilities, else `restricted` |
| Agent CLI | Claude, Codex, Cursor, Pi, OpenCode, … | One long-lived tree per chat, children are shell commands | Yes. Inner CLI sandbox turned off so we do not nest (`sandboxStrategy` / `nativeSandboxOffArgs`, `feat/volt-sandbox:src/vs/platform/voltSandbox/common/sandboxPolicy.ts`) | Chat settings, user layer trusted, repo layer untrusted |
| T4 | Opt-in strict | microVM per session | The VM is the sandbox; the broker is the only channel | Same policy, smaller host surface |

### Where each Volt process is

- **Desktop renderer.** T0 UI. A third-party plugin never runs here. `customize.md` §6.3 already rejects React-in-the-renderer for this reason.
- **Electron main.** T0. `ExtensionHostStarter` (`src/vs/platform/extensions/electron-main/extensionHostStarter.ts:18`) today starts a `WindowUtilityProcess`. `utilityProcess.fork` is at `src/vs/platform/utilityProcess/electron-main/utilityProcess.ts:249`. Seatbelt, bwrap, and `wxc-exec` cannot wrap a process Electron has already forked. Desktop T3 hosts move to `SandboxManager.start` from the main process. `utilityProcess` stays for Volt's own crash-reporter-style helpers that are T0.
- **volt-server.** First sandboxed host. `src/vs/server/node/extensionHostConnection.ts:277` (this checkout) is `cp.fork(bootstrap-fork)`. That spawn is ours. Replace it with `SandboxManager.start`. The fork's IPC becomes an inherited fd (`NODE_CHANNEL_FD` set by the launcher, not by the policy).
- **Web workbench (`/code/`) and the phone.** They are clients. The sandbox is on the machine whose files and network are at risk: the volt-server host. A phone does not run third-party Node.
- **T2 worker.** A process, never a thread inside the extension host. DeepSeek CVE-2026-82533's second hole was `run_code` on a worker thread outside the sandbox (brief §4). A thread shares the host's namespaces.

### What "allow all by default" is allowed to mean

T1 skips prompts. T1 does not skip `prepare` → `confirm`. A T1 manifest that needs the Docker socket or `net.host` carries that capability in the signed file, the install UI shows it once in the release notes, and the process is still confined to that wide policy. A bug in T1 then cannot `setsid` into an unsandboxed child.

Computer use and the user's integrated terminal stay T0. Sandboxing computer use into a container that cannot send input makes the feature false. Third-party plugins do not get that tier.

---

## 3. SandboxManager core

The branch already has the right shape for one-shot runs: `SandboxManager.prepare` / `run` (`feat/volt-sandbox:src/vs/platform/voltSandbox/node/sandboxManager.ts:149` and `:237`), `ISandboxBackend` (`node/sandboxBackends.ts`), fail closed (`SandboxUnavailableError`). v2 adds long-lived hosts, a Windows chooser, live grants that do not restart the host, and an enforcement generation. It does not add a second policy language.

### 3.1 API

```ts
export type SandboxBackendId =
	| 'seatbelt' | 'bubblewrap' | 'mxc' | 'sandbox-user' | 'unsupported';

export type CommandImageClass = 'posix' | 'pe' | 'msys' | 'cygwin' | 'wsl' | 'unknown';

export interface ISandboxManager {
	/** Cached after the first real trial. A failed trial stays failed for the session. */
	probe(): Promise<ISandboxBackendReport>;
	/** One-shot. Today's `run`. Never throws: refusal is `status: 'unavailable'`. */
	run(request: ISandboxCommandRequest, options?: ISandboxRunOptions): Promise<ISandboxRunResult>;
	/** Extension host, MCP server, agent CLI, T2 worker. Returns after `confirm`, not after exit. */
	start(request: ISandboxHostRequest): Promise<ISandboxHostHandle>;
	dispose(): Promise<void>;
}

export interface ISandboxBackendReport {
	readonly platform: NodeJS.Platform;
	readonly selected: SandboxBackendId;
	/** Present so the UI can explain Windows without starting a run. */
	readonly windows?: IWindowsBackendReport;
	readonly capabilities: ISandboxBackendCapabilities;
}

export interface IWindowsBackendReport {
	readonly build: string;                 // e.g. "10.0.26100.9278"
	readonly mxc: 'available' | 'unsupported' | 'broken';
	readonly sandboxUser: 'available' | 'not-installed' | 'broken';
	readonly notes: readonly string[];
}

export interface ISandboxIdentity {
	readonly pluginId: string;              // publisher.name, or "volt.agent:<chatId>"
	readonly tier: 't0' | 't1' | 't2' | 't3' | 'mcp' | 'agent';
	readonly enforcementGeneration: number;
	readonly signature: 'volt' | 'publisher' | 'unsigned' | 'dev-trusted';
}

export interface ISandboxIpcSpec {
	/** Parent passes this fd. The policy cannot name it. */
	readonly mode: 'pipe' | 'socket-fd';
	/** Assigned by the launcher after closefrom. Ignored if the policy tries to set it. */
	readonly channelEnv: 'NODE_CHANNEL_FD';
}

export interface ISandboxHostRequest {
	readonly kind: 'extension-host' | 'mcp' | 'agent-cli' | 'worker' | 'command-pump';
	readonly identity: ISandboxIdentity;
	readonly command: string;
	readonly args: readonly string[];
	readonly policy: IVoltSandboxPolicy;    // v2, already composed
	readonly context: ISandboxRunContext;
	readonly ipc?: ISandboxIpcSpec;
	readonly terminal?: boolean;
	readonly label?: string;
}

export interface ISandboxHostHandle {
	readonly tag: string;
	readonly backend: SandboxBackendId;
	readonly imageClass: CommandImageClass;
	readonly status: 'initialized' | 'partial';
	readonly unenforced: readonly SandboxDimension[];
	readonly pid: number;
	readonly confirmation: string;          // redacted evidence, kept for attestation
	readonly onDenial: Event<ISandboxRunDenial>;
	readonly onExit: Event<{ code: number | null; signal?: string }>;
	allow(grant: ISandboxLiveGrant): Promise<void>;
	revoke(grantId: string): Promise<void>;
	terminate(reason: string): Promise<void>;
	dispose(): Promise<void>;
}

export type ISandboxLiveGrant =
	| { readonly id: string; readonly kind: 'net.connect'; readonly host: string }
	| { readonly id: string; readonly kind: 'net.loopback'; readonly port: number }
	| { readonly id: string; readonly kind: 'fs.read' | 'fs.write'; readonly path: string; readonly once: boolean };
```

`run` is `start` plus wait-for-exit plus `terminate`, matching today's `sandboxManager.ts:237-347`. Callers that already use `prepare` keep working: `prepare` stays as the one-shot spawn spec (`IPreparedSandbox` at `sandboxManager.ts:50-69`).

`createBackend` (`sandboxManager.ts:367-373`) grows a Windows arm. It does not probe both backends and pick the survivor. See section 4.

### 3.2 Policy schema v2

v1 (`SANDBOX_POLICY_SCHEMA_VERSION = 1`, `sandboxSchema.ts:17`) stays parseable. A v1 document is read as generation 0 with these fills: `lifetime: 'command'`, `filesystem.brokerWrites: false`, `network.localNetwork: false`, `network.udp: 'deny'`, `host.inheritFds: []`. Mode `host` stays `host`. New manifests that Volt writes are v2.

```ts
export const SANDBOX_POLICY_SCHEMA_VERSION = 2 as const;
/** Current tightening generation. Ship as 1 with the Windows backend. */
export const SANDBOX_ENFORCEMENT_GENERATION = 1 as const;

export type SandboxNetworkMode = 'none' | 'proxy' | 'public' | 'host';

export interface IVoltSandboxPolicy {
	readonly schemaVersion: 2;
	/**
	 * The generation this policy was written for. Analogous to Android targetSdk:
	 * a higher generation in Volt may add denials that apply to everyone, and may
	 * add loosenings that apply only to policies that opted in.
	 * Missing or 0: every tightening, no loosening.
	 */
	readonly enforcementGeneration: number;
	readonly name?: string;
	readonly lifetime: 'command' | 'host';
	readonly filesystem: {
		readonly read: readonly string[];
		readonly write: readonly string[];
		/** true: no writable bind. Writes are broker fds. Untrusted T2/T3 default. */
		readonly brokerWrites: boolean;
		readonly deny: readonly string[];
		readonly protect: readonly string[];
		readonly unmask: readonly string[];
	};
	readonly network: {
		readonly mode: SandboxNetworkMode;
		readonly allow: readonly string[];
		readonly loopbackPorts: readonly number[];
		/** RFC1918, link-local, CGNAT, multicast. Legal only when mode is `host`. */
		readonly localNetwork: boolean;
		/** Legal only when mode is `host`. `proxy` and `public` are TCP to the broker. */
		readonly udp: 'deny' | 'allow';
		readonly listen: boolean;
	};
	readonly process: { readonly limits: ISandboxLimits };
	readonly env: {
		readonly inherit: readonly string[];
		readonly set: Readonly<Record<string, string>>;
	};
	readonly host: {
		readonly unixSockets: readonly string[];
		readonly systemServices: boolean;
		readonly inheritFds: readonly number[];
	};
	readonly bestEffort: readonly SandboxDimension[];
}
```

New dimensions, same `enforced | partial | unsupported` matrix as `sandboxBackend.ts`:

- `network.public` — outbound TCP to public IPs only. Loopback and local-network blocked in the OS, not only in the proxy.
- `network.udp` — must be `enforced` whenever `udp` is `deny`.
- `network.localNetwork` — must be `enforced` (meaning "denied") whenever `localNetwork` is false.
- `filesystem.brokerWrites` — the backend has no writable bind; the broker is the only write path.
- `process.breakaway` — Windows job does not allow `CREATE_BREAKAWAY_FROM_JOB`.

`public` is the loosening. Only `enforcementGeneration >= 1` may select it. Generation 0 keeps v1's `none | proxy | host`.

Parser rules that stay: unknown fields fail, NFC, no `..`, no control characters, list caps, write cannot be `/` or `${home}` (`sandboxSchema.ts`). Add:

- `schemaVersion` 1 or 2 only. Anything else fails.
- `enforcementGeneration` is an integer `0..current`. A future document (generation 5 on a Volt that knows 1) fails closed, the way a too-new Android manifest fails install rather than running loose.
- Untrusted `env.set` of `isSecretEnvName`, `isReservedEnvName`, or `isInjectionEnvName` is dropped. Today `narrow` checks secret names on inherit (`sandboxComposition.ts:215-216`) but `env.set` only rejects reserved and injection names (`sandboxComposition.ts:226-229`). `VSCODE_EXTHOST_IPC_HOOK` is secret (`sandboxProfiles.ts:75` matches `VSCODE_`) and is not reserved (`isReservedEnvName` is only proxy vars and `VOLT_SANDBOX`, `sandboxProfiles.ts:83-85`). An untrusted `.volt/sandbox.json` can set it. v2 closes that. Trusted `widen` (`sandboxComposition.ts:112-113`) may still set those names; the launcher overwrites the reserved channel variables afterward.
- Reserve, so no layer may set them: `NODE_CHANNEL_FD`, `NODE_OPTIONS`, `VSCODE_EXTHOST_IPC_HOOK`, `VSCODE_EXTHOST_WILL_SEND_SOCKET`, `VSCODE_WILL_SEND_MESSAGE_PORT`, `VSCODE_IPC_HOOK`, `VSCODE_IPC_HOOK_CLI`, `ELECTRON_RUN_AS_NODE`. The launcher writes the ones `bootstrap-fork` needs after composition, from this fixed list (`extensionHostConnection.ts:40-47` on this checkout):

```
VSCODE_ESM_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess
VSCODE_HANDLES_UNCAUGHT_ERRORS=true
VSCODE_NLS_CONFIG=<json from getNLSConfiguration>
VSCODE_EXTHOST_WILL_SEND_SOCKET=1
NODE_CHANNEL_FD=<fd the launcher just assigned>
```

`PATH` for a T3 host is the server `remote-cli` directory only (`extensionHostConnection.ts:51-60`), not the user's shell PATH. `HOME` and `TMPDIR` come from the resolved policy (`${tmp}`), not from the parent environment. `buildUserEnvironment` currently spreads `process.env` and the user shell env (`extensionHostConnection.ts:40-42`). The sandboxed host stops doing that.

### 3.3 Composition

Unchanged rule (`sandboxComposition.ts:81-85`): trusted widens, untrusted only narrows, and every dropped widen is recorded.

Layer order for a plugin host:

1. Builtin `restricted` (or `workspace` / `network` for an agent the user turned on).
2. User `~/.volt/sandbox.json`, trusted, still loaded — the branch defines this and does not load it (`05-limitations.md` item 23).
3. Workspace `.volt/sandbox.json`, untrusted.
4. Signed manifest capabilities, trusted only after the signature check. An unsigned manifest is not a layer; it is a request the user grants, and the grant is the trusted layer (`evaluateCapabilities` already does this, `sandboxCapabilities.ts`).
5. A live grant is not a new composed policy. It is a broker or proxy mutation (section 3.6). Re-composing would restart the OS profile, which Seatbelt and bwrap cannot do in place.

`bestEffort` only shrinks under an untrusted layer (`sandboxComposition.ts:253-260`). A plugin cannot mark `filesystem.protectNew` best-effort if the base did not.

### 3.4 Probe, enforce, launch, confirm, refuse, terminate

Same seven steps as `sandboxManager.ts:149-236` and `docs/security/sandbox/02-design.md`. v2 makes the Windows and long-lived cases fit the same steps.

**Probe.** Once per session, per backend, with a real trial. Seatbelt already refuses if a trial write outside the profile succeeds (`seatbeltBackend.ts:37-65`). Bubblewrap already requires a trial, a different pid/mnt/ipc/uts namespace, and `NoNewPrivs:1 Seccomp:2` (`bubblewrapBackend.ts:110-243`). Windows trials are in section 4. A probe that throws becomes `available: false` for the session. We do not probe the other Windows backend to paper over it.

**Enforce.** `dimensionsUsed` + `checkEnforcement`. New rule: an untrusted identity (T2, T3, unsigned MCP) with `filesystem.brokerWrites: false` and a non-empty `write` set **uses** `filesystem.protectNew`. On Linux that dimension is `partial` (`bubblewrapBackend.ts` probe, the `protectNew` note: binds only exist for paths present at launch). Partial is blocking unless `bestEffort` lists it. Builtin profiles list it (`sandboxProfiles.ts:127` and `:141`) because today's agent CLI accepts the gap. Plugin profiles for untrusted writers do not. They set `brokerWrites: true` instead, which is a different enforced dimension. Agents keep today's best-effort profile so merging the branch does not change chat behavior.

**Resolve.** `realpath`, private `~/.volt/sandbox/runs/<id>` at `0700` (`sandboxManager.ts` `runRootDir`), env from the policy only. Classify the executable (section 4) before launch. `closefrom` everything above the declared fds in the parent before spawn. Node's default spawn with an explicit `stdio` array already avoids extra inherited fds; the Windows path must mark only those handles inheritable.

**Launch.** The backend returns a command line. The manager spawns it `detached` with the declared stdio. No `cp.fork` of the workload: fork would copy the parent's env and fd table. The parent speaks IPC on the pipe it created.

**Confirm.** Timeout stays 15s (`CONFIRM_TIMEOUT_MS` in `seatbeltBackend.ts:19`). `ok: true` only with evidence:

| Backend | Evidence |
|---|---|
| Seatbelt | `volt-sandbox-ready <pid>` on fd 3 (`confirmFromStatusPipe`, `seatbeltBackend.ts:164`) |
| bubblewrap | JSON status with fresh `mnt`,`pid`,`ipc`,`uts` inodes, and a ready line containing `NoNewPrivs:1` and `Seccomp:2` (`bubblewrapBackend.ts` `confirmLaunch`) |
| MXC | Status fd says AppContainer/LowBox; trial connects (below) already passed in probe; this launch's status includes the container SID and the WFP filter id. A missing status is `ok: false` |
| sandbox-user | Token user SID equals the dedicated SID, process is in our job, breakaway flags off |

Confirm never treats "the process is still running" as success. Bubblewrap already waits for both the monitor's JSON and the in-sandbox ready line. Windows must too.

**Refuse.** `confirmation.ok === false` means `terminate` immediately and status `failed` (`sandboxManager.ts` does this for one-shot). Do not relaunch on another backend. The only unsandboxed path is the user's "Run outside sandbox" button, stored on that chat, never as a default.

**Terminate.**

- Linux: SIGKILL the bwrap monitor and the sandbox pid 1. `--die-with-parent` (`bwrap.ts:236`) and the pid namespace make `setsid` children die with pid 1 (`bubblewrapBackend.ts` `killSandbox`). This is the bar.
- macOS: process group, then parent-pointer walk, then `VOLT_SANDBOX_TAG` in the environment (`killRun`, `seatbeltBackend.ts:199`). The external watchdog (`WATCHDOG` at `:18`) kills the group when Volt's pipe closes. It does not see a double-fork that called `setsid` and cleared its env (`05-limitations.md` item 1). v2 adds a reaper (E4). Until that reaper's probe passes, `process.tree` stays `partial`.
- Windows MXC: close the job. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Also `TerminateProcess` the root. Breakaway denied, so `setsid`'s equivalent stays in the job.
- Windows sandbox-user: same job object, plus kill by SID if the job probe ever disagrees (log it; do not pretend the SID walk is the primary).

`dispose` removes the run directory only when the name starts with the run prefix (`removeRunDir` in `sandboxManager.ts`). A host that is still running keeps its directory.

### 3.5 Long-lived hosts versus one-shot commands

One container (Seatbelt profile, bwrap namespace, MXC container, or job) per host, not per shell line.

| Kind | Lifetime | Why |
|---|---|---|
| `run()` command | Process exit, then terminate | Tests, `git` helper, a formatter |
| Agent CLI | The chat's process | Shells are children. A new container per command is what makes MXC stall (srt PR [#766](https://github.com/anthropics/sandbox-runtime/pull/766) lists I/O stalls with several sandboxes) |
| `command-pump` | The chat, when the CLI is not itself the sandbox root | Optional. A tiny trusted-inside-the-sandbox supervisor reads commands from the IPC fd and `posix_spawn`s them. Same profile, one confirm |
| Extension host | Window or server lifetime | `bootstrap-fork` under the backend. One host per trust label in v1 (all T3 together is acceptable only while every one of them has the same restricted policy). Per-extension hosts when a plugin's grant is wider than the shared policy |
| MCP server | Session | Same as a host. Stdio MCP uses the inherited pipes as its protocol, not a socket |
| T2 worker | While the plugin is enabled | No Node binary in the container if we can avoid it: a small `volt-worker` runtime |

PTY: node-pty cannot pass the confirm fd (`05-limitations.md` item 24). A sandboxed terminal writes the ready line to a file inside the run directory that the host opens before spawn, mode `0600`, and the workload's first instruction truncates it. Confirm reads that file. Until that exists, host terminal tools stay refused for sandboxed chats, as they are now.

Agent CLI nesting: `sandboxStrategy` returns `wrap` except Codex `workspace-write` on non-Windows, which is `native` (`sandboxPolicy.ts`). On Windows, once MXC is ours, Codex's own MXC inside ours is nesting and will fail. Windows `wrap` always passes the CLI's "sandbox off" flag. We do not delegate to Codex's sandbox and call it enforced: we cannot `confirm` their container.

### 3.6 Live grants

`sandboxLaunchKey` (`sandboxPolicy.ts:526-533`) deliberately omits `allowedDomains`, and the comment says the proxy takes those live. `allowSandboxDomains` (`feat/volt-sandbox:src/vs/platform/voltStdio/node/voltStdioService.ts:219`) writes through to `allowDomains` on the launch. The only in-repo caller of that method is the passthrough in `projectEnvStdio.ts:51`. Nothing in the window calls it. So a domain the user allows mid-chat updates storage, the process is reused because the key did not change, and the running proxy never hears about it.

Fix the caller. Do not put domains back into the launch key. A key change restarts the agent, which throws away the conversation's process to edit an allowlist the proxy can already edit (`sandboxProxy.ts:79`).

Rules:

- `net.connect` updates the proxy allowlist only. The OS profile allows the proxy port and nothing else, so no Seatbelt/WFP rebuild is required. In-flight tunnels stay up; the next connect sees the new list. `revoke` deletes the entry.
- `net.loopback` is not live in v1. A new loopback port changes the OS profile (Seatbelt cannot be patched; a new WFP filter can, but a port grant is the DeepSeek class of bug). It refuses with "restart the chat to allow this local port", and the restart is a new `start` with the port in the composed policy. Recorded as a grant, not a silent widen.
- `fs.read` / `fs.write` do not edit the profile. The broker opens the path (section 10) and sends the fd or handle. `once: true` closes it after one open. A raw bind is not added under a live process.
- A grant the user did not confirm is not a grant. The host handle's `allow` is called by the trusted monitor after the prompt, never by the workload.

---

## 4. Backends per OS

### 4.1 Windows decision

**Primary: MXC ProcessContainer via `wxc-exec`. Secondary, explicit: sandbox-user. Else refuse.**

MXC facts used here (not re-investigated): MIT; 1.0.0 on 2026-10-07, 1.0.1 on 2026-10-17; Windows ProcessContainer is AppContainer/BaseContainer plus WFP; Windows 11 only, process isolation at 24H2 `26100.9278+`, 25H2 `26200.9278+`, 26H2 `26300.9550+`, 26H1 `28000.2804+`; no hostname rules; Node SDK needs Node 24; VS Code, Copilot, and Codex use it; Codex prefers it ([MXC](https://github.com/microsoft/mxc), [Windows developer blog, 2026-10-07](https://blogs.windows.com/windowsdeveloper/2026/10/07/microsoft-execution-containers-policy-driven-containment-for-ai-agents/), [learn.microsoft.com MXC](https://learn.microsoft.com/en-us/windows/apps/develop/mxc/), VS Code PR [317669](https://github.com/microsoft/vscode/pull/317669)). srt's MXC notes (PR [#766](https://github.com/anthropics/sandbox-runtime/pull/766), 2026-11-06): MSYS2/Git Bash crash `0xC0000005`; UI not locked; `%TEMP%` is per command; I/O stalls with several sandboxes; proxy routing is guaranteed only by observed 25H2 behavior, not by documentation. Codex's older Windows modes are an elevated sandbox user and an unelevated restricted token ([Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox.md)).

#### Why MXC is primary

- It is a kernel container (AppContainer token + WFP), which is the same class of boundary as Seatbelt and a network namespace. A restricted token alone is not: it is still the user's logon, and COM/RPC brokers have a long history of hopping out of restricted tokens.
- Codex and VS Code already ship the same Windows primitive. A Volt-only design would be the one that drifts.
- Hostname policy does not belong in WFP. It belongs in our proxy, with the OS limited to the proxy's TCP port. MXC's lack of hostname rules is then irrelevant. The 25H2 "it happens to honor the proxy" behavior is also irrelevant, because we do not trust the process to honor `HTTP_PROXY`. WFP drops every other outbound connect. A Git-Bash-style program that ignores proxy variables simply has no network, which is the Linux behavior already (`ADR-6`).

#### Why sandbox-user exists at all

Two cases MXC cannot cover, both known before launch:

1. **OS too old.** Windows 10, and Windows 11 builds under the process-isolation floor. Electron 37.6.0 still runs there (`package.json` `"electron": "37.6.0"`). MXC's probe is `unsupported`, not `broken`.
2. **MSYS2 / Git Bash / Cygwin.** `0xC0000005` inside ProcessContainer. Launching them under MXC and catching the crash is not a backend. The crash is also not something we "fix" by disabling the sandbox for that command.

sandbox-user is the srt-win design, under our confirm rules, not an srt dependency (`ADR-14`: srt is a reference):

- One elevated install (`volt-sandbox-setup`) creates a local user `volt-sandbox` with a random password held in an ACL'd secret the SYSTEM service can read, a WFP filter set keyed on that SID, and a login that is not interactive.
- Each run: `CreateProcessWithLogonW` as that user, or an equivalent primary token, inside a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`, and neither `JOB_OBJECT_LIMIT_BREAKAWAY_OK` nor `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`.
- The token is deny-only Administrators, integrity Low, no `SeDebugPrivilege`, no `SeImpersonatePrivilege`.
- NTFS: the workspace grant is an ACL on the real path for that SID, plus the same credential denies as everyone else. This is weaker than a bind mount (TOCTOU, hard links). `filesystem.protectNew` stays `partial`. Untrusted plugin profiles still use the broker rather than a raw ACL grant.
- WFP: permit TCP to `127.0.0.1` and `::1` on the proxy port only; permit the listed loopback ports; deny every other outbound, including UDP, including the rest of loopback. The probe connects to prove it.
- UI is not a goal. The restricted token blocks a lot of `SendInput` and Shell execution by accident. We still deny the broker binaries in section 4.4. srt's note that MXC does not lock the UI applies here too: neither backend is a kiosk.

#### Why sandbox-user is not the fallback

| Situation | Choice | What we refuse to do |
|---|---|---|
| Win11 build ≥ floor, `wxc-exec` trial passed, image is PE | `mxc` | Start sandbox-user "just in case" |
| Same, but the trial cannot prove loopback is blocked | `mxc` capabilities mark `network.proxy` `unsupported`. A policy that needs it is refused | Flip to sandbox-user, or run with `HTTP_PROXY` and hope |
| Same, image is `msys`, `cygwin` | `sandbox-user` if that probe is `available`, else refuse with the `0xC0000005` reason and the setup command | Launch under MXC, catch the access violation, retry unsandboxed |
| Same, image is `wsl` | Refuse | Let `wsl.exe` start a VM as the user |
| MXC confirm fails after spawn (no status, wrong SID, write probe inside the launch fails) | Kill, `failed` | Retry on sandbox-user |
| `wxc-exec` missing on a build that should support it | `mxc: unsupported` until the file is installed. UI offers "Install sandbox support". If the user already installed sandbox-user, it is used only when they set `volt.sandbox.windowsBackend` to `sandbox-user`, or when the image is msys | Silently pick sandbox-user because the better one is absent |
| Windows 10, or Win11 under the floor | MXC `unsupported`. sandbox-user if installed and its trial passed, else refuse | Show a sandbox toggle that runs the agent anyway (G-16, F-01) |
| User sets `volt.sandbox.windowsBackend` to `mxc` or `sandbox-user` | That backend, or refuse | The other one |
| Default `auto` | The table above | A third heuristic |

`mxc: broken` means the binary ran and the trial did not match the policy (a write escaped, or a blocked port connected). Session stays `broken`. We do not fall back. A broken trial is either a bug in our filter or a machine that is not enforcing. Both are refuse.

#### Chooser

```ts
export function chooseWindowsBackend(
	report: IWindowsBackendReport,
	image: CommandImageClass,
	preference: 'auto' | 'mxc' | 'sandbox-user',
): { backend: 'mxc' | 'sandbox-user'; reason: string } | { backend: 'refuse'; reason: string } {
	if (image === 'wsl') {
		return { backend: 'refuse', reason: 'wsl.exe starts a VM outside the sandbox' };
	}
	if (preference === 'mxc') {
		return report.mxc === 'available' && image === 'pe'
			? { backend: 'mxc', reason: 'user preference' }
			: { backend: 'refuse', reason: 'MXC unavailable or this program crashes inside ProcessContainer' };
	}
	if (preference === 'sandbox-user') {
		return report.sandboxUser === 'available'
			? { backend: 'sandbox-user', reason: 'user preference' }
			: { backend: 'refuse', reason: 'sandbox user is not installed or its trial failed' };
	}
	// auto
	if (image === 'msys' || image === 'cygwin') {
		return report.sandboxUser === 'available'
			? { backend: 'sandbox-user', reason: 'MSYS2/Cygwin crashes inside MXC (0xC0000005)' }
			: { backend: 'refuse', reason: 'Git Bash/MSYS2 crashes inside Windows ProcessContainer. Install the Volt sandbox user, or run this command outside the sandbox.' };
	}
	if (report.mxc === 'available' && image === 'pe') {
		return { backend: 'mxc', reason: 'process-container' };
	}
	if (report.mxc === 'broken') {
		return { backend: 'refuse', reason: 'MXC trial failed; not falling back' };
	}
	if (report.mxc === 'unsupported' && report.sandboxUser === 'available') {
		return { backend: 'sandbox-user', reason: 'this Windows build cannot run ProcessContainer' };
	}
	return { backend: 'refuse', reason: 'no Windows sandbox is installed for this build' };
}
```

Image class, before any spawn:

- `wsl`: the resolved path is `System32\wsl.exe` or `wsl.exe` on `Path`.
- `msys` / `cygwin`: the PE import table (or delay-load) names `msys-2.0.dll` or `cygwin1.dll`, or the resolved path sits under `\Git\usr\bin`, `\Git\bin`, or `\msys64\`. Git's `bin\bash.exe` is a shim; follow one level of "this exe's directory contains `..\usr\bin\msys-2.0.dll`".
- `pe`: a PE that is neither of the above.
- `unknown`: refuse on Windows. Do not assume PE.

`%TEMP%` per command (the srt note): the manager's run directory is `TEMP`/`TMP` inside the container. We do not use MXC's fresh temp as storage. **Guess, to pin in the implementing PR:** `wxc-exec` accepts a working directory and an env block; if it forces its own temp, the backend still sets `TEMP` to our directory in the policy env and puts nothing important in MXC's. The argv of `wxc-exec` is not in this repo. The first Windows PR freezes the argv from the MXC 1.0.1 docs and a fixture, and refuses to guess flags at runtime.

I/O stalls: one container per host (section 3.5). A process-wide cap of 8 MXC containers; the 9th `start` waits or refuses with "too many sandboxes". **The number 8 is a guess** until we measure on 24H2.

Node 24: do not import `@microsoft/mxc-sdk` into Electron. Ship or download `wxc-exec.exe`, verify Authenticode against a pinned Microsoft publisher and a pinned file hash for the version we tested (start at 1.0.1). **Open:** confirm the MIT drop actually includes a redistributable `wxc-exec.exe`. If the binary is not redistributable, stop that PR and ask; do not shell out to a copy the user happened to have on `Path` without the pin.

#### Failure cases the tests must hit

1. Build `26100.9278`, trial passed, `cmd.exe /c echo ok` → MXC, confirm shows the container SID, a write to `%USERPROFILE%\.ssh` fails, a connect to `1.1.1.1:443` fails in `proxy` mode with an empty allow list.
2. Same build, policy `proxy` allow `example.com`, connect to `127.0.0.1:9` fails, connect to the proxy port succeeds, connect to `169.254.169.254:80` fails. If any of those three is wrong, `network.proxy` is `unsupported` and this run is refused.
3. `C:\Program Files\Git\bin\bash.exe -lc echo ok` with sandbox-user installed → sandbox-user, and the MXC backend's `launch` is not called (assert with a fake).
4. Same bash with sandbox-user not installed → `unavailable`, message names `0xC0000005`, process table has no `bash.exe`.
5. MXC `launch` throws after the process exists → no second `CreateProcess`, status `failed`.
6. Windows 10 runner → MXC probe `unsupported` without spawning `wxc-exec` (the binary may not even load). With sandbox-user, a run passes its SID check. Without it, `unavailable`, and the UI test checks the level is not "on".
7. `wsl.exe -e cat /etc/passwd` → `unavailable` on both backends.
8. Two chats, two containers, then a third one-shot uses the chat's existing container rather than a third MXC instance (the command pump, or the CLI's own child). This is the stall regression test.

### 4.2 macOS

Backend stays `SeatbeltBackend` through `/usr/bin/sandbox-exec` (`seatbeltBackend.ts`). Floor is Volt's existing Electron 37.6.0 floor, not a second version check. The probe is a trial (`seatbeltBackend.ts:48-60`). `sandbox-exec` has been documented as deprecated for years and still ships (`05-limitations.md` item 6). If it disappears, the same SBPL moves into a signed helper that calls `sandbox_init`. The policy does not change.

Deny-default for workloads. `systemServices: true` flips the base to `(allow default)` (`seatbelt.ts:114`) and is how agent CLIs reach the OS. That profile still denies the escape mach services (`seatbelt.ts:222` and `ESCAPE_SERVICES` around `:36-46`: appleevents, windowserver, pasteboard, cfprefsd) and denies unix-socket connect except granted paths (`seatbelt.ts:211-214`). mDNSResponder is allowed only in `host` mode (`MDNS_SOCKET` at `seatbelt.ts:32-33`). v2 adds to that deny list even under `(allow default)`: `com.apple.coreservices.launchservicesd` (so `open` cannot start Terminal), `com.apple.distributed_notifications`, and the Mach lookup for `com.apple.tccd` when we can name it without breaking `security` for the agent CLI. If an agent CLI trial shows `security` needs `tccd`, the agent profile keeps it and the plugin profile does not. Plugin profiles never set `systemServices`.

`process.tree` and `limits.memory` / `limits.processes` stay partial/unsupported (`seatbeltBackend.ts:40-46`). Do not mark them enforced.

Minimum: the trial, not a marketing version. CI on the macOS version the branch already measured (the findings doc says macOS 26.6) and on the oldest macOS Electron 37.6.0 still supports.

### 4.3 Linux

Backend stays bubblewrap + seccomp. Raise the packaged floor from `MIN_VERSION = [0, 4, 0]` (`bubblewrapBackend.ts:59`) to **0.8.0**, so `--disable-userns` is always on (`bubblewrapBackend.ts:164`). Older bwrap relies on seccomp to refuse new user namespaces. That is a second line, not the floor. Distros that only have 0.4 get `available: false` and a one-line install hint, which the probe already knows how to report.

Keep: `--unshare-user --unshare-pid --unshare-ipc --unshare-uts`, `--unshare-net` unless the holder namespace is the network, `--die-with-parent`, `--dev /dev --proc /proc` (`bwrap.ts:232-263`). Private `/proc` plus a pid namespace is what makes host `/proc/<volt-pid>` invisible. A generated argv missing `--proc` or `--unshare-pid` is a bug in the backend and `launch` throws.

Seccomp stays generated in TypeScript (`ADR-9`): `ptrace`, `process_vm_readv`, `process_vm_writev`, new namespaces (`seccomp.ts`). `socket(AF_UNIX)` stays refused when no socket is granted (`seccomp.ts:188`). When a socket is granted, the branch refuses the combination with `readAll` or with the host network (`bwrap.ts:427`) because abstract-namespace sockets and every socket file would come along. v2 goes further: a granted socket is bridged by the holder the same way a TCP port is, and `AF_UNIX` stays blocked in the sandbox. One code path, no exception in the filter.

`filesystem.protectNew` stays `partial` for the agent profile. It is blocking for untrusted raw writes (section 3.4).

Network bridge (socat + nsenter) stays. No slirp4netns (`ADR-6`).

Memory: RLIMIT_AS remains `partial`. cgroup v2 via `systemd-run --user` is a later dimension, not a claim now (`05-limitations.md` item 4).

CI: Ubuntu 24.04, bwrap ≥ 0.8, kernel ≥ 5.14 (per-userns `RLIMIT_NPROC`) and one older kernel job where `limits.processes` is `partial` and a policy that requires it without `bestEffort` is refused.

### 4.4 Escape catalog

Each row is a concrete path and the mitigation that is in scope. "The OS sandbox" is not a mitigation.

**E1. Loopback service, DeepSeek CVE-2026-82533.** The sandbox can open TCP to `127.0.0.1:3080`. The service trusts the `Host` header and has no auth. The agent promotes itself.

Mitigation: default `loopbackPorts` is empty. Seatbelt allows only the proxy port and the listed ports (`seatbelt.ts:197-199`). Linux has no route to host loopback except the socat bridge for those ports. Windows WFP permits those exact ports, not "the loopback interface". The host MCP and the extension-host pipe are not in that list. The inherited IPC fd is the channel. Any HTTP listener Volt still has requires a per-session bearer the sandbox was given on purpose, and ignores `Host` / `Origin` / `Sec-Fetch-*` for authorization. Tool classing stays (`hostToolSandbox.ts:235`); an unlisted tool is refused. Both lines are required: CVE-2026-82533 needed the open port and the trusted header.

**E2. VS Code IPC unix socket (F-03).** `connect()` to the extension-host pipe, then the `launch` channel starts an unsandboxed host. Env `VSCODE_*` points at the path.

Mitigation: seccomp blocks `AF_UNIX` (E10). Seatbelt denies outbound unix sockets except granted literals (`seatbelt.ts:211`). The IPC path is never a grant. Plugin policy cannot `env.set` it (section 3.2). The parent passes one fd. Desktop stops using `utilityProcess` for T3, so there is no second unsandboxed host to ask for.

**E3. Electron `utilityProcess`.** A plugin that gets main to `utilityProcess.fork` (`utilityProcess.ts:249`) runs outside every wrapper.

Mitigation: the extension host API does not expose `utilityProcess` (it is main-process only). T3 is spawned by `SandboxManager`. The main-process service that used to fork hosts (`ExtensionHostStarter`) calls `start` and does not import `WindowUtilityProcess` for plugin hosts. A test greps the T3 spawn path for `utilityProcess.fork` and fails. First-party T0 helpers may still use it; they are not reachable from extension code.

**E4. macOS double-fork + `setsid` + cleared environment.** `killRun` (`seatbeltBackend.ts:199`) and the watchdog (`:18`, kills `-$pgid` only) lose the process. Seatbelt and rlimits are inherited, so it is not an unsandboxed shell. It is a leftover that can keep writing the workspace up to `fileSizeMB` per process, and `limits.processes` is `unsupported` on macOS, so a fork bomb of survivors is bounded only by the user's process rlimit (`05-limitations.md` items 1-2). That is a disk fill, not a credential read, and it is still a failed terminate.

Mitigation, in order: (1) keep the partial status, do not claim `process.tree` enforced; (2) the in-sandbox prologue sets rlimits before exec so survivors inherit `RLIMIT_FSIZE` and `RLIMIT_CPU` (already the prologue); (3) v2 reaper: a parent-side poller, 200ms, walks `ps` by ppid **and** records every child pid the first time it appears, so a later `setsid` is already in the set. This loses the race of fork+setsid+clear inside one tick. (4) If Volt can ship the Endpoint Security client entitlement `com.apple.developer.endpoint-security.client`, replace the poller with `ES_EVENT_TYPE_NOTIFY_FORK` and kill on the sandbox's root pid. **Guess:** a notarized VS Code fork will not get that entitlement easily. Do not block v1 on it. The adversarial test from the branch (survivor cannot write outside) stays, and a new test asserts the survivor is dead within 2s when it does **not** clear its env, and asserts a survivor that does clear its env still fails a write to `~/.ssh`.

**E5. DNS as an exfiltration channel.** `getaddrinfo` via mDNSResponder under `(allow default)`; UDP/53 to `8.8.8.8`; a wildcard allow `*.attacker.com` making the proxy resolve arbitrary names (`05-limitations.md` item 10).

Mitigation: `proxy` and `public` deny the mDNS socket and port 53/UDP/TCP in the OS profile. The proxy resolves (`sandboxProxy.ts:89` `destination`, lookup at `:208`). Wildcards are a capability of risk `high` and are not in the default grant. Queries are logged redacted (name length, not a user secret) and rate-limited per host. `host` mode may resolve, and the UI calls it critical.

**E6. DNS rebinding and IP-literal bypass.** Allowlist checks the name, then a second lookup returns `169.254.169.254`. Or the request is to the name while the resolved address is private. Or IPv4-mapped / NAT64 / 6to4 forms.

Mitigation: already the proxy's model: one lookup, connect to the checked address, `isPublicAddress` covers the mapped forms (`sandboxProxy.ts:259` and the comment at `:33`). v2 adds the same check in the OS for `public` mode (block the ranges, do not depend on the proxy seeing the name). The proxy binds `127.0.0.1` only (`sandboxProxy.ts:65`). Add a per-run `Proxy-Authorization` secret so another local sandbox cannot use this proxy even if a WFP bug opens loopback. 16 random bytes, set by the manager in `HTTP_PROXY`, not by policy.

**E7. DoH, domain fronting, no TLS inspection.** CONNECT to an allowed CDN, arbitrary traffic inside TLS. The proxy cannot see the inner host (`ADR-6`).

Mitigation: accept this inside `proxy` for names the user granted. Do not MITM. Do not grant `net.connect:*` to T2/T3 by default. SNI is not an extra control: it is inside the tunnel. A strict T4 VM does not change this unless it also MITMs, which we will not do. Document it on the grant sheet: "Can talk to `cdn.example` in any protocol that host supports."

**E8. `/proc` of the host.** Linux: `/proc/<volt-pid>/fd`, `/proc/<pid>/mem`, `/proc/net/unix` finds the IPC socket. DeepSeek DSec also saw a recursive walk of `/proc` crash the kernel (arXiv [2609.22978](https://arxiv.org/abs/2609.22978)).

Mitigation: `--unshare-pid` and `--proc /proc` (`bwrap.ts:232`, `:263`) so the sandbox's proc is its own. Seccomp denies `ptrace` and `process_vm_*` (`seccomp.ts`). Launch throws if those args are absent. macOS has no procfs; deny `task_for_pid` / mach task ports in the plugin profile (Seatbelt `process-info*` and the task-port operations). The agent `(allow default)` profile must gain an explicit deny for `mach-priv-task-port` if a trial shows it is currently allowed. **That trial is required in the macOS adversarial suite; I am not claiming the current SBPL already names `mach-priv-task-port`.** Windows: AppContainer blocks `PROCESS_VM_READ` of a higher-integrity process; the probe tries `OpenProcess` on the parent and must fail.

**E9. Symlink and TOCTOU on a path grant.** Policy allows `${workspace}/src`. The attacker swaps `src` for a symlink to `~/.ssh` between `realpath` and `open`. The host file service checks, then writes (`05-limitations.md` item 13). Hard link planted in the workspace before launch points at a secret the path rules cannot see (item 11).

Mitigation: the broker holds a directory fd for the workspace root, opened with `O_DIRECTORY`. Writes use:

- Linux: `openat2(dirfd, rel, O_NOFOLLOW | O_CLOEXEC, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`.
- macOS: `openat` + `O_NOFOLLOW | O_CLOEXEC`, then `fcntl(F_GETPATH)` / `getattrlist` to confirm the vnode is still under the root. No `O_SYMLINK`.
- Windows: `NtCreateFile` with `OBJ_DONT_REPARSE` and `FILE_OPEN_REPARSE_POINT` only to reject `IO_REPARSE_TAG_SYMLINK` and mount points. Refuse junctions.

Grants are directory fds, not strings re-resolved later. A hard link whose target is outside the root: on Linux `RESOLVE_BENEATH` does not stop a hard link that is already inside. Documented residual, same as the branch. The consumer-side guard (E14) does not fix reads. Credential paths stay on the deny list so a hard link is the remaining hole, and we scan the workspace for hard links whose `st_dev`/`st_ino` matches a denied file at launch when the tree is small enough. **Bound this scan: 20_000 files, same order as `PATTERN_WALK_LIMITS` (`bubblewrapBackend.ts:62`). Past the cap, the run is `partial` on `filesystem.deny` for that host and untrusted profiles refuse.**

**E10. Abstract-namespace unix sockets, Docker, ssh-agent.** Granting one socket turns off the `AF_UNIX` seccomp bit. Abstract sockets (`@/tmp/.X11-unix`) are not files. `docker.sock` is a root shell. The capability text already says so (`sandboxCapabilities.ts`, `socket` kind).

Mitigation: bridge the one granted socket through the holder; keep `AF_UNIX` blocked (section 4.3). `docker.sock`, `containerd`, `podman` stay risk `critical` and are a typed grant with its own confirm dialog, not a normal allow. Default plugin policy has no socket. Windows named pipe `\\.\pipe\vscode-*` is the same bug: the AppContainer gets no capability SID for that pipe. Probe: `CreateFile` on Volt's pipe from inside the container fails.

**E11. `systemServices` / `(allow default)` reopens the world.** Agent profile needs it (`seatbelt.ts:114`). A plugin that copies the agent profile gets Launch Services, cfprefsd (F-20: `defaults write` lands even when the preferences folder is denied), pasteboard, and DNS.

Mitigation: `systemServices: true` is ignored for `tier !== 'agent' && tier !== 't1'` unless the signed manifest lists `host.systemServices` and the user accepted a critical grant. Even then the deny list in section 4.2 is unconditional. cfprefsd stays denied for every profile, as the branch already does (`seatbelt.ts:42`).

**E12. Env injection of the IPC channel.** Untrusted `env.set` can assign `VSCODE_EXTHOST_IPC_HOOK` and `NODE_CHANNEL_FD` (`sandboxComposition.ts:226-229` consults `isReservedEnvName` and `isInjectionEnvName`, not `isSecretEnvName`). If the launcher merges policy env after it assigns the channel fd, the workload's Node connects the wrong fd, or a later child reads the hook path.

Mitigation: section 3.2 reserve list. Launcher assigns channel env last and deletes any policy value. Test: a workspace layer that sets `NODE_CHANNEL_FD=0` is in `ignored`, and the running process's fd matches the pipe the parent holds.

**E13. Windows broker binaries.** From inside an AppContainer, `ShellExecute`, `cmd /c start`, `powershell`, `rundll32`, `mshta`, `wsl.exe`, `OpenSSH\ssh.exe` can land on a broker that starts a normal-integrity process.

Mitigation: WFP is not enough (this is process creation, not a packet). The container's process rules deny those images by canonical path. Probe runs `wsl.exe` and a `ShellExecute` of `notepad.exe` and both must fail or the child must still carry the container SID. If MXC cannot express a deny-image list, the sandbox-user token's ACL on those exes (deny execute for the SID) is part of setup, and the MXC probe includes the `wsl` test. A failed `wsl` test marks the backend `broken`.

**E14. Time-shifted hook.** `filesystem.protectNew` cannot mask a `.git/hooks` or `.vscode/tasks.json` created after launch (`bubblewrapBackend.ts` probe note; `05-limitations.md` item 3). The user's next git command, inside Volt, runs the hook unsandboxed. Committing the hook and checking the branch out later is the same bug (item 14).

Mitigation, at the consumer, which we control: before Volt runs git, a task, or a detected hook manager, hash the protected patterns (`PROTECTED_GIT_PATTERNS`, `PROTECTED_ROOT_NAMES`) and compare to the snapshot taken when the host started. A new or changed file is not executed; the UI shows the diff and waits. `core.hooksPath` for any git Volt spawns on behalf of a sandboxed chat is an empty directory we created. This does not stop iTerm. Say that in the UI once, not on every commit. Untrusted plugins additionally use `brokerWrites` so they never had the raw bind.

**E15. Workspace writable and on the DLL search path (Windows) or `LD_LIBRARY_PATH` (Linux).** A planted `version.dll` next to a binary, or a workspace `node` that is the first `PATH` entry.

Mitigation: env is built from nothing; `isInjectionEnvName` blocks `LD_*` and `DYLD_*`. Windows launcher calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` in the target via the prologue, sets `PATH` to the read-only system directory inside the container, and does not put the workspace on `PATH`. CWD is the workspace but is not a DLL directory once `SetDefaultDllDirectories` ran. Probe: a `evil.dll` beside `cmd.exe`'s copy must not load; we run a small PE that `LoadLibrary`s a bare name and assert it does not open the workspace copy.

**E16. Cross-sandbox proxy reuse, and "Allow host" stuck on the old process.** Sandbox A's proxy allowlist is usable by B if B can open A's loopback port. Separately, the live allowlist never updates (section 3.6).

Mitigation: one proxy per host, bound to `127.0.0.1:0`, OS rule is that port only, `Proxy-Authorization` per host (E6). `allow()` is called from the grant UI on the handle. A regression test starts a host, allows `example.com` without restarting, and asserts the next CONNECT from inside succeeds and a CONNECT to `evil.example` fails.

**E17. User-namespace escape and setuid `bwrap`.** A sandbox that can `clone(CLONE_NEWUSER)` escapes the seccomp caller. Setuid `bwrap` is a historical attack surface.

Mitigation: `--disable-userns` on bwrap ≥ 0.8, seccomp denies `CLONE_NEWUSER` anyway, prefer the unprivileged binary. If `stat` shows the setuid bit and unprivileged userns works, the probe warns and uses the unprivileged one. If only setuid exists, use it, record `setuid` in `details`, pin ≥ 0.8.

**E18. `net.host` means the whole machine, including Volt's own ports.** v1 `host` is unfiltered (`ADR-6`). A grant named "network" that maps to `host` is the DeepSeek bug with extra steps.

Mitigation: v2 `public` is the wide grant (TCP to public IPs, OS-enforced ranges blocked). `host` remains, risk `critical`, T1 or an explicit extra confirm, and even `host` on Windows/macOS denies the destination ports Volt is listening on (the extension-host port, the proxy port of every other sandbox, the agent-server port). Linux `host` shares the host netns (`bwrap` only skips `--unshare-net` in that mode) so those denies have to be socket-level; if we cannot express them, `network.host` is `unsupported` on Linux for untrusted identities and we offer `public` instead. **Guess to verify in the bwrap trial:** a seccomp filter cannot match the destination port of `connect` without a notify supervisor. If the trial confirms that, Linux untrusted `host` is refused and `public` is the ceiling. Agent CLIs keep `host` only when the user turned network fully on, and the UI says so, matching today's critical label.

### 4.5 Minimum versions and CI

| OS | Runs | Refuses |
|---|---|---|
| macOS, Electron 37.6.0 floor | Seatbelt trial | Missing `sandbox-exec`, trial write succeeded |
| Linux, bwrap ≥ 0.8, kernel ≥ 5.4 (5.14 for per-sandbox nproc) | bubblewrap | No bwrap, userns blocked, bridge tools missing when the policy needs `network.proxy` |
| Windows 11 process-isolation builds listed in section 4.1 | MXC for PE; sandbox-user for msys if installed | Trial mismatch, `wsl`, confirm failure |
| Windows 10 and Win11 below the floor | sandbox-user if installed | MXC, and anything if sandbox-user is absent |
| ARM64 and x64 | Both, on every OS we ship | A backend that only probed x64 |

CI jobs: `sandboxSecurity.test.ts` on the branch, plus the Windows rows in section 4.1, on a hosted Win11 image whose build we print in the log (skip, do not pretend, if the runner is below the floor). One Win10 job that expects `unavailable`. One Git Bash job. macOS and Linux keep the existing adversarial tests.

---

## 5. Network broker

The proxy stays the hostname authority (`sandboxProxy.ts`). Modes:

| Mode | OS allows | Proxy |
|---|---|---|
| `none` | Nothing. Linux: empty netns. macOS: `(deny network*)` including DNS mach. Windows: WFP deny all outbound | Not started |
| `proxy` | TCP to `127.0.0.1`/`::1` on the proxy port, plus listed loopback ports. No UDP. No port 53 | Allowlist, DNS pin, public addresses only, ports 80/443 unless the entry names a port (`sandboxProxy.ts:223`) |
| `public` | TCP to public IPs. OS drops loopback (except the proxy, if we still need it — we do not, the OS is the filter), RFC1918, link-local `169.254.0.0/16` and `fe80::/10`, CGNAT `100.64.0.0/10`, ULA `fc00::/7`, multicast | Not on the data path. DNS is the proxy's resolver only if we still want names; otherwise the workload resolves and the OS drops private answers. **Prefer the proxy even in `public`**, so name policy and IP policy stay in one place. The OS drop is the second line |
| `host` | Unfiltered except Volt's own ports where we can say that (E18) | None |

UDP and QUIC: denied in `none`, `proxy`, and `public`. HTTP/3 to an allowed host does not work. That is intended. A program that needs UDP asks for `host`.

TLS: no inspection (E7).

Per-plugin identity: the proxy's `Proxy-Authorization` is the host tag. Logs include `tag` and plugin id, not the workspace path. Denials already flow as `ISandboxRunDenial` kind `network` (`sandboxManager.ts` wires the proxy callback).

"Allow host": a button on the denial. It calls `handle.allow({ kind: 'net.connect', host })` after one confirm. It does not restart the host (section 3.6). It does not allow a private address even if the user types `169.254.169.254` or `localhost`. Those are a different grant, `net.loopback` / `localNetwork`, with the critical sheet.

Local network is its own capability, copied from Android 17's split of internet and local network (brief §4). `net.connect:printer.local` is not how a plugin reaches `192.168.1.5`. The sheet has "Devices on your local network", off by default, and it requires `public` or `host` plus `localNetwork: true`. In `proxy` mode the proxy keeps refusing private answers, so the capability is a no-op there and the UI does not offer it.

Listen: unchanged. Linux listen is inside the netns and the host's browser cannot see it (`05-limitations.md`). A dev server the user must open is a broker that publishes one port through the holder, explicit `net.listen`, not a host-netns sandbox.

---

## 6. Migration: features to extensions

M1 is done. Thirty manifest-only extensions under `extensions/volt-*` (18 features + 12 providers). `IVoltFeatureService` turns the built-in code off when the extension is disabled (`customize.md` §6.1d). The implementation still lives in `contrib/` and `platform/`.

Do **not** move that implementation into today's extension host and sandbox it later. Today's desktop host is a `utilityProcess` and today's server host is an unsandboxed `cp.fork` (`extensionHostConnection.ts:277`). A feature that moves first runs in a worse place than `contrib/`: same privileges, plus whatever else is in the extension host, and no `confirm`.

The sequence that stays shippable:

1. Land the sandbox core, including Windows refuse-or-enforce (section 12, P0-P2).
2. Point the server extension host at `SandboxManager.start` with a T1 policy (P3). Behavior of built-in code does not change yet, because built-in code is still in `contrib/`.
3. Move one feature at a time. The flag stays. Extension disabled → old `contrib/` path. Extension enabled → the moved code. Delete `contrib/` only after the sandboxed path is the default for a release.
4. Then split T3 hosts and turn prompts on for non-Volt publishers.

Each move needs a Volt API instead of a direct service import. The designed set in `customize.md` §8 (`agents.read`, `agents.send`, `terminals.run`, `network`) is too small. Minimum surface:

| API | Used by | Capability |
|---|---|---|
| `volt.agents` read/send/fork | providers, automations | `agents.read`, `agents.send` |
| `volt.workspace` text, search | code-intelligence, git, PRs | `fs.read:workspace` |
| `volt.scm` | git-graph, pull-requests, commit-review | `git.local`, `git.remote:<host>` |
| `volt.terminal` observe | agent-resources | `terminals.read` |
| `volt.terminal` run | none of the third-party set by default | `terminals.run` (critical) |
| `volt.exec` sandboxed | providers that spawn CLIs | the CLI's own policy, not a raw spawn |
| `volt.secrets` | claude-accounts, providers | `secrets.read:<provider>` via the broker |
| `volt.network` | browser, providers | `net.connect:<host>` |
| `volt.ui` panel | visuals, scratch, customize, usage | iframe, `postMessage` only |

Providers do not get Node `child_process`. They call `volt.exec`, which is `SandboxManager.run` or a child of the chat's existing agent host.

### Order

Core, not moved: threads, queue, subagents, run groups, questions, worktrees, terminals (the user's), workspace context, image inspection, the sandbox, the brokers, the signature checker.

Providers first (they already spawn, and the sandbox story is the CLI tree):

1. `volt.provider-local` — loopback to Ollama/LM Studio. Needs an explicit `net.loopback` grant. Dangerous one, do it first so the grant UX exists.
2. `volt.provider-openrouter`, `volt.provider-grok`, `volt.provider-kimi`, `volt.provider-muse`, `volt.provider-fx`, `volt.provider-antigravity` — API only, `net.connect` to that vendor.
3. `volt.provider-claude`, `volt.provider-codex`, `volt.provider-cursor`, `volt.provider-opencode`, `volt.provider-pi` — spawn CLIs. The move is packaging; the process is already the sandboxed tree on the branch.
4. `volt.claude-accounts` — secret broker, no raw Keychain.

Then features that leave the machine or touch other processes:

5. `volt.browser`
6. `volt.devices`
7. `volt.remote-devices`
8. `volt.playgrounds`
9. `volt.visuals`
10. `volt.scratch-board`
11. `volt.computer-use` — T1, wide, never a third-party capability set. Can stay T0 if the iframe split is not worth it. I would keep it T0 through the first sandbox release.

Then workspace UI, read-mostly:

12. `volt.git-graph`
13. `volt.pull-requests`
14. `volt.commit-review`
15. `volt.code-intelligence`

Then the rest:

16. `volt.automations`
17. `volt.usage`
18. `volt.memory`
19. `volt.skills-and-plugins`
20. `volt.agent-resources`
21. `volt.customize`

Code moves as a normal extension: `extensions/volt-*/src`, `activate()` registers the contribution, the old module becomes a re-export that throws if both are on. One feature per PR. The window stays usable with the extension off.

---

## 7. Signing and trust

Challenge "allow all by default, signing it." A bit that means "do not sandbox `publisher === 'volt'`" is a compromised update away from unsandboxed code, and it teaches every other plugin to ask for the same bit. Android's SDK Runtime died on 2025-10-17 because the safe API was too small to bother with (brief §4). The opposite mistake is a bypass bit that is too easy.

What keeps zero friction for first-party:

- Volt's release key signs the VSIX and a capability manifest.
- The signature verifies before `activate`.
- Those capabilities are a trusted composition layer. No prompt, same as today, because today they run as Volt.
- The process still goes through `confirm`.
- An update that adds a capability or changes a host pattern is a prompt, even for `volt`. The diff is the product. Silent auto-update of a same-set manifest stays silent.
- There is no `sandbox: false` key.

Key management: one release key offline, one CI key that can sign only builds tagged from `main`, hardware-backed if we already have it. **I do not know whether Volt has a signing HSM today; do not invent one in the first PR.** Until then, sign with the same key that signs the desktop build, and pin it in the app.

Revocation: a signed generation list. Already-installed copies keep running if the list cannot be fetched (do not brick the IDE on a plane). New installs of a revoked publisher fail closed. Stale list older than 7 days is shown in the attestation line, not treated as a revoke.

Reproducible builds: the VSIX hash is in the signature. A rebuild that does not match is unsigned. We do not need a Debian-style reproducible archive in v1; we need "this hash was signed."

Dev / unsigned: a banner "Unsigned plugin, trusted for this window" after one prompt. That prompt creates a trusted layer equal to the manifest for this window only. It is not a global allow. Playground drafts (`customize.md` §5 and §8) write only their draft folder and get `restricted` plus that folder, network off, until the draft's own sheet is accepted. Install promotes the draft to an unsigned third-party plugin and asks again.

---

## 8. Permissions model and UX

Manifest is `contributes.voltCapabilities`: the capability ids `sandboxCapabilities.ts` already evaluates (`fs.read:workspace`, `net.connect:api.github.com`, `socket:/var/run/docker.sock`, …), plus the Volt API ids in section 6. Unknown ids fail install, not "ignore".

Three times:

| When | What | Stored |
|---|---|---|
| Install | The sheet, highest risk first (`describeCapabilities`) | `~/.volt/sandbox/grants.json`, keyed by plugin id + version + capability id. Not in the repo |
| Update | Only the diff. Same set → silent | Same file, new version |
| Runtime | A capability the manifest did not ask for, or a path outside the grant | One-time by default. "Always" adds it to the grant file. Session-only is the default for `critical` |

The workload does not hold the grant file. The monitor reads it and passes the result to `evaluateCapabilities`.

Revoke: the extension page lists grants with a switch. Revoking `net.connect` calls `handle.revoke` if the host is live, and removes the row. Revoking `fs.write:workspace` cannot unmount a bwrap bind; the UI says "stops on next reload" and reloads the host.

What the user sees: one install sheet, then denials inline in the chat ("Blocked example.com", Allow / No). No modal per file in the workspace once `fs.write:workspace` was granted. Prompt fatigue is how people disable the sandbox. Rules against it:

- Workspace read/write and the plugin's `${storage}` are the install sheet, not runtime prompts.
- Protected paths are never a prompt that offers "allow anyway" for hooks and `.vscode/tasks.json`. The consumer guard (E14) offers "show me" and "don't run", not "run the hook".
- Repeated denials for the same host collapse into one line.
- T1 never prompts except on a capability diff.
- "Run outside sandbox" is a chat-level action, two clicks, recorded, and the status bar stays on "not sandboxed" for that chat.

---

## 9. Third-party extensions

**VS Code extensions with no Volt manifest.** Default policy: read `${workspace}`, write `${storage}` and the extension's global storage, network `none`, no sockets, no `systemServices`, `brokerWrites: true` for any path outside storage. What breaks: formatters and language servers that write the workspace, anything that shells out, GitLens-class tools that spawn git, extensions that open localhost. The install sheet for a popular extension can include a reviewed preset (`fs.write:workspace` as `partial` on Linux protectNew, with the consumer guard on). The user accepts the preset once. We do not scan Open VSX and guess a preset in the client.

**Volt-native third-party (T2).** SES, no Node, iframe UI, broker only. This is the one that can actually be tight. If a publisher cannot live with it, they ship a T3 VSIX and get the looser default. We do not force T2. The SDK Runtime lesson is that a sandbox nobody can build for will be turned off.

**MCP servers.** Declared capabilities in the MCP config Volt owns, not in a repo `.mcp.json` the sandbox just protected. A repo that wants an MCP server shows a trust prompt (the branch already calls this out, `05-limitations.md` item 18). The server is a host. Its tools are classified; unlisted tools are refused for sandboxed chats. Stdio, not a TCP port, so E1 does not apply. If a server insists on a port, that port is a `net.loopback` grant and the server still has to authenticate.

**Agent CLIs.** The whole tree is the host. Env starts empty except `BASE_ENV_INHERIT` and the launcher's proxy vars (`ADR-10`). Inner sandbox off when we wrap. Network defaults follow the chat. `loopback` to the host MCP is the one local port, with the bearer.

**Marketplace.** Open VSX stays the channel. Volt review is a signed preset and a malware scan queue, not a promise that we read every extension. A publisher key (section 7) plus the capability diff is the gate we enforce. A review badge is optional and must not be confused with the OS confirm.

---

## 10. Brokers instead of raw access

Raw OS grants are for the agent CLI profile, which is a shell. Plugins get brokers.

| Resource | Broker | Not this |
|---|---|---|
| Files | Directory fd, flags in E9. Picker for a path outside the workspace (Android scoped storage: the picker is the grant) | A live Seatbelt edit, a new bwrap bind, an ACL on a path the plugin named as a string |
| Secrets | `SecretStorage` in the main process. `volt.secrets.get('claude')` returns a handle the provider's CLI receives on stdin for one exec, or a short-lived env var on that `volt.exec` only | Keychain mach service, `~/.aws` readable, the secret in the extension host's env for its whole life |
| Terminals | Observe: a ring buffer the monitor copies. Run: `SandboxManager.run` with the chat policy | The user's PTY, `child_process.spawn` in the host |
| Git | `volt.scm` runs git with `core.hooksPath` empty and the protected paths read-only. Commits of objects and refs stay allowed (`sandboxProfiles.ts:54-58`) | `git` on `PATH` inside a T3 host that has `fs.write:workspace` as a raw bind |
| Clipboard | Main process. `volt.clipboard.read` is a capability, prompted, returns the string once | macOS pasteboard mach service (already denied, `seatbelt.ts` `com.apple.pasteboard.1`) |
| UI | iframe, `postMessage`, no `parent` DOM (`customize.md` §6.3) | A view in the workbench renderer |
| Network | Section 5 | A socket the plugin opens to the real NIC |

The broker is in T0. It refuses paths that fail E9 even if the capability says write. The OS sandbox is the second line for T3, because T3 still has Node and can call `fs` on whatever we mounted. That is why T3's default mount is storage, not the workspace. A T3 that was granted workspace write and `brokerWrites: false` is the partial profile, labeled partial, with E14 on.

---

## 11. Verification

Adversarial suite, one job per OS in section 4.5. Every escape in section 4.4 that is marked enforced has a test that fails if the mitigation is removed. Partials (E4's race, E9's pre-existing hard link, E7's CDN) have tests that assert the residual and assert the thing that must still hold (cannot read `~/.ssh`, cannot write a hook that Volt then runs).

Existing tests to keep green: `src/vs/platform/voltSandbox/test/node/sandboxSecurity.test.ts` and the common tests on the branch.

Parser fuzz: random bytes and a grammar-aware fuzzer against `parseSandboxPolicyText`. Failures are "rejected" or "accepted and then `checkEnforcement` refuses". A crash or a widened path is a bug. Cap input at `MAX_POLICY_BYTES` (already).

Attestation: every host emits one line at confirm: backend id, status, unenforced dimensions, policy generation, image class, Windows build or bwrap version. The UI status bar shows `sandboxed`, `partial`, or `off`. Telemetry, if enabled, gets the backend id and the unenforced set, not paths and not the allowlist. This is the Play Integrity analogue that actually fits a desktop app: we report what the probe measured, we do not phone home a quote of the kernel.

Red-team scenarios, scripted:

1. CVE-2026-82533 replay: from inside the sandbox, TCP to every listening port of the Volt process. All fail except the granted proxy. HTTP to the proxy with `Host: 127.0.0.1` and a CONNECT to the agent port fails.
2. DSec daemon-socket replay: connect to the IPC socket path from inside. Fails. The inherited fd still round-trips a ping.
3. Overwrite `/bin/bash`: write fails. The binary's hash before and after matches.
4. `yes` into the workspace: dies on `RLIMIT_FSIZE` or the wall clock, and the process is gone after terminate (Linux, Windows). macOS: gone, or still confined and unable to write `~/.ssh` (E4).
5. Port scan of RFC1918 and `169.254.169.254`: every connect fails in `proxy` and `public`.
6. Plant `.git/hooks/pre-commit` after launch, then run Volt's commit. The hook does not run (E14).
7. Untrusted policy sets `NODE_CHANNEL_FD` and `VSCODE_EXTHOST_IPC_HOOK`. Both appear in `ignored`. The live fd is the parent's pipe (E12).
8. Git Bash on Windows follows section 4.1 case 3 or 4, never a crash dialog and never an unsandboxed retry.

---

## 12. Phased roadmap

Each step ships something a user can see, and main stays launchable.

**P0. Merge `feat/volt-sandbox` behind the existing chat sandbox setting.** No Windows change yet (`UnsupportedBackend` still refuses, `unsupportedBackend.ts`). Ask before merging to main, as already decided. Acceptance: current adversarial tests pass on macOS and Linux; Windows chats that ask for a sandbox get a refusal, not an unsandboxed agent.

**P1. Policy v2 reader, reserve list, untrusted `env.set` fix (E12), live `allow()` wired to the denial button (E16).** Files: `sandboxSchema.ts`, `sandboxComposition.ts`, `sandboxProfiles.ts`, the grant caller in volt-runtime (the missing caller of `allowSandboxDomains`). Acceptance: E12 and E16 tests. Users on macOS/Linux see "Allow host" actually open the next request.

**P2. `mxc` backend and the chooser. No sandbox-user yet.** Files: new `src/vs/platform/voltSandbox/node/mxcBackend.ts`, `chooseWindowsBackend`, probe, CI on a Win11 runner at or above the floor. `wxc-exec` pinned by hash. Acceptance: section 4.1 cases 1, 2, 5, 6 (Win10 refuses), 7. Users on supported Win11 get a sandboxed agent. Users on Windows 10 see "not available on this Windows", and the agent does not run sandboxed-and-secretly-open.

**P3. Long-lived `start`, server extension host on it.** File: `extensionHostConnection.ts` spawn path. Env allowlist from section 3.2. Acceptance: a stock extension activates; `confirm` logged; E2 test from inside that host fails to open the pipe path; `NODE_CHANNEL_FD` round-trips. Users: no visible change if nothing fails confirm.

**P4. sandbox-user setup and the msys route.** Acceptance: section 4.1 cases 3 and 4. Users with Git Bash get a working shell inside the sandbox after one elevated install, or a clear refusal.

**P5. Consumer hook guard (E14) and broker open flags (E9) in Volt's file service.** Acceptance: red-team 6. Users: a planted hook does not run; a one-line notice the first time.

**P6. T2/T3 default profiles, grant file, install sheet.** No feature code moves yet. Acceptance: an unsigned VSIX gets the default policy and a sheet.

**P7. Providers, one PR each, order in section 6.** Acceptance: model picker works with the extension on and with it off.

**P8. The 18 features, one PR each, after the API they need exists.** computer-use stays T0 unless a later PR argues otherwise.

**P9. Per-extension T3 host when a grant is wider than the shared restricted host. cgroup memory if `systemd-run --user` works. macOS reaper (E4). T4 microVM only if a user asks for a strict tier.**

Out of every PR: a `sandbox: false` escape for `publisher === 'volt'`.

---

## 13. Risks, open questions, decisions for the user

### Risks

- **MXC proxy enforcement is folklore on some builds.** If the Win11 runner cannot show "connect to 127.0.0.1 other than the proxy fails", we do not ship `network.proxy` on that build. The agent then has no network unless the user picks "Run outside". That is the honest failure mode. Shipping hope is F-01 again.
- **Git Bash refusal will be the Windows bug people file.** The message has to name the crash and the setup command in the first sentence.
- **bwrap 0.8 floor** drops older enterprise images. They get a refusal and an install line, not Landlock. Landlock was rejected because it cannot do this policy (`ADR-3`).
- **Moving features before the host is sandboxed** recreates an unsandboxed plugin platform. Section 6 is the mitigation.
- **T3 workspace write stays partial on Linux.** If we pretend otherwise, E14 is how we get owned. The label has to say partial.
- **`sandbox-exec` goes away.** The helper plan is in the limitations doc. No policy rewrite.
- **One shared T3 host** means a malicious extension in that host can call another extension's `activate` memory. Per-extension hosts (P9) are the real fix. Until then the shared host is restricted, and a wider grant forces a private host (P9's rule, pulled forward if we grant workspace write to one extension).
- **MXC container cap and temp behavior** are guesses until P2 measures them.

### Open questions

- Is `wxc-exec.exe` redistributable in the MXC 1.0.1 MIT drop, and what is the exact argv? P2 pins both from upstream. I did not invent flags in this proposal.
- Can we deny destination ports inside a Linux `host` netns without a supervisor? E18's trial answers it. If not, untrusted `host` is unsupported on Linux.
- Will the macOS reaper get an Endpoint Security entitlement? Assumed no for v1.
- Does `security` / the agent CLI break if `tccd` is denied? Trial in P1 on macOS before adding the deny to the agent profile. Plugin profiles deny it regardless.
- HSM for the release key: unknown in this checkout. P6 can use the desktop signing key.

### Decisions I want from you

1. **Windows: MXC primary, sandbox-user only for "MXC unsupported" and for MSYS2/Cygwin, refuse otherwise.** No silent fallback. Say if you want sandbox-user as the default on all Windows instead (I think that is weaker and it needs an elevated install everywhere).
2. **Windows 10: refuse unless the optional sandbox user is installed.** The alternative is "Windows 10 runs unsandboxed and the UI says so", which is today's bug with better copy. I still refuse.
3. **First-party: pre-granted signed capabilities, still sandboxed.** Not a bypass bit. computer-use and the user's terminal stay T0.
4. **Migration: sandbox the server host before moving feature code.** The stubs can stay as they are. The alternative you described (move all code into extensions first) puts Volt's features into the unsandboxed `utilityProcess` / `fork` host. I would not do that.
5. **Untrusted plugins do not get a raw workspace write** until the broker or the partial+E14 label is in place. Agent chats keep the current best-effort profile so P0 does not change chat behavior.
