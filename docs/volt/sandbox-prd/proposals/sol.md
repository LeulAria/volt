# Sol proposal: capability-secure plugins with an identity-bound network broker

Status: round 1, 2026-11-08. “Main” below means this `volt-f24fd65b` checkout; branch citations explicitly say `feat/volt-sandbox`. Guesses are labelled.

## 1. Threat model

### Assets and attackers

Protect: workspace and user files; credentials and environment secrets; Git configuration, hooks and refs; Volt account/session/device tokens; browser, clipboard and desktop authority; other plugins’ state; host processes and sockets; network identity and private/LAN services; the integrity of Volt updates and grants; availability.

Assume all of these may be hostile:

1. A deliberately malicious plugin or MCP server.
2. A legitimate plugin, provider adapter or CLI whose update channel was compromised.
3. A prompt-injected agent that can invoke every capability its process has.
4. A repository containing malicious `.vscode`, `.volt`, MCP, task, Git hook, language-server or package-manager configuration.
5. A network attacker controlling DNS, an allowed origin, a redirect, or a CDN co-tenant.
6. A paired web/phone client stolen after pairing, and a malicious page open in the web workbench.

The kernel sandbox, `SandboxManager`, broker processes, signed first-party manifest catalogue, grant store, SecretStorage, update verifier and trusted UI are the trusted computing base. Plugin code, plugin UI, agent CLIs, MCP servers, repositories, webviews/iframes and relay payloads are not.

Security properties:

- No workload gets ambient host authority. Every sensitive operation is either kernel-enforced or crosses an authenticated, policy-checking broker.
- Identity is assigned by the launcher, never supplied by the workload. This specifically prevents the DeepSeek-style control-daemon forgery described in DSec ([paper](https://arxiv.org/abs/2609.22978)).
- Unknown policy fields, tools, capabilities, backends and enforcement states fail closed.
- A child cannot receive more authority than its parent merely by changing transport, starting an MCP server, delegating, or moving the UI to a phone.
- “Allowed host” means a named destination and port, not an IP range, arbitrary redirect, loopback, LAN, DNS tunnel or host-network escape.

Out of scope for v1: malicious kernel/root/admin, hardware/firmware compromise, side channels, protecting data the user deliberately pastes into a plugin, perfect containment of first-party native code, and inspecting end-to-end encrypted application payloads by default. Availability is bounded, not guaranteed.

## 2. Trust tiers and host model

| Tier | Workload | Location and boundary | Default |
|---|---|---|---|
| T0 | Minimal Volt core, brokers, update/grant verifier | Electron main or `volt-server`; never renderer | In-process, reviewed TCB |
| T1 | Bundled first-party plugin | Same T2/T3 isolation as third party; signed catalogue may silently grant reviewed capabilities | No ambient “core” privilege |
| T2 | Volt-native JS/Wasm plugin | Dedicated worker per plugin, SES, no Node globals; UI in a separate sandboxed iframe; typed RPC only | Zero capabilities |
| T3 | Existing VS Code extension | Dedicated Node extension host process per extension on execution machine; `browser` entry uses web-worker host | Workspace read only after compatibility consent; no secrets/network/write/process |
| T4 | MCP server or agent CLI | Dedicated OS-sandbox workload/process tree owned by `SandboxManager` | Explicit profile and grants |
| T5 | Strict workload | Per-session microVM, opt-in | Same broker protocol, stronger kernel boundary |

Do not put multiple mutually untrusted plugins in one Node extension host: per-plugin identity is otherwise impossible to enforce for files, network, crash, memory and revocation. VS Code itself distinguishes local, web and remote hosts and runs workspace extensions where the workspace is ([official extension-host architecture](https://code.visualstudio.com/api/advanced-topics/extension-host)); Volt must preserve placement while changing isolation granularity.

Desktop renderers and webviews never hold OS capabilities. Electron main owns local brokers only when execution is local. By default agent CLIs, MCP stdio processes and workspace extensions execute in `volt-server`; its existing process service is created at `agentServerMain.ts:236-247` (main). The `/code/` workbench is only a client plus remote extension-host surface (`serverWorkbench.ts:40-82,284-309` main). The phone is a protocol client, not an execution host.

First-party must not mean “in-process.” It means a signed, reproducibly measured package whose exact manifest may be silently granted a reviewed capability set. Compromise then still meets an OS and broker boundary.

## 3. `SandboxManager` core

### API and identity

Add under `src/vs/platform/voltSandbox/`:

```ts
type WorkloadId = string; // random 128-bit, minted by manager
interface WorkloadPrincipal {
  workloadId: WorkloadId;
  kind: 'plugin' | 'vscode-extension' | 'mcp-stdio' | 'mcp-http' | 'agent-cli' | 'cloud-task';
  packageId: string;
  packageDigest: string;
  sessionId?: string;
  parentWorkloadId?: WorkloadId;
}
interface SandboxManager {
  probe(): Promise<EnforcementReport>;
  prepare(principal: WorkloadPrincipal, request: CapabilityRequest): Promise<PreparedSandbox>;
  launch(prepared: PreparedSandbox, command: SpawnSpec): Promise<SandboxHandle>;
  grant(workloadId: WorkloadId, expectedRevision: number, grant: LiveGrant): Promise<GrantResult>;
  revoke(workloadId: WorkloadId, grantId: string): Promise<void>;
  terminate(workloadId: WorkloadId, reason: string): Promise<void>;
}
```

`PreparedSandbox` contains a canonical policy, policy hash/revision, broker endpoints, sanitized environment and backend launch recipe. `SandboxHandle.ready` resolves only after backend confirmation and broker registration. It exposes denial events and an attestation record, never a mutable raw policy.

### Policy schema v2

Capabilities are UX vocabulary; the strict policy is enforcement:

- `targetSandboxVersion` (monotonic per installed package), `schemaVersion`, principal/digest.
- `filesystem`: read/write handles and canonical roots, deny/protect patterns.
- `network`: `none | broker | host`; TCP hostname/port/protocol rules; `loopback`; `localNetwork`; UDP rules; listen rules; TLS mode.
- `brokers`: files, secrets, git, terminal, clipboard, UI and Host MCP methods.
- `process`: executable digests/paths, child count, CPU/wall/file/open-file/memory limits.
- `environment`: explicit names and brokered secrets; no inheritance switch for third parties.
- `host`: narrowly enumerated system services and sockets.
- `bestEffort`: prohibited for credential, process isolation, network route and write dimensions in release builds.

Like Android’s `targetSandboxVersion`, an installed package may only move to a stricter target without a reinstall; Android documents this monotonic rule and separate SELinux sandbox target in its [manifest reference](https://developer.android.com/guide/topics/manifest/manifest-element). Volt maintains compatibility shims per target for a bounded period, but a plugin cannot pin forever: marketplace minimum target advances annually.

Composition order is built-in floor → signed package request → user/admin grants → session grant → untrusted repository narrowing. Only trusted layers widen. Denies union; limits take the minimum; broker rights intersect parent and child; repo policy can only narrow. Resolve realpaths before launch and check both lexical and canonical paths for brokered operations, consistent with `sandboxResolved.ts:63-104` (`feat/volt-sandbox`).

### Lifecycle and long-lived hosts

Probe every used dimension; resolve; register principal and broker channels; create backend; launch; confirm; then publish `ready`. Any failure terminates and refuses—never starts bare. Linux already proves `NoNewPrivs:1 Seccomp:2` before `exec` (`bwrap.ts:38-48`, `feat/volt-sandbox`); macOS writes readiness only after Seatbelt initialization (`seatbelt.ts:268-282`, same branch).

Long-lived plugin/MCP hosts have leases:

- One principal and policy revision for their lifetime.
- Heartbeat and idle/resource budgets.
- Re-evaluation on package update, workspace change, grant revocation and target-version change.
- Network/file broker revocation is immediate. A filesystem mount cannot always narrow live, so revoke terminates and restarts the workload.
- No host reuse across package digest, principal, workspace, user, target sandbox version or policy hash.

Live grants are compare-and-swap operations against `policyRevision`. The trusted grant service persists durable grants first, updates the broker atomically, emits a replicated state event, then acknowledges. “Once” grants live only in memory and expire after one successful operation or five minutes. A stale client gets the new revision and must re-confirm.

The current path is broken: `allowSandboxDomains` mutates an active launch (`voltStdioService.ts:205-211`, `feat/volt-sandbox`), but no caller reaches it, while `sandboxLaunchKey` omits `allowedDomains` (`sandboxPolicy.ts:526-530`, branch). Fix both: route UI approval to `SandboxManager.grant`, and key reusable processes by immutable policy plus an attached broker principal. Network grants update the principal’s broker rules without restart; other widening starts a new workload.

## 4. Backends per OS

### macOS

Seatbelt on macOS 13+ initially; test 13, 14, 15 and 26 on arm64, plus latest x64 while supported. Deny by default for plugins/MCP. Agent CLI’s current `systemServices` allow-default profile (`seatbelt.ts:112-136`, `feat/volt-sandbox`) is a transitional weaker tier and must be visibly attested as partial. Explicitly deny DNS Mach services in `none`, all Unix sockets except grants, Apple Events, launch/job creation, pasteboard and WindowServer. Keep the known detached-process persistence gap release-blocking for “strict”; the process remains sandboxed but must be surfaced as partial.

### Linux

Bubblewrap 0.8+, kernel 5.14+, seccomp, user/PID/IPC/UTS/network namespaces and no capabilities. The existing bridge-holder gives the workload only named loopback ports through Unix sockets (`bwrap.ts:383-409`, `feat/volt-sandbox`), which is the right broker transport. Test Ubuntu 22.04/24.04, Debian 12/13 and Fedora latest on x64/arm64. Refuse when unprivileged user namespaces are disabled; do not fall back to Landlock.

### Windows

Use MXC ProcessContainer via pinned, signed `wxc-exec` on supported Windows 11 builds; keep Volt’s broker because MXC rules are IP/port, not hostname. Probe exact build and WFP capability. Windows 10 and unsupported Windows 11 refuse sandbox-required workloads. A separately installed srt-win-style restricted local user + WFP + ACL + Job Object backend may be experimental, never silent fallback. Test minimum supported 24H2, 25H2 and current 26H2 x64/arm64 where runners exist. The backend choice and exact enforced dimensions appear in attestation.

The VM tier uses a versioned guest agent speaking the same broker protocol; it is not required for v1.

## 5. Network broker

### Architecture and per-plugin identity

Replace “an HTTP proxy with a mutable list” by `NetworkBroker`, running on the execution host beside `SandboxManager`.

Each principal gets a unique, unguessable broker session and a private route:

- Linux: one private Unix-socket bridge/port inside that workload’s network namespace.
- macOS: a unique loopback port permitted only in that workload’s Seatbelt profile.
- Windows: a unique loopback endpoint plus ProcessContainer/WFP rule.
- T2 worker: typed broker RPC over its existing private message port; no socket API.

The route—not an `X-Plugin-Id` header—selects `WorkloadPrincipal`. A token authenticates protocol setup and prevents confused reuse, but caller-supplied package/session identity is ignored. A principal cannot reach another principal’s endpoint. This is the network equivalent of Android’s per-app UID; Android’s official docs describe distinct process identities and recommend authenticated IPC rather than sensitive localhost services ([security guidance](https://developer.android.com/privacy-and-security/security-tips)).

Support HTTP forwarding, HTTP CONNECT and SOCKS5 CONNECT. SOCKS5 is needed for non-HTTP TCP clients and carries domain names and ports; RFC 1928 defines domain-addressed CONNECT and UDP ASSOCIATE ([RFC 1928](https://www.rfc-editor.org/rfc/rfc1928.html)). `ALL_PROXY` must therefore point to `socks5h://` only for clients that support it; HTTP variables remain HTTP proxy URLs. Raw egress is kernel-blocked.

### Hostname and DNS rules

A rule is `{scheme?, asciiHost, port, transport, expiry, localClass}`:

- Normalize with URL/WHATWG IDNA to lowercase ASCII, strip one trailing dot, reject controls, empty labels, zone IDs and ambiguous numeric forms.
- Exact host by default. `*.example.com` matches descendants, not the apex. Wildcards cannot be public suffixes and require a user-visible registrable domain.
- Missing port means only 80/443 for HTTP(S), never every port. Redirects are independently checked.
- IP literals require an explicit IP rule; a hostname grant never authorizes arbitrary direct IP use.

Broker DNS is the only DNS. It queries the execution host’s configured resolver, returns no answers to the workload, checks every A/AAAA result, and connects to exactly a checked address. Re-resolve for each new connection with a bounded TTL; fail if any answer crosses into a forbidden class. This preserves the current anti-rebinding property (`sandboxProxy.ts:88-115,207-215`, `feat/volt-sandbox`). Named proxy destinations also avoid client A/AAAA queries, consistent with RFC 9460’s proxy guidance ([RFC 9460 §3.2](https://www.rfc-editor.org/rfc/rfc9460.html#section-3.2)).

DoH/DoT from the workload is ordinary denied traffic unless its endpoint is separately granted; port 53 is never general egress. DNS names and denial reasons are audit metadata and are redacted from telemetry unless the user opts in.

### Loopback, LAN and metadata

Split three permissions:

1. `net.loopback.connect` to one manager-issued service endpoint/port.
2. `net.local.connect` to an exact private IP/CIDR and port, with a prominent “devices and services on your local network” grant.
3. Public `net.connect` hostname rules.

This adopts Android 17’s separate-local-network model from the team brief; use the Android 17 compatibility definition as the release-checking source ([Android 17 CDD](https://source.android.com/docs/compatibility/17/android-17-cdd)). Until Volt’s tests identify a destination as public or explicitly local, deny it.

Always deny cloud metadata and platform control ranges, even with LAN permission: `169.254.169.254`, link-local IPv4/IPv6, unspecified, multicast, broadcast, CGNAT, documentation/reserved, IPv4-mapped/private, NAT64-private and host gateway aliases. Loopback wildcard is forbidden. mDNS/SSDP discovery is a separate future capability, off in v1. Listening is separate, binds only sandbox loopback by default, and never exposes a port on host LAN.

The existing blanket private-address refusal and checked-address connect are a good floor (`sandboxProxy.ts:29-37,244-298`, `feat/volt-sandbox`); v2 adds an explicit local-network rule path rather than weakening that floor.

### UDP, TLS and denials

UDP defaults to none. v1 supports SOCKS5 UDP ASSOCIATE only for explicit destination domain/IP and port rules, with no fragmentation, rate/byte limits and an association tied to the authenticated broker session. DNS 53, mDNS 5353 and SSDP 1900 are denied. QUIC requires explicit `udp/443`; otherwise clients fall back to TCP. ICMP and arbitrary raw sockets remain unavailable.

Default TLS mode is pass-through: Volt does not install a CA, decrypt content or log payloads. It may parse the clear ClientHello for diagnostics but cannot prevent an allowed CDN origin from domain-fronting an inner HTTP authority; SNI is itself clear without ECH ([RFC 8744](https://www.rfc-editor.org/rfc/rfc8744/)). Therefore wildcard CDN grants are high risk and first-party defaults must name API origins. Optional enterprise `tls: inspect` terminates TLS with an admin-installed Volt CA, validates inner authority and strips hop-by-hop credentials; certificate-pinned clients may break. Never silently enable it. `tls: opaque` for ECH/no-SNI remains allowed only when the CONNECT hostname itself is explicitly granted.

Every refusal emits `{denialId, workloadId, policyRevision, normalized destination, port, transport, reason}` to trusted UI and returns a protocol-appropriate denial (`403`, SOCKS “not allowed”, or silent UDP drop plus event). Reasons include `not-allowed`, `private-address`, `metadata`, `port`, `transport`, `rate-limit`, `unresolvable`, `tls-policy`.

“Allow host” offers exact `host:port` once/session/project/always; never copies an untrusted suggested wildcard. The prompt shows plugin/CLI/MCP identity, parent chat, execution machine, requested destination and whether it is public/LAN/loopback. Approval uses `denialId + expectedRevision`; the server re-derives the rule from the recorded denial, so a client cannot substitute a different host. Revocation closes matching live sockets.

### Agents, MCP and package registries

- Agent CLIs receive provider API origins, their private Host MCP endpoint and no other network. Their subprocesses inherit the same identity.
- Stdio MCP servers get their own identity, not the agent’s. Their effective authority is their own grants intersected with the calling chat’s policy.
- Remote HTTP MCP is reached by Volt through an `mcp-http:<configDigest>` broker identity. Redirects, OAuth endpoints and tool calls are origin-checked; headers come from SecretStorage, not config interpolation.
- Package installs use `package-fetch:<lockDigest>` identity: registry origin plus discovered artifact/CDN origins, read-only isolated cache, checksums/lockfile, byte/time limits. Post-install runs inside the requesting sandbox. Do not run `npx -y` outside containment. For bundled provider adapters, ship pinned signed artifacts instead.

## 6. Migration: features to extensions

Keep feature flags as routing shims until each extraction is complete. For every move: define a versioned API in core, add contract tests, copy implementation into extension, run both behind a flag, make extension default, then delete old `contrib` code in a later PR. Core keeps editor shell, lifecycle/DI, update/signature/grant verification, sandbox/backends, brokers, remote protocol, extension registry and minimal recovery/settings UI.

Order and required API:

1. `volt-visuals` — safe iframe views, artifact/blob store, render contribution.
2. `volt-scratch-board` — canvas document/store and iframe RPC.
3. `volt-playgrounds` — ephemeral HTTP preview lease and safe file handles.
4. `volt-git-graph` — read-only Git graph/query broker.
5. `volt-code-intelligence` — symbol/search/index query broker.
6. `volt-usage` — metering read API and account-labelled provider events.
7. `volt-memory` — namespaced durable key/value capability with explicit cross-chat persistence.
8. `volt-agent-resources` — read-only skills/resources catalogue and picker handles.
9. `volt-browser` — in-app browser automation broker, origin policy and artifact capture.
10. `volt-devices` — simulator/emulator discovery and typed action broker.
11. `volt-computer-use` — separately approved desktop accessibility/capture broker.
12. `volt-pull-requests` — Git-host OAuth secret handle and PR API broker.
13. `volt-commit-review` — staged-diff/commit transaction API; user confirmation token.
14. `volt-automations` — signed trigger registration and constrained invocation API.
15. `volt-remote-devices` — pairing/device/route APIs and replicated state.
16. `volt-claude-accounts` — Claude credential handles only, never raw tokens.
17. `volt-skills-and-plugins` — marketplace/install/signature/permission APIs.
18. `volt-customize` — feature/slot registry and replacement lifecycle; migrate last because it gates the others.

Then providers, all on one `volt.agentProvider` API (model catalogue, account/secret handles, launch recipe, ACP transport, declared API origins, state/cache paths and permission profile), in increasing compatibility risk:

19. `volt-provider-local`; 20. `volt-provider-openrouter`; 21. `volt-provider-muse`; 22. `volt-provider-pi`; 23. `volt-provider-opencode`; 24. `volt-provider-kimi`; 25. `volt-provider-grok`; 26. `volt-provider-fx`; 27. `volt-provider-cursor`; 28. `volt-provider-codex`; 29. `volt-provider-claude`; 30. `volt-provider-antigravity`.

Each provider gets the same API but distinct signed launch/network/state manifest. The current ACP process launch already centralizes through `IVoltStdioService` (`acpProvider.ts:752-759` main) and passes Host MCP at session creation (`acpProvider.ts:789-807` main), making this a practical seam.

Core chat/session/queue protocol remains until plugin RPC can preserve ordering, recovery and mobile compatibility; then orchestration features may become first-party plugins, but protocol framing and authorization stay core.

## 7. Signing and trust

Do not implement “signature = allow all.” A valid signature identifies a publisher; it does not make every future capability safe.

Use an offline root key → rotating release/intermediate key → package signing keys. The release carries a transparency-style signed catalogue of `{id, version, digest, targetSandboxVersion, manifestDigest, silentlyGrantedCapabilities}`. First-party zero-friction applies only when package bytes and manifest exactly match this catalogue and the package is bundled or came through verified update. A capability increase requires catalogue review and is shown in release notes; high-risk desktop/secret/LAN capabilities still get first-use disclosure.

Support revocation lists and minimum-safe versions, short-lived timestamped update metadata, rollback protection, reproducible-build provenance/SBOM and independent signature verification before unpack and before launch. Keep old signed packages disabled after revocation, not silently downgraded.

Third-party publishers use marketplace keys and review, but signatures grant identity only. Unsigned local development requires a persistent “Developer Mode” banner, no silent grants, dedicated dev profile and explicit per-workspace consent. Playground drafts are data/UI in an iframe with no package install or native execution; promoting one to a plugin creates an unsigned dev package and permission review.

## 8. Permissions model and UX

Manifest:

```json
{
  "targetSandboxVersion": 2,
  "contributes": {
    "voltCapabilities": {
      "required": ["workspace.read", "ui.view"],
      "optional": ["workspace.write", "net.connect:api.example.com:443"],
      "runtime": ["net.local.connect", "clipboard.read"]
    }
  }
}
```

Required permissions appear at install/update; optional are toggles; runtime-sensitive operations use one-time/session grants. Never allow undeclared capabilities except a user-created development override. Group low-risk related operations, explain purpose in publisher language plus Volt’s fixed risk text, and prompt only on attempted use. Show a single denial card with Allow once / this session / project / Always / Refuse.

Store grants on the execution environment in an encrypted grant database keyed by user, package ID + digest lineage, workspace identity, capability, scope and target version. Secrets remain in OS/Volt SecretStorage. Sync only grant state/receipts to clients, never secret values. Publisher change, revoked signature, capability widening or lower target invalidates grants.

The Permissions page lists active processes, machine, effective policy, recent denials and sockets; revoke terminates/restarts when live narrowing is impossible. Rate-limit repeated prompts and remember refusal for the turn. First-party catalogue grants appear as “Included with Volt,” still inspectable and revocable where the app can function without them.

## 9. Third-party extensions, MCP and agent CLIs

Existing VS Code extensions without a Volt manifest are “legacy T3”: browser entry preferred; otherwise per-extension Node host with workspace read, private storage and VS Code API only. No home read, env secrets, raw network, child process, native module, clipboard or workspace write until compatibility consent. This breaks language servers, debuggers, Git integrations, telemetry/update checks, credential helpers and extensions assuming shared host globals. Detect attempted operations and offer narrowly derived capabilities; never auto-grant “all.” A temporary compatibility profile may be selected per extension with a critical-risk label.

Volt-native third-party plugins target T2, use brokers, cannot load native code/dynamic Node modules, and get stable capability APIs. Wasm gets explicit imports only.

MCP:

- Config files in a repository are untrusted. Main currently discovers project and user configs and starts/reuses connections (`mcpHost.ts:25-40,110-160` main).
- Stdio: launch each server through `SandboxManager` with `mcp-stdio` principal, private storage/temp, workspace read only if declared, no secrets or network by default. Current raw spawn at `mcpHost.ts:164-179` must be replaced.
- HTTP: no local process to sandbox, so broker every request, restrict origins/redirects, put auth in SecretStorage and warn that remote code receives tool arguments. Current direct `IRequestService` path is `mcpHost.ts:211-267`.
- Tool annotations are hints, not authority. A tool call’s brokered side effects are checked against caller ∩ server policy. Long-lived shared MCP connections must be partitioned by principal/policy; the current config-only cache key is insufficient.

Agent CLIs run as whole process trees. Environment starts empty; expose provider secrets as expiring broker handles where possible. Their own API, Host MCP and optional registries are explicit. The current profile’s home-readable-minus-denies mode is transitional and visibly weaker. Adapters/probes/model-list commands must also route through the manager, not only the main ACP session.

Marketplace review runs static manifest/code/native-binary analysis, dynamic adversarial traces, provenance and update-diff review. It rejects undeclared network, self-updaters, downloaded executable code, obfuscated permission prompts and public-suffix wildcards.

## 10. Brokers instead of raw access

- **Files:** picker returns opaque read/write handles scoped to inode/URI, workspace, expiry and operation. Revalidate symlinks at use.
- **Secrets:** plugin names a logical credential; SecretStorage injects it only into a brokered request or one process launch, never lists all secrets.
- **Terminal/process:** typed command request with cwd/executable policy, isolated PTY and sandbox inheritance. User’s own terminal stays outside; plugin-created terminals do not.
- **Git:** typed status/diff/commit/fetch/push APIs; hooks disabled or separately approved; credentials stay brokered.
- **Clipboard:** explicit foreground read/write, gesture-bound, no background polling.
- **UI:** iframe/webview with unique origin, CSP and typed `postMessage`; no Node integration, same-origin app cookies or raw command IDs.
- **Host MCP:** capability-checking deputy; unknown tools fail closed. `hostToolSandbox.ts:12-35` (`feat/volt-sandbox`) already states the correct deputy rule.

Broker results carry principal, caller session and policy revision through the call chain so a trusted service cannot accidentally act with its own full authority.

## 11. Verification

CI matrix: macOS 13/latest/26 arm64 (+ x64 while available), Linux Ubuntu 22.04/24.04, Debian 12/13 and Fedora latest x64/arm64, Windows minimum supported 24H2/25H2/current with MXC. Run rootless and restricted-user-namespace variants.

Adversarial suite:

- DNS rebinding, mixed public/private answers, trailing dots, IDNA confusables, IPv4-in-IPv6, NAT64, metadata, redirect to LAN, CONNECT port smuggling, malformed SOCKS, UDP spoof/fragment/flood, DoH, QUIC and CDN domain fronting.
- Cross-plugin proxy endpoint/token use; forged principal/session headers; stolen Host MCP URL; caller-chosen session path; replay after revocation.
- DeepSeek cases: forge control RPC, overwrite shell, recursive `/proc` traversal, `yes` disk fill, mirror scan, leftover-answer hunt and unauthenticated loopback API. The Android guidance explicitly warns that localhost is accessible to other apps and recommends authenticated IPC ([source](https://developer.android.com/privacy-and-security/security-tips)).
- Symlink/hardlink/rename races, new `.git`, hooks, Unix/abstract sockets, fork/setsid, resource bombs and crash/restart orphan reaping.
- Malicious package update, key revocation, downgraded target version and changed publisher.
- Remote stale grant revision, stolen paired device, revoked device, CSRF/websocket origin, relay replay and wrong-machine grant.

Property-fuzz strict policy parsing/composition, hostname normalization, SOCKS/HTTP parsers, MCP JSON-RPC and grant CAS. Differential-test policy against backend probes. Fuzz unknown fields and ensure refusal.

Every launch records signed local attestation: package digest, target, effective policy hash/revision, backend binary/version, per-dimension enforced/partial/unsupported, broker identity and confirmation evidence. UI shows it. Telemetry sends only aggregate backend/error counters by default; destinations and paths stay local.

Release gates require all mandatory dimensions enforced, no raw-egress test success, all Host MCP tools classified, and a red-team escape corpus passing on each supported OS.

## 12. Phased roadmap

1. **Merge and harden the existing base.** Files: `src/vs/platform/voltSandbox/**`, `src/vs/platform/voltStdio/**`. Add policy loading, DNS Mach denial, launch-key/grant fix and refusal tests. Acceptance: existing agent CLI starts confirmed on macOS/Linux; Windows refuses; no silent fallback.
2. **Principal and grant service.** Files: new `voltSandbox/common/principal.ts`, `node/sandboxManager.ts`, `node/grantStore.ts`; protocol/storage integration. Acceptance: random manager identity, CAS revisions, revoke/expiry and attestations tested.
3. **NetworkBroker v2 TCP/DNS.** Replace/extend `sandboxProxy.ts`; add HTTP, CONNECT, SOCKS5 CONNECT, canonical DNS/private classes and per-principal routes. Acceptance: network adversarial corpus and zero raw egress on all backends.
4. **Host MCP binding.** Files: `voltHostMcp/**`, `hostToolSandbox.ts`, `hostToolService.ts`, `acpProvider.ts`. Replace caller-selected path identity with session-bound HMAC capability and dedicated route. Acceptance: forged/replayed/cross-session calls fail; all tools classified.
5. **MCP containment.** Files: `mcpHost.ts`, `mcpConfig.ts`, new MCP policy adapter. Sandbox stdio; broker HTTP; partition connection cache. Acceptance: malicious project config cannot read home, spawn bare, access network or affect another chat.
6. **Agent and package bootstrap completeness.** Route probes/adapters/model listing and package fetch through manager; ship pinned adapters. Acceptance: process audit finds no agent-controlled `spawn` outside manager.
7. **Remote grant protocol.** Files: `voltAgentServer/common/protocol.ts`, `serverApi.ts`, `serverSessionHost.ts`, `apps/client-core/**`, mobile/web UI. Acceptance: server is authoritative; owner device can approve exact denial revision; stale/revoked devices fail; desktop/web/phone converge.
8. **Windows MXC backend.** Files: `mxcBackend.ts`, product packaging/signatures and Windows CI. Acceptance: supported builds confirm ProcessContainer/WFP; unsupported builds refuse.
9. **T2 plugin SDK/host.** Worker+SES, iframe RPC, broker SDK, target/version manifest and dev mode. Acceptance: sample plugin has no ambient Node/network/files and survives revoke/restart.
10. **Migrate features 1-9**, one extension per reviewable PR with dual-run parity and rollback flag.
11. **Migrate features 10-18**, preserving recovery/settings core.
12. **Migrate providers 19-30** onto the common provider API and signed policies; remove old implementations only after parity.
13. **T3 per-extension hosts and marketplace enforcement.** Compatibility scanner/profile, install sheet and review pipeline. Acceptance: representative language server/debugger/Git/theme matrix with explicit breakage reporting.
14. **UDP/local network/enterprise TLS and strict VM tier.** Ship separately behind capability/version gates after TCP broker metrics show need.
15. **Relay/cloud runner parity.** Replace raw agent `spawn` at `apps/relay/src/runner/runner.mjs:300-308` (main) with manager/attestation. Relay remains an outbound authenticated transport (`apps/relay/src/server.mjs:11-18,69-80` main), never the policy authority.

Every PR leaves main shippable: old and new implementations coexist behind a kill switch; storage migrations are forward/backward compatible for one release; unsupported enforcement refuses only the newly sandbox-required surface.

## 13. Risks, open questions and requested decisions

### Principal risks

- Seatbelt is deprecated and macOS process-tree termination remains partial.
- Per-extension Node hosts increase memory/startup cost; pool only same-trust first-party processes, never third parties.
- Legacy extension compatibility may drive users toward an unsafe “allow all” button.
- Pass-through TLS cannot stop domain fronting; inspection breaks privacy and pinning.
- MCP semantics do not describe actual side effects; runtime brokers, not annotations, must enforce.
- Grant replication can become a confused-deputy path unless execution host and monotonic revision remain authoritative.
- Android SDK Runtime’s retirement is a warning: a secure plugin model that is difficult to build for will not be adopted. Keep the broker SDK small and compatibility diagnostics actionable.

### Decisions requested from the user

1. Approve **first-party silent reviewed grants, not signature-based allow-all**.
2. Approve **per-plugin/per-extension processes** despite memory cost.
3. Choose whether unsupported Windows versions **refuse** (recommended) or expose a clearly unsafe opt-out.
4. Approve separate **public network / local network / loopback** permissions and permanent metadata denial.
5. Choose pass-through TLS only (recommended default) and whether enterprise inspection is worth building later.
6. Decide who may approve remote grants: **owner-role devices only** (recommended), or individually delegated devices.
7. Decide whether cloud tasks may pause for live network grants through relay, or must fail and be resubmitted with predeclared grants (recommended for v1).
8. Set the legacy VS Code extension compatibility window and annual minimum `targetSandboxVersion`.
9. Confirm that user-opened terminals remain unsandboxed while every plugin/agent/MCP-created process is manager-owned.

### Remote grant and relay specification

The execution machine is always authoritative:

- **Local desktop execution:** Electron main owns manager/grants; renderer requests approval.
- **`volt-server` execution:** server owns manager, broker and grant DB. It already owns agent stdio/Host MCP (`agentServerMain.ts:236-247` main). Desktop, `/code/` and phone receive denial/grant state over authenticated `/ws`.
- **Web workbench:** its paired-device cookie only opens `/code/`; server validates it on every request/socket (`serverWorkbench.ts:76-82,120-170,182-214` main). It never receives broker or Host MCP secrets.
- **Phone:** `client-core` authenticates with a paired token in the WebSocket hello (`apps/client-core/src/connection.ts:272-281` main). An approval RPC includes only `denialId`, choice and expected revision. Server verifies device role, reconstructs exact rule, commits and broadcasts revision.
- **Sync:** grant summaries are a replicated collection/event; clients cache them only for display. Offline clients cannot create effective grants. On reconnect they accept server snapshot/revision. Revoking a paired device invalidates pending approvals.
- **Relay/cloud runner:** relay can carry authenticated task-scoped denial/decision events, but the runner’s manager enforces and attests. No global grant sync and no secret crosses relay. v1 should fail/resubmit with predeclared task grants; later live grants require an owner decision bound to `{taskId, runnerId, workloadId, denialId, revision, expiry}`.

This preserves one rule across desktop, browser and phone: the UI proposes; the machine that runs the code decides and enforces.
