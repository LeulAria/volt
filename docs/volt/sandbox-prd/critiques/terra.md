# Terra: round 2 critique

My lens: can this be built in this order, can it be tested in CI, and does main stay shippable after every PR. I read all five proposals (`grok.md`, `claude-a.md`, `claude-b.md`, `sol.md`, and my own `terra.md`). None was missing.

Code checks for this round were run in this checkout (`volt/is-everything-plugged-into-volt`, which I call "main" below) and on `feat/volt-sandbox` (`sbx`) through `git show` / `git grep`:

| Fact | Where | Used in |
|---|---|---|
| volt-server is started with `ELECTRON_RUN_AS_NODE: '1'` | `main:src/vs/platform/voltAgentServer/node/agentServerLauncher.ts:168` | O5 |
| The server extension host is one plain `cp.fork(bootstrap-fork)` for every extension | `main:src/vs/server/node/extensionHostConnection.ts:277` | O2 |
| `.ssh`, `.git-credentials`, `.config/gh` are credential denies; `.gitconfig` is protected | `sbx:src/vs/platform/voltSandbox/common/sandboxProfiles.ts:21,23,43` | O2 |
| `sandboxLaunchKey` keys on level, network and roots, not on allowed domains | `sbx:src/vs/platform/voltSandbox/common/sandboxPolicy.ts:526-530` | concession to Sol |
| `allowSandboxDomains` has no UI caller, only a pass-through | `sbx:…/voltStdioService.ts:219`, `sbx:…/projectEnvStdio.ts:51` | concession to Sol and Grok |
| The update feed is served from raw.githubusercontent.com and `sha256hash` is an optional field of that same feed | `main:build/volt/release/publish.mjs:9`, `main:src/vs/platform/update/common/voltUpdateFeed.ts:33` | concession to Claude B |
| No release workflow declares an `environment:` | `grep environment: .github/workflows/volt-build.yml volt-stable.yml` returned nothing | concession to Claude B |
| Built-in Volt extensions are manifest-only (`"contributes": {}`), id `volt.<name>` | `main:extensions/volt-git-graph/package.json` | O1 |
| `CLI_AGENT_DEFINITIONS` is a table; `registerProviders` iterates it | `main:…/agents/cliAgents.ts:402`, `main:…/voltRuntimeService.ts:5647` | adoption from Claude A |
| Volt's only Windows CI job today is `windows-2022` (Server) | `main:.github/workflows/volt-build.yml:472` | O3, CI |
| GitHub has a **hosted Windows 11 client** image, `windows-11-arm`, at 10.0.26200 (25H2) | [partner-runner-images: arm-windows-11-image.md](https://github.com/actions/partner-runner-images/blob/main/images/arm-windows-11-image.md), [win11-arm64/20260906.161](https://newreleases.io/project/github/actions/runner-images/release/win11-arm64/20260906.161) | revises my own CI claim |

---

## 1. Objections

Ranked by how much each would cost if it went into the PRD unchanged.

### O1. Grok §6 ("Code moves as a normal extension: `extensions/volt-*/src`") and Sol §6 ("copy implementation into extension"): the wrong build model

**Claim.** Grok: "Code moves as a normal extension: `extensions/volt-*/src`, `activate()` registers the contribution, the old module becomes a re-export." Sol: "copy implementation into extension, run both behind a flag, make extension default."

**Why it fails.** Built-in extensions build with `gulp compile-extensions`, each against its own tsconfig and the `vscode` API. They cannot import `vs/workbench/**`. Volt's features are workbench code:
- the Git Graph tab is an `EditorPane`, and inline blame is an editor decoration contribution;
- the browser is a `<webview>` driven over CDP by an Electron-main service;
- Scratch hosts the agent dock, which must never be disposed (team memory `volt-scratch-board`);
- visuals render as transcript `BlockPart`s.

None of that is reachable from `extensions/*/src` without rewriting it as a webview, or adding a private back door that exposes workbench services to extensions. A back door is worse than leaving the code in `contrib/`.

**Failure scenario.** P8 / Sol step 4 starts with `volt-git-graph`. The PR author finds that `vscode.window.registerWebviewPanelSerializer` is the only way to draw the tab, and rewrites Git Graph as a webview: about 3 engineer-weeks, plus lost keyboard handling and theme parity. Every later feature PR hits the same wall. Phase 2 grows from my estimate of about 33 engineer-weeks to well over 50, and the platform work is blocked behind it.

**Fix (adopted from Claude A §6.4).** First-party in-process code stays in the workbench, split into `contrib/volt<Feature>/`. The `extensions/volt-*` manifest points at it with `voltModule`, which is honoured only for `publisher: volt` built-ins whose hash matches. Code moves into `extensions/volt-*/src` only when it is genuinely T2-shaped: memory, provider probes, usage.

### O2. Grok §2 / P3 ("point the server extension host at `SandboxManager.start` with a T1 policy … no visible change"): it breaks git in `/code/`

**Claim.** Wrapping the existing server extension host is a behaviour-neutral step.

**Why it fails.** `extensionHostConnection.ts:277` is the only extension host for the web workbench (`/code/`) and the phone shell. It runs every extension there: VS Code's built-in `git`, the TypeScript server, formatters and debuggers. Any sandbox policy that keeps the credential floor denies `~/.ssh` and `~/.git-credentials` and protects `~/.gitconfig` (`sbx:sandboxProfiles.ts:21-43`).

Grok's T3 default (network `none`, write `${storage}` only) is stricter still.

**Failure scenario.** A user on `/code/` clicks Sync in the SCM view.
- The `git` extension spawns `git push` inside the wrapped host.
- `ssh` cannot read `id_ed25519`, and the proxy refuses port 22.
- The push fails with "Permission denied (publickey)".

The TypeScript server fails the same way when it writes `tsbuildinfo` outside storage. Every Grok P3 acceptance test passes ("a stock extension activates; confirm logged"), because activation is not where it breaks.

**Fix.** Do not wrap the shared host. Add a **new** host kind next to it: a sandboxed host per publisher, which is my PR 18. Route to it only:
- extensions installed from Open VSX after the PR lands, and
- extensions that opt in with a Volt manifest.

VS Code's built-in extensions stay in the existing unsandboxed host until the git and file brokers exist (merged sequence M-P3). Claude A PR 24 and Claude B PR 10 have the same gap: they say "sandboxed ext host" without saying *which* extensions move into it.

### O3. Claude A §12 (MXC is PR 25 of 28) and Claude B §12 (Windows is PR 14 of 16): Windows sits behind the feature it gates

**Claim.** Both roadmaps open sandboxed third-party hosts (Claude A PR 24, Claude B PR 10) many PRs before any Windows backend exists.

**Why it fails.** The brief's decided first step (§2) is "merge `feat/volt-sandbox`, then add `mxcBackend.ts`". `SandboxManager` fails closed on Windows (`UnsupportedBackend`). So the moment the third-party host is "sandbox required", there are only two choices, and both are bad:
- every Windows volt-server user loses every Open VSX extension;
- or someone adds "run unsandboxed on Windows for now" under release pressure. That is finding F-01 again, the silent fallback Grok §0.3 rightly forbids.

**Failure scenario.** Claude A PR 24 merges. Its acceptance is "top 50 Open VSX extensions smoke-tested", and it is run on the macOS and Linux CI it has. The Windows nightly ships with Prettier, ESLint and GitLens all failing to start in server mode, with "Sandbox unavailable" in the extension host log. No CI row caught it, because `volt-build.yml:472` only builds on `windows-2022`.

**Fix.** Windows is its own track that starts right after the merge (my PR 9, Grok P2, Sol 8). The default flip for third-party hosts (my PR 26) is gated per OS: Windows stays "ask" until the MXC job is green.

### O4. Claude A §13 D3 ("T3 default network = public `*` with logging"): every Open VSX extension can exfiltrate the repo

**Claim.** v1 T3 hosts get workspace read plus unrestricted public egress, logged.

**Why it fails.** That is exactly the GlassWorm attack (Claude B AT-1). Logging records the theft after it has happened. It also contradicts Grok (§9: network `none`) and Sol (§9: no raw network). And it is not even the cheaper option: network is the one grant that can widen live without a restart (Grok §3.6, my §3.7). So a default of `none` plus a one-click "Allow host" on the denial costs almost nothing in compatibility.

**Failure scenario.**
1. A typo-squatted formatter on Open VSX activates `onStartupFinished`.
2. It reads the workspace, which includes a committed `.env.local`. The credential floor covers home directories, not every file inside the repo.
3. It POSTs a tarball to `https://cdn-telemetry.example`.
4. With `public *` this succeeds, and the user sees one log line later.
5. With `none`, the request is refused and the user sees "Blocked cdn-telemetry.example · Allow / No".

**Fix.** T3 default network `none`, plus:
- reviewed per-extension presets signed by Volt (Grok §9, Claude B R5: threshold-signed);
- live per-host grants from the denial card.

Breakage is reported on the extension's page. That is honest, and it is fixable one host at a time.

### O5. Claude B PR 2 / R6 / D7 (Electron fuses, `RunAsNode` off, inspect args off): turns off Volt's own server

**Claim.** PR 2 ships "Electron fuses (inspect args, NODE_OPTIONS)", and D7 asks to turn off `RunAsNode` "if a Node helper can replace it".

**Why it fails.**
- **`RunAsNode`:** volt-server, the default execution host for every chat, is launched as `ELECTRON_RUN_AS_NODE: '1'` (`agentServerLauncher.ts:168`). VS Code's `code` CLI and several forks depend on the same mode. Turning the fuse off means a separately shipped, separately signed Node binary per target (8 release targets, team memory `volt-release-pipeline`), its notarization, and an update path for it. That is a release-engineering project, not a hardening PR.
- **Inspect arguments:** the fuse disables `--inspect` for the binary. That breaks extension development (`--inspect-extensions`) and the team's own way of debugging the agent server at scale (memory `volt-agent-server-scale`: "USR1 inspector logpoints").

**Failure scenario.** PR 2 merges with the fuses flipped in `build/`. The packaged nightly starts, the launcher forks volt-server, and Electron ignores `ELECTRON_RUN_AS_NODE`: it tries to open a second app window and exits. Chats never connect. CI does not catch it, because the unit tests run from `out/`, not the fused binary.

**Fix.**
- Keep Claude B's real point: every Volt listener authenticates, even on loopback (AT-5).
- Apply `--disable-sigusr1` (Node ≥ 22.14, per Claude B) only to packaged volt-server and Node hosts, and only after a test shows the flag is accepted under `RUN_AS_NODE`.
- Leave fuses out of this program. Reopen them only if a sandbox escape actually needs `RunAsNode`.

### O6. Claude B §7.2 / §7.5 / PR 4 / PR 15 (TUF with 2-of-3 offline root, independent rebuilder in a second org, threshold-2 for first-party plugins): a key ceremony this project cannot staff yet

**Claim.** TUF and threshold-2 co-signing must land before any plugin work.

**Why it fails.** The repo has one git author (`LeulAria`). Claude B D4 itself asks "who holds the offline root keys … and who runs the independent rebuilder". Until there are three people, 2-of-3 is one person with three YubiKeys: theatre that also adds a single point of failure.

Threshold-2 for first-party updates protects a channel v1 does not need. Built-ins ship inside the signed app, and Claude A §7.1 verifies them with a build-time hash manifest. Out-of-band first-party plugin updates can wait for the marketplace.

**Failure scenario.** The Claude CLI changes its ACP flags on a Friday. The fix to `volt-provider-claude` is ready, but the rebuilder in the second org is down, or its owner is away. Threshold-2 blocks the plugin update, so the hotfix needs a full app release anyway.

**Fix.** The real, cheap parts first:
- Claude B PR 1: signing secrets move into a protected `release` Environment. Today no workflow uses `environment:`.
- A signed feed with **one pinned Ed25519 key** held in that Environment. The app checks the signature over the feed JSON before trusting `sha256hash`. This closes the verified gap (feed and hash both come from raw.githubusercontent.com) in about a week.
- TUF roles, threshold signing and the rebuilder come with the third-party marketplace (merged M-P6), when there are both people and a channel to protect.

### O7. Claude B §12 PR 11 ("migrate low-risk plugins to T2: visuals, scratch, customize, memory"): three of the four cannot be T2

**Claim.** These four are the low-risk first T2 migrations.

**Why it fails.** A T2 plugin is an SES worker in a process with no fs, net or spawn, with UI through declarative trees or iframes (Claude A §2.1, brief §2). Only memory fits that.
- **Customize** restyles the whole workbench (look tokens, slots, the Playground). It also gates every other feature through `IVoltFeatureService`, which is why Sol puts it last.
- **Scratch** owns the agent dock and its elbow connectors inside the workbench.
- **Visuals** are transcript `BlockPart`s, and the diagram zoom viewer depends on them.

"Low risk" here means low security risk. It is the highest build risk.

**Failure scenario.** PR 11 starts with customize. Its slots API hands workbench DOM regions to the extension. In T2 that becomes an iframe per slot, which is the 100-iframe cost Claude A §2.5 warns about, and look tokens no longer apply to native lists. The PR stalls, and Claude B PRs 12–16 are blocked behind it, because PR 11 also carries "enforce first-party ceilings".

**Fix.**
- Memory goes first in T2: Claude A W4a, my Wave A.
- Customize, scratch, visuals, browser, devices and computer-use stay in-process behind the facade and import lint (my "T0p fence-only", Claude A T1). They are user decision D5.
- Enforcing ceilings is a separate PR that does not wait on any T2 migration.

### O8. Claude A §6.4 W4 ("a T2 plugin that fails to start falls back to its T1 build of the same code"): a silent fallback with two build pipelines

**Claim.** First-party T2 plugins compile twice, and when the sandboxed host fails, the in-process T1 build runs instead.

**Why it fails.**
1. **Security.** This is the F-01 pattern again: a failed `confirm` runs the code with more authority. Grok §0.3 and Sol §3 ("never starts bare") both forbid it.
2. **Build.** The same source would compile for two module systems and two API bindings: the workbench facade, and the `volt` object endowed in SES. Every API change then has two implementations to keep in step. Parity drift between them is a class of bug CI must test on every PR forever.

**Failure scenario.** An attacker who can make the plugin host fail to confirm (for example, by filling `$TMPDIR` so bwrap's ready marker cannot be written) gets memory's code running in the workbench with the in-process facade. The facade is T1's "only containment" (Claude A §2.3), and it guards against bugs, not malice. The fallback turns a denial of service into a privilege gain.

**Fix.** Fail closed: "Memory is unavailable: sandbox failed to start · Details". Keep the `contrib/` code reachable only through the **feature flag** for one release, as a user decision ("turn the extension off"). It must never be an automatic fallback.

### O9. Sol §2 (T1 = "same T2/T3 isolation as third party", T2 = "dedicated worker per plugin") and Sol §12 ordering

**Claims and failures.**
1. **"First-party must not mean in-process."** Applied to computer use, this loses TCC attribution: the helper must be the responsible process, per team memory `volt-dictation-and-tab-pitfalls`. Applied to the browser `<webview>` + CDP and to simulator streaming, it is the O1 rewrite again. Grok §2 and Claude A both keep computer use in T0/T1, for the reason Grok gives: "sandboxing computer use into a container that cannot send input makes the feature false."
2. **T2's isolation unit is a worker, with no process boundary stated.** DeepSeek's second hole (brief §4) was `run_code` on a worker thread outside the sandbox. A thread shares the host process's namespaces and Seatbelt profile. Grok §2 and Claude A §2.2 both make T2 a *process* (per publisher), with workers inside only for one signer. Sol's table has to say this.
3. **PR 3's acceptance "zero raw egress on all backends" comes before PR 8 (MXC).** On Windows, the unsupported backend refuses everything, so the test passes because nothing ran. That test proves nothing for Windows.
4. **Providers migrate last (19–30).** They are the cheapest migration (Claude A W1: `CLI_AGENT_DEFINITIONS` is already a table) and the one with the most process spawning. Doing them last delays the only migration that removes code from `voltRuntimeService.ts` early.
5. **"Copy implementation into extension, run both behind a flag" for 30 items.** That puts two copies of most of Volt in main for months, with every bug fixed twice.

**Failure scenario for item 2.** A T2 plugin escapes SES through a V8 bug (Claude A §13 R2 calls SES on worker_threads in Electron's Node "fewer production miles"). In a worker-per-plugin, shared-process design, it reads every other plugin's RPC port and impersonates them, because identity is bound to the channel and the channels live in the same address space.

**Fix.** T2 = an OS-sandboxed process per publisher, SES workers inside it. Sol's route-bound principal (§5) then attaches to the *process's* channel.

### O10. Claude B §7.3 ceiling table ("requested ⊄ ceiling → the extra capabilities are dropped, the plugin loads with the rest"): fail-safe at the wrong time

**Claim.** The core holds a per-plugin ceiling table generated from the manifests at core build time. At load, anything over the ceiling is dropped.

**Why it fails.** For built-ins, a ceiling generated from the manifest at build time *equals* the manifest. The two-key rule only means something for out-of-band plugin updates, which O6 defers. What remains is the load-time drop. It turns a manifest/ceiling mismatch into a feature that half-works in production and logs an error nobody reads.

**Failure scenario.** A PR adds `net.connect:api.openrouter.ai` to `volt-provider-openrouter` but forgets the ceiling file. CI is green and the release ships. Model listing silently returns nothing for every OpenRouter user, and the bug report says "OpenRouter models missing".

**Fix.** Keep the ceiling table and CODEOWNERS on it (Claude A §7.1 point 3 says the same). Enforce `manifest ⊆ ceiling` as a **build/CI failure**. The load-time check stays as a tamper backstop, which should never fire in a correct build.

---

## 2. Concessions and adoptions

**From Grok:**
- No silent fallback anywhere (O8 relies on it).
- The Windows chooser: MXC for PE images, sandbox-user only for MSYS2/Cygwin or below the floor, refuse otherwise.
- The **E12 `env.set` hole is a P1 fix, not a v2 nicety.** Untrusted policy can set `VSCODE_EXTHOST_IPC_HOOK` and `NODE_CHANNEL_FD` (`sbx:sandboxComposition.ts:226-229`).
- The scripted red-team list (§11, eight items) becomes the CI suite's backbone.
- **"Do not move feature code into today's unsandboxed host."** This corrects my own PR 13, which started the first-party out-of-process host "unsandboxed → audit". I now gate any out-of-process first-party move on `start()` existing (merged M-P2 after C5). Moving earlier would put features in a host with Volt's full rights plus every co-hosted extension.

**From Claude A:**
- The facade + `voltModule` pointer + per-feature `contrib/` folders (O1 fix).
- Providers as data first, via `contributes.voltAgents` with a deep-equal parity test against `CLI_AGENT_DEFINITIONS`. This is the cheapest migration that changes real code.
- Tool *schemas* come from the manifest, so lazy activation does not shrink an agent's tool list (§6.6).
- The **server-side enablement mirror** as an explicit prerequisite. Without it, a feature disabled in the window still runs its tools on volt-server.
- Declarative UI before iframes.
- Caller identity bound to the channel, never to a payload field.
- Declarative provider probes, which keep T2 spawn-free (§13 open question; I take the "declarative" answer).

**From Claude B:**
- Release secrets into a protected Environment as the first PR. It is independent and cheap, and the gap is verified.
- Authentication on every listener, loopback included (AT-5).
- **Attenuation:** a plugin acting for a chat acts with `plugin ∩ chat` rights (AT-6). This matters more than signing, and I had it only implicitly.
- **Report mode with a "zero would-be denials over one release" gate** before enforce. This replaces my vaguer "when telemetry is clean".
- The critical class can never be granted to third parties through a prompt.
- The reserved `volt.*` namespace and the built-in hash check.
- Claiming the `volt` namespace on Open VSX.

**From Sol:**
- **The launch-key bug** (verified: `sandboxLaunchKey` omits allowed domains, `sbx:sandboxPolicy.ts:530`). It goes into C2 with the live-grant wiring.
- Principals with CAS revisions on grants.
- Per-principal broker **routes**, not headers, for network identity.
- **MCP containment early.** Stdio servers are raw-spawned today (`main:mcpHost.ts:164-179`, per Sol). That is a live exposure, so it moves ahead of the plugin platform.
- The execution host is the only grant authority. Phones and the web propose; they never decide.
- Cloud tasks fail and resubmit with predeclared grants in v1.
- A separate local-network permission, and a permanent metadata deny.

**Revisions to my own proposal:**
- **CI.** My §11.4 said MXC "probably needs a self-hosted Windows 11 runner". Wrong in part. GitHub ships a hosted **`windows-11-arm`** client image at 10.0.26200 (25H2) (sources in the fact table above). So the MXC suite can be a hosted, **required** check on arm64 as soon as the image's servicing build is at or above the MXC floor in brief §4. The last published image I found was 26200.9168. Whether 26200.x and 26100.x builds compare 1:1 against the 26100.9278 floor is a **guess** to confirm in C4. x64 Windows 11 still needs a self-hosted runner.
- **D6 shrinks** from "fund a self-hosted gate" to "fund a self-hosted x64 runner, arm64 is hosted".
- **Sequence.** My PR 13 is withdrawn in its old form (see Grok above).

---

## 3. Revised position on every disputed decision

| # | Decision | Positions (round 1) | My revised position | Why |
|---|---|---|---|---|
| 1 | Order: sandbox core vs migration | Brief/user: migrate then sandbox. Grok: sandbox host before moving code. Claude A: facade first, sandbox mid. Claude B: channel first. Sol: core first. Terra: core first, migration in parallel | **Three parallel tracks after the merge:** S (supply-chain hardening), C (core sandbox), M (facade + in-process migration). Out-of-process plugin moves wait for C5 `start()` | The user's order holds where it matters: nothing is sandboxed before it is a plugin, and nothing moves out of process before the host can be sandboxed |
| 2 | Merge `feat/volt-sandbox` first | All agree (ask the user) | Agree, C1. **Ask the user before merging** | Brief §2 |
| 3 | Windows backend timing | Grok/Sol/Terra early; Claude A/B last | **Early, its own track (C4), right after C1** | O3 |
| 4 | Windows below the MXC floor | Grok: sandbox-user if installed, else refuse. Claude A: first-party T2 `partial`. Claude B/Sol/Terra: refuse + explicit opt-out | **Refuse + explicit, recorded "Run outside sandbox" per chat.** sandbox-user stays conditional (merged M-P8) | `partial` for a no-fs/no-net T2 host means SES alone, which is not a boundary |
| 5 | First-party trust | All five reject literal allow-all | **Declared capabilities, auto-granted by signature, enforced; report mode → enforce after zero would-be denials for one release** | Unanimous; Claude B's gate is the testable form |
| 6 | Ceiling enforcement point | Claude B: drop at load. Claude A: CODEOWNERS | **CI fails if manifest ⊄ ceiling; load-time check only as a tamper backstop** | O10 |
| 7 | Where first-party in-process code lives | Grok/Sol: `extensions/volt-*/src`. Claude A/Terra: `contrib/` + pointer | **`contrib/volt<Feature>/` + `voltModule`, built-ins only; `extensions/*/src` only for T2-shaped code** | O1 |
| 8 | Deep-UI features out of process? | Sol yes; Claude B some (scratch, customize, visuals); Grok/Claude A/Terra no | **No: browser, scratch, visuals, devices, computer-use, customize stay in-process behind the facade** (user decision D5) | O1, O7, TCC attribution |
| 9 | T2 isolation unit | Sol: worker per plugin. Claude A/Grok: process (per publisher / own) | **OS-sandboxed process per publisher; SES worker per plugin inside it; never a thread in another host** | O9 item 2 |
| 10 | T3 host granularity | Grok: shared per trust label, per-extension later. Claude A/Terra: per publisher. Sol: per extension | **Per publisher, cap 8, then a shared restricted pool; any extension granted workspace write gets a private host** | Memory cost (Sol accepts it; I measure it in M-P1) vs the cross-extension risk Grok admits |
| 11 | T3 default network | Claude A: public `*`. Grok/Sol/Terra: none | **`none`, plus signed presets and live per-host grants** | O4 |
| 12 | T3 default filesystem | Grok: read workspace, write storage. Sol: read only after consent | **Read workspace, write `${storage}`; workspace write through the broker or as a labelled `partial` with the hook guard (Grok E14)** | Grok's reasoning; Sol's consent-before-read breaks every language server for little gain |
| 13 | Which extensions enter the sandboxed server host | Unspecified by all | **New host kind; only Open VSX installs and Volt-manifest extensions. VS Code built-ins stay in the existing host until the brokers land** | O2 |
| 14 | Desktop local extension host | Grok: `SandboxManager.start` from main. Claude A: refuse when the server is off. Terra: route to the local server | **Route to the local volt-server's sandboxed hosts (M-P5). With the agent server off, third-party Node extensions are refused** | One implementation; avoids `utilityProcess` |
| 15 | Fallback when a sandbox fails | Claude A: T1 fallback for first-party. Others: none | **None. Fail closed with a visible reason** | O8 |
| 16 | Live grants | All: network live; filesystem via broker or relaunch | Agree. **Network grants via CAS on the principal; filesystem widening = broker handle or restart** | Seatbelt and bwrap fix mounts at launch |
| 17 | Network identity | Grok: `Proxy-Authorization` = host tag. Sol: route per principal | **Sol's route per principal; the token only authenticates setup** | A tag in a header can be replayed by a co-located process |
| 18 | UDP / SOCKS5 / TLS inspection | Sol: SOCKS5 + UDP ASSOCIATE + enterprise TLS. Grok: no UDP, no inspection | **v1: HTTP + CONNECT + SOCKS5 CONNECT (TCP). No UDP, no TLS inspection. UDP and inspection are later, gated (M-P9)** | Scope; each needs its own adversarial corpus |
| 19 | Local network permission | Grok/Sol: separate. Others implicit | **Separate `net.local.connect`, off by default; metadata always denied** | Unanimous where stated |
| 20 | Signing infrastructure in v1 | Claude B: full TUF + threshold + rebuilder first. Grok: desktop key, pinned. Claude A: KMS plugin key | **Protected Environment now (S1); single pinned Ed25519 feed key (S3); built-in hash manifest (M-P6a); TUF + threshold with the marketplace** | O6 |
| 21 | Out-of-band first-party plugin updates | Claude B/Sol: yes, signed. Claude A: built-ins ride the app | **Not in v1. Built-ins ship with the app** | Removes the channel the threshold scheme protects |
| 22 | Electron fuses / SIGUSR1 | Claude B: fuses + `--disable-sigusr1` | **No fuse changes. `--disable-sigusr1` on packaged volt-server and Node hosts only, after a test under `RUN_AS_NODE`** | O5 |
| 23 | Listener authentication | Claude B | **Adopt: every listener authenticates, loopback included (S2)** | AT-5 / CVE-2026-82533 |
| 24 | Attenuation (`plugin ∩ chat`) | Claude B, Sol | **Adopt in policy v2 compile (C6) and the broker contract** | Confused deputy |
| 25 | MCP containment timing | Sol early; Claude B PR 12; Terra PR 8 | **Early: C7, before any plugin host** | Raw spawn today |
| 26 | Remote grant authority | Sol | **Adopt: the execution host decides; clients send `denialId + revision`** | Phone/web cannot be trusted to name the rule |
| 27 | Kill switch | Terra | **Keep: a remote switch only moves enforce → ask, never to off** | It is otherwise a remote "disable sandbox" |
| 28 | Windows CI | Claude B: self-hosted. Terra: self-hosted gate. Grok: hosted Win11 | **Hosted `windows-11-arm` as a required MXC job once its build clears the floor; self-hosted x64 nightly; hosted `windows-2022` asserts refusal** | New fact (hosted 25H2 image) |
| 29 | Provider migration shape | Claude A: data + T2 hooks with `process.exec`. Grok: `volt.exec` | **Data (`contributes.voltAgents`) + declarative probes; launches go through core `SandboxManager`; T2 never gets `process.exec`** | Keeps T2 spawn-free |
| 30 | Dev / unsigned / Playground | Broad agreement | **Claude B §7.6: packaged builds never honour a dev flag; developer mode lives in user data; drafts install as publisher `local`, third-party tier** | Agreement; Claude B's version is the most testable |

---

## 4. Merged PR sequence

Three tracks start once C1 is merged. **Every PR keeps main shippable:** the new path is off or in report mode until its gate passes, and the old path stays until a later PR removes it. The effort figures are **guesses** in engineer-weeks (ew), carried over from my round-1 numbers where the scope is the same.

### Track S: supply chain and listeners (independent; can start before C1)

| PR | Scope (source) | Gate / acceptance | Why main stays shippable | ew |
|---|---|---|---|---|
| S1 | Signing secrets into a protected `release` Environment; split build from sign; artifact attestations (Claude B PR 1) | A workflow on a throwaway branch cannot read the signing secrets; `gh attestation verify` passes | CI-only change | 0.5 |
| S2 | Inventory of every Volt listener; token authentication on each; `--disable-sigusr1` on packaged volt-server (Claude B PR 2, without the fuses) | AT-5 matrix on mac/linux: no token, a stolen-looking token and a forged `Host` all fail; the server still starts under `RUN_AS_NODE` | The token is minted by the launcher; clients already hold pairing tokens | 1.5 |
| S3 | Ed25519 signature over the update feed; public key pinned in the app; nightly key ≠ stable key (O6) | A feed with a valid sha256 and no signature is refused; a nightly signature on the stable channel is refused | The old clients' path stays readable for one release | 1 |

### Track C: sandbox core (agents, MCP, Windows)

| PR | Scope (source) | Gate / acceptance | Why main stays shippable | ew |
|---|---|---|---|---|
| C1 | **Merge `feat/volt-sandbox`** (ask the user). Replaces main's older `voltSandbox` copy | Branch suite green on macOS + Linux; Windows chats asking for a sandbox get a refusal | Behind the existing chat sandbox setting | 1 |
| C2 | E12 reserve list for `env.set`; launch key includes the principal and grants; wire "Allow host" to a live grant (Grok P1, Sol, Terra PR 2) | E12 test; allowing a host reaches a running agent without restart; a reused session does not inherit another chat's domains | Fixes only | 1.5 |
| C3 | Close OS gaps (DNS mach in `none`, etc.) + spawn audit gate: no agent-controlled `spawn` outside the manager (Terra PR 4/6, Sol 6) | Spawn audit lint in CI; adversarial additions green | Lint starts as a warning, then an error | 1.5 |
| C4 | **`mxcBackend.ts` + Windows chooser**; `wxc-exec` pinned by hash and its Authenticode checked; refusal below the floor (Grok P2, Terra PR 9) | Grok §4.1 cases 1, 2, 5, 6, 7; Git Bash case is a clear refusal, not a crash | Windows already refuses; this only adds a working path | 4 |
| C5 | `start()` for long-lived hosts + `IVoltSandboxService` + attestation line + status UI (Grok P3 API, Terra PR 5) | A test host confirms on all three OSes; `NODE_CHANNEL_FD` round-trips; E2 (IPC pipe path) fails from inside | No caller is switched yet | 2.5 |
| C6 | Policy v2 + `compilePolicy` with attenuation + principal/CAS grant store (Terra PR 7, Sol 2, Claude B PR 6) | Property tests: compile ⊆ caller; untrusted layers never widen; floor in every output; CAS rejects stale revisions | v1 documents still parse as generation 0 | 3 |
| C7 | Host MCP session-bound capability + **stdio MCP servers under `SandboxManager`**, cache partitioned by principal (Sol 4, 5) | A malicious project `.mcp.json` cannot read home, spawn bare or reach the network | Repo MCP servers get a trust prompt first; user config keeps working | 3 |
| C8 | NetworkBroker v2: per-principal routes, HTTP + CONNECT + SOCKS5 CONNECT, `net.local.connect`, metadata always denied (Sol 3, TCP only) | Sol's network corpus (rebinding, IDNA, NAT64, CONNECT smuggling) on mac/linux/Windows-arm | The proxy stays the default until the corpus is green | 3 |

### Track M: facade and in-process migration (starts after C1)

| PR | Scope (source) | Gate / acceptance | Why main stays shippable | ew |
|---|---|---|---|---|
| M1 | Facade `IVoltPluginContext` + `IVoltCapabilityService` (report mode) + contribution points + manifests filled + **server enablement mirror** (Claude A W0, §6.6) | Catalog parity test; disabling a feature in the window also stops its server tools | Report mode cannot block | 3 |
| M2 | Providers as data: `contributes.voltAgents`; `registerProviders` reads contributions; declarative probes (Claude A W1) | Deep-equal parity test against `CLI_AGENT_DEFINITIONS`; all 12 providers detected; live check with Grok 4.7 | The same objects are built from the same data | 2 |
| M3 | Per-feature `contrib/` splits + `voltModule` + import lint, one feature per PR: git-graph, PR / commit-review split, usage, code-intelligence, claude-accounts, remote-devices page, automations, skills, agent-resources (Claude A W2/W3, Terra PR 11/15) | Lint clean per feature; the feature runs with only its manifest grants in report mode | One PR per feature, each revertible | ~12 |
| M4 | Fence-only for browser, scratch, visuals, devices, computer-use, customize (Terra PR 16, user decision D5) | Lint; lazy load; no behaviour change | In-process code, unchanged | 3 |
| M5 | Ceiling table + **CI check that manifest ⊆ ceiling** + enforce per feature after **zero would-be denials over one release** (Claude B PR 7, O10) | CI fails on a deliberately over-wide manifest; enforce flips feature by feature | Per-feature flip; report data decides | 1.5 |

### Track P: plugin hosts (needs C5 + C6; P1 also needs C8)

| PR | Scope (source) | Gate / acceptance | Why main stays shippable | ew |
|---|---|---|---|---|
| P1 | **New** sandboxed T3 host kind per publisher on volt-server, `exthost-default` (network `none`, write storage), env allowlist. **Only Open VSX installs and Volt-manifest extensions use it** (O2, Terra PR 18) | Top 50 Open VSX smoke list with a breakage report; AT-1 and AT-10; Git sync from `/code/` still works (built-in `git` is untouched) | Opt-in per install source; built-ins stay in the old host | 4 |
| P2 | T2 host process (per publisher) + SES + RPC on fd 3 + `MainThreadVolt*` for tools/storage/context; **memory is the first T2 plugin, failing closed** (Claude A PR 5–7, O8) | Identity-forging test; simulated SES escape hits OS denials; memory tools work from desktop, web and phone | The `contrib/` memory stays reachable only through the feature flag for one release | 4 |
| P3 | Brokers: files (fd + hook guard E14), secrets (handles), git (`core.hooksPath` empty), terminals (Grok §10, Terra PR 20) | Red-team 6 (planted hook does not run); TOCTOU tests | Brokers are new APIs; old callers move one by one | 4 |
| P4 | Permission UX: install sheet, denial card, Access page, prompt budget, critical class never prompt-grantable (Claude B §8, Sol §8, Terra PR 22) | AT-12 usability check; grants survive restart; a signer change drops grants | Shows read-only rows for built-ins first | 3 |
| P5 | Desktop routes third-party extensions to the local server's sandboxed hosts (Terra PR 19) | Same smoke list from desktop; with the agent server off, the refusal is clear | Built-ins unaffected | 2 |
| P6 | (a) Reserved `volt.*` namespace + built-in hash manifest; (b) third-party signing + revocation feed; (c) TUF roles and threshold signing **when the marketplace opens** (Claude B PR 5/15, Claude A §7.1, O6) | AT-4, AT-13; (c) AT-3 rollback cases | (a) only checks what the app already ships | 2 + 3 |
| P7 | **Default flip per OS:** third-party hosts are sandbox-required on macOS/Linux; Windows only once the C4 job is a required, green check (O3, Terra PR 26) | Release gate: Sol §11 gates on that OS | Per-OS switch; a remote switch can only go enforce → ask | 1 |
| P8 | *Conditional:* sandbox-user backend for MSYS2 and below-floor Windows (Grok P4, Terra PR 25) | Grok §4.1 cases 3 and 4 | Opt-in elevated install | 4 |
| P9 | *Later, gated:* UDP / SOCKS UDP, enterprise TLS inspection, VM tier, relay runner parity (Sol 14–15) | Their own adversarial corpora | Behind capability/version gates | — |

### Dependency graph

```
S1, S2, S3          (no dependencies; start now)
C1 → C2 → C3
C1 → C4             (Windows track, parallel)
C2 → C5 → C6 → C7
          C6 → C8
C1 → M1 → M2
     M1 → M3 → M5
     M1 → M4
C5 + C6 → P2 → P3 → P4
C5 + C6 + C8 → P1 → P5
M1 → P6a;  P4 → P6b → P6c
P1 + P4 + C4(green) → P7
```

### CI rows

| Runner | Runs | When |
|---|---|---|
| `ubuntu-24.04` x64 + arm, plus the Docker rig (Debian, Fedora/SELinux, Ubuntu 22.04, Arch) | Full suite, seccomp, namespaces | Every PR touching `voltSandbox`, brokers, listeners, the loader or grants |
| `macos-15` + newest | Full suite including Seatbelt | Same |
| **`windows-11-arm` (hosted, 25H2)** | MXC suite (C4), red-team items 1, 5, 7, 8 | Required once the image's build clears the MXC floor (**guess** to confirm in C4) |
| Self-hosted Windows 11 x64 | MXC suite x64 | Nightly; required for releases |
| `windows-2022` (existing, `volt-build.yml:472`) | Refusal suite: nothing launches "sandboxed" without a backend | Every PR above |
| Packaged-binary smoke (all OSes) | volt-server starts under `RUN_AS_NODE`; listener AT-5 matrix | Release workflows (catches what O5 describes) |

**Total, guess:**
- Tracks S + C: about 24 ew.
- Track M: about 21 ew.
- Track P: about 31 ew without P8/P9.

That is close to my round-1 ~66 ew. Track M is cheaper than my round 1 because nothing deep is rewritten. Track P is dearer because brokers and the permission UX come earlier.
