# Sandbox + plugin platform PRD: team brief

Everyone on the team reads this first. It holds the user's request, what is already decided, the facts we already checked, and where the code is. Don't re-research what is here; spend your effort on the design and on attacking each other's designs.

## 1. The user's request (scope)

Write a comprehensive PRD for:
1. **The sandbox core**: `SandboxManager`, its policy, backends, network broker. How to build it.
2. **Migration first**: move everything Volt has into plugin extensions (features and providers), so Volt itself is built from plugins.
3. **Then the sandbox under the plugins**: plugins run inside the sandbox, with permissions.
4. **Volt's own (internal) plugins are allowed everything by default**, through signing ("allow all by default, signing it kinda"). Challenge this if you think it's wrong, but give a concrete alternative that keeps the same zero-friction experience for first-party plugins.
5. **How other (third-party) extensions handle the sandbox**: VS Code extensions from Open VSX, Volt-native plugins, MCP servers, agent CLIs.

The goal is the most secure architecture that still ships and that developers will actually build for.

## 2. Decided so far (2026-11-08, with the user)

From the Scratch board "Untitled board 3" (frames 1-8) and the chat "Design /scratch skill architecture for Volt" (`agent-90b18b24-838f-40d6-a83e-85dfe13b90da`; read it with the volt `thread_read` tool if you have it):

- **Stack:** L0 OS → L1 sandbox base → … → L7 distribution/marketplace. "Everything is a plugin," secure by default.
- **Base (L1) = option A:** Volt's own `SandboxManager` (Seatbelt on macOS, bubblewrap + seccomp on Linux, Volt's host proxy) is the foundation. **MXC ProcessContainer only as the Windows backend**, launched through MXC's signed `wxc-exec` binary (MXC's Node SDK needs Node ≥ 24; Electron 37 ships Node 22.19).
- **Alternatives kept open:** B = MXC everywhere (revisit if MXC gains hostname rules and live denials); C = Anthropic sandbox-runtime (srt) (reference for its Windows design); D = microVM per session (only as an opt-in strict tier).
- **Plugin host tiers:**
  - **T2, the default for Volt-native plugins:** a worker with SES (hardened JS) and zero ambient capabilities, UI in iframes, Wasm components via jco. This is the MetaMask Snaps / Figma plugin pattern.
  - **T3, for existing VS Code extensions:** a per-plugin sandboxed Node extension host. Extensions that ship a `browser` entry can run in the web-worker extension host instead.
- **First sandboxed host goes on volt-server.** `src/vs/server/node/extensionHostConnection.ts` starts the remote extension host with a plain `cp.fork(bootstrap-fork)`, which Seatbelt/bwrap can wrap. Desktop's local host is an Electron `utilityProcess` (ExtensionHostStarter → WindowUtilityProcess), which the wrappers can't wrap.
- **Environment caution:** the sandbox builds the environment from nothing, and `isSecretEnvName` treats `VSCODE_*`/`ELECTRON_*` as secret-like. A trusted host layer must name the variables `bootstrap-fork` needs, plus `NODE_CHANNEL_FD`.
- **First step:** merge `feat/volt-sandbox`, then add `mxcBackend.ts`. Ask the user before merging anything to main.

## 3. Current state of the code

**`main` (Volt 0.0.6, VS Code base 1.105.1), which is this checkout:**
- **30 stub extensions** `extensions/volt-*`: 18 features + 12 provider families. Each holds only a `package.json` with `"contributes": {}`.
- **Feature switches:** `IVoltFeatureService` (`src/vs/workbench/contrib/voltCustomize/browser/voltFeatureService.ts`, list in `common/voltFeatures.ts`) turns built-in features on and off when their extension is enabled or disabled. The feature code still lives in `src/vs/workbench/contrib/volt*`, `src/vs/platform/volt*` and `src/vs/workbench/services/voltRuntime`.
- **Core with no extension:** chats/threads, queue, subagents/tasks, run groups, questions/plans, worktrees, terminals/dev servers, workspace context, image inspection (`voltFeatures.ts:24`).
- **Customize design doc:** `docs/volt/customize.md`:
  - §3: five layers.
  - §6.3: slots and replacement, designed.
  - §7: extension lifecycle.
  - §8: security. A designed `contributes.voltCapabilities` (`agents.read`, `agents.send`, `terminals.run`, `network`), checked in the main-thread proxy and shown on install.
  - §10: built vs. not built.
  - §11: roadmap.
- **Runtimes:** volt-server owns the agent runtime (`src/vs/server/node/voltAgent/agentServerMain.ts`). Desktop is a client by default. Web = the workbench at `/code/`. Phone = WebView shell.
- **GitHub Copilot and VS Code's built-in AI were removed in #90.** That includes `terminalContrib/chatAgentTools`, which is where VS Code's own MXC integration lives upstream (VS Code PR #317669, merged 2026-05-21, milestone 1.122: `src/vs/platform/sandbox/` + the `@microsoft/mxc-sdk` dependency + `wxc-exec.exe`).

**Branch `feat/volt-sandbox` (not merged; main is 11 commits ahead, none in voltSandbox/voltStdio).** Read it with `git show feat/volt-sandbox:<path>`; don't check it out. Code is in `src/vs/platform/voltSandbox/{common,node}`, docs in `docs/security/sandbox/00..05`.

**Policy** (`common/sandboxSchema.ts`, `sandboxProfiles.ts`, `sandboxPolicy.ts`, `sandboxComposition.ts`):
- **Schema v1:**
  - `filesystem`: `read`, `write`, `deny`, `protect`, `unmask`.
  - `network`: `mode` none/proxy/host, plus `allow`, `loopbackPorts`, `listen`.
  - `process.limits`.
  - `env`: `inherit`, `set`.
  - `host`: `unixSockets`, `systemServices`.
  - `bestEffort`.
  - Strict parser; anything left out defaults to the most restrictive value.
- **Credentials:** credential paths and `.env*` are always denied.
- **Protected paths:** git config, hooks, refs, shell rc, `.vscode`, `.claude/settings.json` stay read-only.
- **Secret env names:** never inherited.
- **Layering:** trusted layers widen access; untrusted layers can only narrow it, and each attempted widening is dropped and recorded.
- **Not wired yet:** user and repo policy files are not loaded.

**Lifecycle:**
1. Probe: each backend reports enforced, partial or unsupported per dimension.
2. Enforcement check: refuse if a used dimension isn't enforced and isn't marked best-effort.
3. Resolve: realpaths; environment built from nothing.
4. Start a per-run proxy.
5. Launch:
   - macOS: generated Seatbelt profile through `sandbox-exec`.
   - Linux: `bwrap` with user/pid/ipc/uts namespaces, `--cap-drop ALL`, `--disable-userns`, and a seccomp BPF filter on a pipe.
6. Confirm:
   - macOS: a ready line on fd 3.
   - Linux: bwrap's JSON status with namespace inodes that differ from the host's, plus `NoNewPrivs:1 Seccomp:2` from inside.
7. Refuse, never fall back. The only fallback is the user's "Run outside sandbox" button.
8. Kill the whole tree.
- **Windows:** `UnsupportedBackend` refuses everything.

**Network proxy** (`node/sandboxProxy.ts`):
- A per-run HTTP proxy on `127.0.0.1:0` handling CONNECT and plain http. No SOCKS.
- Matches exact hosts or `*.x`; an entry without a port allows 80/443 only.
- Resolves DNS itself, refuses if any address is private (loopback, RFC1918, link-local/metadata, CGNAT, ULA), and connects to the address it checked.
- macOS: Seatbelt allows outbound only to the proxy port.
- Linux: no network namespace route. A socat bridge in a "holder" namespace carries only the proxy and loopback ports out through unix sockets.

**Host MCP:**
- Per-session `HMAC-SHA256(serverSecret, sessionId+groups)` bearer token.
- Requires a loopback Host header and rejects `Origin`/`Sec-Fetch-*`.
- Every tool is classed (safe/reads/writes/network/spawns/escapes…); unlisted tools are refused for sandboxed chats (`workbench/services/voltRuntime/common/hostToolSandbox.ts`).

**Known gaps found today:**
- **"Allow host" never reaches a running agent's proxy.** `allowSandboxDomains` in `voltStdio/node/voltStdioService.ts:219` has no caller, and allowed hosts are excluded from `sandboxLaunchKey`, so the process is reused.
- **macOS:** a double-forked `setsid` process with a cleared environment survives tree kill (it stays sandboxed).
- **DNS mach service:** not explicitly denied under `(allow default)`.
- **Proxy limits:** no UDP, no TLS inspection (domain fronting works), and `host` mode is unfiltered.
- **Linux memory limit:** RLIMIT_AS only.
- **Policy files:** user/repo policy files are not loaded.

## 4. External facts already checked (cite these; don't re-research)

**MXC (Microsoft Execution Containers):**
- MIT licence. 1.0.0 on 2026-10-07, 1.0.1 on 2026-10-17.
- Backends:
  - Windows: ProcessContainer (AppContainer/BaseContainer + WFP).
  - Linux: Bubblewrap, LXC.
  - macOS: Seatbelt.
  - Windows Sandbox, MicroVM and Hyperlight are experimental.
- **Windows builds:** Windows 11 only. Process isolation needs 24H2 26100.9278+, 25H2 26200.9278+, 26H2 26300.9550+ or 26H1 28000.2804+. Session isolation needs higher builds. No Windows 10.
- **Network:** IP/port rules only, no hostname rules.
- **Node SDK:** needs Node 24.
- **Who uses it:** VS Code, Copilot and Codex (Codex prefers MXC).

**Anthropic sandbox-runtime (srt):**
- Apache-2.0. Seatbelt + bwrap + an HTTP/SOCKS proxy with domain allowlists.
- **Windows "srt-win" (alpha):** a dedicated `srt-sandbox` local user + a WFP egress fence keyed on that SID (loopback reachable only to the proxy ports) + NTFS ACLs + a write-restricted token + a job object. Needs one elevated install.
- **MXC opt-in (PR #766, 2026-11-06):** srt added MXC BaseContainer as a second Windows backend. Problems that PR lists for MXC:
  - MSYS2/Git Bash programs crash (`0xC0000005`).
  - UI is not locked.
  - `%TEMP%` is per-command.
  - I/O stalls with several sandboxes.
  - Routing through the proxy is guaranteed only by how 25H2 behaves, not by documentation.

**Codex on Windows:** prefers MXC. Legacy modes are "elevated" (sandbox users + firewall + ACLs) and "unelevated" (a restricted token).

**Android** (the model to learn from):
- Per-app UID.
- SELinux domain pinned to targetSdk; rules only tighten when the app updates.
- Zygote applies everything in a fixed order (seccomp before `setuid`) and kills the child on any error. There's no separate confirm step.
- INTERNET is checked by eBPF at socket creation; per-UID eBPF firewall. **No OS-enforced hostname allowlist.** Hostname filtering means a VPN or proxy broker.
- Android 17 adds a separate local-network permission.
- Isolated processes (no permissions, a channel to the host only).
- Scoped storage through a FUSE broker, with a picker as the grant.
- **SDK Runtime:** third-party SDKs in their own process with a fixed small permission set, binder calls, remote UI, no native code or dynamic loading. **Retired 2025-10-17 for low adoption.** Lesson: a plugin sandbox that is hard to build for dies.
- Verified Boot / Play Integrity: attestation of enforcement.

**DeepSeek:**
- **DSec** (arXiv 2609.22978): about 3M sandboxes a day across FnCall / container-in-VM / Firecracker / QEMU; eBPF per-task network rules; AppArmor; per-command ordered logs. Observed agent misbehaviour:
  - Forging RPC to the control daemon's socket.
  - Overwriting `/bin/bash`.
  - A recursive `grep /` through `/proc` that crashed the kernel.
  - `yes` filling tens of GB.
  - Port-scanning mirrors.
  - Hunting for leftover answers.
- **DeepSeek Harness, CVE-2026-82533 (CVSS 9.4, fixed 2026-08-27):** the sandbox left loopback open. The harness's unauthenticated API on port 3080 trusted the `Host` header, so the agent switched itself to full access. A second hole: `run_code` ran in a worker thread outside the sandbox.

## 5. How the debate runs

**Round 1:** each member writes `docs/volt/sandbox-prd/proposals/<your-name>.md`, a complete proposal covering every section in §6, with your assigned emphasis done deepest. Cite code as `path:line` (say which branch). Cite external facts by URL. Mark guesses as guesses.

**Round 2:** each member reads all the proposals and writes `docs/volt/sandbox-prd/critiques/<your-name>.md`:
- the 5-10 strongest objections to the other proposals, each naming the proposal, the claim, why it fails, and a concrete attack or failure scenario;
- what you concede and adopt from others;
- your revised position on every disputed decision.

Be adversarial and specific. "Could be insecure" is worthless; "plugin X reads `~/.ssh/id_ed25519` through Y because Z" is useful.

**Synthesis:** the orchestrator (Opus 5.5) writes `docs/volt/sandbox-prd/PRD.md` from all of it.

**Rules:**
- Write only your own file.
- Don't change code.
- Don't commit.
- Don't touch other members' files.

## 6. Required sections in every proposal

1. **Threat model:** assets, attackers (malicious plugin, compromised update, prompt-injected agent, malicious repo, network attacker), trust boundaries, and what is explicitly out of scope.
2. **Trust tiers and host model:** in-process core, first-party, Volt-native third-party, VS Code extensions, MCP servers, agent CLIs, a VM tier. What runs where (desktop renderer, Electron main, utilityProcess, volt-server, worker, iframe).
3. **SandboxManager core:**
   - API.
   - Policy schema v2: capabilities → policy, versioning like Android targetSdk.
   - Composition and layering.
   - Probe, enforce, launch, confirm, refuse, terminate.
   - Long-lived hosts, as opposed to one-shot commands.
   - Live grants.
4. **Backends per OS:** macOS, Linux, Windows (MXC primary? srt-win-style fallback? refuse?), minimum versions, CI coverage.
5. **Network broker:** hostname rules, DNS, loopback and local-network rules, UDP, TLS, per-plugin identity, denials and "Allow host".
6. **Migration: features → extensions.**
   - The order for all 18 features + 12 providers.
   - The Volt extension API surface each one needs.
   - How code moves out of `contrib/`.
   - What stays core.
   - How to keep Volt shippable at every step.
7. **Signing and trust:** first-party "allow all by default"; key management, update signing, revocation, reproducible builds, the dev/unsigned mode, Playground drafts.
8. **Permissions model and UX:**
   - The manifest (`contributes.voltCapabilities`, or something better).
   - Install-time vs runtime vs one-time grants.
   - Where grants are stored.
   - Revoking.
   - What the user sees.
   - Avoiding prompt fatigue.
9. **Third-party extensions:**
   - Existing VS Code extensions with no manifest: the default policy, and what breaks.
   - Volt-native third-party plugins.
   - MCP servers.
   - Agent CLIs.
   - Marketplace review.
10. **Brokers instead of raw access:** files (picker grants), secrets (`SecretStorage` broker), terminals, git, the clipboard, UI (iframes and `postMessage` only).
11. **Verification:** the adversarial test suite per OS, the CI matrix, attestation/telemetry of the enforcement state, fuzzing the policy parser, red-team scenarios from the DeepSeek and Android lessons.
12. **Phased roadmap:** numbered PRs, each with scope, files, acceptance criteria, and what ships to users at that step.
13. **Risks, open questions, and the decisions you want the user to make.**

## 7. Team

| Member | Model | Emphasis (go deepest here; still cover everything) |
|---|---|---|
| `grok` | Grok 4.7 (Cursor) | OS sandbox core and backends, especially Windows (MXC vs srt-win vs refuse) and escape paths |
| `claude-a` | Opus 5.5 (Claude Code) | Plugin host tiers, the Volt extension API, and migrating all 30 features/providers out of `contrib/` |
| `claude-b` | Opus 5.5 (Claude Code) | Red team: threat model, signing/supply chain, the first-party "allow all" question, permission UX |
| `sol` | GPT 5.6 Sol (Cursor) | Network broker, MCP servers, agent CLIs, volt-server/web/phone (remote) |
| `terra` | GPT 5.6 Terra (Codex) | Concrete build plan: PR sequence, file moves, tests, CI matrix, effort, keeping main shippable |
