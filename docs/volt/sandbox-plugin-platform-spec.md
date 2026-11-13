# Volt sandbox and plugin platform: master specification

Status: revision 2, draft for decision. Date: 2026-11-08. Open decisions are in [Part N](#part-n-open-decisions).

Revision 1 (the merged five-model spec) is kept at [`sandbox-prd/spec-v1.md`](sandbox-prd/spec-v1.md). This revision re-audits it against the code on both branches, primary OS documentation and live tests on this machine. It changes several of its decisions; [Part O](#part-o-decision-log) lists every change and the reason.

**Scope:**
- Execution and permission core: principals, the policy authority, `SandboxManager`, OS backends, brokers.
- Moving every Volt feature behind a plugin boundary, then running plugins inside the sandbox with permissions.
- First-party trust and signing ("Volt's own plugins get everything they need, without prompts").
- How VS Code extensions, Volt-native plugins, MCP servers, agent CLIs and native helpers are isolated.

The look and layout engine stays in [`customize.md`](customize.md).

## How to read the evidence

Every technical claim carries one of these tags:

| Tag | Meaning |
|---|---|
| **[code]** | Read in the code during this revision. `main:` is the main branch at `3d2540c` (Volt 0.0.6, VS Code 1.105.1, Electron 37.6.0, Node 22.19.0). `sbx:` is the unmerged branch `feat/volt-sandbox` at `ee23e23`. Paths are relative to the repo root. |
| **[test]** | Reproduced on this machine (Apple M4 Max, macOS 26.6 build 25G72) during this revision. |
| **[src]** | Stated by a primary source: vendor docs, a man page, a source repo, an advisory. Listed in [Part P](#part-p-sources). |
| **[report]** | A field report in an issue tracker: evidence of what someone observed, not a vendor guarantee. |
| **[proposed]** | A design decision of this spec, not yet built. |
| **[assumption]** | Believed but not verified. Each one names how to verify it. |
| **[open]** | Unresolved. Each one is either an open decision (Part N) or a named trial in the roadmap. |

Line numbers drift. The roadmap's first PR re-checks every `[code]` citation it depends on.

## Contents

- [Part A. Summary](#part-a-summary)
- [Part B. Architectural findings report](#part-b-architectural-findings-report)
- [Part C. Master architecture](#part-c-master-architecture)
- [Part D. Threat model](#part-d-threat-model)
- [Part E. Security invariant catalog](#part-e-security-invariant-catalog)
- [Part F. SandboxManager and the execution core](#part-f-sandboxmanager-and-the-execution-core)
- [Part G. Permission and capability specification](#part-g-permission-and-capability-specification)
- [Part H. Plugin runtime and lifecycle](#part-h-plugin-runtime-and-lifecycle)
- [Part I. Broker security specification](#part-i-broker-security-specification)
- [Part J. Platform enforcement matrices](#part-j-platform-enforcement-matrices)
- [Part K. Adversarial verification plan](#part-k-adversarial-verification-plan)
- [Part L. Performance benchmarking plan](#part-l-performance-benchmarking-plan)
- [Part M. Implementation roadmap](#part-m-implementation-roadmap)
- [Part N. Open decisions](#part-n-open-decisions)
- [Part O. Decision log](#part-o-decision-log)
- [Part P. Sources](#part-p-sources)
- [Appendix 1. Behaviour changes for existing users](#appendix-1-behaviour-changes-for-existing-users)

---

## Part A. Summary

### A.1 What the audit found

Revision 1 was directionally right: an OS sandbox as the real wall, one host per extension, signed ceilings instead of "allow all", parallel tracks. But it was built on three assumptions that don't hold.

1. **"Today's exposure is the unsandboxed extension host."** It is much wider. `main` has two Critical holes that need no plugin platform to exploit:
   - any local process can mint an **owner** token for volt-server and run commands (B-01);
   - a cloned repo's MCP config is started unsandboxed, without a trust check, when the composer gets focus (B-02).
2. **"The sandbox branch is ready to merge."** It is close, but has two Critical escapes and several High ones:
   - planting `.git/commondir` makes Volt's own host-side `git status` run agent-written config (B-03);
   - Volt runs the project's test command unsandboxed after a sandboxed turn (B-04);
   - agent CLI state files stay writable, so a sandboxed chat plants an MCP server that runs unsandboxed later (B-05);
   - switching a sandboxed chat to Codex drops Volt's wrap (B-10).
3. **"The OS sandbox gives the same guarantees on all three systems."** It doesn't:
   - On macOS, every sandboxed process can read the environment of the user's other processes (B-12, tested), sandboxed children inherit Volt's TCC grants (B-13, tested), and there is no tree containment.
   - On Windows, MXC has no resource limits, can't nest inside a job of our own, has a DNS side channel and breaks Git Bash.
   - On Linux, bubblewrap below 0.12 has a high-severity setup escape (CVE-2026-87766) and Ubuntu 24.04 ships 0.9.0.

### A.2 What this revision changes

| Area | Revision 1 | Revision 2 | Why |
|---|---|---|---|
| First step | Merge `feat/volt-sandbox`, then harden | **Phase 0: fix the live holes on `main` first** (owner token, repo MCP, command exposure, helper integrity, feed signature). **Phase 1: fix the branch's escapes before merging it** | Users are exposed today, on code paths unrelated to the sandbox |
| Central abstraction | `SandboxManager` does policy, launch, grants and network | **Split into five parts:** Principal Registry, Policy Authority (the one permission decision function), Policy Compiler, Execution Supervisor (`SandboxManager` keeps this role), Attestor. Brokers call the Authority | One decision function is testable and keeps launch, broker and UI decisions consistent; launch code doesn't decide permissions |
| Sandbox confirmation | Ready line written inside the sandbox | **External attestation:** the parent verifies the child from outside (macOS `sandbox_check(pid)`, Linux `/proc/<pid>/status` + namespace inodes, Windows token and job queries). The workload starts only after the parent sends a go byte | Evidence from inside can't prove itself. `sandbox_check` works from the parent on macOS 26.6 [test] |
| First-party ceilings | "A bug in a first-party plugin reaches only its ceiling" | **Ceilings bind only out-of-process code.** In-process first-party UI is labelled trusted core, and its blast radius is the whole renderer | A lint is not a boundary; revision 1 overclaimed |
| Plugin pooling | "Low-only plugins with identical capabilities may share a process" | **Never across subject identities.** Only instances of the same package, digest, signer and policy may share | A shared process is a shared identity |
| Cross-plugin calls | Effective rights = plugin ∩ caller | Plus an **egress-compatibility rule:** a chat may pass data to a plugin only if the plugin can't send it anywhere the chat couldn't, unless the user approves that flow | Attenuating the broker call doesn't stop the plugin's own network grant |
| File grants | Pass an fd into the sandbox | **Mediated I/O for revocable grants;** fd passing only for one-shot reads, with stated non-revocability | A passed fd can't be revoked |
| Windows | MXC + job object active-process limit for "no spawn" | MXC only. Resource limits by polling. "No spawn" is **unsupported on Windows** until proven. DNS leak and loopback breadth documented. **Git Bash refused** | MXC has no limit fields and UI-limited jobs can't nest [src] |
| Linux | bubblewrap ≥ 0.8 | **bubblewrap ≥ 0.12** by default (CVE-2026-87766), probe-verified. Add Landlock as a second layer and per-sandbox cgroups via `systemd-run --user` | Advisory GHSA-pxhw-h44j-8pfx [src] |
| macOS | Seatbelt | Seatbelt + **TCC responsibility disclaim** + `/dev/ttys*` removed + mDNSResponder denied + process tracking. **Secrets never in env or argv** of any process | B-12, B-13 |
| Plugin hosts | `utilityProcess` excluded for T3; Node hosts under the sandbox | Same, with a stated reason: Electron 37's `utilityProcess` has no sandbox and ignores `--permission` and `--disable-sigusr1` [test] | Measured, not assumed |

### A.3 The model in one page

```mermaid
flowchart TB
  subgraph Clients[Clients: desktop workbench, web /code/, phone]
    UI[Volt UI: proposes, never decides]
  end
  subgraph EH[Execution host: Electron main or volt-server]
    PR[Principal Registry<br/>mints identities, binds channels]
    PA[Policy Authority<br/>evaluate&#40;principal, capability, target, caller chain&#41;]
    GS[(Grant store + epochs<br/>~/.volt/trust, denied to every sandbox)]
    PC[Policy Compiler<br/>pure, immutable launch policy + hash]
    SV[Execution Supervisor = SandboxManager<br/>spawn, attest, account, revoke, kill]
    AT[Attestor<br/>external evidence]
    BR[Brokers: files, secrets, network, git, terminals,<br/>clipboard, browser, devices, UI, automations, hosting, commands, MCP host tools]
    AU[(Audit log)]
  end
  subgraph OS[OS backends]
    SB[Seatbelt + disclaim]
    BW[bubblewrap ≥0.12 + seccomp + Landlock + cgroup]
    MX[MXC ProcessContainer via wxc-exec]
  end
  W[Workloads: agent CLIs, MCP servers, T2 plugin hosts,<br/>T3 extension hosts, tasks, helpers]
  UI -->|approval with denialId + epoch| PA
  PR --> PA
  PA --> GS
  PA --> PC --> SV --> OS --> W
  SV --> AT
  W -->|RPC on inherited channel; identity = channel| BR
  BR -->|every request| PA
  PA --> AU
  BR --> AU
  SV --> AU
```

**Rules everything follows** (each maps to invariants in Part E):

1. **One authority.** Every privileged decision, at launch, in a broker or in the UI, comes from one pure function, `PolicyAuthority.evaluate`, over a versioned snapshot. No component keeps its own allow list.
2. **Identity comes from the channel.** Principals are minted by the registry and bound to the channel the supervisor created. Any id, path, permission or caller claim in a payload is ignored or must match.
3. **Immutable launch, mutable brokers.** A process's OS policy is fixed and hashed at launch. Only broker-side grants change while it runs. Widening the OS policy means a relaunch. Narrowing it means a relaunch, or a kill if the narrowing is a revocation.
4. **Refuse, never fall back.** An unenforceable mandatory dimension refuses the launch. Running unsandboxed is a separate, recorded choice by the user, never a retry path.
5. **External evidence.** "Sandboxed" is reported only from evidence the workload can't produce. The workload runs only after it.
6. **No amplification.** A principal never gains authority by calling another principal, acting for an agent, or being called by one. Effective rights are the intersection along the call chain, plus the egress-compatibility rule for data.
7. **Loopback is not authentication.** Every listener authenticates every request with a secret the caller can't get from the network, the environment or another process.
8. **Prompts are not boundaries.** A prompt can only grant what the OS and the brokers then enforce. Critical capabilities are never prompt-grantable.
9. **Honest labels.** Every running principal shows its real state (`Sandboxed`, `Partial: dims`, `Trusted core`, `Not sandboxed: reason`). Nothing claims a guarantee its platform row in Part J doesn't give.

---

## Part B. Architectural findings report

Severity:
- **Critical:** an exploitable security boundary failure.
- **High:** a major security or architectural weakness.
- **Medium:** a reliability, scalability or maintainability concern, or a security weakness that needs an unusual precondition.
- **Low:** usability or optimisation.

"Live" means the defect is on `main` today. "Branch" means it is on `feat/volt-sandbox` and would ship with C1. "Design" means it is in revision 1 of this spec.

### B.0 Index

| Id | Sev | Where | Finding |
|---|---|---|---|
| B-01 | Critical | Live | `POST /api/auth/local` mints an **owner** token for any loopback caller that sends no `Origin` |
| B-02 | Critical | Live | Repo MCP configs are spawned unsandboxed, with no trust check, on composer focus; project entries shadow the user's |
| B-03 | Critical | Branch | `.git/commondir` isn't protected; Volt's host-side `git status` then runs agent-planted `core.fsmonitor` and hooks |
| B-04 | Critical | Branch | The post-turn test check runs the project's test command unsandboxed for sandboxed chats |
| B-05 | Critical | Branch + Design | Writable agent state (`~/.claude.json` MCP servers, `~/.gemini/settings.json`, generic provider dirs) persists code into later unsandboxed runs |
| B-06 | High | Live + Branch | Unsandboxed execution reachable from sandboxed chats: managed terminals, native-model shell tool, workflows, worktree setup, `docker_ensure`, probes, title generation, relay runner |
| B-07 | High | Live | Host MCP: one bearer per server; the chat id and tool groups come from the URL, so one agent can act as another chat (fixed on the branch) |
| B-08 | High | Live | Extension-host RPC takes the extension id from the payload for secrets, authentication, storage and webviews |
| B-09 | High | Live | Any extension can run any command, including `volt.browser.automate`, which skips the browser access checks |
| B-10 | High | Branch | Codex at `workspace-write` uses its own sandbox (`native`), so `thread_launch`/`handoff` to Codex drops Volt's wrap and its credential denies |
| B-11 | High | Branch | Child chats inherit the caller's settings but not its workspace, so `thread_launch` writes to other projects |
| B-12 | High | Platform | macOS: a sandboxed process reads the argv and environment of the user's other non-platform processes (`KERN_PROCARGS2`); no profile tested blocks it |
| B-13 | High | Platform | macOS: sandboxed children are TCC-attributed to Volt and inherit its privacy grants |
| B-14 | High | Live | Native helpers are compiled into user-writable folders and run after only an exists check; a swapped binary inherits Volt's TCC grants |
| B-15 | High | Branch | The code index follows symlinks; "safe" search tools read credentials through a workspace symlink |
| B-16 | High | Branch | Network off is bypassed through the in-app browser (local pages always allowed, sandbox may listen, page JavaScript unfiltered) |
| B-17 | High | Branch | ACP `fs/*` writes check, then write by path (TOCTOU), and the check fails open for an unknown process or an unbound session |
| B-18 | High | Live | Release and update chain: unsigned feed, hash from the same feed, no Authenticode or codesign check on some paths, signing secrets without a protected Environment, Open VSX signatures never verified |
| B-19 | High | Live | Electron fuses at defaults; SIGUSR1 opens an inspector; `utilityProcess` ignores `--disable-sigusr1` and `--permission` |
| B-20 | High | Design | bubblewrap floor 0.8 is below the fix for CVE-2026-87766 (fixed in 0.12.0) |
| B-21 | High | Design | Revision 1's first-party ceilings are claimed for in-process code that no ceiling can bind |
| B-22 | High | Design | Per-call attenuation doesn't stop data a chat passes to a plugin from leaving through the plugin's own network grant |
| B-23 | High | Design | Webview origin and `localResourceRoots` come from the extension's payload: a file-read escape for any sandboxed T3 extension with a webview |
| B-24 | High | Live | volt-server network mode: plain HTTP on `0.0.0.0`, device tokens never expire, global pairing failure limit (LAN lockout); relay pairing has no failure limit |
| B-25 | High | Design | Windows plan assumes job-object controls MXC doesn't offer; MXC loopback, DNS, startup and Git Bash problems unaddressed |
| B-26 | Medium | Branch | macOS profiles allow read/write on every `/dev/ttys*` (other terminals' input) |
| B-27 | Medium | Branch | Linux pattern denies (`.env`) come from a bounded walk and degrade silently to best effort |
| B-28 | Medium | Branch | seccomp is a denylist; unrestricted socket families (`AF_VSOCK`, `AF_NETLINK`, `AF_ALG`, …) and some syscalls missing |
| B-29 | Medium | Branch | The workload runs before the parent confirms the sandbox |
| B-30 | Medium | Branch | Sandboxed agents can listen on any loopback port (port squatting) |
| B-31 | Medium | Branch | Proxy: no client authentication, no tunnel idle timeout, `64:ff9b:1::/48` missing, "Allow host" never reaches the running proxy |
| B-32 | Medium | Branch | Untrusted layers can widen through symlinks (latent: repo layers aren't loaded yet) and through `*` with a port |
| B-33 | Medium | Branch | Linux: path resolution and bind are separate steps (race under shared temp folders) |
| B-34 | Medium | Branch | Denial rows parsed from workload output offer "Allow" buttons (forgeable) |
| B-35 | Medium | Branch | Other runs' temp folders readable; one shared package cache writable by every sandboxed chat |
| B-36 | Medium | Live | Workspace setting `volt.devices.remoteHosts` takes an unchecked ssh `user` and lets a repo redirect scp |
| B-37 | Medium | Live | In-app browser `<webview>`: popups to `openExternal` for any scheme, no permission handler on its partition, no `will-attach-webview` |
| B-38 | Medium | Live | `VSCODE_IPC_HOOK` is in every child's environment, and the main socket's `launch` channel opens windows with any CLI arguments |
| B-39 | Medium | Design | Revision 1 contradicts itself in seven places (B.4) |
| B-40 | Medium | Design | One Node process per extension costs ~62–69 MB each; with no lifecycle budget it doesn't scale to 50 extensions or 100 agents |
| B-41 | Low | Branch | `isSecretEnvName` is a denylist and misses `*_KEY`, `*_PAT`, `*_JWT` |
| B-42 | Low | Design | Revision 1's corrections: CI floor, VS Code and MXC, host MCP token, "already sandboxed" |

### B.1 Critical

#### B-01. Any local process can mint an owner token for volt-server
- **Evidence [code]:**
  - `main:src/vs/server/node/voltAgent/serverPairing.ts:343-352`. The local-session route accepts a request when `sameOrigin = !origin || origin === \`http://${req.headers.host}\``, the method is POST, the peer is loopback and the Host is a loopback literal. Then it calls `issueLocal()`.
  - `:260-262`: `issueLocal` issues `role: 'owner'`.
  - A non-browser client (curl, Node, any sandboxed workload) sends no `Origin`, so it passes.
- **Impact:**
  - **What the owner token reaches:** `/ws` hello as owner, `terminals.start` (no role check, `serverTerminals.ts:356` per the boundary audit), pairing, tunnels and shutdown. So any local principal can run arbitrary commands as the user.
  - **Who can use it:**
    - any sandboxed workload with loopback access. Today's agent profile with network on allows all of loopback (`sbx:docs/security/sandbox/05-limitations.md` #8), and `main`'s Seatbelt profile allows `localhost:*`;
    - every other OS user on the machine;
    - any unsandboxed extension.
  - **This is the DeepSeek CVE-2026-82533 class.**
- **Solution:**
  - The desktop app opens the local web session with a one-time nonce in the URL fragment. The server accepts `/api/auth/local` only with that nonce, single use, 60 s. Alternatively the client presents the master token from the 0600 file.
  - Never treat "no Origin" as same-origin. Rate-limit token minting, and cap and expire local device entries.
- **Verification:** `curl -XPOST -H 'Host: 127.0.0.1:<p>' http://127.0.0.1:<p>/api/auth/local` returns 403. The same call from a sandboxed agent profile returns 403. The real browser flow still signs in with the nonce. INV-07, INV-08.

#### B-02. A cloned repo's MCP servers start unsandboxed, without trust, on composer focus
- **Evidence [code]:**
  - `main:src/vs/workbench/services/voltRuntime/browser/host/mcpHost.ts:26` reads `WORKSPACE_CONFIGS = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.volt/mcp.json']`.
  - `:115-128`: project files are listed before home files, and the first name wins, so a project entry replaces the user's server with the same name.
  - `:165`: `this.stdio.spawn({ command: config.command, args, cwd, env: config.env })`, with no sandbox field and the host's full environment.
  - Per the boundary audit, the trigger is `prewarmNative` on composer focus (`voltRuntimeService.ts:1408-1412`), gated only by `modePolicy(mode).allowMcp`, which is true even in Plan mode.
  - The branch's `05-limitations.md` #18 confirms it: "a cloned repository's file runs when native models start".
- **Impact:** cloning a repo and focusing the composer with a native model runs the repo's command as the user. This is the Cursor CVE-2025-54135 / 54136 class [src].
- **Solution:**
  - Repo MCP configs need Workspace Trust **and** a per-server approval pinned to a hash of `{command, args, env, cwd, resolved binary digest}`. Any change re-prompts with a diff.
  - User entries win over project entries on a name clash.
  - Every stdio server runs as a T4 principal under the supervisor (F.7). No prewarm before approval.
- **Verification:** a fixture repo whose `.mcp.json` runs `touch /tmp/pwn`: focusing the composer creates nothing; approving shows the exact command; editing the args re-prompts. INV-21, INV-22.

#### B-03. `.git/commondir` redirects Volt's own git to agent-written config
- **Evidence [code]:**
  - `sbx:src/vs/platform/voltSandbox/common/sandboxProfiles.ts:58` protects only `**/.git/config`, `config.worktree`, `hooks` and `modules`.
  - `sbx:src/vs/platform/voltSandbox/node/sandboxResolver.ts:397` *reads* `commondir` to find the common git folder but never protects it (`:398-408`).
  - The audit found host-side git runs automatically, unsandboxed and unhardened. Examples: `git status` (`sbx:…/voltRuntimeService.ts:4664`) and `workspace_status`, which is classed `safe` and runs `git status`. No call passes `-c core.fsmonitor=` or a `core.hooksPath` override.
- **Impact:**
  1. The agent writes `/tmp/x/config` containing `[core] fsmonitor = sh -c '…'`, then `echo /tmp/x > .git/commondir`.
  2. Volt's next `git status` runs that command outside the sandbox. Commit review also runs `/tmp/x/hooks/*`.

  This defeats the design's claim that the protected set keeps host git safe.
- **Solution:**
  1. Turn `.git` from a protect list into an **allow list**. Writable: `objects/`, `refs/`, `logs/`, `index`, `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_*`, `COMMIT_EDITMSG`, `packed-refs`, `*.lock`, and the same set under `worktrees/*/`. Everything else is read-only: `commondir`, `gitdir`, `config*`, `hooks`, `info/`, `modules/`, `objects/info/alternates`.
  2. All host-side git goes through one `HostGit` wrapper:
     - It runs `git -c core.fsmonitor=false -c core.hooksPath=<empty dir> -c protocol.ext.allow=never`.
     - It sets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` to the user's real global config, and `GIT_NO_REPLACE_OBJECTS=1`.
     - It checks that `rev-parse --git-common-dir` resolves inside the expected repository.
     - User-initiated commits run hooks only after the build-entry guard (I.6) shows changed hooks.
- **Verification:** SEC test on macOS and Linux. Writing `.git/commondir` or `.git/worktrees/w/commondir` is denied, and a host `git status` through the wrapper with a planted `fsmonitor` creates no marker. A spawn-audit rule forbids `git` calls outside `HostGit`. INV-15, INV-16.

#### B-04. The post-turn test check runs unsandboxed for sandboxed chats
- **Evidence [code]:**
  - `sbx:…/voltRuntimeService.ts:5585-5589`: `runCheck` calls `this.stdio.exec({ id, command, cwd: root.fsPath, … })` with no `sandbox` field.
  - The browser preflight next to it is gated: `:4528-4530`, `… && this.getSandboxSettings(session.sessionId).level === 'off'`.
- **Impact:**
  1. A prompt-injected sandboxed agent edits the `test` script, `conftest.py` or `jest.config.js`. All are writable workspace files.
  2. When the turn ends, Volt runs it with the user's full authority.
- **Solution:** the check runs with the chat's sandbox request, network off by default. `execFor` already supports this (`sbx:voltRuntimeService.ts:347-354`). A spawn-audit rule requires every `exec`/`spawn` reachable from a chat turn to carry a principal, or a recorded "user action" reason.
- **Verification:** LIFE test. A sandboxed chat sets `"test": "touch $HOME/pwned"`; after the turn there is no marker, and `exec` was called with `sandbox` set. INV-03, INV-14.

#### B-05. Writable agent state persists code into later unsandboxed runs
- **Evidence:**
  - **Claude [code]:** `sbx:src/vs/platform/voltSandbox/common/sandboxPolicy.ts:136` gives Claude `homeFiles: ['.claude.json']`, writable. Claude Code keeps local- and user-scope MCP servers, each an arbitrary command, in `~/.claude.json` [src: Claude Code MCP docs].
  - **Antigravity [code]:** `:173-178` has no `protectedHome`, so `~/.gemini/settings.json` (MCP servers and hooks) is writable.
  - **Kimi, Muse and generic providers [code]:** no protection at all. `genericHomeDirs` makes `.<name>`, `.config/<name>` and `.local/share/<name>` writable.
  - **Cursor [code]:** keeps `cli-config.json` writable on purpose (`:153-155`), and it holds command allow lists.
  - **Instruction files:** `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and skills folders are writable instructions that every future session reads.
- **Impact:** a sandboxed chat writes an MCP server or an auto-approval into the CLI's state. The next unsandboxed start of the same CLI runs it outside any sandbox. That includes a chat at level `Off` (the default, `sbx:sandboxPolicy.ts:506`), Volt's own unsandboxed probes and title generation, and the user's own terminal. This is a time-shifted escape.
- **Solution:**
  1. **Deny by default inside CLI state.** Each footprint lists *writable* subpaths (session logs, caches, todo files, the CLI's own project transcript folder), not protected ones.
  2. **Config-bearing files are never writable from the sandbox:** `~/.claude.json`, `settings*.json`, `mcp*.json`, `config.toml`, `cli-config.json`, `hooks`, `plugins`, `skills`, `agents`, `commands`, `CLAUDE.md`, `AGENTS.md`.
  3. **Where the CLI must write its config,** point it at a per-chat copy (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` overlay) seeded read-only from the real one. Volt merges back only allowlisted keys (model choice, session ids) after the turn.
  4. **Unknown providers** get no writable home state; only `${storage}`.
- **Verification:** for each footprint, SEC tests try to add an MCP entry to `~/.claude.json`, write `~/.gemini/settings.json`, and append to `~/.claude/CLAUDE.md`. All are denied, or land in the overlay and are dropped by the merge. A footprint-lint fails CI if a footprint grants a writable directory without an explicit file allow list. INV-15, INV-17.

### B.2 High

#### B-06. Unsandboxed execution reachable from a sandboxed chat
- **Evidence [code]:**
  - **Managed terminals:** `terminal_start` goes to `managedTerminals.ts:475` / `serverTerminals.ts` with no sandbox. In Agent mode it needs no approval (`terminalTools.ts:69`, boundary audit).
  - **Native-model shell:** `shellTool.ts:181` uses `stdio.exec`; `IVoltExecRequest` on `main` has no sandbox field, and `sbx:05-limitations.md` #16 says native models are never sandboxed.
  - **Workflows** (`workflowExecutors.ts:789,805,1003`), **worktree setup** (`agentRunGroupService.ts:350-373`), **`docker_ensure` / `app_open`** (`managedTerminals.ts:924-1007`), **probes and title generation** (`sbx:05-limitations.md` #19), and the **relay runner**, which runs with `--dangerously-bypass-approvals-and-sandbox` and the full environment (`apps/relay/src/runner/agents.mjs:24-32`, #20).
  - The branch's own `05-limitations.md` #22 adds reading other chats: `thread_read`, `thread_search`, `workspace_status` and `terminal_output` read other chats' transcripts and terminals.
- **Impact:** the agent sandbox is bypassed by asking Volt to run the thing instead. This is a confused deputy, and it shares a root cause with B-04.
- **Solution:**
  - Every execution path carries an `ExecContext { principal, onBehalfOf }`. The supervisor refuses a spawn with no principal, unless the call site is in the spawn allowlist with reason `user-action` (a click by the user).
  - Terminals started for a sandboxed chat run under the chat's policy. They need the PTY confirm path (F.6).
  - Cross-chat reads are a capability (`agents.read:other`), denied to sandboxed chats by default.
- **Verification:** the spawn-audit CI gate (K.4), plus one LIFE test per path: a sandboxed chat asks for it, and the canary write outside the workspace fails. INV-03, INV-14, INV-26.

#### B-07. Host MCP: one bearer per server, caller chosen by URL (live; fixed on the branch)
- **Evidence [code]:**
  - On `main`, `voltHostMcpService.ts:109` mints one `randomBytes(32)` token per server, and `:170-171` takes `sessionId` and `groups` from the URL path and query.
  - On the branch, `sbx:…/host/hostToolService.ts:540-545` issues `hostMcpSessionToken(secret, sessionId, groups)`, an HMAC that binds the chat and its tool groups, and `sbx:platform/voltHostMcp/node/voltHostMcpService.ts:98` checks it.
- **Impact on `main`:** an agent can call `/mcp/<other chat id>` and act as another chat, for example `terminal_start` under that chat's mode.
- **Solution:** ship the branch's per-session HMAC in Phase 0, separately from the rest of the branch if needed. Add an expiry and a key epoch, so a revoked chat's token dies.
- **Verification:** a cross-chat call with chat A's token on chat B's path returns 401. INV-01.

#### B-08. Extension identity is taken from the RPC payload
- **Evidence [code]:**
  - `main:src/vs/workbench/api/browser/mainThreadSecretState.ts:38-48`: `$getPassword(extensionId, key)` and siblings.
  - `mainThreadAuthentication.ts:464`: `$getSession(…, extensionId, …)`, with silent-access checks at `:389`, `:393` and `:439` keyed on that id.
  - `mainThreadStorage.ts:46`, `:56`: keys come from the payload.
  - `mainThreadWebviewPanels.ts:164-172`: the origin is derived from the payload extension id.
  - `RPCProtocol` has one proxy per host and no per-extension principal. Upstream VS Code is the same [src].
- **Impact:**
  - Any extension in a shared host can read or write another's secrets.
  - It can get another's authentication sessions silently, for example by claiming to be `vscode.git` to get the GitHub session.
  - It can overwrite another's state and take over another's webview origin.
- **Solution:**
  - **Short term (Phase 0):** every `MainThread*` customer that takes an extension id checks it against the set of extensions *running in that host*. `IExtHostContext` knows its host; the running-location tracker knows which extensions it holds. This closes nothing inside a shared host, but it is the precondition for per-extension hosts.
  - **Long term:** one host per extension (H.3), where the host's set has one element.
- **Verification:** a test extension calls `$getPassword('vscode.github-authentication', …)` and is denied in a per-extension host. In the shared host the check is reported as "not isolated" on the Security page. INV-01, INV-09.

#### B-09. Any extension can run Volt's privileged commands
- **Evidence [code]:** `main:mainThreadCommands.ts:81-92` executes any command id. The boundary audit lists Volt commands reachable this way:
  - **`volt.browser.automate`** (`browserAutomation.ts:1625`): calls `automate()` directly for any `callerId`. That skips `browserAccess.blockReason` and the mode checks in `hostToolService.ts:154-171`, so it can run `browser_evaluate` and `browser_run` with file edits, on a profile that may hold imported Chrome cookies.
  - **`volt.agentServer.allowNetwork`** (`agentServerClient.contribution.ts:567-579`): silently rebinds volt-server to `0.0.0.0`.
  - **`voltAgent.checkpoint.restore` / `.redo`:** rewrite workspace files.
- **Impact:** a malicious extension, or later a T3 extension in its own host, drives the user's logged-in browser and widens the server's exposure. This is a confused deputy.
- **Solution:**
  - Commands are **private by default.** A command is callable from an extension host only if it is in that principal's exported-command allowlist (`commands.execute:<id>`), evaluated by the Authority.
  - `volt.*` commands that act for agents accept calls only from core (a registry flag `internal: true` checked in `MainThreadCommands`).
  - `volt.browser.automate` moves behind `IHostToolService` and stops being a command.
- **Verification:** a test extension calling each internal `volt.*` command gets `CommandNotAllowed`. A lint fails any `CommandsRegistry.registerCommand('volt.…')` without an explicit visibility. INV-10.

#### B-10. Switching to Codex drops Volt's wrap
- **Evidence [code]:**
  - `sbx:sandboxPolicy.ts:480-488`: `if (providerId === 'codex' && level === 'workspace-write') return 'native';`. That strategy spawns with no Volt sandbox (the audit cites `acpProvider.ts:920-924`, and `codexAppServer.ts:118` has no `sandbox`).
  - `thread_launch {model}`, `handoff` and `thread_configure` are classed `safe`, and `sandboxCovers`/`isAtLeastAsStrict` compare level, network, folders and hosts, never the strategy.
- **Impact:** a sandboxed chat starts a Codex child or hands itself to Codex. Codex's own sandbox reads the whole disk and lacks Volt's credential denies and protected names.
- **Solution:**
  - Always wrap: Codex runs under Volt's sandbox with its own sandbox off, as the read-only level already does (`codexSandboxValue`).
  - Add the strategy to every sandbox comparison (`native < wrap`).
  - Refuse launches and handoffs to a provider whose strategy is weaker than the caller's.
- **Verification:** GATE tests. `thread_launch {model: codex}` and `handoff` from a sandboxed chat are either wrapped or refused. A SEC test shows the wrapped Codex can't read the credential canaries. INV-11.

#### B-11. Child chats inherit settings but not the workspace
- **Evidence [code]:**
  - `sbx:…/chatSandbox.ts:20-25` (`confineChatSandbox`) and `sbx:sandboxInheritance.ts:96-111` (`isAtLeastAsStrict`) ignore the child's working folder.
  - `thread_launch` accepts `project` and `workspace: 'root' | existing_worktree`. The `sandboxCovers` workspace check exists for delegates (`hostToolSandbox.ts:433-436`) but isn't applied to spawns.
- **Impact:** a chat confined to worktree A starts a child with write access to the main checkout, another chat's worktree, or another project.
- **Solution:** a spawn requires the child's roots ⊆ the caller's roots (realpath), or the child is forced to `read-only`. The same rule applies to `handoff`.
- **Verification:** GATE and LIFE tests for each `workspace` variant and `project`. INV-11.

#### B-12. macOS: sandboxed processes read other processes' environments
- **Evidence [test], macOS 26.6:**
  - A target `node` process was started with `CANARY_SECRET=hunter2`. A small C reader calling `sysctl(KERN_PROCARGS2, pid)` found the variable in all of these:
    - unsandboxed;
    - under `(allow default)` with `(deny signal)`, which is the branch's agent shape;
    - under the branch's deny-default shape, `(deny default)(allow process-exec process-fork)(allow file-read*)(allow sysctl-read)(allow process-info* (target same-sandbox))`;
    - with `(deny sysctl-read (sysctl-name "kern.procargs2"))`;
    - with `(deny process-info-pidinfo)`;
    - with no `sysctl-read` allow at all.
  - Platform binaries (`/bin/sleep`) were not readable even unsandboxed. The audit's suggested fix, `(deny process-info*)`, does **not** block it.
- **Impact:** every sandboxed workload can read secrets in the environment or argv of any same-user, non-platform process. That covers terminals with exported tokens, agent CLIs started with `ANTHROPIC_API_KEY`, and Volt's own processes. Credential file denies don't help if the same secret sits in a process environment.
- **Solution:** treat this as a **platform residual** with design rules.
  1. **No secret in any env or argv Volt controls.** Provider keys reach agent CLIs through a 0600 file in the principal's run folder, an inherited fd, or the secrets broker's header injection (I.3). `claudeLogin.ts:98`'s hex-on-argv path is removed.
  2. **Volt's own binaries ship with the hardened runtime and a stable signature**, so their processes get platform-style protection. **[assumption]** Hardened runtime blocks `KERN_PROCARGS2` from other processes of the same user; verify with the same C reader against a signed build.
  3. The Security page says plainly that on macOS a sandboxed process can read other processes' environments.
  4. **[open]** Find a Seatbelt operation that mediates `KERN_PROCARGS2`. Trial ten candidate rules with the C reader as the harness.
- **Verification:** K.3 test MAC-ENV-1, a canary process plus the C reader inside every macOS profile. It is expected to *fail open* and is tracked as a known residual until (2) or (4) changes it. MAC-ENV-2: no Volt-spawned process has a secret-looking env name. INV-24.

#### B-13. macOS: sandboxed children inherit Volt's TCC grants
- **Evidence [test, research agent, macOS 26.6]:** a sandboxed, double-forked, `setsid` child reported volt-server as its responsible process. Spawning with `responsibility_spawnattrs_setdisclaim(attr, 1)` made the child its own responsible process, and the child stayed sandboxed. VS Code tracks the same issue [src: microsoft/vscode#307364].
- **Impact:** if Volt holds Full Disk Access, Screen Recording or Accessibility, every sandboxed workload inherits it within its Seatbelt profile. Full Disk Access plus broad `file-read*` (the agent profile) exposes TCC-protected data such as Mail and Messages.
- **Solution:** the macOS backend spawns every sandbox root with responsibility disclaimed (a private SPI that Chromium, Firefox and LLDB use). Helpers that *need* Volt's TCC grants (speech, computer use) are not disclaimed. They are signed, bundled and authenticated (B-14).
- **Verification:** MAC-TCC-1. A sandboxed probe queries its responsible pid (private API, test-only) and must be its own root. A TCC-protected canary file is unreadable to a sandboxed agent profile when Volt holds Full Disk Access (manual CI lane). INV-25.

#### B-14. Native helpers can be swapped
- **Evidence [code], boundary audit:** speech (`~/.volt/speech/<sha16>/volt-speech`, `fs.access` only, `voltSpeechMainService.ts:325-327`), desktop/computer use (`<userData>/volt-desktop/…`, `:225-226`), FFF index (`fffEngine.ts:237`), device hub (`deviceHub.ts:191`), and on `main` the Landlock helper (`sandboxLauncher.ts:274-276`) are all run after an exists check from user-writable folders.
- **Impact:** any unsandboxed same-user process, today's extensions included, replaces a helper. The replacement runs as Volt's child with Volt's TCC grants. The swapped sandbox helper is the sandbox enforcer itself.
- **Solution:**
  - Helpers ship signed inside the app bundle. They are never compiled at runtime into user data.
  - The supervisor verifies the code signature (macOS `SecStaticCodeCheckValidity` with Volt's designated requirement; Windows `WinVerifyTrust`; Linux a pinned SHA-256 in `builtin-manifest.json`) **immediately before every launch**.
  - Helpers authenticate their parent by inherited fd only.
  - Dev builds use an explicit "unsigned helpers" developer mode with a badge.
- **Verification:** swap each helper with a stub and expect the launch to be refused with a reason. INV-27.

#### B-15. Search tools read through symlinks
- **Evidence [code]:**
  - `ripgrep.ts:29-31,64-66` adds `--follow` unless `ignoreSymlinks`, which is off by default.
  - `hostToolSandbox.ts:101-104` classes `instant_grep`, `find_symbol` and `find_files` as `safe`. They run in Volt's unsandboxed index process.
- **Impact:**
  1. The agent runs `ln -s ~/.ssh ws/k`. Creating the link is allowed; reading through it inside the sandbox is denied.
  2. `instant_grep "PRIVATE KEY"` runs on the host and follows it. **[assumption]** Content lines come back, not only paths; verify with the GATE test.
- **Solution:** host-side reads for a sandboxed chat go through the file broker, with the chat's read policy checked on the *real path of each result*. The index for sandboxed chats ignores symlinks. The tools are re-classed `reads`.
- **Verification:** GATE test. A workspace symlink to a canary credential folder; `instant_grep CANARY` returns nothing. INV-12.

#### B-16. Network off is bypassed through the in-app browser
- **Evidence [code]:**
  - `sbx:hostToolSandbox.ts:534-536` always allows local pages.
  - `sbx:seatbelt.ts:203-207` allows `network-bind` and `network-inbound` on `localhost:*`, and the agent profile always sets `listen` (`sandboxPolicy.ts:406`).
  - Page traffic isn't proxied (`05-limitations.md` #21).
- **Impact:** the agent serves a page on loopback, then navigates the in-app browser to it, and the page's script sends workspace data anywhere. With network on, `browser_evaluate` runs in the user's signed-in profile.
- **Solution:**
  - Sandboxed chats get a **separate, signed-out browser partition per chat.** Its session uses `session.setProxy` to the chat's broker route, so the same hostname rules apply.
  - A single `webRequest.onBeforeRequest` dispatcher attributes each request by `webContentsId`, and treats a null frame as deny [src: Electron 37 web-request docs].
  - `listen` is off by default; dev servers get an explicit `net.listen` grant (I.4).
- **Verification:** e2e GATE test. A network-off sandboxed chat serves a beacon page, and the test host receives nothing. INV-19.

#### B-17. ACP `fs/*` writes race and fail open
- **Evidence [code]:**
  - `acpProvider.ts:2061` checks, then `:2077` writes by path through `fileService.writeFile`, following symlinks.
  - `sbx:voltStdioService.ts:225-227` returns `true` for an unknown process id.
  - The check is skipped when `sessionForClient` finds no session (`acpProvider.ts:2176-2183`).
  - The race is documented in `05-limitations.md` #13; the fail-open paths are not.
- **Impact:** the agent flips a workspace folder between a real folder and a symlink to `$HOME` while asking Volt to write `dir/.zshrc`. Volt writes `~/.zshrc` unsandboxed. This is an escape.
- **Solution:**
  - Writes go through the file broker's handle-based open (I.2): `O_NOFOLLOW_ANY` on macOS, `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` on Linux through a small native helper, and component-wise `FILE_FLAG_OPEN_REPARSE_POINT` on Windows.
  - An unknown process or unbound session is denied whenever the chat is sandboxed.
- **Verification:** a race test flips a symlink during 1,000 writes; no byte lands outside the workspace. Unit test: `sandboxAllows(unknown)` is `false`. INV-12, INV-13.

#### B-18. Release and update chain
- **Evidence [code], boundary audit:**
  - **The feed is unsigned JSON** on the `volt-update-feed` branch. `sha256hash` sits next to `url` (`voltUpdateFeed.ts:32-33`) and is written from the same CI (`publish.mjs:19,61`).
  - **macOS cross-channel install** is `ditto` plus a move, with no codesign check (`updateService.darwin.ts:216,222`).
  - **The Windows installer** runs with no Authenticode check (`updateService.win32.ts:210,282,311`).
  - **Builds without certificates still ship:** ad-hoc on macOS, unsigned on Windows (`darwin-package.sh:43-53`, `win32-sign.ps1:15-17`).
  - **Signing secrets are exposed to every workflow:** `secrets: inherit` with no `environment:` in any `volt-*.yml`, and 69 of 75 actions are tag-pinned.
  - **Open VSX signatures are never verified.** `@vscode/vsce-sign` isn't shipped (`extensionSignatureVerificationService.ts:70-82`), and it can't parse Open VSX's `.sigzip` anyway [src: eclipse-openvsx/openvsx#1247].
- **Impact:** anyone who can push to the feed branch, or tamper with an artifact, ships code to every user. Extensions are unauthenticated beyond TLS.
- **Solution:** S-track in Part M.
  - A protected `release` Environment with required reviewers.
  - An Ed25519-signed feed with a pinned key per channel.
  - Authenticode and codesign checks before install.
  - Release workflows fail without certificates.
  - Actions pinned by SHA in release jobs.
  - Artifact attestations.
  - Open VSX verification against the pinned registry key (`node-ovsx-sign`-style).
- **Verification:**
  - A tampered feed is refused.
  - A nightly signature on stable is refused.
  - An unsigned Windows installer is refused.
  - A workflow from a throwaway branch can't read the signing secrets.
  - A tampered `.vsix` fails the registry signature check.

  INV-28, INV-29.

#### B-19. Electron fuses and the inspector
- **Evidence:**
  - No `flipFuses` anywhere [code]. `npx @electron/fuses read --app /Applications/Volt.app` shows RunAsNode, NodeOptions and NodeCliInspect enabled, and ASAR integrity off [test].
  - volt-server runs as `ELECTRON_RUN_AS_NODE: '1'` (`main:src/vs/platform/voltAgentServer/node/agentServerLauncher.ts:168`) [code].
  - In an Electron 37.6.0 `utilityProcess.fork` with `execArgv: ['--disable-sigusr1']`, SIGUSR1 still opened the inspector, and `--permission` was not applied [test, research agent].
  - `--disable-sigusr1` exists from Node 22.14 and is stable from 22.20; Electron 37.6.0 ships 22.19.0 [src].
- **Impact:** any same-user process that can send a signal attaches an inspector to volt-server or an extension host, which is full control. Branch profiles deny signals outside the sandbox (`sbx:seatbelt.ts:134`), but unsandboxed extensions and other user processes can.
- **Solution:**
  - Sandboxed hosts (T2/T3) are spawned as `ELECTRON_RUN_AS_NODE` children through the supervisor, never `utilityProcess`, with `--disable-sigusr1` (verified per host by a SIGUSR1 test).
  - volt-server gets `--disable-sigusr1`.
  - Flip `EnableNodeOptionsEnvironmentVariable` and `GrantFileProtocolExtraPrivileges` off after a compatibility test. Keep RunAsNode (D-07).
  - Pack `out/` into an integrity-checked asar (D-08).
- **Verification:** HOST-SIG-1. `kill -USR1` against every host type opens no port 9229 and changes nothing in `/proc/<pid>/net` or `lsof`. INV-30.

#### B-20. bubblewrap floor below a high-severity fix
- **Evidence [src]:**
  - Advisory GHSA-pxhw-h44j-8pfx / CVE-2026-87766: symlinks in attacker-controlled bound content redirect file or directory creation onto the host. Fixed in bubblewrap 0.12.0 (2026-08-26) using `openat2(RESOLVE_IN_ROOT)`. No backport to setuid builds.
  - Revision 1 requires ≥ 0.8.
  - The branch rig used Ubuntu 24.04's bubblewrap 0.9.0 (`sbx:docs/security/sandbox/04-performance.md`).
- **Impact:** Volt binds the workspace, which is attacker-controlled, and then mounts protections inside it. That is the vulnerable pattern. A concurrent sandboxed agent writing the same workspace can swap a path component during setup.
- **Solution:**
  - Default floor 0.12.0.
  - The probe also runs a CVE trial (a symlinked mount point inside a bound fixture must not land outside), so a distro build with the fix backported passes on evidence.
  - Below that, refuse with install guidance. D-04 records the trade-off: Ubuntu 24.04 and Debian 12 ship older versions.
- **Verification:** LNX-BWRAP-CVE probe and test on a 0.9.0 image (expect refusal) and a 0.13.1 image (expect pass). INV-05.

#### B-21. First-party ceilings don't bind in-process code
- **Evidence:** revision 1 §11.1 says "a bug in a first-party plugin, or a stolen plugin key, reaches only that plugin's ceiling". It also keeps six features and "the UI half of other features" in the renderer (T1). That is protected by "facade + import lint + lazy load. Not a sandbox".
- **Impact:** in-process code runs with the renderer's full authority: every service, every IPC channel to Electron main. The ceiling table limits only code that runs out of process. The claim misleads reviewers about the blast radius of the browser, scratch, visuals, devices, computer use and customize features.
- **Solution:**
  - State the real boundary. **T1 is trusted core code**, reviewed as TCB, with its own tests: CODEOWNERS, an import lint, and no direct `child_process`/`fs` (spawn-audit).
  - Ceilings apply to T2 and T3.
  - Agent-authored content that a T1 feature renders is parsed in an opaque-origin iframe or a sandboxed renderer, never on the workbench's main thread (C.3).
  - Shrinking T1 is an explicit long-term goal, measured by its line count.
- **Verification:** a docs test asserts that the Security page labels T1 features as "Trusted core", not "Sandboxed". INV-31.

#### B-22. Data passed to a plugin leaves through the plugin's own grants
- **Evidence:** revision 1's attenuation (`effective = plugin ∩ caller`) applies at broker calls. A T2/T3 process's own OS-level and broker grants, for example `net.connect api.linear.app`, are fixed by its policy, not by who called it.
- **Impact:**
  1. A chat with network off calls a plugin tool, passing workspace content.
  2. The plugin sends it to its granted host.

  The chat's "network off" is bypassed by composition. This is the confused-deputy shape for data, not authority.
- **Solution:** the **egress-compatibility rule** (G.6). Invoking principal B on behalf of A is allowed only if egress(B) ⊆ egress(A), or the user has approved the flow "A → B's hosts" (scope: once, this chat, this project). Otherwise the call is refused, with a card naming the hosts. This applies to tools, `chats.send`, context providers and hooks.
- **Verification:** PERM-FLOW-1. A network-off chat invoking a tool from a plugin with `net.connect x` is refused; after "Allow for this chat" it succeeds; the approval is visible and revocable. INV-02.

#### B-23. Webview origin and resource roots from the payload
- **Evidence [code]:** `main:mainThreadWebviewPanels.ts:164-172`: `reviveWebviewExtension(extensionData)`, `getOrigin(viewType, extension.id)`, and `contentOptions: reviveWebviewContentOptions(initData.webviewOptions)`. So `localResourceRoots` come from the extension.
- **Impact:** once T3 hosts are OS-sandboxed, a T3 extension's webview, rendered by the workbench outside that sandbox, can load any local file the renderer can read. That is a file-read escape that bypasses the host's OS policy.
- **Solution:** core derives the webview origin from the principal and clamps `localResourceRoots` to the principal's readable set (its extension folder and storage; the workspace only if it has `files.read:workspace`). Core writes the CSP (I.10).
- **Verification:** T3-WEBVIEW-1. A webview with `localResourceRoots: ['/']` can't load `~/.ssh/id_ed25519` via `vscode-resource`. INV-19, INV-20.

#### B-24. volt-server in network mode
- **Evidence [code], boundary audit:**
  - Plain HTTP on `0.0.0.0` when network is on (`agentServerLauncher.ts:164-166`). Seen live as `*:47818`.
  - Device tokens have only `owner | device` roles and no expiry (`serverPairing.ts:33`).
  - The pairing failure limit is global (12 per minute, `:21-25`), so anyone on the LAN can lock pairing out.
  - Relay pairing codes have no failure limit (`apps/relay/src/relay.mjs:130-133`).
- **Impact:** tokens and the workbench cookie cross the LAN in clear text. A stolen token never expires. Pairing can be brute-forced on the relay, and denied locally.
- **Solution:**
  - TLS with a pinned self-signed key shown in the pairing QR, or Noise over the existing WebSocket.
  - Scoped, expiring tokens with refresh.
  - Per-source failure limits.
  - Step-up for high-risk remote approvals (I.13).
- **Verification:** REM-1 to REM-4 in K.3. INV-08.

#### B-25. Windows assumptions that MXC doesn't meet
- **Evidence [src], MXC repo and issues:**
  - The 1.0.0 schema has no CPU, memory or process-count fields for ProcessContainer.
  - Nested jobs are only possible if neither job sets UI limits, and MXC's job does.
  - MXC#1665 [report]: `hostLoopback: allow` without proxy mode opens every localhost port.
  - MXC#1666 [report]: DNS resolves through the host's DNS Client even in proxy mode, a side channel.
  - MXC#1629 [report]: about 28 s to first output with `ui.disable: false`.
  - MXC#1061 [report]: MSYS2/Git Bash fails, also when native `git` reaches `sh.exe`.
  - MXC#1706 [report]: only `\\.\pipe\LOCAL\` names work.
  - VS Code removed MXC on 2026-10-08 (microsoft/vscode#340446) and doesn't sandbox terminal commands on Windows today.
  - Revision 1 §5.2 relies on "a job object with an active-process limit of 1" for `spawn: none`.
- **Impact:** revision 1's Windows guarantees for `process.spawn`, resource limits and loopback isolation can't be built on MXC as specified. "Volt inherits MXC from VS Code" is false.
- **Solution:** Part J.3 states Windows guarantees separately.
  - `process.spawn: none` is **unsupported** on Windows until a trial proves otherwise.
  - Resource limits are enforced by polling and killing (best effort).
  - Network uses MXC Model 2 (proxy-only egress), never plain `hostLoopback`.
  - The DNS leak is a documented residual.
  - Git Bash is refused.
  - Startup latency is measured as a release gate.
- **Verification:** the WIN-* suite on `windows-11-arm` (hosted, 26200.9725, above the floor [src]) and a self-hosted x64 VM. INV-04, INV-05.

### B.3 Medium and Low

| Id | Evidence | Impact | Solution | Verification |
|---|---|---|---|---|
| B-26 | `sbx:seatbelt.ts:128` allows `file-read* file-write* file-ioctl` on `/dev/ttys[0-9]+`; `DEVICE_FILES` at `:30` [code] | A sandboxed process opens another terminal's tty and competes for its input (sudo passwords) or spoofs output. **[assumption]** Not reproduced yet; raise to High if MAC-TTY-1 reproduces | Allow only `/dev/tty` and inherited fds; a PTY workload gets its own device path in its profile | MAC-TTY-1 |
| B-27 | `sbx:bubblewrapBackend.ts:62` walk limits (20k entries, depth 8, 500 ms); patterns count as `filesystem.protectNew`, best effort for agents [code] | `.env` files the walk misses stay readable, reported as a generic `partial` | A separate `filesystem.denyPatterns` dimension that is mandatory; incomplete walk → refuse. Linux agents read only `${system}`, `${path}`, workspace and their state, not `/` | LNX-ENV-1 (`.env` at depth 9 in a 25k-entry home) |
| B-28 | `sbx:seccomp.ts:51-67`, default allow at `:194`, only `AF_UNIX` checked at `:184-192` [code] | `AF_VSOCK` reaches the hypervisor from an empty netns; `AF_ALG`, `AF_KEY`, `AF_TIPC` etc. load rarely-used kernel code; `modify_ldt`, `kcmp`, `pidfd_getfd` unrestricted | Socket family allow list (`AF_INET`, `AF_INET6`, `AF_UNIX` only when granted, else `EAFNOSUPPORT`); add the missing syscalls; long-term an allowlist filter (seccomp(2), systemd and Docker all recommend one [src]) | Unit: BPF per family; rig: `socket(AF_VSOCK)` fails |
| B-29 | Prologue writes ready and immediately `exec`s (`sbx:bwrap.ts:48`, `seatbelt.ts:279-281`); Volt confirms afterwards [code]. bwrap's `child-pid` status line precedes mounts, seccomp and exec [src: bubblewrap.c] | The workload runs for milliseconds before a failed confirm kills it | Go-byte protocol (F.5): the prologue blocks on a byte from the parent after external attestation | FAULT-1: inject a confirm failure; the workload's first syscall marker never appears |
| B-30 | `sbx:seatbelt.ts:203-207` binds `localhost:*`; agent profile `listen: true` [code] | Squats OAuth callbacks and dev ports; serves exfil pages (B-16) | `listen` off by default; per-run port range when granted; Volt's ports reserved | NET-LISTEN-1 |
| B-31 | `sbx:sandboxProxy.ts` listens on `127.0.0.1:0` with no client auth (`:65`), no CONNECT idle timeout (`:117-137`); `64:ff9b:1::/48` missing from `embeddedIPv4` (`:286-297`); `allowSandboxDomains` has no caller (boundary + branch audits) [code] | Any local process uses a chat's egress grants (cross-principal reuse); slow tunnels pile up; one NAT64 range unchecked; "Allow host" doesn't apply live | Network broker v2 (I.4): per-principal routes, `Proxy-Authorization` token, idle timeouts, full special-range table, live grants | NET corpus (K.3) |
| B-32 | `sbx:sandboxComposition.ts:46-57`: `entryInside` compares text before realpath; `allowCovers('*', 'evil.com:6379')` is true [code] | A repo layer widens writes through a symlink, or proxy ports through `*` (latent: repo layers aren't loaded) | Re-check containment on realpaths; record the source layer per entry; `*` covers ports 80/443 only | POL-PROP-3/4 |
| B-33 | Paths resolved at `sbx:sandboxManager.ts:175`, bound later; `pathKinds` uses `stat` (`bubblewrapBackend.ts:442-451`) [code] | A concurrent sandbox swaps `/tmp/proj` for a symlink to `$HOME` between check and bind. **[assumption]** Not reproduced | `--bind-fd` (bwrap ≥ 0.10) on `O_PATH\|O_NOFOLLOW` fds; refuse roots under agent-writable temp | LNX-RACE-1 |
| B-34 | `sbx:sandboxDenials.ts:54-72` parses denials from output text [code] | The agent prints a fake denial and the UI offers "Allow folder ~/.ssh". `folderGrantError` limits folders, but host grants are open | Only broker- or OS-sourced denials, with a `denialId` the broker recorded, get grant buttons | UX-FORGE-1 |
| B-35 | `~/.volt/sandbox/runs/*/tmp` readable to every agent; `~/.volt/sandbox-cache` shared writable (`sbx:sandboxLauncher.ts:187`) [code] | Cross-chat reads; chat A poisons packages chat B runs | Deny `~/.volt/**` except the run's own folder; caches keyed per principal | SEC-CROSS-1 |
| B-36 | `volt.devices.remoteHosts` is WINDOW-scoped (`voltDevices.contribution.ts:50`); `user` and `identityFile` unchecked (`agentDevices.ts:47,58`) [code] | A repo points scp at its own host. **[assumption]** `-o` injection via `user` not reproduced | APPLICATION scope; validate `user`; show the destination on first use | CFG-1 |
| B-37 | `browserEditor.ts:1402-1404` (`allowpopups`, no preload); no `will-attach-webview`; `window.open` → `openExternal` for non-blank URLs (`app.ts:498`) → OS handlers for any scheme (`nativeHostMainService.ts:605-608`) [code] | A web page launches OS protocol handlers; permissions on the browser partition are unhandled | `will-attach-webview` strips preload and node options; `setWindowOpenHandler` denies non-http(s); permission handlers on every partition | WEB-1..3 |
| B-38 | `main:src/vs/code/electron-main/main.ts:241,251` puts `VSCODE_IPC_HOOK` in `process.env`; children inherit it, stdio children through `voltStdioService.ts:478` [code]; `launchMainService.ts:50` starts windows with any args | A process that can connect the socket opens an unsandboxed window that loads its own extension (`--extensionDevelopmentPath`). Branch Seatbelt denies `remote unix-socket` for agents | The supervisor's env is built from nothing, so it never carries it; the floor denies the socket path; the `launch` channel accepts only the CLI's own requests (peer pid check) | ENV-IPC-1 |
| B-39 | B.4 | Contradictions mislead implementation | Resolved in this revision | Review |
| B-40 | Electron-as-Node child RSS ~62 MB, `utilityProcess` ~69 MB and 74 ms [test]; revision 1 guessed 30–80 MB | 50 extensions in one host each cost ~3 GB; idle hosts must cost nothing at 100+ agents | Lazy activation, idle stop, a host budget, activation-event routing; pool only identical identities (H.6) | PERF-HOST-* (Part L) |
| B-41 | `sbx:sandboxProfiles.ts:74-80` | Secrets with other names leak into `inherit: ['*']` | Agent profiles never use `inherit: ['*']`; an allow list per footprint | ENV-1 |
| B-42 | B.5 | Spec facts were wrong | Corrected | — |

### B.4 Contradictions in revision 1

| # | Revision 1 says | It also says | Resolution in revision 2 |
|---|---|---|---|
| 1 | "No pooling of mutually untrusted code" (§4 rules) | "Plugins whose capabilities are all `low` and identical may share a process" (§4 T2) | Pool only instances of the same subject identity (H.6) |
| 2 | "Refuse, never fall back" (§1 rule 1) | First-party T2 logic runs in-process when the OS can't sandbox, after one question per machine (§5.5) | Kept as a recorded, visible **degraded mode** (D-06), not a fallback: it is decided before launch from a static platform fact, never after a failure, and the Security page shows it permanently |
| 3 | "A failed check never offers an override button" (§1) | Metric "fewer than 2% 'run outside sandbox' overrides" (§2) | The metric counts chats set to `Off` and third-party extensions given "Run with full access", both separate controls |
| 4 | Confirm evidence "must come from outside the workload" (§5.5) | Seatbelt evidence is a line written on fd 3 from inside (§5.5 table) | External attestation (F.5) |
| 5 | `process.spawn: none` on Windows via a job active-process limit (§5.2) | MXC is the only Windows backend (§6) | Unsupported on Windows (B-25) |
| 6 | C4 acceptance "canary green on `windows-11-arm`" (§16) | That image's build is a **guess** below the floor (§15.3) | The image is now 26200.9725, above the floor [src]; C4 can use it |
| 7 | Ceilings bound "a bug in a first-party plugin" (§11.1) | T1 in-process code is "Not a sandbox" (§4) | B-21 |

### B.5 Facts revision 1 got wrong

| Revision 1 | Correct |
|---|---|
| Host MCP has "per-session HMAC" (§14) | `main` uses one bearer per server; the branch adds the per-session HMAC (B-07) [code] |
| Agent CLIs are "already sandboxed on `sbx:`" (§13.4) | Except Codex at `workspace-write` (B-10). `main` already has an opt-in sandbox, default `off` [code] |
| VS Code's MXC work is a base to inherit (prior turn) | VS Code removed MXC on 2026-10-08 (#340446) and uses Anthropic's sandbox-runtime on macOS and Linux [src] |
| The hosted `windows-11-arm` image is below the MXC floor (guess) | 26200.9725 (image 20261101), above it [src] |
| bubblewrap ≥ 0.8 | ≥ 0.12 (B-20) |
| The macOS canary "direct connect to a public IP fails" | It needs no external packet: a sandbox deny returns `EPERM` immediately. The canary checks the error class, never waits on a timeout (F.5) |
| The `KERN_PROCARGS2` gap was not known | B-12 |

---

## Part C. Master architecture

### C.1 Goals, non-goals, success measures

**Goals:**
- **G1. Confined by default.** Every workload that isn't Volt's core (agents, MCP servers, plugins, extensions, tasks they start) runs under an OS sandbox the parent has attested, or doesn't run. The exception is a recorded user choice.
- **G2. One decision function.** Launch policy, broker checks and UI prompts all come from `PolicyAuthority.evaluate`. A decision can be replayed from the audit log.
- **G3. Honest guarantees.** Each platform row in Part J is what the product claims. The UI never shows more.
- **G4. Zero prompts for Volt's own plugins**, still bounded by ceilings for out-of-process code. Third-party prompts are rare, in context, and never the only control.
- **G5. Everything is a plugin for lifecycle and contribution.** Every feature has a manifest, capabilities and a switch, and can be replaced through slots. Isolation follows the tier table (C.2), not the word "plugin".
- **G6. Easy to build for.** A sandboxed Volt plugin is as easy to write and debug as a VS Code extension. Android's SDK Runtime, which sandboxed third-party SDKs, was retired on 2025-10-17 for low adoption [src].
- **G7. Cheap when idle.** Idle sandboxed hosts cost no CPU and are stopped after a budget. Security work never makes the 100-agent case worse than Part L's budgets.

**Non-goals for v1:**
- TLS interception.
- UDP and raw sockets for plugins.
- A VM by default.
- Sandboxing the user's own terminal and git. Volt's *implicit* git is hardened (I.5).
- Running deep-UI first-party features out of process. They are trusted core, labelled as such.
- A Windows sandbox below the MXC build floor.
- Windows 10.

**Success measures:**

| Measure | Target | Source |
|---|---|---|
| Spawn coverage | 100% of non-user spawns carry a principal; the spawn-audit gate is green | K.4 |
| Attestation | 0 launches reported `Sandboxed` without external evidence, over 14 days of beta | Telemetry `attestation=external` |
| Refusals | < 2% of sandboxed launches refused on supported platform rows | Telemetry |
| Unsandboxed choice | Chats at `Off` and third-party "full access" grants are each counted; there is no "override" | Telemetry |
| Adversarial suite | 100% of K.3 green on every supported row; residuals listed as expected-fail with an owner | CI |
| Performance | Part L budgets, no regression > 20% on any tracked metric | Nightly bench |

### C.2 Workload taxonomy and placement

Each workload kind was checked against the question "does it need its own process, a worker, an iframe or a native helper?"

| Workload | Tier | Process model | OS isolation | Identity | Authority source | Why this placement |
|---|---|---|---|---|---|---|
| Volt core: workbench services, Electron main, volt-server | **T0 (TCB)** | Existing processes | Renderer: Chromium sandbox (`sandbox: true`, `main:windows.ts:165` [code]). Main and server: none, they are the monitor | n/a | n/a | It *is* the reference monitor; kept small and audited |
| First-party UI: browser, scratch, visuals, devices, computer use, customize, and the view half of other features | **T1 trusted core** | In the renderer, lazy-loaded | Renderer sandbox only; **no boundary against the workbench** | Feature id (for lifecycle only) | Code review + CODEOWNERS | Deep UI can't leave the workbench without rewrites (revision 1 §19). Labelled honestly (B-21) |
| First-party logic: memory, usage, provider probes, automations scheduler, PR/commit-review services, agent-resources reader | **T2-fp** | One OS-sandboxed Node process per subject identity, lazily started | OS sandbox + broker-only I/O | Minted principal; subject = `volt.<feature>@<digest>` | Ceiling table compiled into core | Logic that parses untrusted input or holds tokens leaves the renderer (rule "UI in, logic out") |
| Volt-native third-party plugin | **T2** | Same host kind as T2-fp | OS sandbox (empty profile: own bundle read-only, no network, no spawn where enforceable) + SES inside as defence in depth | Minted; subject = `<publisher>.<name>@<signer>` | User grants ∩ manifest | Capability-first API makes most plugins need no OS widening |
| VS Code extension (Node entry) | **T3** | One sandboxed `bootstrap-fork` extension host **per extension**, on the execution host | OS sandbox + broker network + core-owned webview CSP | Minted; subject = `<publisher>.<name>@<signer>` | Inferred default + user grants + signed presets | `MainThreadSecretState` etc. trust payload ids (B-08); a shared host can't be secure |
| VS Code extension (browser-only entry) | **T3-web** | One sandboxed renderer per extension (hidden `BrowserWindow`, `sandbox: true`, own partition, RPC bridge preload only) **[proposed]** | Chromium renderer sandbox (a real OS sandbox) | Same | Same | The shared web-worker extension host lives in the workbench renderer; a worker is not a boundary. **[open]** Measure cost (Part L) |
| Extension with no code (themes, grammars, snippets, icon packs) | **Data** | No process | n/a | Package digest | Install consent | Nothing executes |
| Agent CLI | **T4** | One process tree per chat | OS sandbox per chat | Minted; subject = `chat:<id>/provider:<p>` | Chat settings ∩ project policy ∩ admin | Already true on the branch, except B-10 |
| stdio MCP server | **T4** | One process per (server config digest, chat or project scope) | OS sandbox | Minted; subject = `mcp:<configDigest>` | Approval pinned to the config hash ∩ caller chat | B-02 |
| HTTP MCP server | **Broker identity** | No process | Network broker rules | `mcp-http:<configDigest>` | Same | Nothing runs locally |
| Language servers, linters, debug adapters started by an extension | Child of its T3 host | Inside the host's sandbox | Inherited | Same principal | Same | They are the extension's code |
| Tasks, terminals and commands run for an agent | Child of the chat principal | Inside the chat's sandbox | Inherited | Chat principal | Chat | B-04, B-06 |
| Tasks and terminals the user starts | **User** | Outside | None | `user` | n/a | Non-goal; the build-entry guard warns (I.6) |
| Native helpers: speech, computer use, device hub, tunnels, code index | **H** | Own process launched by core | Per-helper profile where TCC allows; signed, bundled, verified before launch | Helper id + signature | Core, per helper | B-14 |
| Web content: agent HTML, plugin panels, charts, diagrams | **Web** | Opaque-origin iframe in a Volt-owned container. **[open]** Process isolation of sandboxed iframes in Electron 37 (Chromium 138) is unverified; until measured, agent HTML renders in its own sandboxed renderer | Chromium sandbox | Panel owner principal | Panel owner | Parsers of agent-written content never run on the workbench main thread |
| Strict mode | **T5** | microVM per session (opt-in) | Hardware virtualisation | Same broker protocol | User | Later |

**Placement rules:**
1. **Electron main runs no plugin code.** Its Volt services are brokers.
2. **The renderer runs no third-party code** outside sandboxed iframes and per-extension sandboxed renderers.
3. **No process ever hosts two subject identities.** H.6 allows pooling only instances of one identity.
4. **JavaScript realms, workers, SES compartments and the Node permission model are defence in depth, never the boundary.**
   - SES makes no CPU, memory or side-channel promises and has had escapes: CVE-2023-39532, CVE-2025-32792 [src].
   - Node says its permission model "does not provide security guarantees in the presence of malicious code" [src].
   - Electron 37's `utilityProcess` has no sandbox option and ignores `--permission` [src, test].

### C.3 Process topology on one execution host

```mermaid
flowchart LR
  subgraph Desktop[Desktop app]
    R[Workbench renderer<br/>T0 + T1 trusted UI<br/>Chromium sandbox]
    M[Electron main<br/>T0 brokers]
    W1[T3-web renderer<br/>per browser-only extension]
    IF[Agent HTML renderer<br/>opaque origin]
  end
  subgraph Server[volt-server = execution host by default]
    PR[Principal Registry]
    PA[Policy Authority + grant store]
    SV[Supervisor / SandboxManager]
    NB[Network broker]
    FB[File, secret, git, terminal brokers]
    HM[Host MCP endpoint]
  end
  subgraph Sandboxes[OS sandboxes]
    A1[Agent CLI, chat 1] --- A1c[its tools and tasks]
    MC[stdio MCP server]
    P2[T2 plugin host]
    P3[T3 extension host] --- LS[its language server]
  end
  H[Signed native helpers]
  R <-->|authenticated WS| Server
  M <--> R
  SV --> Sandboxes
  SV --> H
  A1 -->|HMAC per chat| HM
  P2 -->|inherited channel| FB
  P3 -->|inherited channel, ext-host protocol| R
  Sandboxes -->|per-principal route + token| NB
  NB --> Internet((Internet))
```

- **volt-server is the default execution host.** It already owns agent stdio and the host MCP (`main:server/node/voltAgent/agentServerMain.ts:242-246` [code]).
- **With the agent server off, Electron main is the execution host.** Third-party Node extensions then refuse, because `utilityProcess` can't be sandboxed (D-09).
- **Remote:** web and phone clients talk to volt-server. The relay is a transport, never an authority.

### C.4 Trust boundaries

| # | Boundary | Crossing mechanism | Authentication | Authority check |
|---|---|---|---|---|
| TB1 | User ↔ core | UI gestures | Gesture token minted by core UI (G.8) | n/a |
| TB2 | Core ↔ any sandboxed principal | Inherited channel (socketpair, pipe or fd) created by the supervisor | Possession of the channel; identity = channel | Authority per request |
| TB3 | Principal ↔ principal | Only through core (tool invoke, command, `chats.send`) | Both identities from their channels | Attenuation + egress compatibility |
| TB4 | Sandbox ↔ Volt listeners | Loopback HTTP/WS, unix sockets, named pipes | Per-principal bearer or HMAC, never Host/Origin/peer address | Authority |
| TB5 | Workspace content ↔ things that execute it later | Files | Content pins and the build-entry guard | Trust + review |
| TB6 | Volt ↔ network | Network broker | Principal route + token | Rules + special ranges |
| TB7 | Build ↔ users | Feed, installers, extensions | Signatures with pinned keys | Monotonic versions |
| TB8 | Clients ↔ execution host | WS over TLS or Noise | Scoped, expiring device tokens + step-up | Server re-derives every grant |
| TB9 | Core ↔ native helpers | Inherited fd | Signature checked before launch + parent fd | Per-helper allow list |
| TB10 | Volt ↔ OS privacy and permissions (TCC, AppContainer) | OS attribution | Disclaim for sandboxes; helpers signed | n/a |

### C.5 Is `SandboxManager` the right central abstraction?

**Partly.** On the branch, `SandboxManager` does five jobs:
- composes policy (`sandboxComposition.ts`);
- resolves paths and the environment (`sandboxResolver.ts`);
- launches and confirms (`sandboxManager.ts`, backends);
- holds live network grants (`allowDomains` on `IPreparedSandbox`);
- runs the proxy (`sandboxProxy.ts`).

Permission decisions for brokers, the host-tool gate (`hostToolSandbox.ts`) and the UI live elsewhere, with their own logic. That is how B-10, B-11 and B-15 happened: the host-tool gate's idea of "covers" disagreed with the launcher's.

**Revision 2 splits the responsibilities:**

| Component | Owns | Doesn't own | Pure? |
|---|---|---|---|
| **Principal Registry** | Minting principals, binding them to channels, the on-behalf-of chain, revocation of identities | Decisions | No (state) |
| **Policy Authority** | `evaluate()` over a versioned snapshot: floor, manifests, ceilings, grants, workspace, admin, caller chain; prompt eligibility; the egress-compatibility rule | Enforcement | **Yes**, given the snapshot |
| **Grant store** | Grants, epochs, compare-and-swap commits, expiry, audit of changes | Decisions | No |
| **Policy Compiler** | `compileLaunchPolicy(principal, snapshot) → ILaunchPolicy` (immutable, hashed) and backend profile text | Launching | **Yes** |
| **Execution Supervisor (`SandboxManager`)** | Probing backends, spawning, external attestation, the go byte, resource accounting, crash restarts, tree termination, applying revocations | Deciding permissions | No |
| **Attestor** | Per-backend external evidence; the canary; the evidence record | — | No |
| **Brokers** | Enforcing Authority decisions on every request, race-free I/O, audit | Their own allow lists | No |

`SandboxManager` keeps its name and its branch API (`prepare`, `run`, `dispose`, `IPreparedSandbox`). It loses composition and live grants to the Authority and the network broker. That is a refactor of the branch, not a rewrite (M.2, C2).

---

## Part D. Threat model

### D.1 Assets

| Id | Asset | Examples |
|---|---|---|
| A1 | User credentials | `~/.ssh`, cloud CLIs, keychain items, `.env*`, provider tokens, browser cookies and profiles, **secrets in other processes' environments** (B-12) |
| A2 | Volt's own secrets | volt-server master token, host MCP secret, device tokens, broker keys, `~/.volt/trust/**` |
| A3 | Code that runs later | git internals (`commondir`, `config`, `hooks`), shell rc, LaunchAgents, systemd user units, Windows Run keys, `.vscode/tasks.json`, MCP configs, **agent CLI state** (`~/.claude.json`, `settings*.json`, `CLAUDE.md`, skills), worktree setup files, build entries (`package.json` scripts, `Makefile`, `build.rs`, `.cargo/config.toml`, `pyproject.toml`, `.github/workflows/**`, `.envrc`, `.husky`, `.pre-commit-config.yaml`, `.devcontainer`) |
| A4 | Volt's privileged positions | macOS TCC grants (Full Disk Access, Accessibility, Screen Recording, Microphone, Speech), the update channel, unsandboxed spawning, the user's signed-in in-app browser profile |
| A5 | Other chats | transcripts, queues, terminals, worktrees |
| A6 | Release keys | Developer ID, Authenticode, feed key, plugin signing key, CI secrets |
| A7 | Files outside the task | the rest of home, other projects |
| A8 | Availability and money | CPU, memory, disk, process slots, provider quotas |
| A9 | The user's attention | prompts, notifications (fatigue is an attack) |

### D.2 Adversaries

| # | Adversary | Capability assumed |
|---|---|---|
| ADV1 | **Prompt injection** in model input (web pages, issues, files, tool output, MCP descriptions) | Arbitrary instructions to an agent with the agent's authority |
| ADV2 | **Malicious agent-generated code** | Arbitrary code inside the chat's sandbox, persistent across turns |
| ADV3 | **Malicious repository** | Controls every file in the workspace, including dotfiles, before Volt opens it |
| ADV4 | **Compromised dependency** of the user's project or of a plugin | Code at install time (lifecycle scripts) and at run time |
| ADV5 | **Malicious plugin or extension** | Arbitrary code in its host; can publish updates |
| ADV6 | **Malicious or rug-pulled MCP server** | Arbitrary tool descriptions and outputs; code in its process |
| ADV7 | **Compromised Volt supply chain** | Push to the feed branch, a poisoned build dependency, a stolen key, or a CI cache |
| ADV8 | **Local unprivileged process or another OS user** | Connect to loopback, signal same-user processes, read world-readable files |
| ADV9 | **Network attacker** | MITM, DNS answers, rebinding, LAN access to volt-server in network mode |
| ADV10 | **Stolen device, token or paired phone** | Valid credentials until revoked |
| ADV11 | **Buggy first-party code** (confused deputy) | Correct identity, wrong request |

### D.3 Threat catalogue

Every threat has a preventive control, a detection mechanism, a recovery path and an adversarial test from Part K. Layers: OS (backend), POL (composition and floor), AUTH (identity and listener auth), BRK (broker checks), NET (network broker), SIGN (signatures), UX (prompts and visibility), REV (revocation and review).

| Id | Threat | Example | Prevent | Detect | Recover | Test |
|---|---|---|---|---|---|---|
| T-01 | Prompt injection drives tools | A web page tells the agent to `terminal_start curl … \| sh` | OS sandbox on every agent path (B-06); egress rules; critical class never prompt-grantable | Audit log of tool calls with source labels; denial cards | Kill the chat's principal; revoke its session grants; restore a checkpoint | LIFE-INJ-1..5 |
| T-02 | Malicious agent code | `yes > big`, `grep -r /`, a fork bomb, port scan, exfil | OS + rlimits/cgroups + network broker | Resource accounting; denial stream | Tree kill; quota reset | SEC-DSEC-* |
| T-03 | Malicious repository | `.mcp.json` server, `.vscode/tasks.json`, `.git/config` fsmonitor, `.envrc`, symlinks to `~/.ssh`, hard links, a repo `.volt/sandbox.json` widening | Trust gate + content-pinned approvals (B-02); HostGit (B-03); narrow-only repo layers (B-32); symlink-safe host reads (B-15) | "Ignored widening" notices; build-entry diff | Revert files; drop approvals | REPO-1..9 |
| T-04 | Compromised dependency | npm `postinstall` steals tokens (Shai-Hulud, s1ngularity [src]) | Installs run under the chat or `package-fetch` principal with no credential reads and allow-listed registries; secrets never in env (B-12) | Network denials; build-entry diff | Kill; rotate the affected tokens (the UI lists which were reachable) | DEP-1..3 |
| T-05 | Malicious plugin | Reads `~/.ssh`, republishes itself (GlassWorm [src]) | Per-extension OS host; credential floor; network none by default; signer pinning; scan | Activity tab; denial telemetry; scan hits | Revocation list; disable; drop grants | PLG-1..8 |
| T-06 | MCP tool poisoning, rug pull, shadowing | Description says "also read ~/.ssh and pass it as `ctx`" | Pinned tool-list hash; namespaced tools; long or imperative descriptions flagged; outputs labelled untrusted; T4 sandbox | Diff on change | Re-approval; disable the server | MCP-1..6 |
| T-07 | Volt supply-chain compromise | Feed rewritten to a malicious build | Protected Environment, signed feed, platform signature check, attestations; ceilings compiled into core | Signature failures reported; attestation verify in CI | Revoke the key epoch; ship a fixed build; kill switch to `ask` | SUP-1..7 |
| T-08 | IPC spoofing | Extension passes another's id; agent uses another chat's URL | Identity from channel (INV-01); per-chat HMAC | Mismatch counters | Kill the offending principal | IPC-1..6 |
| T-09 | Cross-plugin escalation | Plugin A calls plugin B's command to reach B's grants | Commands private by default; attenuation; egress compatibility | Denials | Revoke | XPL-1..4 |
| T-10 | Sandbox escape | Mount or namespace syscalls, `AF_VSOCK`, IPC socket, SIGUSR1 inspector, launchd submit, AppleEvents, `wsl.exe`, COM brokers | Backend profiles + seccomp allow lists + env from nothing + floor | Escape suite each release | Hotfix the profile; refuse the backend version | ESC-E1..E24 |
| T-11 | Persistence | Agent config (B-05), LaunchAgents, shell rc, git internals, hooks, worktree setup, `.claude/skills` | Execution-bearing files unwritable (INV-15); no implicit execution of sandbox-written code (INV-14) | Build-entry guard; file hash ledger for agent state | Restore from the ledger; show diffs | PERS-1..8 |
| T-12 | Resource exhaustion | Memory bomb, fork bomb, disk fill, 1,000 hosts | cgroups (Linux), polling + kill (macOS, Windows), host budget, tmpfs size, broker byte budgets | Accounting events | Kill + backoff; mark broken | RES-1..6 |
| T-13 | Network exfiltration | DNS tunnelling, domain fronting, webhook sites, browser beacons, a plugin's own grant | Broker as the only resolver; mDNSResponder denied (macOS); exfil-capable list; browser partition proxy (B-16); egress compatibility (B-22) | Denials; per-host byte counters | Revoke the host; kill | NET-1..20 |
| T-14 | Credential theft | `~/.aws`, keychain, other process env (B-12), symlink via host search (B-15), secrets returned raw | Floor; secrets by reference; no secrets in env; symlink-safe host reads | Canary files in CI; secret-use audit | Rotate; the UI shows which principals could reach which secrets | CRED-1..8 |
| T-15 | Update rollback or freeze | Old vulnerable build re-served | Monotonic version in a signed feed; feed expiry; later TUF timestamp role | Expired-feed warning | Refuse and alert | SUP-4,5 |
| T-16 | Revocation failure | Revoked plugin keeps running; revoked grant still works through an open tunnel or fd | Revocation kills or relaunches; tunnels closed; mediated I/O for revocable file grants; epoch checks on every broker call | Revocation latency metric | Force-kill | REV-1..5 |
| T-17 | Remote client compromise | Stolen phone approves a persistent grant | Scoped, expiring tokens; step-up; local owner confirm for high-risk; server re-derives | Device activity log | Revoke the device; pending approvals die | REM-1..6 |
| T-18 | Race conditions | Symlink flip during host write (B-17), path swap before bind (B-33), grant check vs use | Handle-based I/O; `--bind-fd`; CAS on epochs; decision bound to `(principal, epoch)` | Race tests in CI | n/a | RACE-1..6 |
| T-19 | Denial of service against Volt | Pairing lockout (B-24), proxy slowloris, prompt floods, crash loops | Per-source limits; timeouts; prompt budgets; restart budget | Counters | Backoff; mark broken | DOS-1..6 |
| T-20 | Confused deputy in first-party code | `volt.browser.automate` for any caller (B-09); post-turn check (B-04) | ExecContext on every call; internal-only commands; spawn audit | Spawn-audit CI | Hotfix | DEP-1..; B-04 tests |
| T-21 | Permission-UX attacks | Forged denial rows (B-34), misleading text, timing | Only broker-recorded denials get buttons; Volt-authored text; inert buttons; budgets | Prompt telemetry | Auto-deny after 2 refusals | UX-1..6 |
| T-22 | Local process attacks Volt listeners | Owner token (B-01), host MCP cross-chat (B-07), inspector via signal (B-19) | Listener auth library; `--disable-sigusr1`; floor denies signals | Auth-failure counters | Rotate the token epoch | LST-1..8 |
| T-23 | Webview and browser escapes | `localResourceRoots: ['/']` (B-23); popups to OS handlers (B-37) | Core-owned roots and CSP; window-open handler | Webview egress denials | Close the webview | WEB-1..6 |
| T-24 | TCC hijack | Swapped helper (B-14); inherited grants (B-13) | Signed helpers verified before launch; disclaim | Signature failures | Refuse the helper | MAC-TCC-1,2 |

### D.4 Residual risks accepted for v1

Each residual is shown to the user where it applies and tracked as an expected-fail test.

1. **Exfiltration through the agent's own provider channel.** The control is what the agent can read.
2. **Domain fronting through an allowed CDN.** No TLS inspection.
3. **macOS:**
   - other processes' environments readable (B-12) until a fix is found;
   - no tree containment for double-fork plus `setsid` (survivors stay sandboxed);
   - no hard memory cap;
   - `RLIMIT_NPROC` is per user.
4. **Windows:**
   - DNS lookups through the host DNS Client (MXC#1666);
   - no OS resource limits;
   - Git Bash refused;
   - ambient `ALL APPLICATION PACKAGES` reads of system files.
5. **Linux:** paths that don't exist at launch can't be protected by bind mounts. Landlock or broker writes cover them where available.
6. **Hard links that already exist** in a writable root and point at secrets. A bounded scan marks the run `partial`.
7. **Trusted core (T1) bugs** have renderer-wide blast radius.
8. **Side channels and kernel 0-days** are out of scope. The surface is still shrunk (seccomp, deny-default).

### D.5 Out of scope

- Malware already running unsandboxed as the user. Note that B-01 and B-19 make *any* such process an owner of Volt, which is in scope.
- Physical access.
- A compromised OS vendor signing chain.

---

## Part E. Security invariant catalog

Each invariant names where it is enforced, the executable tests that prove it (Part K) and the platforms where it holds. "Residual" marks platforms where the invariant is known not to hold; that test is expected to fail and is tracked.

| Id | Invariant | Enforced at | Tests | Platforms |
|---|---|---|---|---|
| INV-01 | No workload can forge its principal. Identity is the channel; payload ids are ignored or must match | Registry, every `MainThread*` customer, host MCP HMAC, broker RPC | IPC-1..6 | All |
| INV-02 | No principal gains authority or egress by invoking another principal or acting for an agent | Authority (attenuation + egress compatibility) | XPL-1..4, PERM-FLOW-1 | All |
| INV-03 | Every process started for a non-user principal is started by the supervisor with that principal | Supervisor + spawn-audit CI gate | SPAWN-AUDIT, LIFE-PATH-* | All |
| INV-04 | No unsupported dimension is reported as enforced | Backend reports + compiler | DIFF-1, PROBE-* | All |
| INV-05 | A failed probe, launch, attestation or canary never runs the workload unsandboxed | Supervisor | FAULT-1..12 | All |
| INV-06 | No sandbox reports success without external evidence, and the workload runs only after it | Attestor + go byte | ATTEST-1..4, FAULT-1 | All |
| INV-07 | Every Volt listener authenticates every request with a secret; Host, Origin, peer address and loopback never authenticate | Listener library + lint | LST-1..8 | All |
| INV-08 | Tokens are scoped and expiring; a revoked token or device stops working within 5 s | Token service | REM-1..6 | All |
| INV-09 | No plugin can read or write another plugin's storage, secrets, state or webview origin | Per-subject storage roots, secret namespaces, per-host id sets, core-derived origins | PLG-ISO-1..5 | All |
| INV-10 | Commands are private by default; internal commands can't be run from an extension host | `MainThreadCommands` + Authority | XPL-CMD-1..3 | All |
| INV-11 | A child, delegate or handoff never runs with a weaker level, wider roots, wider network or weaker strategy than its parent | Authority (`covers`) used by host tools and launcher alike | GATE-SPAWN-1..6 | All |
| INV-12 | Host-side operations for a sandboxed principal obey its policy on real paths, race-free | File broker (handle-based) | RACE-1..3, GATE-SYM-1 | All |
| INV-13 | An unknown, unbound or expired principal is denied | Registry + brokers | IPC-5, FAULT-9 | All |
| INV-14 | Volt never implicitly executes code a sandboxed principal could have written. A user-reviewed action is the only way | HostGit, check runner, worktree setup, MCP host, hooks | PERS-1..8, B-04 tests | All |
| INV-15 | Execution-bearing paths (A3) are unwritable from every sandbox | Floor + backend profiles | PERS-1..8 | macOS, Linux, Windows; Linux paths not existing at launch are a residual unless Landlock ABI ≥ 1 is present |
| INV-16 | Host git never runs repository-controlled code implicitly | HostGit wrapper + lint | GIT-1..4 | All |
| INV-17 | Agent CLI config and instruction files are never writable from the sandbox | Footprints (allow-list form) | PERS-AGENT-* | All |
| INV-18 | No untrusted policy layer widens any dimension, including through symlinks or wildcard ports | Authority composition (property-tested) | POL-PROP-1..8 | All |
| INV-19 | All network egress of a principal, including its webviews and browser partition, passes the broker's rules | Backend network rules + browser partition proxy + webview CSP | NET-1..20, WEB-1..6 | macOS, Linux; Windows except the DNS residual |
| INV-20 | Webview resource roots ⊆ the owning principal's readable set | Core webview service | T3-WEBVIEW-1 | All |
| INV-21 | No repo-supplied executable config runs without Workspace Trust and a content-pinned approval | MCP host, tasks, hooks, worktree setup | REPO-1..9 | All |
| INV-22 | An approved MCP server or tool list that changes is not used until re-approved | MCP host | MCP-1..6 | All |
| INV-23 | No revoked grant remains usable: brokers within one request, network within 1 s (tunnels closed), OS-level by relaunch or kill within 5 s | Grant store epochs + supervisor | REV-1..5 | All |
| INV-24 | No secret is placed in the environment or argv of any Volt-spawned process | Supervisor env builder + lint | MAC-ENV-2, ENV-1 | All (macOS reason: B-12) |
| INV-25 | Sandboxed processes are not attributed to Volt for TCC | macOS backend | MAC-TCC-1 | macOS |
| INV-26 | A sandboxed chat can't read other chats without `agents.read:other` | Host-tool gate via Authority | GATE-XCHAT-1..3 | All |
| INV-27 | Helpers and sandbox binaries are verified immediately before every launch | Supervisor | HELPER-1..4 | All |
| INV-28 | An update installs only with a valid channel signature, a valid platform code signature and a version above the installed one | Updater | SUP-1..5 | All |
| INV-29 | An extension installs only with a valid registry signature, or as an explicitly unsigned third-party extension | Extension installer | SUP-6,7 | All |
| INV-30 | No host accepts a debugger via signal, env or CLI argument | Launcher args + fuses + floor | HOST-SIG-1..3 | All |
| INV-31 | Every UI label matches the principal's attested state; T1 is labelled "Trusted core" | Security page + status model | UX-LABEL-1..3 | All |
| INV-32 | `evaluate` is deterministic: the same snapshot epoch and request give the same decision | Authority (pure) | POL-DET-1 (replay of logged decisions) | All |
| INV-33 | Credentials outside a principal's declared authority are unreadable | Floor | CRED-1..8 | All. macOS env residual (B-12) |
| INV-34 | Stopping a principal terminates its whole tree | Supervisor | TREE-1..4 | Linux, Windows guaranteed; macOS best effort, survivors stay confined |
| INV-35 | A resource-limit violation terminates the offender and never degrades the host | Supervisor accounting | RES-1..6 | Linux hard limits; macOS and Windows by polling |
| INV-36 | Every privileged broker operation is audited with principal, chain, decision and epoch | Brokers | AUDIT-1 | All |
| INV-37 | Secrets are never returned raw to a principal without `secrets.read` (critical) | Secrets broker | CRED-6 | All |
| INV-38 | A remote client can't change a grant: the server re-derives it from its own record and requires step-up for high risk | Grant service | REM-3..6 | All |

---

## Part F. SandboxManager and the execution core

All of this runs on the execution host. Files are under `src/vs/platform/voltSandbox/` unless stated. `common/` holds the pure parts, `node/` the rest.

### F.1 Principals

```ts
/** Who a grant is about: stable across restarts and instances. */
export type SubjectKey =
  | `plugin:${string}@${string}`        // `${publisher}.${name}@${signerFingerprint}`; unsigned local: `@local:${sha256(path)}`
  | `firstparty:${string}`              // `volt.<feature>` (out-of-process logic only)
  | `chat:${string}`                    // chat id; the agent CLI and everything it starts
  | `mcp:${string}`                     // sha256 of the canonical server config
  | `mcp-http:${string}`
  | `helper:${string}`                  // signed helper id
  | `package-fetch:${string}`           // lockfile digest
  | 'user';                             // only for user-action spawns; never minted for a sandbox

/** One running instance. Minted by the registry, never by the workload. */
export interface IPrincipal {
  readonly id: string;                  // 128-bit random, base64url
  readonly subject: SubjectKey;
  readonly kind: 'agent' | 'mcp' | 't2' | 't3' | 't3-web' | 'helper' | 'task' | 'package-fetch';
  readonly packageDigest?: string;      // sha256 of the installed bundle (plugins, extensions)
  readonly signer?: string;             // fingerprint or 'volt' or 'local'
  readonly executionHost: string;       // server instance id
  readonly parent?: string;             // principal id this one was started for (tasks, children)
  readonly launchPolicyHash: string;    // F.3
  readonly createdAt: number;
}

/** Carried on every broker request and every spawn. Built by core from channels, never from payloads. */
export interface ICallContext {
  readonly principal: IPrincipal;                  // the immediate caller (from the channel)
  readonly onBehalfOf: readonly IPrincipal[];       // outermost first: e.g. [chat, plugin]
  readonly gesture?: IUserGestureToken;            // G.7
  readonly requestId: string;
}
```

**Rules:**
- **Registry state.** The registry keeps `channelId → principal`. A channel belongs to exactly one principal, for the principal's life. Closing it revokes the principal.
- **Grants attach to the subject; decisions are about the principal.** Each decision also binds the principal's `launchPolicyHash` and the snapshot epoch (G.2).
- **The on-behalf-of chain is built by core** when it routes a call: a tool invoke, a command, `chats.send`, a hook. Payloads can't extend it.
- **The `user` subject is never a sandbox principal.** It marks spawns that the user's own click started, through a short allowlist of call sites (K.4).

### F.2 The authority interface used by the execution core

Part G specifies the semantics. The supervisor and brokers see only this:

```ts
export interface IPolicyAuthority {
  readonly epoch: number;                                         // snapshot version; bumps on any grant/policy change
  evaluate(req: IAccessRequest, ctx: ICallContext): IDecision;     // pure over the current snapshot
  launchView(principal: IPrincipal): ILaunchView;                  // what the compiler needs; pure
  onDidChange: Event<{ epoch: number; subjects: readonly SubjectKey[]; narrowed: boolean }>;
}
export interface IDecision {
  readonly allow: boolean;
  readonly epoch: number;
  readonly deniedBy?: 'floor' | 'manifest' | 'authority' | 'caller' | 'workspace' | 'admin' | 'egress-compat' | 'platform';
  readonly promptable?: IPromptOffer;                              // only if deniedBy === 'authority' and G.3 allows it
  readonly reason: string;                                         // Volt-authored text
}
```

### F.3 Launch policy (schema v2)

The compiler turns `launchView(principal)` into an immutable launch policy, hashed with SHA-256 over its canonical JSON. Rules carried over from the branch's v1 parser (`sbx:common/sandboxSchema.ts`):
- unknown fields fail;
- text is NFC;
- no `..` and no control characters;
- lists have caps;
- `write` can't be `/` or `${home}`;
- a missing field means the most restrictive value.

v1 stays parseable as generation 0.

```ts
export interface ILaunchPolicy {
  readonly schemaVersion: 2;
  readonly targetPolicy: number;                 // G.9
  readonly subject: SubjectKey;                  // filled by core only
  readonly lifetime: 'command' | 'host';
  readonly filesystem: {
    readonly read: readonly string[];
    readonly write: readonly string[];
    readonly writeMode: 'bind' | 'broker';       // broker: no writable binds; writes go through the file broker (T2 default)
    readonly deny: readonly string[];            // floor + profile; mandatory
    readonly denyPatterns: readonly string[];    // `**/.env` etc.; MANDATORY dimension (B-27)
    readonly protect: readonly string[];         // read-only inside writable roots; allow-list form for .git (B-03)
    readonly unmask: readonly string[];          // trusted layers only
  };
  readonly network: {
    readonly mode: 'none' | 'broker' | 'host';   // host = critical class
    readonly route?: string;                     // broker route id (F.5); filled by core
    readonly listen: { readonly ports: readonly number[] } | false;   // B-30: explicit ports only
    readonly local: 'none' | 'broker';           // LAN only through broker rules (I.4)
  };
  readonly process: {
    readonly spawn: 'any' | 'none';              // 'none' unsupported on Windows (J.3)
    readonly tty: 'none' | 'own';                // 'own' = /dev/tty + inherited pty fds only (B-26)
  };
  readonly resources: { readonly cpuSeconds?: number; readonly memoryMB?: number; readonly pids?: number;
                        readonly diskMB?: number; readonly fileSizeMB: number; readonly openFiles: number; readonly wallClockSeconds: number };
  readonly env: { readonly allow: readonly string[]; readonly set: Readonly<Record<string, string>> };  // allow-list only (B-41)
  readonly ipc: { readonly channels: readonly ('rpc' | 'status' | 'pty')[] };  // fds created by the supervisor; nothing else
  readonly host: { readonly unixSockets: readonly string[]; readonly systemServices: 'none' | 'agent' };
  readonly platform: { readonly tcc: 'disclaim' | 'inherit' };  // inherit only for signed helpers
  readonly bestEffort: readonly SandboxDimension[];   // may only contain dimensions the floor marks optional (F.13)
}
```

**Changes from revision 1:**
- `principal` becomes `subject`.
- `network.allow` moves out of the launch policy into broker grants. The OS layer only knows the route.
- `listen` becomes explicit ports.
- `env.inherit` becomes an allow list.
- `tty`, `denyPatterns`, `platform.tcc` and `writeMode` are added.
- `bestEffort` can no longer contain credential, network, IPC or execution-bearing dimensions; the compiler rejects that.

**Mandatory vs optional dimensions:**

| Mandatory (refuse if not enforced) | Optional (may be `partial`, shown) |
|---|---|
| `filesystem.read`, `.write`, `.deny`, `.denyPatterns`, `.protect` (existing paths) | `filesystem.protectNew` (paths created after launch) |
| `network.mode`, `network.listen` | `resources.memoryMB`, `resources.pids`, `resources.cpuSeconds` on macOS and Windows |
| `ipc.*`, `host.unixSockets`, signals outside the sandbox | `process.tree` on macOS |
| `process.spawn: none` when requested | `platform.tcc` on macOS < 14 **[assumption]**: the disclaim SPI's minimum version is unverified |
| `env` (allow list) | |

### F.4 Supervisor API

```ts
export interface IVoltSandboxService {
  capabilities(): Promise<ISandboxBackendReport>;           // real trial per backend; cached per (backend, OS build, binary digest)
  start(req: IStartRequest): Promise<ISandboxedProcess>;    // resolves only after attestation + go byte
  run(req: IStartRequest & { lifetime: 'command' }, o?: IRunOptions): Promise<IRunResult>;   // refusal is a status, never a throw
  list(): readonly ISandboxedProcessInfo[];
  readonly onDidChangeStatus: Event<ISandboxStatusChange>;
}

export interface IStartRequest {
  readonly principal: IPrincipal;                            // minted by the registry before the call
  readonly command: { readonly file: string; readonly args: readonly string[]; readonly cwd: string } |
                    { readonly fork: string; readonly execArgv: readonly string[] };   // Node host: ELECTRON_RUN_AS_NODE child
  readonly restart?: { readonly maxPerMinute: number };
  readonly pty?: { readonly cols: number; readonly rows: number };
}

export interface ISandboxedProcess {
  readonly principal: IPrincipal;
  readonly backend: 'seatbelt' | 'bubblewrap' | 'mxc';
  readonly status: 'running' | 'partial';
  readonly unenforced: readonly SandboxDimension[];
  readonly attestation: IAttestation;                        // F.12
  readonly rpc?: IChannel;                                   // only after the go byte
  relaunch(reason: string): Promise<void>;                   // same subject, new principal id, policy recompiled
  terminate(reason: string): Promise<void>;
  readonly onExit: Event<{ code: number | null; signal: string | null; reason: ExitReason }>;
  readonly onResource: Event<IResourceSample>;
}
```

`prepare`, `run` and `dispose` on the branch stay as thin wrappers until their callers move (M.2, C2).

### F.5 Launch protocol

```mermaid
sequenceDiagram
  participant C as Caller (core service)
  participant R as Registry
  participant A as Authority
  participant P as Compiler
  participant S as Supervisor
  participant B as Backend
  participant W as Prologue / workload
  C->>R: mint(subject, kind, parent)
  R-->>C: principal
  C->>S: start(principal, command)
  S->>A: launchView(principal)
  A-->>S: view (epoch e)
  S->>P: compile(view, backendReport)
  P-->>S: launch policy + hash, or Refuse(dimension)
  S->>S: verify binaries (wrapper, helper, workload interpreter) signatures/digests
  S->>S: resolve paths to realpaths, open roots O_PATH|O_NOFOLLOW (Linux), build env from nothing
  S->>S: set up broker route + token, status pipe, RPC socketpair, go pipe
  S->>B: launch(policy, fds)
  B->>W: OS sandbox applied, exec prologue
  W->>S: status: "ready <pid>" (informational only)
  S->>S: EXTERNAL attestation of pid (F.12)
  S->>S: canary results from prologue checked against expected error classes
  alt attestation or canary fails
    S->>W: kill tree; status failed; refuse
  else ok
    S->>W: go byte
    W->>W: exec workload
    S-->>C: ISandboxedProcess (rpc channel opened now)
  end
```

**Step rules:**
1. **Order.** The supervisor never execs the workload before attestation. The prologue is a tiny fixed program owned by Volt: `/bin/sh` script text on macOS today, and a static helper later. It runs inside the sandbox, writes `ready`, runs the canary, and **blocks on one byte from the go pipe**. Any other byte, EOF or a timeout makes it exit 125. This fixes B-29.
2. **External attestation** (the parent observes; the workload can't influence it):

   | Backend | Evidence the parent collects |
   |---|---|
   | Seatbelt | `sandbox_check(pid, NULL, SANDBOX_FILTER_NONE) == 1`. It worked from an unsandboxed parent on macOS 26.6 [test]. Plus spot checks `sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH, <credential sentinel realpath>) == 1` and `"network-outbound"` when the mode is not `host`. Private SPI exported by libsystem_sandbox, so the Attestor checks it exists at probe time and refuses if missing |
   | bubblewrap | The parent reads `/proc/<child-pid>/status` from the host side: `NoNewPrivs: 1`, `Seccomp: 2`, `Seccomp_filters ≥ 1`. It compares `/proc/<child-pid>/ns/{mnt,pid,ipc,uts,user,net,cgroup}` inodes with its own: all different, net different unless `host`. It checks the cgroup path is the run's scope. bwrap's JSON `child-pid` is used only to find the pid; its line precedes setup [src] |
   | MXC | The parent opens the child process: `GetTokenInformation(TokenIsAppContainer) == TRUE`, the `TokenAppContainerSid` is the run's container SID, `IsProcessInJob(child, job) == TRUE` with the job handle MXC returns, and `QueryInformationJobObject` UI limits ⊇ the policy's. **[open]** Whether `wxc-exec` exposes the job handle or container SID to the parent; if not, Volt calls the PSEC API through a small signed helper (decision D-03) |

3. **Canary.** The prologue tries, and reports the *error class* of, each of these:
   - an `open()` of a sentinel credential file the floor denies (expect `EPERM`/`EACCES`; on Linux the path may be absent, so expect `ENOENT` because it's masked);
   - a TCP connect to a non-route address, which must fail immediately with `EPERM` (macOS), `ENETUNREACH` (Linux netns) or `WSAEACCES` (Windows). A connect that goes into `SYN_SENT`, i.e. doesn't fail within 50 ms, fails the canary;
   - when not `host`, a connect to the supervisor's canary listener on loopback, which must fail.

   The canary only means anything because attestation already proved who ran it.
4. **Channels.**
   - RPC, status and go are created by the supervisor as anonymous pipes or socketpairs and passed by fd number, never by path.
   - On Windows they are named pipes under `\\.\pipe\LOCAL\volt-<random>` with an explicit DACL for the container SID, `FILE_FLAG_FIRST_PIPE_INSTANCE` and `PIPE_REJECT_REMOTE_CLIENTS` [src]. The broker opens pipes the sandbox might own with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`.
   - Core accepts no RPC on a channel until the go byte is sent.
5. **Refusal.** A refusal is a typed status: `{ refused: dimension | 'probe' | 'attest' | 'canary' | 'binary' | 'budget', reason }`. It never throws into a path that retries without the sandbox. The only way to run without a sandbox is the user's `Off` control, which is a different code path with its own principal kind (`user`).

### F.6 Lifecycle state machine

```mermaid
stateDiagram-v2
  [*] --> Requested
  Requested --> Refused: compile/probe/budget refuses
  Requested --> Launching
  Launching --> Attesting: prologue ready
  Launching --> Failed: launch error
  Attesting --> Running: attested + canary ok + go byte
  Attesting --> Failed: evidence missing/wrong
  Running --> Idle: no RPC/UI/tool use for idle budget (hosts only)
  Idle --> Running: activation event
  Idle --> Stopped: idle stop
  Running --> Relaunching: OS-level grant change
  Relaunching --> Launching
  Running --> Crashed: unexpected exit
  Crashed --> Backoff
  Backoff --> Launching: within restart budget
  Backoff --> Broken: budget exhausted
  Running --> Stopping: terminate / revoke / update
  Stopping --> Stopped: tree gone (or survivors confined, macOS)
  Failed --> [*]
  Refused --> [*]
  Stopped --> [*]
  Broken --> [*]
```

**PTY workloads.** node-pty can't pass extra fds, so the prologue gets the status and go channels as a 0600 FIFO pair in the run directory, which no other principal can read (`~/.volt/sandbox/runs/<id>` is denied to every other principal, B-35). Until this exists, host terminal tools stay refused for sandboxed chats, which is today's branch behaviour.

### F.7 Process creation and environment sanitisation

1. **Spawn path.** Only `SandboxSupervisor.start/run` and the `user` path may call `child_process`, `utilityProcess`, `Worker` with `eval`, or `vm`. A spawn-audit gate in CI enforces this (K.4). The branch's `childLedger` remains the record of user-path children.
2. **Environment from nothing:**
   - The workload env = `env.allow` names copied from the host, plus `env.set` from trusted layers, plus the launcher-reserved names written **last**.
   - Reserved names: `NODE_CHANNEL_FD`, `NODE_OPTIONS` (always unset), `ELECTRON_RUN_AS_NODE` (set only for Node hosts), `VSCODE_*`, proxy variables, `VOLT_SANDBOX_*`.
   - Untrusted layers may only set names that match `^[A-Z][A-Z0-9_]{0,63}$` and are not secret-like, reserved or injection names.
   - The caller's `context.env` (provider launch specs) gets the same checks. Today it gets a reserved-only check (`sbx:sandboxResolver.ts:272-280`, revision 1 finding).
3. **Wrapper environment.** `sandbox-exec`, `bwrap` and `wxc-exec` run as the user before the sandbox exists, so each gets a fixed minimal env: `PATH=/usr/bin:/bin`, plus `LANG` on macOS and Linux, `SystemRoot` on Windows. bwrap already gets `{}` (`sbx:bubblewrapBackend.ts:337-338` [code]).
4. **No secrets in env or argv** (INV-24). Provider credentials reach the CLI through one of three channels:
   - the CLI's own credential store, read-only, outside the floor: e.g. Claude's `.credentials.json` is readable by *its own* chat principal only;
   - a 0600 file in the run directory, named by an env var that holds a path, not a secret;
   - the network broker's header injection for HTTP APIs (I.3).
5. **Handle inheritance:**
   - POSIX: the backend closes every fd ≥ 3 except the channels (`close_range` on Linux ≥ 5.9, an fd sweep on macOS).
   - Windows: `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` with exactly the channel handles [src].
   - A test opens 64 extra fds before launch and checks none survive. The branch already tests fds 3–64.
6. **Working directory and PATH:**
   - `cwd` is a realpath inside a readable root.
   - `PATH` never contains a writable root ahead of system folders.
   - On Windows, Volt's own helpers call `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`. It isn't inherited [src], so MXC children rely on the image-load mitigation policy where MXC exposes it **[open]**.

### F.8 Resource accounting

| Resource | Linux | macOS | Windows (MXC) |
|---|---|---|---|
| Memory | cgroup v2 `memory.max` + `memory.oom.group=1` via `systemd-run --user --scope` when the user manager delegates `memory` (systemd ≥ 252 delegates `pids memory cpu` by default [src]); else `partial` | Poll `proc_pid_rusage` footprint for every tracked pid at 1 Hz; kill over the limit (`partial`) | Poll the job's `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` peak or per-process working sets; kill over the limit (`partial`). MXC has no limit fields [src] |
| Processes | `pids.max` | `RLIMIT_NPROC` is per user [src], so `partial`; a fork-rate watchdog kills the tree | Poll the active process count; kill (`partial`) |
| CPU | `cpu.max` | `RLIMIT_CPU` per process + accounting poll | Poll and kill |
| File size | `RLIMIT_FSIZE` | `RLIMIT_FSIZE` | Volume quota not available; per-run disk poll (`partial`) |
| Disk | tmpfs `size=` for `${tmp}`; poll writable roots' growth | Poll | Poll |
| Wall clock | Supervisor timer | Same | Same |
| Open files | `RLIMIT_NOFILE` | Same | Job handle limits via MXC UI isolation; otherwise none |
| Network bytes and connections | Broker budgets | Same | Same |
| RPC rate | Channel rate limiter (token bucket per principal) | Same | Same |

Accounting emits `IResourceSample` at 1 Hz for hosts and per command for one-shot runs. A violation kills the principal's tree, records `ExitReason.resource`, and counts against the restart budget.

### F.9 Runtime permission changes and revocation

| Change | Applies | Mechanism | Latency budget |
|---|---|---|---|
| Network host or local-network grant | Live | Broker rule on the subject; CAS on the epoch | Next connection |
| Network revoke | Live | Rule removed; open tunnels for that rule closed | ≤ 1 s |
| File handle grant (one-shot read) | Live | The broker opens and passes an fd **only for `once` reads**. Documented as non-revocable after delivery | n/a |
| File or folder grant (revocable) | Live | Mediated I/O through the file broker (no fd); every op checks the epoch | Next op |
| Workspace write, exec, socket, listen port, tty, systemServices | Relaunch | New launch policy; the old process is drained and killed | ≤ 5 s |
| Any narrowing of the launch policy | Relaunch or kill | Same; if the principal can't be relaunched safely (agent mid-turn), it is killed and the turn ends with a notice | ≤ 5 s |
| Plugin disabled, revoked or signer changed | Kill | Tree kill; grants dropped | ≤ 5 s |
| Secret revoked or rotated | Live | `SecretRef` resolution fails at next use | Next use |

**Epoch rule.** Every broker decision records `(principal, epoch)`. A request whose principal's subject was narrowed at an epoch after the principal's last check is re-evaluated before it runs. CAS commits make two concurrent approvals for different hosts both land, in order. Approving the same host twice is idempotent.

**The launch key** is `launchPolicyHash`. Network grants are excluded (the branch already does this, `sbx:sandboxPolicy.ts:526-531` [code]). A network grant never restarts a process.

### F.10 Process-tree termination

| OS | Mechanism | Guarantee |
|---|---|---|
| Linux | `--unshare-pid --die-with-parent`, bwrap spawned from Node's **main thread** (`PR_SET_PDEATHSIG` fires when the creating thread dies [src]). Kill = write `1` to the scope's `cgroup.kill` (kernel ≥ 5.14 [src]) or SIGKILL the namespace's pid 1, which SIGKILLs everything in the namespace [src]. pidfds for signalling | Complete |
| macOS | New process group; kqueue `EVFILT_PROC` `NOTE_FORK`/`NOTE_EXIT` on every known pid; a 1 Hz `proc_listallpids` sweep matching the run's responsible-pid root (disclaimed) and the run tag; SIGKILL. Seatbelt `(allow signal (target same-sandbox))` stops the tree signalling out | Best effort: a double-forked, `setsid`, env-cleared process that also re-disclaims can escape tracking but stays sandboxed [test] |
| Windows | MXC's job with `KILL_ON_JOB_CLOSE` [src]; Volt keeps the job handle (or MXC keeps the container) and closes it | Complete for job members. Surrogate spawns (WMI, Task Scheduler, COM) are outside the job, which is why they must be denied by the container, not caught by the job (J.3) |

### F.11 Crash recovery

- **Workload crash:** restart budget with exponential backoff (1 s, 2 s, 4 s). Three crashes in 60 s marks the principal **Broken**, with its last 64 KB of stderr kept in its own storage. **A principal never restarts with a looser policy.** The policy is recompiled from the current snapshot, which can only be the same or narrower without a new grant.
- **Supervisor crash (volt-server or main exits):**
  - Linux children die with their parent (`--die-with-parent`).
  - Windows jobs close.
  - On macOS the watchdog (`/bin/sh`, the branch's design) kills the group.
  - On restart, the supervisor reads the run ledger (`~/.volt/sandbox/runs/*/ledger.json`), sweeps survivors by tag and responsible pid, deletes stale run directories, and re-validates broker routes. No route survives a supervisor restart.
- **Grant store crash:**
  - Writes are atomic (write temp, `fsync`, rename) with a monotonic epoch.
  - A torn or unparsable store loads as **empty for third-party subjects**, and for first party as ceilings only. The Security page shows "Permissions were reset". Never "allow all".
- **Backend breakage after an OS update:** probe results are keyed by the OS build. A changed build re-probes before the next launch, and `broken` refuses for the session.

### F.12 Attestation record

```ts
export interface IAttestation {
  readonly principalId: string;
  readonly backend: 'seatbelt' | 'bubblewrap' | 'mxc';
  readonly backendVersion: string;            // sandbox-exec n/a; bwrap --version; wxc-exec file version + signer
  readonly osBuild: string;
  readonly launchPolicyHash: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;   // e.g. { sandbox_check: 1, nsMnt: 4026532901, seccomp: 2, appContainerSid: 'S-1-15-2-…' }
  readonly canary: Readonly<Record<string, string>>;                           // e.g. { credOpen: 'EPERM', publicConnect: 'EPERM' }
  readonly unenforced: readonly SandboxDimension[];
  readonly attestedAt: number;
}
```

The Security page shows it. Opt-in telemetry sends `kind`, `backend`, `osBuildBucket`, `status`, `unenforced[]` and the result, never paths or hosts.

### F.13 When the platform can't sandbox

| Situation | Untrusted (agents, MCP, third-party plugins and extensions) | First-party out-of-process logic (T2-fp) |
|---|---|---|
| Platform `unsupported`, a static fact known before launch: Windows below the floor, Linux without user namespaces or bwrap ≥ 0.12, an unsupported architecture | Refuse. The user may set a chat to `Off` (recorded, shown in the status bar). Third-party plugins and extensions don't run | **Degraded mode (D-06):** asked once per machine, "Volt can't sandbox its own plugins on this system. Run them without a sandbox, as before?" Yes → they run in-process (as today), labelled `Not sandboxed (OS unsupported)` on the Security page and in the plugin's chip. No → those features are off |
| Probe `broken`, attestation failed, canary failed | Refuse and kill. No override | Refuse and kill. **Never degraded mode**: a failed attestation can be attacker-induced |

Degraded mode is decided before any launch from the backend report. It is a different code path from the sandboxed launch, so no failure can fall into it. First-party logic therefore has two bindings (T2 and in-process), and both run the same test suite.

---

## Part G. Permission and capability specification

### G.1 Concepts

- **Capability:** `id@version` with a class (`none | low | medium | high | critical`) and a scope schema. Examples: `net.connect@1 {hosts: HostPattern[]}`, `files.read@1 {scope: 'workspace' | Path[]}`, `agents.send@1 {chats: 'current' | 'any'}`.
- **Grant:**

  ```ts
  { id, subject: SubjectKey, capability: 'id@v', scope, kind: 'once' | 'session' | 'workspace' | 'persistent',
    workspace?: string, sessionId?: string, expiresAt?: number,
    source: 'user' | 'ceiling' | 'preset' | 'admin' | 'developer', grantedAt, lastUsedAt, epoch }
  ```

- **Layers**, each a function `Layer(subject, capability, scope, target) → allow | deny | n/a`:

| Layer | Who writes it | Can widen? | Stored |
|---|---|---|---|
| **Floor** | Core (code) | Never (deny-only) | Compiled in |
| **Manifest** | Plugin author | Declares the maximum; grants nothing by itself | Package |
| **Authority grant** | First party: ceiling table. Others: the user (install sheet, prompts, Access page) and signed presets | Yes, up to the manifest | Compiled ceilings; `~/.volt/trust/grants.json` |
| **Workspace restriction** | Repo `.volt/sandbox.json` (trusted workspaces only), Workspace Trust state | Never | Repo + trust store |
| **Admin** | MDM: macOS managed preferences `com.volt.policy`, Linux `/etc/volt/policy.json` (root-owned), Windows `HKLM\Software\Policies\Volt` | Never | OS-protected locations |
| **Caller** | Core, from the on-behalf-of chain | Never | Runtime |
| **Platform** | Backend report | Never (unenforceable mandatory dimension = deny) | Probe cache |

### G.2 The evaluation function

```text
evaluate(req = {capability c, scope s, target t}, ctx) at snapshot epoch e:

  P   = ctx.principal.subject
  chain = ctx.onBehalfOf ++ [ctx.principal]

  1. if Floor denies (c, t)                                   → deny 'floor'
  2. if not Manifest(P) declares c with scope ⊇ s             → deny 'manifest'     (core subjects: built-in manifest)
  3. if not Grants(P, e) cover (c, s, t)                       → deny 'authority' (+ promptable?, G.3)
       Grants(P, e) = Ceiling(P)                       if P is first-party
                    = ∪ valid user/preset/admin grants if not   (valid: not expired, not revoked, epoch ≤ e,
                                                                 workspace/session match)
  4. if Workspace(t) restricts (c, s)                          → deny 'workspace'
  5. if Admin restricts (c, s, t)                              → deny 'admin'
  6. for each caller C in chain except P:
        if evaluate((c, s, t), context of C) denies            → deny 'caller'          (attenuation)
  7. if c is a data-flow edge (tool invoke, chats.send, context, hook) from caller C to P:
        if egress(P) ⊄ egress(C) ∪ FlowApprovals(C → P)        → deny 'egress-compat'   (G.6)
  8. if c maps to a launch dimension the backend can't enforce → deny 'platform'
  → allow (epoch e)
```

**Properties (each property-tested, K.2):**
- **Monotone:** adding a deny anywhere never turns a deny into an allow.
- **Attenuating:** allow(P via chain) ⇒ allow(C) for every C in the chain, for the same request.
- **Floor-dominant:** no input allows a floor-denied target.
- **Ceiling-bounded:** first-party allows ⊆ Ceiling.
- **Deterministic:** the same `(snapshot, request, ctx)` gives the same output (INV-32). Decisions are logged with the epoch and can be replayed.
- **Time-explicit:** expiry is checked against a timestamp in the snapshot, not the wall clock read inside `evaluate`. The snapshot is rebuilt when the earliest grant expires.

Union happens only inside layer 3 (different grant kinds of one subject). Across layers it's an intersection.

### G.3 Prompt eligibility

A denial may offer a prompt only if **all** of these hold:
- `deniedBy === 'authority'`, i.e. no other layer denies;
- the capability class is `low`, `medium` or `high` (critical never);
- the manifest declares it as `optional` or `required`;
- the request carries a valid user gesture token (G.7), or the plugin's own UI is in the foreground and focused;
- the prompt budget isn't exhausted (G.12);
- the denial came from a broker or the OS with a recorded `denialId` (B-34).

Otherwise the denial is silent to the user. It is counted on the plugin's Activity tab, and the API returns `VoltCapabilityError`.

### G.4 Grant kinds

| Kind | Lifetime | Typical source | Example |
|---|---|---|---|
| Install-time | Persistent, until uninstall or revocation | Install sheet for `required` low and medium | `net.connect api.linear.app` |
| Runtime | As chosen in the prompt | First use of `optional` or `high` | `agents.send` |
| Once | One request (one connection, one file op) | "Allow once" | An unexpected host |
| Session | Until the chat or plugin host ends | "Allow for this chat" | Desktop control for one chat |
| Workspace | While the subject runs in that workspace root | "Allow for this project" | `files.write` in repo X |
| Persistent | Until revoked; **expires** after 30 days unused (third party) | "Always allow" | A plugin's API host |
| Picker | Exactly the picked file or folder, mediated I/O | Native picker | `~/Downloads/a.csv` |

**Expiry:**
- Third-party persistent grants expire after 30 days unused; Android 11 auto-reset is the precedent [src].
- High-class persistent grants expire after 90 days regardless.
- First-party ceilings never expire, but drop to "prompt" when revocation metadata is stale (G.10).

### G.5 Revocation

Revocation is:
- a grant-store write (new epoch);
- the Authority's `onDidChange({ narrowed: true })`;
- brokers re-evaluating in-flight work for that subject;
- the network broker closing matching tunnels;
- the supervisor relaunching or killing principals whose launch view narrowed.

INV-23 gives the latency budgets. An fd already delivered for a `once` read is the single documented exception. Revoking a signer, disabling a plugin or receiving a revocation-list entry kills every principal of that subject.

### G.6 The egress-compatibility rule

Data moves when principal C invokes principal P: tool arguments, `chats.send` text, context returned to a chat, hook payloads. Attenuation (step 6) limits what P can *do* for C. It doesn't limit where P can *send what C gave it*.

```text
egress(X) = the set of network destinations X can reach (broker grants ∪ OS host mode = ⊤)
            ∪ the subjects X can pass data to (its own outgoing flow approvals)
Invocation C → P allowed iff  egress(P) ⊆ egress(C) ∪ FlowApprovals(C → P)
```

- `FlowApprovals(C → P)` is a grant on C: "this chat may send data to Linear (api.linear.app) through `linear.sync`", scoped once, this chat or this project.
- First-party principals whose egress is empty (memory, git-graph) are always compatible.
- A chat with network `host` has egress ⊤ and is compatible with everything.
- A network-off chat calling a plugin that has hosts gets a card: "Send this chat's content to api.linear.app via Linear?", with Allow once / for this chat / Refuse.

### G.7 Caller context and gesture tokens

- **Gesture tokens.** Core's UI layer mints a gesture token when it handles a real input event (click, key) inside a Volt-owned element. Its content is `{ id, principal it targets, issuedAt, consumed }`, valid for 1 s and single use. Payloads can't create one. Webviews and iframes can't produce one, since their events don't reach core's handler; a "click" there is a `postMessage`.
- **Building the chain.** Core appends to `onBehalfOf` when it routes:
  - an agent's tool call to a plugin: chain `[chat]`, principal plugin;
  - a plugin calling `chats.send`: chain `[plugin]`, principal chat. The *chat's* authority to send is checked as well;
  - an automation running a shell node: chain `[automation subject]`, principal task.

### G.8 Capability catalog

| Class | Capabilities | Third party | First party (out of process) | First party (T1) |
|---|---|---|---|---|
| none | `ui.contribute`, own storage, own config, own commands, picked files | automatic | automatic | trusted core |
| low | `files.read:workspace` (trusted workspace), `net.connect` to named non-exfil hosts, `agents.read:current`, `tools.register` (class ≤ reads), `usage.report` | install sheet | ceiling | trusted core |
| medium | `agents.read:any`, `agents.send`, `git.read`, `hosting.read`, `files.write` (broker), `terminals.read`, `terminals.run` (caller's sandbox), `browser.read`, `clipboard.read` | install sheet + first use | ceiling | trusted core |
| high | `agents.create`, `agents.context`, `agents.hooks`, `agents.read:other`, `git.write`, `git.push`, `hosting.write`, `secrets.use:<svc>`, exfil-capable hosts, `net.local.connect`, `net.loopback.connect:<port>`, `net.listen:<port>`, `browser.drive`, `devices.drive`, `automations.schedule`, `commands.execute:<id>` (foreign) | runtime, in context; "once" is the default | ceiling | trusted core |
| critical | `desktop.control`, `screen.capture`, `secrets.read`, `secrets.manage`, `files.read:home`, `spawn.unsandboxed`, `network.host`, `commands.execute:*`, full access | **never by prompt**: Settings → plugin → Advanced access, typed confirmation, re-acknowledged on every update; never for T2 third party | helpers only, per-chat approval when acting for an agent | trusted core |

**Tool classes** (`sbx:hostToolSandbox.ts:36` `HostToolSandboxClass`) map onto capabilities. A plugin can't declare a tool class lower than its capabilities imply. Revision 2 re-classes `instant_grep`, `find_symbol`, `find_files` and `workspace_status` as `reads` (B-15, B-03), and `thread_read`, `thread_search` and `terminal_output` across chats as `agents.read:other` (B-06).

### G.9 Versioning and migration

- **Capability ids are versioned** (`net.connect@1`). A new version may narrow semantics, and grants for `@1` are migrated by a table in core:
  - **Narrowing migrations** apply automatically.
  - **Widening migrations** never apply: the grant is dropped and the plugin asks again.
- **`targetPolicy`** in the manifest works like Android's `targetSdk`:
  - New restrictions apply to plugins whose `targetPolicy ≥ N`.
  - Security fixes apply to everyone.
  - `product.json` `minimumTargetPolicy` rises over time; plugins below it stop loading with a message.
- **Updates:**
  - A plugin update that declares new `required` capabilities asks again before activating the new version.
  - A capability-widening update never auto-installs.
  - A signer change drops all grants (TOFU pinning).
- **Grant-store schema.** It is versioned, and migrations are pure functions with tests. A store from a newer Volt is read-only, with all third-party grants treated as absent.

### G.10 First-party ceilings

- **The table.** `src/vs/platform/voltPlugins/common/firstPartyCeilings.ts` (**[proposed]**) maps `volt.<feature> → Capability[]` and is owned through CODEOWNERS.
- **CI check.** CI fails if a first-party manifest declares anything outside its ceiling. A load-time check is a tamper backstop.
- **What it applies to:** only out-of-process first-party logic (T2-fp). T1 code is trusted core (B-21).
- **Granting.** Volt's signature grants `declared ∩ ceiling`, with no prompt and no sheet. Widening needs a core release, so a stolen plugin key alone can't widen.
- **Stale revocation metadata.** When it is older than its expiry, first-party *high* and *critical* auto-grants drop to "prompt". Nothing is bricked.

### G.11 Determinism and tests

- **Snapshot.** The Authority's snapshot is an immutable object built from:
  - the grant store at epoch e;
  - manifests by digest;
  - ceilings;
  - admin policy by digest;
  - workspace restrictions by digest;
  - backend reports;
  - an `asOf` timestamp.
- **Logged decisions.** Every decision logs `(epoch, snapshotDigest, request, ctxDigest, decision)`. A replay test re-runs a day's decisions against the stored snapshots and expects identical results (POL-DET-1).
- **Implementation.** `evaluate` is in `common/`, imports nothing from `node/` or `browser/`, and is fuzzed (K.2).

### G.12 Prompt UX rules (UX is a layer, never the boundary)

- **Text.** Volt writes the sentence. Plugin text appears only as a quoted reason, length-capped, with invisible and bidi Unicode stripped.
- **Budgets:**
  - at most 1 prompt per plugin per minute and 3 per day;
  - 2 refusals → auto-deny until the Access page is opened;
  - prompts coalesce over 2 s.
- **Placement:**
  - no modal during an agent run, only one inline card per turn;
  - buttons inert for 500 ms and needing pointer movement;
  - no prompts from background code.
- **Pickers instead of path prompts.** The install sheet groups low and medium capabilities.
- **First party never prompts**, except the stale-revocation case (G.10).
- **Every list and control** uses `WorkbenchList` edge to edge and `createVoltButton` / `createVoltDropdown`.

**Surfaces:**
- **Extension entry:** a tier chip (`Built-in`, `Trusted core`, `Sandboxed`, `Partial: dims`, `Not sandboxed: reason`).
- **Plugin page:** Permissions and Activity tabs (denials, hosts reached, tools registered, last 7 days).
- **Settings → Security:** every running principal with backend, status, unenforced dimensions and attestation.

---

## Part H. Plugin runtime and lifecycle

### H.1 Host kinds

| Host | How it starts | Inside | Boundary |
|---|---|---|---|
| **T2 plugin host** | Supervisor starts `<Volt executable>` with `ELECTRON_RUN_AS_NODE=1 --disable-sigusr1 out/vs/platform/voltPlugins/node/pluginHostMain.js` and channels on fds 3–5. **Not `utilityProcess`**: it has no sandbox and ignores `--permission` and `--disable-sigusr1` [test] | `lockdown()` (SES 2.x, 4–10 ms [test]), then the plugin's single bundled file evaluated in a `Compartment` whose only endowments are the `volt` API proxy, `console`, timers, `TextEncoder`/`Decoder`, `URL`, `crypto.getRandomValues` and `WebAssembly`. No `require`, no Node built-ins, no `process` | OS sandbox: read its bundle and storage only; writes through the broker (`writeMode: 'broker'`); network `none`; spawn `none` where enforceable (J); no IPC except its channels |
| **T3 extension host** | Supervisor starts `bootstrap-fork` with `ELECTRON_RUN_AS_NODE=1 --disable-sigusr1`, `VSCODE_ESM_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess`, its env from the fixed list (F.7) and `NODE_CHANNEL_FD` written last. One host per extension, on the execution host | Stock extension host code, with one extension in its registry | OS sandbox (T3 default policy, H.7) + broker network + core-owned webviews. The renderer's `MainThread*` customers accept only this host's extension id (B-08) |
| **T3-web host** | One hidden `BrowserWindow` per browser-only extension: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, partition `volt-ext:<subject>`, preload = the RPC bridge only, `webRequest` routed to the broker **[proposed]** | The web-worker extension host code | Chromium renderer sandbox + partition-level egress |
| **T4 process** | Supervisor `start` | Agent CLI, MCP server, task | OS sandbox |
| **Helper** | Supervisor `start` after signature check | Signed native binary | Per-helper profile |

### H.2 Activation and lazy loading

- **Contributions are data.** Tools (`contributes.voltTools` with JSON schemas), commands, settings, slot items, surfaces, dock sections and agent providers come from the manifest. An agent's tool list is complete before any plugin starts; today `hostTools.ts:1029` reads tools at session start.
- **Activation events** (`onTool:<name>`, `onCommand:<id>`, `onView:<id>`, `onLanguage:<id>`, `onStartupFinished` for first party only) start the host lazily. The first tool call waits for activation, with a budget (Part L).
- **Idle stop:**
  - T2 hosts stop after 5 minutes with no RPC, no visible UI and no registered live resource (watchers, timers longer than 60 s).
  - T3 hosts stop when none of their activation conditions are live, for example no open editor of their languages and no visible view.
  - State that must survive lives in storage.
- **Host budget.** At most N concurrently running plugin hosts (default 24; Part L). Over budget, the least recently used idle host is stopped. If none is idle, the new activation is refused with a message, **never co-hosted**.

### H.3 IPC protocol

**T2 uses `volt-plugin/1`:**

| Property | Rule |
|---|---|
| Transport | The inherited socketpair (POSIX) or `LOCAL\` named pipe (Windows) from F.5. No other endpoint exists |
| Framing | 4-byte big-endian length + UTF-8 JSON; max 16 MiB per frame; binary payloads as separate frames referenced by id |
| Semantics | JSON-RPC 2.0 requests, responses and notifications, both directions |
| Handshake | The host sends `{ protocol: 'volt-plugin/1', apiVersions: ['1.x'], sdk }`; core replies with the chosen version. Mismatch → host exits 2 |
| Identity | None in messages. The channel is the principal (INV-01). Fields named `extensionId`, `principal` or `caller` in a payload are rejected |
| Deadlines | Default 30 s per request. Tools declare their own (max 10 min). Cancellation via `$/cancel` |
| Backpressure | At most 64 in-flight requests per direction per principal, then `RateLimited`. A token bucket on calls per second |
| Errors | Typed: `VoltCapabilityError {capability, target, deniedBy}`, `NotFound`, `InvalidArgument`, `RateLimited`, `Internal` |
| Validation | Every core method has a JSON schema. Unknown fields are rejected. Strings are NFC-checked and length-capped |

**T3** keeps VS Code's `RPCProtocol` over its channel. The same identity rule is applied in the `MainThread*` customers (B-08).

### H.4 API versioning and compatibility

- `engines.volt` (semver) in the manifest. The host refuses a plugin whose range excludes the running API.
- Namespaces have stability levels `stable` and `proposed`. Proposed APIs are available only to first party and in developer mode.
- Deprecation: two minor releases of warnings, then removal.
- Capability versions (G.9) are independent of the API version.
- VS Code extensions use `engines.vscode`, unchanged. Volt's API base is VS Code 1.105.1.

### H.5 Dependencies and code loading

- **T2:**
  - One bundled file (esbuild, `SOURCE_DATE_EPOCH`, sorted).
  - No `node_modules` at runtime, no native code.
  - Wasm only from the bundle, through the component model (jco).
  - `import()` and `eval` inside the Compartment are SES-confined. CVE-2023-39532 (dynamic `import()` escape) is why the OS layer is the wall [src].
- **T3:** as VS Code. Native modules are allowed, because they run inside the OS sandbox.
- **`extensionDependencies` and `exports`.** One host per extension means `vscode.extensions.getExtension(x).exports` (live JS objects) doesn't work across extensions:
  - **First-party APIs** that extensions consume, such as the built-in Git extension's API, are re-exposed as broker-backed RPC proxies (`volt.git`).
  - **Third-party-to-third-party `exports`** are unsupported in v1. A dependent pair is offered "Run these two together", a **critical** grant that creates one combined principal whose grants are the *union*, shown as such. Default: off.
  - The T3 smoke test (top-50) measures the breakage (D-10).

### H.6 Pooling

A process hosts exactly one subject identity, `(subject, packageDigest, launchPolicyHash)`.
- **Allowed:** reusing a stopped host's warm process image for the *same* identity, for example after an idle stop.
- **Forbidden:**
  - two plugins in one process, whatever their capabilities. This removes revision 1's "identical low-only plugins may share" rule (B.4 #1);
  - two workspaces' instances of one plugin when their policies differ, since workspace grants change the hash.

### H.7 T3 default policy (no Volt manifest)

| Dimension | Default |
|---|---|
| Read | Its own folder and storage; the workspace if trusted; `${system}`, `${path}`; a signed toolchain list (`~/.cargo`, `~/.rustup`, `~/go`, `~/.nvm`, …) |
| Write | Its storage and tmp. **No raw workspace write**: formatters and refactorings return `TextEdit`/`WorkspaceEdit`, which the main thread applies. Raw write is a medium grant |
| Network | **None**. Live "Allow host" naming the destination; signed per-extension presets; never public `*` |
| Exec | Allowed inside the sandbox (language servers, linters); children inherit |
| Webviews | Core-owned origin, roots and CSP (I.10) |
| `extensionKind: ui` with no browser entry | Doesn't activate until the critical "Run with full access" grant, re-acknowledged every version |
| Secrets and auth | Through `SecretStorage`/`authentication`, keyed by the host's single extension id |

What breaks and the fix shown on denial (telemetry records extension id and denied dimension, no paths):

| Breaks | Fix offered |
|---|---|
| Reading `~/.gitconfig`, `~/.kube`, `~/.aws` | A declared path grant, or the config broker for `~/.gitconfig` |
| Docker, Remote-SSH, debuggers attaching to host pids | Critical grant |
| Global tool installs | "Allow folder", with a Volt-validated scope |
| GUI spawning (`open`, `xdg-open`) | `process.gui` (high), brokered through `openExternal` |
| Consuming another extension's `exports` | H.5 |

### H.8 Resource quotas (defaults)

| Kind | Memory | CPU | Pids | Disk (storage) | Network | Idle stop |
|---|---|---|---|---|---|---|
| T2 | 256 MB | 50% of one core averaged over 10 s | 1 (spawn none) | 100 MB | Broker only; 50 MB per day | 5 min |
| T3 | 1 GB | 100% of one core over 10 s | 64 | 500 MB | Broker; 200 MB per day | Activation-based |
| T4 agent | 4 GB | unlimited (the user's task) | 512 | Workspace | Chat grants | Chat end |
| T4 MCP | 512 MB | 100% of one core | 64 | 100 MB | Approved hosts | 10 min |

Quotas are enforced per F.8, so hard on Linux and `partial` on macOS and Windows. Users can raise them per plugin on its page.

### H.9 Crash handling

Restart budget and backoff are per F.11. The UI shows:
- "Plugin stopped · Restart" on its surfaces;
- the last stderr lines on its page;
- a status-bar count of broken plugins.

A crashing plugin never takes core down: core treats a broken channel as an exit.

### H.10 Install, upgrade and rollback

1. **Download** into `~/.volt/plugins/<subject>/<version>-<digest>/`, a directory written only by the installer and denied to every sandbox.
2. **Verify:**
   - the signature (registry or Volt) and the digest;
   - the signer pin;
   - the scan (invisible and private-use Unicode, obfuscation, `child_process`/native modules versus declared capabilities, known-bad hashes).
3. **Diff capabilities** against the installed version. New `required` capabilities ask first; widening never auto-installs. Third-party auto-updates wait 72 h (setting).
4. **Switch:**
   - start the new version's host on next activation;
   - drain the old one for 10 s, then kill it.
5. **Keep** the previous two versions. Rollback re-verifies the old digest and signature and is refused below the revocation list's minimum version. Grants carry over only when the signer is unchanged and the capabilities didn't widen.
6. **Built-ins** ship with the app, are checked at load against `builtin-manifest.json` (hashes, generated at build), and never update from a gallery.

### H.11 Migration: every feature behind a plugin boundary

**Definition of done per feature** (from revision 1 §10.1, kept):
1. The manifest is the source of truth for its contributions.
2. It activates through `IVoltPluginContext`.
3. It imports only `base/`, its broker interfaces, the facade (`services/voltPlugins/common/voltApi.ts`) and the UI kit, enforced by an import-pattern lint per feature folder.
4. A test activates it with exactly its manifest's grants and expects no denial.
5. Disabling it unloads its code.
6. Its ceiling entry lands in the same PR, for out-of-process logic.

Prerequisite: a **server-side enablement mirror**. Today a feature disabled in the window keeps its tools on volt-server (`customize.md` §6.1d).

**End state per extension** (revision 1 §10.4, with T1 relabelled):

| # | Extension | End state | Notes |
|---|---|---|---|
| 1–6, 8–10 | provider-claude, codex, cursor, grok, opencode, pi, kimi, muse, fx | Signed data + declarative probes (H.12) | ACP and app-server clients stay core |
| 7 | provider-antigravity | Data + T2 model provider | |
| 11 | provider-local | T2 model provider | `net.loopback.connect:11434/1234` through the broker |
| 12 | provider-openrouter | T2 model provider | Secret ref; shared `@volt/provider-kit` |
| 13 | memory | **First T2 plugin** | Tools + storage; context output labelled and capped |
| 14 | usage | T1 page + T2 logic after the secrets broker | OAuth fetches move behind refs |
| 15 | agent-resources | T1 views + T2 reader | Scoped reads of harness dirs, never credentials, never writes |
| 16 | code-intelligence | T1 settings + helper index | Index reads the workspace with **symlinks ignored for sandboxed chats** (B-15) |
| 17 | git-graph | T1 + git broker | |
| 18–19 | pull-requests, commit-review | T1 UI + T2 service | Split `voltAgent/browser/pullRequests/` first |
| 20 | automations | T1 pages + T2 scheduler on volt-server | Shell nodes run as tasks under the automation's principal |
| 21 | skills-and-plugins | T1 marketplace UI | Installer and verifier stay core |
| 22 | customize | T1 trusted core | Catalog, enablement and look engine are core |
| 23 | claude-accounts | Core broker | Writes `~/.claude*` under Claude's locks |
| 24 | remote-devices | T1 Devices page | Pairing, tokens and tunnels are core |
| 25–30 | browser, playgrounds, visuals, scratch-board, devices, computer-use | **T1 trusted core**, fenced (lazy, import lint), agent content in separate renderers | Labelled "Trusted core" (B-21) |

**Stays core with no extension:** threads, queue, subagents, run groups, questions and plans, worktrees, terminals, workspace context, images, `voltSandbox`, `voltStdio`, `voltHostMcp`, `voltAgentServer`, `voltStorage`, `voltWindowScope`, `voltRelay`, the ACP and app-server clients, `IVoltFeatureService`, the Authority, the grant store and the brokers.

### H.12 Providers are signed data

Providers never return an arbitrary `{command, args}`. A provider is data:

```jsonc
"contributes": { "voltAgents": [ {
  "id": "claude",
  "binary": "claude",                                   // bare name; core resolves, pins the path + digest, shows it on the sheet
  "args": ["--acp", "--model", "${model}"],             // template; core-defined substitutions only
  "apiHosts": ["api.anthropic.com"],
  "state": {                                            // B-05: allow-list form
    "configOverlay": "CLAUDE_CONFIG_DIR",               // per-chat overlay seeded read-only from the real dir
    "writable": ["projects/${projectSlug}", "todos", "statsig", "shell-snapshots"],
    "mergeBack": ["model"]                              // keys merged back after the turn
  },
  "probe": { "command": ["claude", "auth", "status"], "parse": "regex:^Logged in" },
  "models": { "source": "acp" }
} ] }
```

- Core launches the CLI through the supervisor with the provider's own profile.
- A third-party provider never gets the shared agent profile.
- `CLI_AGENT_DEFINITIONS` (`main:src/vs/workbench/services/voltRuntime/browser/agents/cliAgents.ts:402`) becomes contributed data, checked by a deep-equal parity test.

### H.13 Developer experience

- `npm create volt-plugin`, a T2 template and `volt.d.ts`.
- A Playground "New plugin" flow.
- **A local runner with the real sandbox.** The same supervisor runs the plugin with its manifest grants, and denials print with the `deniedBy` layer.
- **Debugging.** Developer mode only: the supervisor starts the host with `--inspect=127.0.0.1:0` on a random port and prints the URL in Volt's debug console. A badge marks the host "debuggable".
- **Report mode.** In developer mode, the API layer can run in report mode for one plugin: would-be denials are logged, not enforced. The OS layer never has a report mode.
- **Kill criterion.** If fewer than about 10 registry plugins use T2 after two releases, T3-with-manifest becomes the recommended path.

---

## Part I. Broker security specification

### I.1 The contract every broker follows

| # | Requirement | How |
|---|---|---|
| 1 | Authenticated caller | `ICallContext` built by core from the channel. Brokers have no other entry point |
| 2 | Explicit capability check | `authority.evaluate(req, ctx)` on **every** call. No broker keeps its own allow list |
| 3 | Caller attenuation | The chain is in `ctx`, and `evaluate` applies it (G.2 step 6). Data-flow calls also apply G.6 |
| 4 | Input validation | A JSON schema per method; paths canonicalised then resolved by handle; hosts IDNA-normalised; sizes capped |
| 5 | Resource limits | Per-principal rate, concurrency and byte budgets |
| 6 | Audit | `{ts, principal, chain, method, target (redacted), decision, epoch}` to the execution host's audit log (rotated, 0600, denied to every sandbox) |
| 7 | Revocation | Re-evaluates on `onDidChange`. Long operations check the epoch between chunks |
| 8 | Adversarial tests | Each broker has a suite in K.3 |

```ts
export interface IBroker<M extends Record<string, (...a: any[]) => Promise<any>>> {
  readonly id: string;
  handle<K extends keyof M>(ctx: ICallContext, method: K, args: unknown): Promise<Awaited<ReturnType<M[K]>>>;  // validates args itself
}
```

### I.2 Files broker

- **Capabilities:** `files.read`, `files.write` with `{scope: 'workspace' | picked handle | declared paths}`; `files.watch`; `files.search`.
- **Race-free opens:**
  - **Linux:** a small signed native helper (`volt-fsd`) does `openat2(dirfd, rel, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)` and returns the fd to the broker over `SCM_RIGHTS`. Node has no `openat2` [src].
  - **macOS:** Node's `fs.open` with numeric `O_NOFOLLOW_ANY` (0x20000000, macOS 11+) on the realpath [test]. `O_RESOLVE_BENEATH` where xnu supports it **[assumption]**: the macOS version mapping is unverified.
  - **Windows:** walk components with `FILE_FLAG_OPEN_REPARSE_POINT`, refuse any reparse point, keep the parent handles, and re-check with `GetFinalPathNameByHandle` [src]. `OBJ_DONT_REPARSE` via `NtCreateFile` in the helper where available [src].
- **Hard links:** a write to a file with `nlink > 1` inside a writable root is refused for sandboxed principals (macOS `O_UNIQUE` [test, SDK]). Linux and Windows check `st_nlink`/`NumberOfLinks` on the open handle.
- **The floor is enforced in the broker too:** the credential list, `denyPatterns` and execution-bearing paths, all checked on the *final* path of the open handle.
- **Revocable grants are mediated I/O** (read, write and stat ops over RPC). Only `once` reads may hand an fd to the sandbox (F.9).
- **Limits:** 64 open handles and 256 MB/min of writes per principal.
- **Audit:** the path is hashed with a per-install salt; the full path appears only in the local log.
- **Tests:** RACE-1..3 (symlink flip during 1,000 ops), hard-link refusal, `..` and NFC/NFD tricks, case-folding on APFS and NTFS, reparse points on Windows, 8.3 short names on Windows **[open]**.

### I.3 Secrets broker

- **API:** `volt.secrets.ref(key) → SecretRef` (opaque, principal-bound) and `volt.net.fetch(url, { auth: ref })`.
- **Header injection.** The network broker injects the header for allowed hosts only, i.e. the hosts listed in the secret's own metadata (`injectHosts`, the same model as VS Code's sandbox credential settings [src]). The plugin never sees the value.
- **Namespacing.** Secrets are namespaced per subject. `secrets.read` (raw) is critical. `secrets.use:<svc>` is high.
- **Storage:** OS keychain (Keychain, libsecret, DPAPI). Fallback is a 0600 file in `~/.volt/trust/secrets/`, denied to every sandbox.
- **No secret ever goes into env or argv (INV-24).** `claudeLogin.ts:98`'s `security -X <hex>` argv path is replaced with stdin.
- **OAuth tokens** in `voltUsage` and `voltAccounts` move behind refs.
- **Tests:** CRED-6 (raw read denied), CRED-7 (a ref from principal A is useless to B), header injection only to listed hosts, and the ref survives a host restart but not a signer change.

### I.4 Network broker

Replaces the branch proxy (`sbx:node/sandboxProxy.ts`) with a principal-aware broker. Its address checks are kept (`:97-126` [code]).

| Aspect | Rule |
|---|---|
| Routes | One per principal. **Linux:** a unix socket bridged into its netns by the holder. **macOS:** its own loopback port, allowed only in its profile with `(remote ip "localhost:<port>")` (never `local ip`, which matches any address [src]). **Windows:** MXC Model 2 proxy-only egress to one broker port. Never plain `hostLoopback` (MXC#1665) [src] |
| Authentication | Per-principal `Proxy-Authorization` token (needed on Windows, defence in depth elsewhere). Another principal's token on this route → 407 and an audit event (B-31) |
| Protocols | HTTP forward and `CONNECT` only. No SOCKS, UDP or raw sockets in v1 (QUIC falls back to TCP) |
| Hostnames | IDNA to lowercase ASCII; one trailing dot stripped; controls, empty labels and ambiguous numeric forms rejected. `*.example.com` matches descendants only, never a public suffix (bundled PSL). No port means 443; port 80 needs an explicit `http://` grant. IP literals need IP rules. `*` covers ports 80/443 only (B-32) |
| DNS | The broker is the only resolver: exactly one lookup per connection, every A/AAAA answer must be public, connect to the address that was checked. No TTL cache. **macOS:** `/private/var/run/mDNSResponder` denied in every profile except `host` (DNS exfil [test, src]). **Windows:** lookups still go through the host DNS Client inside MXC (MXC#1666), a documented residual |
| Special ranges (always denied, even with LAN permission) | IPv4: `0/8, 10/8*, 100.64/10, 127/8, 169.254/16, 172.16/12*, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16*, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255`. IPv6: `::, ::1, ::ffff:0:0/96` (judged as IPv4), `64:ff9b::/96` and **`64:ff9b:1::/48`** (judged as IPv4), `100::/64, 2001:db8::/32, 2002::/16` (judged as IPv4), `fc00::/7*, fe80::/10, fec0::/10, ff00::/8`. `*` = allowed only by `net.local.connect` to an exact address or CIDR and port; metadata `169.254.169.254` and `fd00:ec2::254` never |
| Local network | `net.local.connect` is a separate high capability, like Android 17's `ACCESS_LOCAL_NETWORK` (enforced for API 37+ apps [src]) and Chrome 142's Local Network Access prompt [src] |
| Loopback | `net.loopback.connect:<port>` to exactly one manager-issued or user-named port. Never Volt's own listener ports (the broker knows them) |
| Listen | `net.listen:<port>`. The sandbox binds only granted ports. A dev server the user opens is published through the holder or route |
| TLS | Opaque pass-through, no SNI check. Fronting is a residual. The **exfil-capable list** (paste sites, webhook catchers, tunnels, object storage, fronting CDNs, registry publish endpoints, `gist`/`api.github.com` write paths) needs the high-class flow; it ships signed through the feed |
| Redirects | Not followed by the broker. Each new connection is checked again |
| Limits | Per principal: 64 concurrent connections, CONNECT idle timeout 120 s, header timeout 15 s, byte budget per H.8 |
| Denials | `{denialId, principal, epoch, destination, port, reason}` with reasons `not-allowed \| private-address \| metadata \| port \| transport \| rate-limit \| unresolvable \| auth`. Coalesced per principal over 2 s |
| Approval | The client sends `denialId + expectedEpoch`. The broker re-derives the rule from its own record, so a client can't swap the host. "Allow host" never allows a private address |
| Live apply | A grant applies to the next connection of the *running* process (fixes "Allow host", B-31). Revocation closes tunnels |
| Browser partition | Sandboxed chats' browser partitions call `session.setProxy` to the chat's route. Plugin webviews get partition-level routing (I.10) |
| Tests | NET-1..20: rebinding, IDNA homographs, NAT64 both prefixes, IPv4-mapped, 6to4, decimal/octal/hex IPs, CONNECT smuggling, absolute-form vs Host mismatch, CL/TE conflicts, pipelining after CONNECT, slowloris, cross-principal token reuse, live grant same PID, revoke closes tunnel, metadata on both families, redirect to private, wildcard public suffix, port widening via `*` |

### I.5 Git broker and HostGit

- **One wrapper for every git process Volt runs:** `HostGit.run(ctx, repo, args)`. A lint forbids `git` spawns outside it.
  - **Always:** `-c core.fsmonitor=false -c core.hooksPath=<empty dir> -c protocol.ext.allow=never -c core.sshCommand=<Volt default>`, plus `GIT_CONFIG_NOSYSTEM=1` and `GIT_NO_REPLACE_OBJECTS=1`. `rev-parse --git-common-dir` and `--git-dir` must resolve inside the expected repo. Otherwise refuse.
  - **User-initiated actions** (Commit, Push from the SCM view) run with the user's hooks **after** the build-entry guard (I.6) shows any hook or config changed since the last user review.
  - **Agent- or plugin-initiated actions** (`git.write`, `git.push`) never run repo hooks. They run under the caller's principal for writes to the work tree.
- **Capabilities:** `git.read`, `git.write`, `git.push` (prompt per repo, per remote).
- **Tests:** GIT-1..4 (`commondir`, `core.fsmonitor`, a `hooksPath` into a tracked folder, `alternates`), push to an unexpected remote.

### I.6 Build-entry guard

- **Snapshot.** When a sandboxed writer starts in a workspace, the guard snapshots hashes of every execution-bearing file in A3. That includes worktree setup files and the `.git` allow-list's read-only part.
- **Check.** Before Volt runs a task, install, commit hook or worktree setup for the user, changed entries show a diff and wait for the user.
- **Agent state** (B-05): the per-chat overlay's merge-back is filtered to allowlisted keys. Anything else is shown as a diff and dropped.

### I.7 Terminals broker

- `volt.terminals.run` always runs under the **caller's** principal (a chat's sandbox, or a plugin-scoped task policy).
- `terminals.read` covers the caller's own terminals; other chats' terminals need `agents.read:other`.
- The user's own terminals stay outside, by design.
- **Tests:** a sandboxed chat's `terminal_start` writes outside the workspace → denied (LIFE-PATH-1).

### I.8 Clipboard broker

- **Write** is free but rate-limited and audited.
- **Read** needs `clipboard.read` and a gesture token from the last second.
- **Seatbelt** denies the pasteboard for every profile [test, src]. MXC defaults deny clipboard read and write [src].

### I.9 Browser broker

- `volt.browser.*` is backed by `IHostToolService`. `volt.browser.automate` stops being a command (B-09).
- **Sandboxed chats** get their own **signed-out partition** per chat, with the chat's network route (B-16).
- **Unsandboxed chats** with network on may use the shared profile, but only with `browser.drive` and the user's per-chat approval for signed-in sites.
- `browser_evaluate` and `browser_run` with edits are high and caller-attenuated.
- **Popups:** `setWindowOpenHandler` denies non-http(s) schemes; `will-attach-webview` strips preloads and node options; permission handlers are set on every partition (B-37).

### I.10 UI broker, webviews and panels

- **Declarative views** (list, card, form, markdown, stat, chart) are rendered by core with `WorkbenchList`, `createVoltButton` and `createVoltDropdown`.
- **Panels** are iframes with an opaque origin and core-written CSP: no `connect-src` unless the owner has network grants, and then only those hosts. They talk to core by `postMessage` only.
- **T3 webviews:**
  - Core derives the origin from the principal.
  - `localResourceRoots` are clamped to the principal's readable set (B-23).
  - Core writes `connect-src`, `img-src`, `media-src`, `frame-src`, `form-action` and `font-src` to the granted hosts.
  - Egress is attributed by `webContentsId` + `frame` in one central `webRequest.onBeforeRequest` dispatcher. A null frame is denied. Only one listener per event exists [src], so the dispatcher is core's.
  - `openExternal`/`asExternalUri` to an ungranted host shows Volt's confirm with the full URL, a length cap and a budget. Today `main:mainThreadWindow.ts:69-73` passes `fromExtension: true` [code].
- **Tests:** WEB-1..6 and T3-WEBVIEW-1.

### I.11 Devices and desktop brokers

- **Device control:** `devices.drive` (high).
- **Desktop control:** `desktop.control` and `screen.capture` (critical, helpers only). Approval is per chat when acting for an agent.
- **The device hub's HTTP listener** gets the listener library's bearer auth (B-24 class). Today it has none per the boundary audit.
- **Device hub install:** `expo-device-hub` is installed at runtime with no integrity check. It moves to a pinned, hashed artifact.

### I.12 Automations broker

- **Triggers** run as the automation's own subject (`automation:<id>`), whose grants are set when the user creates it.
- **Shell nodes** run as tasks under that principal, sandboxed.
- **Workflow files** no longer declare their own trust: the `source.kind` in the YAML is ignored for trust decisions (boundary audit: `workflowSchema.ts:237-239`). Trust comes from where Volt loaded the file and the user's approval of its content hash.

### I.13 Hosting broker and the grant service for remote clients

- **Hosting:** `hosting.read` and `hosting.write`. Every PR create or comment from an agent is labelled as such.
- **Remote approvals:** clients send `{denialId, choice, expectedEpoch}`. The server re-derives and commits, then broadcasts the epoch.
- **Step-up.** These high-risk remote escalations need a fresh device step-up, and by default a local owner confirmation:
  - persistent grants;
  - `net.local`;
  - `secrets.use`;
  - `spawn.unsandboxed`;
  - setting a chat to `Off`.
- Revoking a device kills its pending approvals.

### I.14 Commands broker

- Every `CommandsRegistry` entry gets a visibility: `internal` (core only), `exported:<capability>`, or `public` (VS Code built-ins that are already safe). Volt commands default to `internal`.
- Extensions call only `public` commands, plus `exported` ones they hold the capability for.
- A lint fails a `volt.*` registration without explicit visibility (B-09).

### I.15 Host MCP tools (the agent-facing broker)

- **Token:** a per-chat HMAC token binding `{sessionId, groups, keyEpoch, expiry}`. The branch already binds session and groups (`sbx:platform/voltHostMcp/node/voltHostMcpService.ts:98` [code]).
- **Classification.** Every tool has a capability mapping (G.8), evaluated by the Authority with the chat as principal. `hostToolSandbox.ts`'s own `covers` logic is replaced by `authority.evaluate`, so the gate and the launcher can't disagree (B-10, B-11, B-15).
- **Reads on the host** (search, `workspace_status`) go through the files broker and HostGit.

---

## Part J. Platform enforcement matrices

Columns:
- **OS:** enforced by the kernel or the OS sandbox.
- **Volt:** enforced by Volt's brokers or supervisor.
- **Best effort:** detected and acted on, but not guaranteed.
- **No:** unsupported. The policy compiler refuses a mandatory request for it.

The three platforms are **not equivalent**. J.4 says where they differ.

### J.1 macOS (Seatbelt via `/usr/bin/sandbox-exec`)

`sandbox-exec` is documented as deprecated but still ships on macOS 26.6 [test, src]. Chromium, Codex, srt and Cursor use SBPL [src]. Plan B is a signed `sandbox_init` helper; the policy model doesn't change.

| Dimension | Mechanism | Level | Guarantee | Refuse when | Test |
|---|---|---|---|---|---|
| File read | Deny-default profile; allow lists on **realpaths** (SBPL matches resolved paths: `/tmp` rules never match, `/private/tmp` does [test]) | OS | Reads outside the allow list fail with `EPERM` | Probe trial read succeeds | MAC-FS-1 |
| File write | Allow list on realpaths | OS | Writes outside fail | Same | MAC-FS-2 |
| Protected paths (existing) | `deny file-write*` on literals and regexes; `.git` allow-list form | OS | Writes fail even inside writable roots | — | PERS-* |
| Paths created later | Regex denies by name (e.g. `/\.git/hooks(/|$)`) | OS | Name-pattern denies hold for new paths too | — | MAC-FS-3 |
| Hard links | New links to denied files fail [test]; existing multi-link files are a residual; the broker refuses `nlink > 1` | OS + Volt | No new links into denied paths | Bounded scan finds a link to a denied path → `partial` | MAC-HL-1 |
| Credentials | Floor denies (`sandboxProfiles.ts:20-30` list + `.env*` patterns) | OS | Unreadable | — | CRED-* |
| Network egress | `(deny network*)` + `(allow network-outbound (remote ip "localhost:<route>"))` [src: srt notes `local ip` matches any] | OS | Only the broker route is reachable | — | NET-MAC-1 |
| Hostname rules | Network broker | Volt | Per I.4 | — | NET-* |
| DNS | `/private/var/run/mDNSResponder` denied unless `host`; resolution in the broker | OS + Volt | No DNS channel except through the broker | — | NET-MAC-DNS |
| Loopback services | Only the route port | OS | Volt listeners and other ports unreachable | — | LST-* |
| Listen | `network-bind`/`network-inbound` on granted ports only | OS | No squatting | — | NET-LISTEN-1 |
| Process creation | `spawn: any` allows `process-fork`; `spawn: none` = `(deny process-fork)` + `(allow process-exec (literal <workload>))` | OS | `none`: no new processes, self-exec only | — | MAC-SPAWN-1 |
| Process tree | Group + kqueue + sweep (F.10) | Best effort | Survivors stay sandboxed | — | TREE-MAC-1 |
| Signals | `(deny signal)(allow signal (target same-sandbox))` [code, branch memory: `(deny signal (target others))` is a no-op] | OS | No signals outside | — | HOST-SIG-1 |
| Other processes' info | `(allow process-info* (target same-sandbox))` | OS for `process-info*` ops | **Residual:** argv and env of non-platform same-user processes are readable via `KERN_PROCARGS2` under every profile tested (B-12) [test] | — | MAC-ENV-1 (expected fail), MAC-ENV-2 |
| TCC | Responsibility disclaimed at spawn [test, research agent] | OS (private SPI) | Sandboxes don't inherit Volt's TCC grants | SPI missing → `partial` for `platform.tcc` | MAC-TCC-1 |
| Mach services | Allow list: `opendirectoryd.libinfo` (Node needs it [test]), `system.logger`, `PowerManagement.control`; deny `cfprefsd.daemon`, `coreservices.appleevents`, `CoreServices.coreservicesd`, `lsopen`, `trustd.agent` (unless a TLS-heavy Go tool needs it; data-leak warning [src]), pasteboard | OS | No AppleEvents, LaunchServices or preference writes | — | MAC-MACH-1..4 |
| launchd job submission | Refused for sandboxed callers even under `(allow default)` [test] | OS | No persistence via launchctl | — | MAC-LD-1 |
| TTY | `/dev/tty` and inherited fds only; `/dev/ttys*` removed (B-26) | OS | No access to other terminals | — | MAC-TTY-1 |
| Memory | Footprint poll + kill | Best effort | Kill within 2 s of crossing | — | RES-MAC-1 |
| Pids | `RLIMIT_NPROC` is per user [src] + fork-rate watchdog | Best effort | — | — | RES-MAC-2 |
| CPU, file size, open files | `RLIMIT_CPU`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE` | OS | Hard | — | RES-MAC-3 |
| Attestation | `sandbox_check(pid, …)` from the parent [test] | OS (private SPI) | External evidence | SPI missing → refuse | ATTEST-MAC-1 |
| Versions | Supported macOS 14+ **[proposed]**; tested on 26.6 [test]; CI on `macos-15` and the newest image | — | — | Probe trial fails | PROBE-MAC |

### J.2 Linux (bubblewrap + seccomp + Landlock + cgroup v2)

| Dimension | Mechanism | Level | Guarantee | Refuse when | Test |
|---|---|---|---|---|---|
| File read | Mount namespace; read-only binds of the allow list; `--remount-ro /` when not reading all. **Agents no longer read `/`** (B-27) | OS | Unlisted paths don't exist inside | — | LNX-FS-1 |
| File write | Write binds; with Landlock ABI ≥ 1, `LANDLOCK_ACCESS_FS_WRITE_*` on the same roots as a second layer [src] | OS (+ OS) | Writes outside fail | — | LNX-FS-2 |
| Protected paths (existing) | `--ro-bind` over each; parent pins | OS | Read-only | — | PERS-* |
| Paths created later | Not expressible with binds. With Landlock ABI ≥ 1, `.git` and similar can be write-denied by making their *parent* read-only in Landlock and granting writes per allow-listed child | `partial` without Landlock; OS with Landlock | — | — | LNX-FS-3 |
| Pattern denies (`.env`) | Bounded walk at launch; **incomplete walk refuses** (B-27) | OS for found paths | Every `.env` in readable roots is masked, or the launch is refused | Walk incomplete | LNX-ENV-1 |
| Mount-point setup races | `--bind-fd` from `O_PATH\|O_NOFOLLOW` opens (bwrap ≥ 0.10); bwrap ≥ 0.12 resolves with `RESOLVE_IN_ROOT` (CVE-2026-87766 fix) [src] | OS | No setup escape | bwrap < 0.12 and CVE trial fails | LNX-BWRAP-CVE, LNX-RACE-1 |
| Network | `--unshare-net`; holder bridges the broker route only | OS | No interfaces except loopback; route only | — | NET-LNX-1 |
| Hostname rules, DNS | Broker; no resolver inside | Volt | Per I.4 | — | NET-* |
| Listen | Inside the netns only; published through the holder on grant | OS | No squatting of host ports | — | NET-LISTEN-1 |
| Syscalls | seccomp: arch kill, x32 deny, `clone3` → `ENOSYS`, namespace flags, mount family, `ptrace`, keyrings, `bpf`, `perf_event_open`, `userfaultfd`, `io_uring_*`, `TIOCSTI`/`TIOCLINUX` (`sbx:common/seccomp.ts` [code]) **plus** a socket-family allow list and `modify_ldt`, `kcmp`, `pidfd_getfd`, `process_madvise`, `vmsplice`, NUMA calls (B-28). Roadmap: move to an allow list [src] | OS | Listed calls fail | Arch not x64/arm64 | LNX-SECCOMP-* |
| Process creation | `spawn: none` = `fork`/`vfork` denied, and `clone` allowed only with `CLONE_THREAD` (threads still work; `clone3` → `ENOSYS` makes glibc fall back to `clone` [src]) | OS | No new processes | — | LNX-SPAWN-1 |
| Nested user namespaces | `--disable-userns` (bwrap ≥ 0.8) + seccomp | OS | Can't create | — | LNX-USERNS-1 |
| Process tree | PID namespace + `--die-with-parent` from the main thread + cgroup `cgroup.kill` [src] | OS | Complete | — | TREE-LNX-1 |
| Signals, `/proc` | `--unshare-pid --proc /proc`; host pids invisible | OS | — | — | LNX-PROC-1 |
| Other processes' env | Invisible (PID namespace) | OS | Holds | — | LNX-ENV-2 |
| Abstract unix sockets | `--unshare-net` isolates the abstract namespace; Landlock ABI 6 scoping as a second layer [src] | OS | — | — | LNX-UNIX-1 |
| TTY | `--new-session`; private devpts; TIOCSTI filtered | OS | — | — | LNX-TTY-1 |
| Memory, pids, CPU | cgroup v2 via `systemd-run --user --scope -p MemoryMax -p TasksMax -p CPUQuota` (systemd ≥ 252 delegates `pids memory cpu` [src]); else rlimits and `partial` | OS | Hard when delegated | — | RES-LNX-1..3 |
| `${tmp}` size | tmpfs `size=` | OS | — | — | RES-LNX-4 |
| Attestation | Parent reads `/proc/<pid>/status` and `ns/*` inodes, plus the cgroup path | OS (observed externally) | External evidence | Mismatch | ATTEST-LNX-1 |
| Distro gating | **Ubuntu ≥ 23.10:** AppArmor restricts unprivileged userns; the `bwrap-userns-restrict` profile is bound to `/usr/bin/bwrap` [src], so Volt uses the **system** bwrap and never a bundled one. Debian/Arch `kernel.unprivileged_userns_clone`; RHEL 7 `user.max_user_namespaces=0` [src] | — | — | userns blocked → refuse with the exact fix | PROBE-LNX-* |
| Versions | x64, arm64; kernel ≥ 5.4 (seccomp + userns), ≥ 5.14 for `cgroup.kill` (else SIGKILL pid 1); **bubblewrap ≥ 0.12** default (D-04); Landlock optional | — | — | — | PROBE-LNX |

### J.3 Windows 11 (MXC ProcessContainer via `wxc-exec`)

MXC 1.0.1, MIT. ProcessContainer is the "BaseContainer" tier, built on the native PSEC API (`CreateProcessSecurityEnvironment`); it is AppContainer-based but **not** LPAC [src]. The Node SDK needs Node ≥ 24 [src], so Volt launches the signed `wxc-exec.exe` with a pinned `version: "1.0.0"` config and `telemetry.enabled: false` (the `1.1.0-alpha` contract sends required telemetry [src]).

| Dimension | Mechanism | Level | Guarantee | Refuse when | Test |
|---|---|---|---|---|---|
| File read | `readonlyPaths` (narrow: Windows, Program Files, toolchains, workspace) + `deniedPaths` for every credential store (`.ssh`, `.aws`, `.npmrc`, `%APPDATA%\Microsoft\{Credentials,Protect,Vault}`, browser stores). **Never `C:\` or the profile root** | OS | Unlisted user files unreadable. **Residual:** ambient `ALL APPLICATION PACKAGES` reads of system paths (MXC#1533) [src] | `deniedPaths` unsupported on the build (`PSE_SUPPORT_FS_DENY`) → refuse | WIN-FS-1 |
| File write | `readwritePaths` | OS | — | — | WIN-FS-2 |
| Protected paths | A child deny under a writable grant wins over the grant [src] | OS | — | — | PERS-WIN |
| Temp | `%TEMP%`, `%TMP%`, `%LOCALAPPDATA%` point to a per-container folder wiped per command [src, report]; Volt's run directory is set as `TEMP`/`TMP` | — | — | — | WIN-TMP-1 |
| Network | MXC "Model 2" proxy-only egress: `egress.default: deny`, broker loopback port only, `allowedProxyPeer` unset (Volt's broker isn't packaged) [src]. Never plain `hostLoopback: allow` (opens all ports, MXC#1665) | OS (WFP via PSEC) | Only the broker port | — | NET-WIN-1 |
| Hostname rules | Broker + per-principal `Proxy-Authorization` | Volt | Per I.4 | — | NET-* |
| DNS | **Residual:** lookups resolve through the host DNS Client even in proxy mode (MXC#1666) [report] | No | DNS side channel exists | — | NET-WIN-DNS (expected fail) |
| Loopback | Proxy mode only. Loopback inside the container broke after KB5127648 (MXC#1505) [report] | OS, measured not promised [src] | — | Canary connect to a non-route loopback port succeeds | NET-WIN-2 |
| Process creation | Shells need children; `CHILD_PROCESS_RESTRICTED` would break them. `spawn: none` is **unsupported** | No | — | `spawn: none` requested → refuse | WIN-SPAWN-1 |
| Surrogate spawns | WMI `Win32_Process.Create`, Task Scheduler, BITS, out-of-process COM, `wsl.exe` escape jobs [src]. Whether a BaseContainer can reach them is undocumented → the probe tests `wsl.exe`, `schtasks /create`, a WMI create and `ShellExecute`; each must fail or stay contained | OS (to be proven) | — | Any probe succeeds → `broken` | WIN-ESC-1..4 |
| MSYS2 / Git Bash / Cygwin | Fail under BaseContainer (MXC#1061, srt #766: 0xC0000005 / 0xC0000142) [report] | No | — | Image imports `msys-2.0.dll` or `cygwin1.dll`, or path under `\Git\usr\bin` → refuse with a reason; native `git.exe` OK until it reaches `sh.exe` | WIN-MSYS-1 |
| WSL | `wsl.exe` starts a VM outside the sandbox | No | — | Refuse | WIN-ESC-1 |
| Process tree | MXC job with `KILL_ON_JOB_CLOSE`; children can't break away [src] | OS | Complete for job members | — | TREE-WIN-1 |
| UI, input, clipboard | `ui.disable: false` (true breaks Node: 0xC0000142 [report]); `clipboard: none`, `injection: false`, `isolation: container` → job UI limits [src] | OS | No clipboard, no input injection; **windows can still open** | — | WIN-UI-1..3 |
| Handle inheritance | `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` (MXC uses it [src]) | OS | Only listed handles | — | WIN-HANDLE-1 |
| DLL planting | Workspace never on `PATH`; env from nothing. `SetDefaultDllDirectories` isn't inherited [src]; image-load mitigation flags exposed by MXC? **[open]** | Volt + **[open]** | — | — | WIN-DLL-1 |
| Named pipes | Only `\\.\pipe\LOCAL\` names work inside [report]; broker pipes use DACL + `FIRST_PIPE_INSTANCE` + `REJECT_REMOTE_CLIENTS`; identification-level SQOS [src] | OS + Volt | No impersonation by the sandbox | — | WIN-PIPE-1 |
| Resource limits | Not in MXC's schema; UI-limited jobs can't nest [src] → poll the job and kill | Best effort | — | — | RES-WIN-1 |
| Startup | Up to ~28 s to first output with UI enabled (MXC#1629) [report] | — | — | p50 > budget (Part L) on the release build → Windows stays off by default | PERF-WIN-1 |
| Attestation | Token queries (`TokenIsAppContainer`, container SID) + `IsProcessInJob` from the parent | OS (observed) | External evidence | Not obtainable from `wxc-exec` → D-03 helper | ATTEST-WIN-1 |
| Versions | Windows 11 24H2 ≥ 26100.9278, 25H2 ≥ 26200.9278, 26H2 ≥ 26300.9550, 26H1 ≥ 28000.2804; loopback servers in-container need .9550 [src]. **Not** Windows Server or Windows 10 | — | — | Below the floor → refuse | PROBE-WIN |
| `wxc-exec` integrity | `WinVerifyTrust` with a pinned Microsoft publisher + file hash before every launch | Volt | — | Mismatch → refuse | HELPER-WIN-1 |

### J.4 Where the platforms are not equivalent

| Guarantee | macOS | Linux | Windows |
|---|---|---|---|
| Credential files unreadable | Yes | Yes | Yes, if `deniedPaths` is supported and reads are narrow |
| Other processes' secrets | **No** (env via `KERN_PROCARGS2`) | Yes | Yes (AppContainer can't open other processes) **[assumption]**; verify with WIN-ENV-1 |
| No egress except the broker | Yes | Yes | Yes, except DNS |
| Paths created later protected | Name-pattern denies | With Landlock | Child-deny rules |
| Tree termination | Best effort | Complete | Complete |
| Hard memory and pid limits | No | Yes (delegated cgroup) | No |
| "No new processes" | Yes | Yes | **No** |
| TCC / OS privacy grants not inherited | Yes (disclaim) | n/a | n/a |
| External attestation | Private SPI | `/proc` | Token + job queries |
| Git Bash agents | Yes | Yes | **No** |

The Security page shows the column for the user's platform. A user can't pick a level whose mandatory dimensions their row lacks.

---

## Part K. Adversarial verification plan

### K.1 Test layers

| Layer | Purpose | Where | Runs |
|---|---|---|---|
| Unit | Parsers, compiler, profile generators, seccomp assembler, Authority | `src/vs/platform/voltSandbox/test/common` (the branch has 5 suites) | Every PR |
| Property | Composition and Authority laws | `fast-check` in `common/` | 1k runs per PR, 1M nightly |
| Fuzz | Policy JSON parser, manifest parser, SBPL string escaping, proxy request parser, hostname normaliser, path canonicaliser | `jsfuzz`/`fast-check` with corpora checked in | Nightly, 30 min per target |
| Differential | One policy + a probe corpus (≈200 file, network, process and IPC operations) run on every backend; the observed allow/deny vector must equal what each backend's report claims, and the backends must agree wherever J.4 says they are equivalent | `test/node/differential/` | Nightly per OS |
| OS adversarial | Escape catalogue, DSec replays, CVE replays | `test/node/sandboxSecurity.test.ts` (branch) + new suites; `VOLT_SANDBOX_REQUIRED=1`; every run proves it ran | Path-filtered PRs + nightly |
| Fault injection | Each launch step fails (probe, compile, resolve, spawn, status pipe, attestation, canary, go byte, channel open, cgroup create) | `test/node/fault/` with a `FaultPoint` hook compiled only in test builds | Every PR touching the supervisor |
| Race | Symlink flips, path swaps before bind, grant vs use, concurrent approvals | `test/node/race/` with N=1,000 iterations and a seed | Nightly |
| Escape | Each E-row and B-row with a removal test (fails if the mitigation is removed) | `test/node/escape/` | Nightly + release |
| Permission escalation | Authority + brokers with forged chains, ids and payloads | `test/common/authority/`, `test/node/brokers/` | Every PR |
| Supply chain | Feed signatures, installer signatures, extension signatures, built-in hash manifest, helper signatures | `test/node/supply/` + release workflow smoke | Every PR touching updates or extensions; release |
| Integration | Real extensions under enforce (ESLint, Prettier, GitLens, Python, rust-analyzer, Docker); real agent CLIs | Rig | Nightly + release |
| Performance | Part L | `scripts/volt-sandbox-bench.mjs` (branch) extended | Nightly; regression > 20% fails |

### K.2 Property tests (laws)

| Id | Law |
|---|---|
| POL-PROP-1 | For any layers, `compile(out) ⊆ caller` on every dimension |
| POL-PROP-2 | Untrusted layers never widen (lists ⊆, modes ≤, ports ⊆), including after realpath (B-32) |
| POL-PROP-3 | A symlinked untrusted entry whose realpath leaves the trusted roots is dropped |
| POL-PROP-4 | `allowCovers('*', h:p)` only for p ∈ {80, 443} |
| POL-PROP-5 | The floor appears in every output |
| POL-PROP-6 | First-party output ⊆ ceiling |
| POL-PROP-7 | Credential paths are denied for every input |
| POL-PROP-8 | `bestEffort` never contains a mandatory dimension |
| AUTH-PROP-1 | Monotone: adding a deny never yields an allow |
| AUTH-PROP-2 | Attenuating: allow(P via chain) ⇒ allow(C) for each C |
| AUTH-PROP-3 | Egress-compatibility holds for every data-flow edge |
| POL-DET-1 | Replay: logged decisions reproduce exactly |

### K.3 Suites

Each id is a test file or `describe` block. "Exp-fail" marks known residuals that must keep failing until fixed. If one passes, CI asks for the residual to be removed.

| Suite | Cases (summary) | Platforms |
|---|---|---|
| ATTEST-* | External evidence present; a forged ready line without the sandbox (run the prologue unsandboxed) is rejected; go byte withheld → no workload marker | All |
| FAULT-1..12 | Every launch step fails → the child is dead, the status is `failed`/`refused`, no marker | All |
| LST-1..8 | CVE-2026-82533 replay: from every profile, every Volt port and socket with no token, a forged token, a forged Host, no Origin (B-01) → 401/403. A fake `127.0.0.1:3080` on the host is unreachable | All |
| IPC-1..6 | Payload extension ids, URL chat ids, forged `onBehalfOf`, a reused channel after revoke, an unknown principal, a wrong HMAC epoch | All |
| XPL-1..4, XPL-CMD-1..3 | Plugin A calling B's command; internal `volt.*` commands from an extension; `exports` across hosts | All |
| PERM-FLOW-1 | Egress compatibility (B-22) | All |
| GATE-SPAWN-1..6 | `thread_launch {model: codex}`, `handoff` to Codex, `project: other`, `workspace: root` from a worktree, `existing_worktree` (B-10, B-11) | All |
| GATE-SYM-1, GATE-XCHAT-1..3 | Symlinked secrets via `instant_grep`; `thread_read` and `terminal_output` of another chat | All |
| LIFE-PATH-1..8 | Every B-06 path from a sandboxed chat: terminal, native shell, workflow, worktree setup, `docker_ensure`, probes, title generation, post-turn check | All |
| PERS-1..8, PERS-AGENT-* | `.git/commondir`, `.git/config`, hooks, `hooksPath` into tracked dirs, `~/.zshrc`, LaunchAgents, systemd user units, Run keys; per provider: MCP entries, settings, `CLAUDE.md`, skills | All |
| GIT-1..4 | HostGit ignores fsmonitor, hooks, `alternates`, `ext::` | All |
| REPO-1..9 | `.mcp.json` before trust, after trust before approval, after an args change; `.vscode/tasks.json`; `.envrc`; repo `.volt/sandbox.json` widening; repo workflow claiming `source.kind: builtin` | All |
| MCP-1..6 | Tool poisoning, rug pull (description change), shadowing a Volt tool, 64-char name collision, server reaches home, server reaches the network | All |
| CRED-1..8 | Canaries in `~/.ssh`, `~/.aws`, `gh`, keychain item, `.env` deep in a big tree, browser profile, a secret ref used by another principal, raw secret read | All |
| MAC-ENV-1 (exp-fail), MAC-ENV-2 | `KERN_PROCARGS2` reader against a canary process; no secret-like env in any Volt-spawned process | macOS |
| MAC-TCC-1,2 | Responsible pid; Full Disk Access canary (manual lane) | macOS |
| MAC-TTY-1, MAC-MACH-1..4, MAC-LD-1, MAC-HL-1, MAC-SPAWN-1, MAC-FS-1..3 | Per J.1 | macOS |
| LNX-* | Per J.2, including LNX-BWRAP-CVE on 0.9.0 (expect refuse) and 0.13.1 (expect pass), LNX-RACE-1, LNX-ENV-1 | Linux |
| WIN-* | Per J.3, including WIN-MSYS-1, WIN-ESC-1..4, NET-WIN-DNS (exp-fail), WIN-ENV-1 | Windows |
| NET-1..20 | I.4 corpus | All |
| WEB-1..6, T3-WEBVIEW-1 | Webview roots, CSP, `openExternal`, popups to custom schemes, partition permission handler, beacon from a network-off chat's page | All |
| REV-1..5 | Revoke a host mid-tunnel; revoke a plugin with an open RPC; revoke a file grant mid-stream; signer change; revocation-list entry | All |
| REM-1..6 | Expired token, revoked device, stolen-token step-up, LAN pairing lockout per source, relay pairing brute force limit, client-swapped host in approval | All |
| SUP-1..7 | Unsigned feed; cross-channel signature; rollback below installed; Windows installer without Authenticode; macOS cross-channel without codesign; tampered `.vsix`; built-in file edited | All |
| HELPER-1..4 | Swap each helper → refused; `wxc-exec` hash mismatch | All |
| HOST-SIG-1..3 | SIGUSR1 to every host type → no inspector; `NODE_OPTIONS=--inspect` in a layer → dropped; `--inspect` in `execArgv` outside developer mode → refused | All |
| RES-1..6 | Memory bomb, fork bomb, `yes > file`, 10k files in tmp, 1,000 connections, a crash loop | All |
| RACE-1..6 | Symlink flip during broker writes; path swap before bind; concurrent approvals; grant revoked between check and use | All |
| SEC-DSEC-* | DSec replays: forge control RPC, overwrite `/bin/bash`/the app bundle, `grep -r /proc`, `yes > file`, port scan, leftover hunting in other runs' tmp | All |
| UX-1..6, UX-FORGE-1, UX-LABEL-1..3 | Forged denial rows get no buttons; inert buttons; budgets; labels match attestation | All |
| ESC-E1..E24 | Revision 1's E1–E18, plus E19 `.git/commondir`, E20 agent state persistence, E21 browser partition egress, E22 `AF_VSOCK`, E23 TCC inheritance, E24 `KERN_PROCARGS2` | Per OS |

### K.4 Static gates

- **Spawn audit.** Every `child_process.*`, `utilityProcess.fork`, `new Worker` (with `eval` or a file outside `out/`), `vm.*` and `pty.spawn` call site in `src/` and `apps/` is in `build/volt/sandbox-spawn-allowlist.json` with an owner and a reason: `supervisor`, `user-action` or `build-only`. A new site fails CI.
- **Listener lint.** `http.createServer`, `net.createServer`, `WebSocketServer` and `listen(` outside the listener library fail.
- **Command visibility lint.** B-09.
- **Git lint.** `git` spawned outside `HostGit` fails.
- **Env lint.** A secret-like env name set on any spawn fails (INV-24).
- **Footprint lint.** A provider footprint with a writable directory and no file allow list fails (B-05).
- **Ceiling check.** A first-party manifest ⊄ its ceiling fails.

### K.5 CI matrix

| Runner | Runs | When |
|---|---|---|
| `ubuntu-24.04` x64 + arm64; Docker rig: Debian 12, Fedora (SELinux), Ubuntu 22.04, Arch, plus bwrap 0.9.0 and 0.13.1 images | Unit, property, LNX-*, differential | Every PR touching the sandbox, brokers, listeners, loader, grants (path filter) |
| `macos-15` + newest | Unit, MAC-*, differential | Same |
| `windows-11-arm` (hosted, 26200.9725 ≥ floor [src]) | WIN-*, NET-WIN-* | Same, once C4 lands; required for Windows default-on |
| Self-hosted Windows 11 x64, ephemeral VM | WIN-* x64 | Nightly; required for releases (D-12) |
| `windows-2022` (existing) | Refusal suite: nothing claims "sandboxed" without a backend | Every PR above |
| Packaged-binary smoke, all OSes | volt-server under `RUN_AS_NODE`, listener matrix, fuses read-back, helper signatures | Release workflows |
| Integration (real extensions, real agent CLIs) | Enforce mode | Nightly + release |
| Perf bench | Part L | Nightly |

### K.6 Release gates

1. All mandatory dimensions enforced on every supported row (J).
2. 100% of non-exp-fail suites green. Each exp-fail has an owner and a linked issue.
3. 0 attestation failures and 0 canary failures over 7 days of beta.
4. Refusal rate < 2% on supported rows.
5. Every host tool and command classified.
6. No Part L metric regressed by more than 20%.

---

## Part L. Performance benchmarking plan

### L.1 Baselines (measured) and budgets

| Metric | Baseline | Budget (p50 / p95) | Regression gate | How |
|---|---|---|---|---|
| Sandboxed command end to end, `workspace` profile, macOS | 65 ms p50, 75 ms p90 (`sbx:docs/security/sandbox/04-performance.md`, M4 Max) | 80 / 120 ms | +20% | `volt-sandbox-bench.mjs --runs 30` |
| Same, Linux (Docker VM, arm64) | 20.4 ms | 30 / 50 ms | +20% | Linux rig `bench` |
| Same, Windows MXC | Not measured; field report of ~28 s with UI enabled [report] | **[open]** target 300 / 800 ms; Windows stays off by default until met | +20% once set | WIN bench on arm64 + x64 |
| `sandbox-exec` overhead per spawn | +6–8 ms (`true`, `node -e 0`) [test] | — | Tracked | Microbench |
| Attestation added (`sandbox_check` / `/proc` read / token query) | Not measured **[open]** | ≤ 3 ms | +50% | Bench |
| Agent CLI process start (sandboxed), excluding the CLI's own boot | 88 ms macOS (branch) | 120 / 200 ms | +20% | Bench |
| T2 host cold start to first RPC | Not built; components: Electron-as-Node child 62 MB, `utilityProcess` 74 ms fork-to-message [test]; SES lockdown 4–10 ms [test] | 150 / 300 ms | +20% | New bench |
| T2 host warm activation (process running) | — | 5 / 20 ms | +50% | New bench |
| T3 host cold start (one small extension) | Not measured | 400 / 800 ms | +20% | New bench |
| Tool call round trip through T2 (empty handler) | — | 1 / 3 ms | +50% | New bench |
| RPC throughput, 1 KB messages | — | ≥ 20k msg/s per channel | −20% | New bench |
| File broker read 1 MB (mediated) vs direct | — | ≤ 1.5× direct | +20% | New bench |
| File broker small-file op (stat/open/close) | — | ≤ 0.5 ms | +50% | New bench |
| Network broker throughput (CONNECT, 1 GB over loopback to a local TLS sink) | Not measured (branch) | ≥ 80% of direct | −20% | New bench |
| Network broker added connect latency | — | ≤ 2 ms + one DNS lookup | +50% | New bench |
| Memory per idle T2 host | ~62 MB Electron-as-Node baseline [test] + SES ~4–6 MB [test] | ≤ 80 MB | +15% | `ps`/`proc_pid_rusage` |
| Memory per idle T3 host | Not measured | ≤ 120 MB | +15% | Same |
| Host-side memory per sandbox (watchdog/bwrap monitor/socat) | ~2 MB watchdog (macOS) | ≤ 5 MB | +20% | Same |
| CPU of idle hosts | — | 0% (no timers when idle; stopped after idle budget) | Any non-zero over 60 s | `top` sample |
| Concurrency: 8 sandboxes started together | 94 ms for all 8, macOS | 150 ms | +20% | Bench |
| 100 agent chats, idle | — | Supervisor + broker CPU < 1% of a core, memory < 50 MB beyond the agents themselves | +20% | 100-agent rig (`volt-agent-server-scale` memory) |
| Revocation latency (network) | — | ≤ 1 s to close tunnels | > 1 s | REV-1 timing |
| Revocation latency (OS-level, relaunch/kill) | — | ≤ 5 s | > 5 s | REV-2 timing |
| Shutdown (all principals) | — | ≤ 2 s for 50 principals | +50% | Bench |
| Policy compile | 5.1 ms macOS (branch) | Cached by `(view digest, backend digest)`: 0.1 ms hit | +50% | Bench |

### L.2 Safe optimisations

- **Cache immutable compilation.** Key compiled launch policies and SBPL/BPF text by `(launchView digest, backend report digest)`. Invalidate on any input digest change. Correctness test: a cache hit equals a recompile.
- **Lazy everything:**
  - hosts start on activation events;
  - brokers' routes open on first use;
  - the bounded pattern walk runs once per workspace per epoch, with results keyed by a directory-mtime digest and re-walked when it changes.
- **Pool only identical identities** (H.6): a warm process image for the same `(subject, digest, policy hash)`.
- **Keep SBPL small:** drop rules outside every readable or writable root (the branch did this and saved about 20 ms). Prefer regexes over thousands of literals (srt: thousands of filters take seconds to compile [src]). Keep each string literal under 1 KB, because `sandbox-exec` rejects literals over 1025 bytes [src].
- **Linux:** one `systemd-run --user --scope` per host, not per command, for long-lived hosts. Commands inside a host share its cgroup.
- **IPC:** binary frames for bulk data; avoid JSON for file contents.
- **One container per long-lived host** (MXC), not per shell line: one attestation per host, and it avoids the MXC I/O stalls srt reported with concurrent containers [report].

### L.3 Forbidden optimisations

- Co-hosting different subjects.
- Skipping attestation on a warm start.
- Caching DNS answers across connections.
- Report mode at the OS layer.
- Reusing a principal across workspaces or policy hashes.
- Letting a supervisor restart reuse a broker route.

---

## Part M. Implementation roadmap

### M.0 Principles

- **Close live exposure first.** Phase 0 runs on `main` and needs nothing from the sandbox branch.
- **Never merge a known escape.** Phase 1 fixes the branch's Critical and High findings before C1.
- **Every PR keeps `main` shippable.** The new path is off, or in report mode at the API layer, until its gate passes. The old path stays until a later PR removes it.
- **Rollback is a plain revert,** or a setting flip that is application-scoped and narrow-only.
- **Effort is in engineer-weeks with agents (ew).** Every number is a **guess**.

**Dependency graph:**

```mermaid
flowchart LR
  subgraph P0[Phase 0: main, now]
    L1[P0-1 listener auth] ; L2[P0-2 repo MCP gate] ; L3[P0-3 identity + commands] ; L4[P0-4 helper integrity] ; L5[P0-5 env + browser hygiene]
    S1[S1 release secrets] ; S2[S2 signed feed + installer checks] ; S3[S3 extension signatures + built-in manifest]
  end
  subgraph P1[Phase 1: branch hardening]
    H1[H1 HostGit + .git allow list] ; H2[H2 ExecContext everywhere] ; H3[H3 agent state overlay] ; H4[H4 inheritance + Codex wrap] ; H5[H5 host reads + browser partition] ; H6[H6 fs broker ops] ; H7[H7 backend hardening + attestation]
  end
  C1[C1 merge sandbox]
  subgraph P2[Phase 2: core]
    C2[C2 registry + authority + grants] ; C3[C3 network broker v2] ; C4[C4 Linux/macOS extras] ; C5[C5 supervisor hosts] ; C6[C6 MCP under supervisor] ; C7[C7 MXC backend]
  end
  subgraph P3[Phase 3: boundary migration]
    M1[M1 facade + manifests] ; M2[M2 providers as data] ; M3[M3 per-feature PRs] ; M4[M4 T1 fencing] ; M5[M5 ceilings enforce]
  end
  subgraph P4[Phase 4: plugin hosts]
    Q1[P1 T2 host + memory] ; Q2[P2 T3 host per extension] ; Q3[P3 brokers] ; Q4[P4 permission UX] ; Q5[P5 webview ownership] ; Q6[P6 desktop routing] ; Q7[P7 namespace + revocation] ; Q8[P8 default flip]
  end
  L3 --> H4
  H1 & H2 & H3 & H4 & H5 & H6 & H7 --> C1
  C1 --> C2 --> C3
  C1 --> C4
  C2 --> C5 --> C6
  C1 --> C7
  M1 --> M2
  M1 --> M3 --> M5
  C2 --> M5
  M1 --> M4
  C2 & C3 & C5 --> Q1 --> Q3 --> Q4
  C2 & C3 & C5 & L3 --> Q2 --> Q5 --> Q6
  S3 --> Q7
  Q2 & Q4 & Q7 --> Q8
  C7 --> Q8
```

### M.1 Phase 0: close live exposure on `main` (about 6 ew)

**P0-1. Listener authentication** (1.5 ew)
- **Objective:** no Volt listener grants anything on loopback or Origin alone (B-01, B-24 partly, device hub, playground).
- **Architecture:** a new `src/vs/platform/voltListeners/node/listenerAuth.ts`:
  - bearer from a 0600 file or a per-launch secret;
  - constant-time compare;
  - Host allow list;
  - `Origin` required on state-changing browser routes;
  - per-source rate limits.

  `/api/auth/local` accepts only a single-use nonce that the desktop app puts in the URL fragment when it opens the local web session.
- **Files:**
  - `src/vs/server/node/voltAgent/serverPairing.ts` (`:343-352`, `issueLocal`, the failure limiter at `:21-25`);
  - `agentServerMain.ts` (WS Origin rule at `:644-645`, `/health` compare at `:739`);
  - the desktop opener for the local session;
  - `apps/relay/src/relay.mjs` (`:130-133` failure limit);
  - `voltDevices/…/deviceHub.ts`, `voltBrowser/…/browserPlaygrounds.ts`.
- **Dependencies:** none.
- **Sequence:**
  1. Library + tests.
  2. The local-session nonce (desktop and server together).
  3. Per-source pairing limits.
  4. Relay limit.
  5. Device hub and playground.
  6. The listener lint, in warn mode, then error.
- **Acceptance:**
  - `curl -XPOST …/api/auth/local` → 403;
  - the browser sign-in from the desktop works;
  - LAN pairing lockout from one address doesn't affect another;
  - relay pairing locks after 10 failures per code.
- **Security tests:** LST-1..8, REM-4,5.
- **Performance:** auth adds < 0.2 ms per request.
- **Rollback:** revert. The nonce flow and the old flow can't coexist, so this ships in one release with a note.
- **Done:** LST suite green on macOS, Linux and Windows; the lint is at error level.

**P0-2. Repo MCP gate** (1 ew)
- **Objective:** no repo-supplied MCP server runs without trust and a content-pinned approval (B-02).
- **Architecture:**
  - `IVoltMcpApprovals` store in user data, keyed by `(workspace realpath, server name, config digest)`.
  - User entries take precedence over project entries.
  - Prewarm only approved servers.
  - The approval card shows the full command, args, env names and resolved binary path.
- **Files:** `src/vs/workbench/services/voltRuntime/browser/host/mcpHost.ts` (`:26`, `:115-128`, `:165`), `mcpConfig.ts`, `voltRuntimeService.ts` (`prewarmNative` ~`:1408-1412`, `:4323`), a new approval UI in the composer card area.
- **Dependencies:** none.
- **Sequence:**
  1. Precedence fix.
  2. Trust gate.
  3. Approval store and card.
  4. Pin by digest; re-prompt on change.
- **Acceptance:** REPO-1..3 and MCP-1..2 green; existing user-level servers keep working with no prompt.
- **Security tests:** REPO-1..3, MCP-1..4.
- **Performance:** none measurable.
- **Rollback:** revert. Approvals are additive data.
- **Done:** a fixture repo can't run code on focus; behaviour change B-AP-2 is in the release notes.

**P0-3. Identity checks and command visibility** (1.5 ew)
- **Objective:** close B-07 (host MCP cross-chat) and B-09 (privileged commands), and lay the groundwork for B-08.
- **Architecture:**
  - Port the branch's per-session HMAC host-MCP token (`sbx:platform/voltHostMcp/node/voltHostMcpService.ts:84-98`, `sbx:…/hostToolService.ts:536-545`), adding a key epoch and expiry.
  - Command visibility (I.14). `volt.browser.automate` becomes an internal service call.
  - `MainThreadSecretState`, `Authentication`, `Storage` and `WebviewPanels` check the payload id ∈ the extensions running in that host.
- **Files:**
  - `src/vs/platform/voltHostMcp/node/voltHostMcpService.ts`;
  - `src/vs/workbench/services/voltRuntime/browser/host/hostToolService.ts`;
  - `browserAutomation.ts:1625`;
  - `agentServerClient.contribution.ts:567-579`;
  - `agentChangesActions.ts:230,255`;
  - `src/vs/workbench/api/browser/mainThreadCommands.ts`, `mainThreadSecretState.ts`, `mainThreadAuthentication.ts`, `mainThreadStorage.ts`, `mainThreadWebviewPanels.ts`;
  - `src/vs/platform/commands/common/commands.ts` (visibility field).
- **Dependencies:** none. Conflicts with the branch's hostToolService changes are resolved at C1.
- **Acceptance:** IPC-2, XPL-CMD-1..3; a test extension calling `volt.browser.automate` gets `CommandNotAllowed`; a test extension's `$getPassword` for an id not in its host is denied.
- **Security tests:** IPC-1..3, XPL-CMD-*.
- **Performance:** none.
- **Rollback:** revert per item.
- **Done:** the command lint is at error level for `volt.*`.

**P0-4. Helper integrity** (1 ew)
- **Objective:** no helper or enforcement binary runs from a user-writable location without verification (B-14).
- **Architecture:**
  - Helpers are built in CI, signed and placed in the app bundle.
  - Runtime compile paths go behind developer mode.
  - The supervisor-to-be (today each service) verifies the signature (macOS `SecStaticCodeCheckValidity` with the designated requirement; Windows `WinVerifyTrust`; Linux the `builtin-manifest.json` digest) before every launch.
- **Files:** `voltSpeechMainService.ts` (`:156`, `:272`, `:294`, `:325-331`), `voltDesktopMainService.ts` (`:141`, `:213`, `:222-226`), `fffEngine.ts` (`:63`, `:237`, `:351-353`), `deviceHub.ts` (`:191`, `:203`, `:342`), build scripts under `build/volt/`.
- **Dependencies:** S1 (signing in a protected Environment).
- **Acceptance:** HELPER-1..4; speech, computer use and FFF work from a packaged build; TCC prompts are attributed to the signed helper.
- **Rollback:** revert to runtime compile behind a setting.
- **Done:** no helper path under user data in a packaged build.

**P0-5. Environment and browser hygiene** (1 ew)
- **Objective:** close B-38, B-36, B-37 and the argv secret.
- **Architecture:**
  - `voltStdioService` builds child env from an allow list (no `VSCODE_IPC_HOOK*`, no `ELECTRON_*` unless needed).
  - `claudeLogin.ts:98` writes via stdin.
  - `volt.devices.remoteHosts` becomes APPLICATION-scoped, with `user` validated.
  - The in-app browser gets `will-attach-webview`, `setWindowOpenHandler` (http/https only) and partition permission handlers.
  - volt-server starts with `--disable-sigusr1`, after HOST-SIG-1 passes under `RUN_AS_NODE` on Node 22.19.
- **Files:** `src/vs/platform/voltStdio/node/voltStdioService.ts` (`:478`), `src/vs/platform/voltAccounts/node/claudeLogin.ts`, `voltDevices.contribution.ts:50`, `agentDevices.ts:37-58`, `browserEditor.ts:1402-1404`, `src/vs/code/electron-main/app.ts` (`:470-498`), `agentServerLauncher.ts:168`.
- **Acceptance:** ENV-IPC-1, CFG-1, WEB-1..3, HOST-SIG-1 (volt-server).
- **Rollback:** revert per item.
- **Done:** every item's test is green.

**S1. Release secrets and provenance** (0.5 ew)
- **Objective:** signing keys reachable only from reviewed release runs (B-18).
- **Changes:**
  - a `release` Environment with required reviewers;
  - `secrets: inherit` removed in favour of explicit secrets in the signing job only;
  - build split from signing;
  - signing jobs pin actions by SHA;
  - `actions/attest-build-provenance`;
  - release workflows **fail** without certificates (`darwin-package.sh:43-53`, `win32-sign.ps1:15-17`);
  - publishing doesn't proceed when a platform job fails (`volt-build.yml:609`).
- **Files:** `.github/workflows/volt-{stable,beta,nightly,build}.yml`, `build/volt/release/*`.
- **Acceptance:** a workflow on a throwaway branch can't read the secrets; `gh attestation verify` passes for a release asset.
- **Rollback:** revert the workflow.
- **Done:** two releases cut through the Environment.

**S2. Signed feed and installer verification** (1 ew)
- **Objective:** an update installs only with a valid feed signature and a valid platform signature (INV-28).
- **Changes:**
  - An Ed25519 feed signature with a pinned key per channel. The key lives in the protected Environment; the public keys go in `product.json`.
  - The feed has an expiry and a monotonic version.
  - macOS cross-channel installs check `codesign --verify --deep --strict` and the team identifier before the move.
  - Windows checks Authenticode with the pinned publisher before running the installer.
  - `downloadUrl` and `releaseUrl` must be https.
- **Files:** `src/vs/platform/update/common/voltUpdateFeed.ts`, `electron-main/updateService.{darwin,win32}.ts`, `voltUpdateDownload.ts`, `build/volt/release/publish.mjs`, `product.json`.
- **Acceptance:** SUP-1..5.
- **Rollback:** a feed served with both old and new fields for one release, then signature-only.
- **Done:** an unsigned feed is refused in a packaged build.

**S3. Extension signatures and built-in manifest** (1 ew)
- **Objective:** INV-29; the built-in integrity check.
- **Changes:**
  - Verify Open VSX `.sigzip` against the pinned registry public key (Ed25519, `node-ovsx-sign`-style), instead of `@vscode/vsce-sign`, which can't parse it [src].
  - Unsigned → install only as an explicitly unsigned third-party extension.
  - `builtin-manifest.json` (file hashes) is generated at build and checked at load for `extensions/volt-*` and helper binaries.
- **Files:** `src/vs/platform/extensionManagement/node/extensionSignatureVerificationService.ts`, `extensionDownloader.ts:73-75`, `extensionGalleryManifestService.ts:227`, `extensions.contribution.ts:268`, build.
- **Acceptance:** SUP-6,7.
- **Rollback:** a setting to warn instead of refuse, application-scoped, for one release.
- **Done:** a tampered `.vsix` is refused.

### M.2 Phase 1: harden the sandbox branch before merging it (about 9 ew)

All on `feat/volt-sandbox`, or a branch from it.

**H1. HostGit and the `.git` allow list** (1.5 ew)
- **Objective:** B-03, INV-16.
- **Changes:**
  - The `.git` allow list in `sandboxProfiles.ts`, `sandboxResolver.ts:394-408` and `bwrap`/`seatbelt` generators.
  - `HostGit` in `src/vs/platform/voltGit/node/hostGit.ts` **[proposed]**.
  - Every host git call migrated: `voltRuntimeService.ts:4664`, `agentWorktreeService.ts:193`, `gitTools.ts:117`, PR and commit services.
  - Git lint.
- **Acceptance:** GIT-1..4, PERS-1..3.
- **Rollback:** revert. HostGit is additive.
- **Done:** the lint is at error level.

**H2. `ExecContext` on every execution path** (2 ew)
- **Objective:** B-04, B-06, INV-03, INV-14.
- **Changes:**
  - `IVoltExecRequest` and `spawn` take a required `ExecContext`.
  - The post-turn check (`voltRuntimeService.ts:5449-5493,5589`) runs with the chat's sandbox.
  - Native-model shell (`shellTool.ts:181,236`), workflows (`workflowExecutors.ts:789,805,1003`), worktree setup (`agentRunGroupService.ts:350-373,413-415`, `agentWorktreeSetupService.ts:285`), `docker_ensure` and `app_open` (`managedTerminals.ts:924-1007`), probes and title generation (`acpProvider.ts:1165`, `voltRuntimeService.ts:1293`), and hooks (`voltHooksService.ts:336`) either carry the chat principal or are refused for sandboxed chats.
  - Managed terminals for sandboxed chats stay refused until C5's PTY path.
  - The relay runner gets a stripped env and runs through the supervisor on Linux.
  - The spawn-audit gate starts (K.4).
- **Acceptance:** LIFE-PATH-1..8; the spawn audit is green with every site classified.
- **Rollback:** revert per path.
- **Done:** the allowlist has no `TODO` reasons.

**H3. Agent state overlay** (1.5 ew)
- **Objective:** B-05, INV-17.
- **Changes:**
  - Footprints in allow-list form (`sandboxPolicy.ts:133-200`).
  - Per-chat config overlays for Claude (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`) and others where supported; others get read-only config.
  - Merge-back of allowlisted keys after the turn.
  - Generic providers get no writable home state.
  - The footprint lint.
- **Acceptance:** PERS-AGENT-* for every provider; live turns on Claude, Codex, Cursor, Grok and OpenCode still work. Logins persist through the CLI's own credential file, which stays writable for its own principal only.
- **Rollback:** revert. Overlays are temporary directories.
- **Done:** the lint is at error level.

**H4. Inheritance and Codex wrap** (1 ew)
- **Objective:** B-10, B-11, INV-11.
- **Changes:**
  - `sandboxStrategy` always returns `wrap` for sandboxed levels, so Codex runs with its own sandbox off under Volt's wrap (`sandboxPolicy.ts:480-488`, `codexAppServer.ts:118`).
  - Strategy and roots go into `isAtLeastAsStrict`/`sandboxCovers`.
  - Spawn and handoff require child roots ⊆ caller roots.
- **Files:** `sandboxPolicy.ts`, `sandboxInheritance.ts:96-111`, `chatSandbox.ts:20-25`, `hostToolSandbox.ts:266-287,416-438`, `agentThreadToolService.ts:950-970`.
- **Acceptance:** GATE-SPAWN-1..6.
- **Rollback:** revert.
- **Done:** green.

**H5. Host reads and browser egress** (1 ew)
- **Objective:** B-15, B-16, B-30.
- **Changes:**
  - Sandboxed chats' search and index ignore symlinks and filter results by the real path.
  - Search tools are re-classed `reads`.
  - A per-chat signed-out browser partition with `setProxy` to the chat's proxy.
  - `listen` off by default, with a per-port grant.
- **Files:** `ripgrep.ts:29-31,64-66`, `voltCodeIntelligence.contribution.ts:48`, `hostToolSandbox.ts:53,95-104,534-536`, `browserEditor.ts`, `seatbelt.ts:203-207`, `sandboxPolicy.ts:401,406`.
- **Acceptance:** GATE-SYM-1, WEB-6, NET-LISTEN-1.
- **Rollback:** revert per item.

**H6. Race-free host file operations** (1 ew)
- **Objective:** B-17, INV-12, INV-13.
- **Changes:**
  - ACP `fs/*` goes through handle-based opens: macOS `O_NOFOLLOW_ANY` [test]; Linux the `volt-fsd` `openat2` helper; Windows component-wise reparse refusal.
  - `sandboxAllows` fails closed for unknown ids and unbound sessions.
- **Files:** `acpProvider.ts:2061-2077,2176-2183`, `voltStdioService.ts:219-230`, new `src/vs/platform/voltFiles/node/safeOpen.ts` + native helper.
- **Acceptance:** RACE-1..3; unit tests.
- **Rollback:** revert.

**H7. Backend hardening and external attestation** (2 ew)
- **Objective:** B-12 (rules), B-13, B-20, B-26, B-27, B-28, B-29, B-31 (live grants), B-33, B-35.
- **Changes:**
  - **macOS:** disclaim at spawn; `/dev/ttys*` removed; mDNSResponder denied outside `host`; `sandbox_check` attestation; go byte.
  - **Linux:**
    - bwrap ≥ 0.12 or a passing CVE trial;
    - socket-family allow list and the missing syscalls in `seccomp.ts`;
    - pattern-walk refusal;
    - `--bind-fd` roots;
    - `/proc` attestation from the parent;
    - go byte.
  - **Both:**
    - deny `~/.volt/sandbox/runs` except the run's own folder, and per-principal caches;
    - "Allow host" wired to `allowSandboxDomains` (minimal fix before C3);
    - the proxy route token (minimal).
- **Acceptance:** MAC-TCC-1, MAC-TTY-1, ATTEST-*, FAULT-1, LNX-BWRAP-CVE, LNX-SECCOMP-*, LNX-ENV-1, SEC-CROSS-1, and NET live grant (same PID).
- **Performance:** attestation ≤ 3 ms; the macOS `workspace` end-to-end budget stays ≤ 80 ms p50.
- **Rollback:** revert per item.
- **Done:** the suite is green on macOS 15, macOS newest, Ubuntu 24.04 with bwrap 0.13.1, and the Docker matrix.

**C1. Merge `feat/volt-sandbox`** (1 ew, **needs the owner's approval, D-01**)
- **Objective:** one sandbox on `main`.
- **Changes:** merge main into the branch, resolve conflicts with P0-3 (hostToolService, voltHostMcpService), and replace `main`'s older `platform/voltSandbox` copy.
- **Acceptance:**
  - every branch suite green on macOS and Linux;
  - Windows sandboxed chats refuse;
  - a chat at `Off` behaves as today;
  - live agent turns on every provider.
- **Rollback:** a revert commit. `main`'s pre-merge sandbox is opt-in and off by default, so reverting changes nothing for default users.
- **Done:** a beta release with the merged sandbox and no new crash class over 7 days.

### M.3 Phase 2: execution core (about 17 ew)

**C2. Principal Registry, Policy Authority, grant store, compiler split** (4 ew)
- **Objective:** one decision function (C.5, Part G); INV-01, 02, 18, 32.
- **Changes:**
  - New `src/vs/platform/voltSandbox/common/{principals.ts, authority.ts, grants.ts, compile.ts}` and `node/{principalRegistry.ts, grantStore.ts}`.
  - `sandboxComposition.ts` logic moves into `authority.ts`.
  - `hostToolSandbox.ts` decisions call `authority.evaluate`.
  - The grant store moves to `~/.volt/trust/grants.json` (atomic, epoch).
  - Decision log.
- **Sequence:**
  1. Pure Authority with property tests.
  2. Shadow mode: compute and compare with existing decisions; log diffs.
  3. Switch the host-tool gate.
  4. Switch the launcher.
  5. Remove old paths.
- **Acceptance:** POL-PROP-*, AUTH-PROP-*, POL-DET-1; 0 shadow diffs over one beta release (or each diff explained and fixed).
- **Performance:** `evaluate` ≤ 50 µs p95; snapshot rebuild ≤ 5 ms.
- **Rollback:** shadow mode stays switchable for one release.
- **Done:** no allow list outside the Authority (grep gate).

**C3. Network broker v2** (3 ew)
- **Objective:** I.4 in full; B-31; INV-19.
- **Changes:** per-principal routes and tokens, the special-range table, the exfil list, budgets, live grants with CAS, tunnel close on revoke, browser partition routing.
- **Files:** `node/sandboxProxy.ts` → `node/networkBroker.ts`, the bwrap holder, the Seatbelt network rules.
- **Acceptance:** NET-1..20 on macOS and Linux.
- **Performance:** throughput ≥ 80% of direct; connect overhead ≤ 2 ms.
- **Rollback:** the old proxy stays behind a flag for one release.
- **Done:** the old proxy is removed.

**C4. Linux and macOS second layers** (2 ew)
- **Objective:** J.1 and J.2 rows marked OS.
- **Changes:**
  - Landlock layer when ABI ≥ 1 (a static helper exec'd as the bwrap payload, `landlock_restrict_self()` before exec'ing the prologue);
  - per-host `systemd-run --user --scope` cgroups;
  - `cgroup.kill`;
  - macOS kqueue tracking and the responsible-pid sweep;
  - footprint polling.
- **Acceptance:** LNX-FS-3, RES-LNX-*, TREE-*, RES-MAC-*.
- **Rollback:** each layer behind a probe flag.
- **Done:** green.

**C5. Supervisor for long-lived hosts** (3 ew)
- **Objective:** F.4–F.11 for `lifetime: 'host'`.
- **Changes:** `start()`, restart budget, idle stop, resource accounting events, the attestation record and Security page, the PTY confirm path (FIFO pair), host budget.
- **Files:** `node/sandboxManager.ts` → `node/supervisor.ts` (`SandboxManager` kept as a façade), `voltStdio` integration, new `contrib/voltSecurity/` page.
- **Acceptance:**
  - a test host attests on macOS and Linux;
  - `NODE_CHANNEL_FD` round-trips;
  - the IPC pipe is unreachable from inside;
  - sandboxed terminals work for sandboxed chats (managed terminals un-refused).
- **Performance:** cold host start within budget.
- **Rollback:** feature flag (application scope).
- **Done:** Security page live.

**C6. stdio MCP under the supervisor** (2 ew)
- **Objective:** every MCP server is a T4 principal (B-02 completed).
- **Changes:**
  - `mcpHost.ts:165` spawns via `supervisor.start` with the server's approved policy: workspace read if declared, no home, network none until granted.
  - Tool-list pinning (hash of names, descriptions, schemas).
  - Namespacing without truncation collisions (hash suffix).
  - Connection cache partitioned by principal.
- **Acceptance:** MCP-1..6.
- **Rollback:** flag.
- **Done:** no unsandboxed MCP spawn in the spawn audit.

**C7. MXC backend for Windows 11** (4 ew)
- **Objective:** J.3.
- **Changes:**
  - `node/mxcBackend.ts`: config JSON v1.0.0, telemetry off, `wxc-exec` pinned and Authenticode-checked.
  - Image classifier (msys/cygwin/wsl).
  - Model 2 network.
  - Attestation via token and job queries, or the D-03 helper.
  - Poll-based limits.
  - Probe trials for surrogate spawns.
  - Startup benchmark.
- **Acceptance:**
  - WIN-* green on `windows-11-arm` and the x64 VM;
  - Git Bash refused with a reason;
  - p50 startup within budget, otherwise Windows stays off by default.
- **Rollback:** Windows backend flag.
- **Done:** the release gates for the Windows row.

### M.4 Phase 3: boundary migration (about 21 ew; runs in parallel from Phase 0)

**M1. Facade, contribution points, manifests, server enablement mirror** (3 ew)
- **Changes:** `IVoltPluginContext`; the facade in report mode; `contributes.voltTools`, `voltSlotItems`, `voltSettingsPages`, `voltSurfaces`, `voltDock`, `voltAgents`, `voltCapabilities`, `voltModule`; the 30 manifests filled in; `VOLT_FEATURES` generated from manifests; the server-side enablement mirror.
- **Dependencies:** none. Report mode doesn't need C2.
- **Acceptance:** catalog parity test; disabling a feature in the window stops its server tools.
- **Rollback:** the generator falls back to the hand-written list.

**M2. Providers as signed data** (2 ew)
- **Changes:** `contributes.voltAgents` (H.12) including the state overlay fields from H3; deep-equal parity with `CLI_AGENT_DEFINITIONS`.
- **Acceptance:** all 12 providers detected; live turn check.

**M3. One PR per feature** (about 12 ew)
- **Changes:** `contrib/volt<Feature>/` + `voltModule` + the import lint, in this order: git-graph, PR/commit-review split, usage UI, code-intelligence, agent-resources, automations UI, skills UI, remote-devices page, claude-accounts broker.
- **Acceptance per PR:** the lint is clean; the feature runs with only its manifest grants in report mode; a live parity checklist (fresh profile, CDP); enable/disable without reload; startup time before and after.
- **Rollback:** each PR reverts on its own.

**M4. Fence T1** (3 ew)
- **Changes:**
  - lazy load for the six deep-UI features;
  - agent HTML, charts and diagrams rendered in a separate sandboxed renderer;
  - the "Trusted core" label;
  - T1 line count tracked.
- **Acceptance:** UX-LABEL-*; no behaviour change.

**M5. Ceilings enforced** (1.5 ew)
- **Changes:** the ceiling table; CI `manifest ⊆ ceiling`; per-feature report → enforce after 0 would-be denials over one release.
- **Dependencies:** C2.
- **Acceptance:** CI fails on an over-wide manifest.

### M.5 Phase 4: plugin hosts (about 24 ew)

| PR | Objective and changes | Depends on | Acceptance | Rollback | ew |
|---|---|---|---|---|---|
| P1 | **T2 host** (H.1): `pluginHostMain.js`, SES Compartment, `volt-plugin/1` RPC, `MainThreadVolt*`-equivalents for tools, storage and context. **Memory** becomes the first T2 plugin, with the F.13 degraded mode | C2, C3, C5 | Identity-forging test; a simulated SES escape hits OS denials; memory works from desktop, web and phone; perf budgets | Memory falls back to in-process (the dual binding) | 4 |
| P2 | **T3 host per extension** on volt-server: supervisor-spawned `bootstrap-fork`, T3 default policy (H.7), per-host id sets enforced, `exports` handling (H.5) | C2, C3, C5, P0-3 | Top-50 Open VSX smoke with a breakage report; cross-extension secret test; git sync from `/code/` still works | Per-extension "run in shared host" setting during beta | 4 |
| P3 | **Brokers:** files (handle-based), secrets by reference, git, terminals; build-entry guard | C2 | RACE-*, CRED-6,7, GIT-*, build-entry tests | Revert per broker | 4 |
| P4 | **Permission UX:** install sheet, denial card, Access page, budgets, critical class, gesture tokens, Security page entries | C2, P3 | Usability check with 5 users; UX-*; a signer change drops grants | Revert | 3 |
| P5 | **Webview ownership:** core-derived origins, clamped roots, CSP, egress dispatcher, `openExternal` gate | P2 | WEB-*, T3-WEBVIEW-1 | Revert | 2 |
| P6 | **Desktop routing:** desktop runs third-party Node extensions in the local volt-server's sandboxed hosts; with the server off they refuse | P2 | Same smoke list from desktop | Setting | 2 |
| P7 | **Reserved `volt.*` namespace, revocation list, signer pinning** | S3 | Namespace-squat and tamper tests; REV-5 | Revert | 2 |
| P8 | **Default flip per OS:** sandbox required for third-party extensions and plugins on macOS and Linux; Windows only when C7's job is required and green and PERF-WIN-1 is met | P2, P4, P7, C7 | K.6 release gates | Kill switch moves the tier to `ask`, never to off silently | 1 |
| Later | TUF + threshold signing (with a marketplace); Volt registry and review; Windows legacy backend with per-run SIDs; SOCKS5 CONNECT; enterprise TLS inspection; VM tier; relay parity; seccomp allow list | — | Each with its own corpus | — | — |

**Total (guess):**

| Phase | ew |
|---|---|
| Phase 0 | 6 |
| Phase 1 + C1 | 10 |
| Phase 2 | 17 |
| Phase 3 | 21 |
| Phase 4 | 24 |
| **Total, before "Later"** | **about 78** |

Phases 0 and 1 (about 16 ew) remove every Critical finding. Phase 3 can run beside Phases 1 and 2.

---

## Part N. Open decisions

Each decision has a recommendation. **Owner's call** marks the ones only the product owner can make.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D-01 | Merge `feat/volt-sandbox` (C1) | Merge now / after Phase 1 / not at all | **After Phase 1.** Merging now ships B-03, B-04, B-05 and B-10 to every user who turns the sandbox on. **Owner's call** |
| D-02 | Order of work | Revision 1's tracks / Phase 0 first | **Phase 0 first, immediately.** B-01 and B-02 are live and unrelated to plugins |
| D-03 | Windows attestation if `wxc-exec` doesn't expose the job or container SID | Trust `wxc-exec`'s exit status / a small signed helper calling PSEC directly / wait for Node 24 (Electron ≥ 40 [src]) and use the SDK in-process | **Helper**, only if the C7 trial shows `wxc-exec` gives no externally checkable evidence. Reassess when Volt moves to Electron ≥ 40 |
| D-04 | bubblewrap floor | 0.8 (revision 1) / 0.12 / 0.12 or a passing CVE trial | **0.12, or an older distro build that passes the CVE-2026-87766 probe trial.** Ubuntu 24.04 (0.9.0) and Debian 12 users without a backport get a refusal with install guidance. **Owner's call** on how loud that is |
| D-05 | Deep-UI first-party features in-process | Out of process (Sol, revision 1) / in-process labelled trusted core | **In-process, labelled "Trusted core"**, with agent content in separate renderers and T1 size tracked |
| D-06 | First-party out-of-process logic on an OS that can't sandbox | Turn the features off / degraded mode asked once per machine | **Degraded mode,** decided before launch from static facts, shown permanently; never after a failed attestation |
| D-07 | `RunAsNode` fuse | Turn off / keep | **Keep.** volt-server and every sandboxed Node host run as `ELECTRON_RUN_AS_NODE` children (`agentServerLauncher.ts:168` [code]). Turn off `EnableNodeOptionsEnvironmentVariable` and `GrantFileProtocolExtraPrivileges` after a compatibility run |
| D-08 | App code integrity at rest | Pack `out/` into asar + `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` / rely on the code signature | **Asar + integrity fuses**, after a build trial. Today `out/` is loose and only `default_app.asar` is covered [test]. The app bundle is user-writable, so the signature alone isn't checked at load |
| D-09 | Third-party Node extensions on desktop with the agent server off | Refuse / run unsandboxed in `utilityProcess` with a warning | **Refuse.** `utilityProcess` can't be sandboxed [src, test] |
| D-10 | Extensions consuming another extension's `exports` | Unsupported / combined principal (union, critical) / RPC proxying | **First-party APIs as brokers; third-party pairs only through the critical combined grant; measure breakage in P2** |
| D-11 | Remote escalations | Server-owned only / plus a local owner confirmation by default | **Local owner confirmation by default** for persistent, local-network, secret-use, unsandboxed-spawn and set-to-Off approvals |
| D-12 | Windows x64 runner | None / self-hosted ephemeral VM | **Fund it.** Hosted `windows-11-arm` covers arm64 only, and Windows Server images aren't supported by MXC [src]. **Owner's call** |
| D-13 | Browser-only third-party extensions | Shared web-worker host / per-extension sandboxed renderer | **Per-extension sandboxed renderer** (T3-web), after a memory measurement. If it's too heavy, refuse third-party browser-only extensions with code until it fits |
| D-14 | Linux agent reads | Read all but credentials (branch) / read `${system}`, `${path}`, workspace, own state | **Narrow reads.** B-27 shows that pattern denies over `/` can't be guaranteed. Behaviour change for agents that read other projects |
| D-15 | Git Bash on Windows | Refuse / a legacy sandbox-user backend (srt-win style) | **Refuse in v1**, with PowerShell suggested. Revisit when MXC#1061 is fixed, or with a per-run-SID design and its own threat model |
| D-16 | Codex's own sandbox and approvals | Keep `native` / always wrap | **Always wrap.** Codex then runs with its own sandbox off inside Volt's, like the read-only level already does |
| D-17 | Claim the `volt` namespace on Open VSX | Yes / no | **Yes** |
| D-18 | `KERN_PROCARGS2` residual on macOS | Accept and document / block Volt-wide by hardened runtime + no env secrets / research a Seatbelt rule | **All three:** no env secrets (INV-24) now; hardened runtime for Volt's binaries after verification; a time-boxed rule search |

### N.1 Owner's answers (2026-11-08)

These override the recommendations above where they differ. Implementation follows them.

| # | Question | Answer |
|---|---|---|
| 1 | Scope of this run | All phases (0–4), in order, without stopping |
| 2 | Where the work lands | Everything on `feat/volt-sandbox`, with `main`, `feat/volt-sandbox` and `feat/volt-customize` merged in (customize is already in `main` as #62) |
| 3 | Git rights | Push and open PRs; never merge to `main` |
| 4 | D-01 | **Changed:** the sandbox reaches `main` now, through a PR; hardening lands in follow-ups |
| 5 | Default level for new chats | Sandbox **on by default** on macOS and Linux after Phase 1, and on Windows through MXC once C7 passes; every platform goes through `SandboxManager` |
| 6 | First-party plugins | Zero prompts, capped by ceilings compiled into core |
| 7 | B-01 | One-time link code from the desktop app, with the pairing code as fallback |
| 8 | B-02 | Workspace Trust + per-server approval pinned to the command |
| 9 | B-05 | Per-chat config overlay; only safe keys merge back |
| 10 | B-04/B-06 | Commands Volt runs for a sandboxed chat run inside that chat's sandbox with the chat's rules (not network-off) |
| 11 | Managed terminals | Build the sandboxed PTY path now (Phase 1), not in C5 |
| 12 | D-04 | Refuse bubblewrap < 0.12 unless the CVE probe passes |
| 13 | D-14 | **Changed:** narrow agent reads on **all** platforms (macOS, Linux, Windows) |
| 14 | Windows | Build MXC and verify it on the hosted `windows-11-arm` runner. The owner asked to get MXC by upgrading the VS Code base while keeping Volt's UI. Upstream removed its MXC integration on 2026-10-08 (microsoft/vscode#340446), so an upgrade brings nothing; the MXC launcher is ported from upstream's last version instead, with no UI change |
| 15 | D-12 | No self-hosted x64 runner for now |
| 16 | D-15 | **Changed:** try to make Git Bash work under MXC (MXC#1061: AppContainer-compatible MSYS2 runtime, ASLR/`fork()` interaction) without weakening MXC. Refuse until a CI test proves it works |
| 17 | S1–S3 | Implement the code; leave the GitHub workflows unchanged. Verification enforces only when `product.json` carries the keys |
| 18 | P0-4 | Yes: helpers signed in the bundle, verified before every launch; an "unsigned helpers" developer mode |
| 19 | D-07/D-08 | Yes, after a release-build trial |
| 20 | B-24 | Pinned self-signed TLS shown in the pairing QR, plus expiring tokens |
| 21 | T2 host | OS-sandboxed process with SES inside |
| 22 | P8 | **Changed:** sandboxing third-party VS Code extensions is **opt-in per extension**; by default they run as today |
| 23 | Live verification | Separate visible test instance; live turns on Opus 5.5 High; test the Git Bash issue as well |
| 24 | Execution | Parallel subagents in worktrees, combined at the end; no budget cap |
| 25 | Docs | The spec and `sandbox-prd/` stay untracked |
| 26 | Remaining recommendations | All accepted (D-03, D-05, D-06, D-09, D-10, D-11, D-13, D-16, D-18). The owner ticked "None" together with every item; read as "accept all" |

### N.2 Owner's later direction (2026-11-08)

- **No phone certificate pinning.** The phone app keeps connecting the way it did; LAN TLS stays available but isn't required.
- **No marketplace work.** No Volt registry, no Open VSX namespace claim (D-17 dropped), no revocation-list service (P7 dropped). Installing `.vsix` files from Open VSX or elsewhere stays as it is.
- **The main deliverable is the sandbox plus Volt-as-extensions:** every Volt feature is a built-in extension, preinstalled and enabled with no download and no `.vsix`, granted its access by default (first-party ceilings, zero prompts), and its APIs and utilities are exposed to third-party extensions through a `volt` extension API.

---

## Part O. Decision log

### O.1 Changes from revision 1

| Change | Revision 1 | Revision 2 | Deciding evidence |
|---|---|---|---|
| Start with live holes | Track S + C1 merge first | Phase 0 on `main` first | B-01, B-02 verified in code |
| Merge readiness | C1 then harden | Harden (Phase 1), then C1 | B-03, B-04, B-05, B-10 on the branch |
| Central abstraction | `SandboxManager` composes, launches and grants | Registry + Authority + Compiler + Supervisor + Attestor | The host-tool gate and launcher disagreed (B-10, B-11, B-15) |
| Confirmation | Ready line from inside | External attestation + go byte | `sandbox_check(pid)` works from the parent [test]; bwrap's status line precedes setup [src]; the workload ran before confirm (B-29) |
| First-party blast radius | Ceilings bind first-party plugins | Ceilings bind out-of-process code only; T1 is trusted core | B-21 |
| Pooling | Identical low-only plugins may share | One subject per process | B.4 #1 |
| Data flow | Attenuation only | Attenuation + egress compatibility | B-22 |
| File grants | fd passing | Mediated I/O for revocable grants | Revocation invariant |
| Windows | Job-object limits under MXC | Unsupported where MXC can't; polling; DNS residual; Git Bash refused | MXC schema and nested-job rules [src]; MXC#1061, #1629, #1665, #1666 [report] |
| bubblewrap | ≥ 0.8 | ≥ 0.12 or a CVE trial | CVE-2026-87766 [src] |
| macOS privacy | Not covered | Disclaim at spawn | B-13 [test] |
| macOS env exposure | Not known | Residual + "no secrets in env" | B-12 [test] |
| Agent state | Protect lists inside writable dirs | Allow lists + per-chat overlays | B-05 |
| Host git | Protected set keeps it safe | HostGit wrapper + `.git` allow list | B-03 |
| Host MCP | "Per-session HMAC" (main) | Main has a per-server bearer; port the branch's HMAC in Phase 0 | B-07 [code] |
| Plugin host process | Node host under the sandbox | Same, with `utilityProcess` excluded explicitly | `utilityProcess` has no sandbox and ignores `--permission` and `--disable-sigusr1` [src, test] |
| Spawn none | seccomp `execve` deny after first exec | No new processes (`fork`/`vfork` denied, `clone` only with `CLONE_THREAD`); self-exec allowed | A post-exec `execve` deny can't be installed by bwrap, which applies seccomp right before the workload's exec [src] |
| Linux agent reads | All but credentials | Narrow | B-27 |
| CI for Windows | Hosted image "below the floor" (guess) | Hosted `windows-11-arm` is 26200.9725 | runner-images readme [src] |
| VS Code inheritance | "Upgrading brings MXC code" | VS Code removed MXC; it uses srt on macOS and Linux | microsoft/vscode#340446 [src] |

### O.2 Kept from revision 1, with the deciding argument

| Decision | Deciding argument |
|---|---|
| One host per extension | The extension id is a payload value (`mainThreadSecretState.ts:38` [code]); a shared host can't be secured |
| Signed ceilings instead of "allow all" (for out-of-process logic) | A limit signed by the same key as the code is no limit; ceilings compiled into core need two keys |
| No override button on failed checks; `Off` is a separate control | On Windows with Git Bash, an override would become the backend |
| Providers as signed data | A returned launch spec makes core a process deputy in the widest profile |
| HTTP + CONNECT only, opaque TLS | New parsers are new bypasses; SNI doesn't stop fronting |
| No OS audit mode | bubblewrap and MXC can't audit; report mode exists only at the API layer |
| Two epochs (launch hash vs broker grants) | Restarting an agent for every "Allow host" loses the turn |
| No Electron `RunAsNode` change | volt-server needs it |
| Security switches in user data, narrow-only from workspaces | A cloned repo's `.vscode/settings.json` must not change security. On `main` the sandbox level and access mode are already APPLICATION-scope storage [code] |
| Remote: the execution host decides | Clients propose; the server re-derives |

---

## Part P. Sources

**Code:** `main` at `3d2540c` and `feat/volt-sandbox` at `ee23e23`, cited inline. Branch design docs: `sbx:docs/security/sandbox/00-assessment.md … 05-limitations.md`. Debate record: [`sandbox-prd/`](sandbox-prd/); revision 1: [`sandbox-prd/spec-v1.md`](sandbox-prd/spec-v1.md).

**Local tests (this machine, macOS 26.6, 2026-11-08):**
- `sandbox_check(pid)` from an unsandboxed parent returns 1 for a sandboxed child and 0 otherwise. Per-path answers match the profile on realpaths.
- `KERN_PROCARGS2` reads a canary env var from a `node` process under every profile tried.
- `sandbox-exec` adds about 6–8 ms per spawn.
- The research agents also measured: TCC responsibility and disclaim; launchd submit refused; mDNSResponder needed for `dns.lookup`; Electron 37 `utilityProcess` ignoring `--disable-sigusr1` and `--permission`; Volt's fuses at defaults; memory and startup baselines.

**macOS:**
- `sandbox-exec(1)` (deprecated notice): <https://keith.github.io/xcode-man-pages/sandbox-exec.1.html>
- Chromium mac sandbox: <https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/mac/README.md>, `common.sb`: <https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/policy/mac/common.sb>
- Responsible process: <https://www.qt.io/blog/the-curious-case-of-the-responsible-process>; VS Code TCC issue: <https://github.com/microsoft/vscode/issues/307364>
- Sandbox escapes: <https://jhftss.github.io/A-New-Era-of-macOS-Sandbox-Escapes/>, CVE-2025-31191: <https://www.microsoft.com/en-us/security/blog/2025/05/01/analyzing-cve-2025-31191-a-macos-security-scoped-bookmarks-based-sandbox-escape/>
- xnu sources (`O_NOFOLLOW_ANY`, `O_RESOLVE_BENEATH`): <https://github.com/apple-oss-distributions/xnu>

**Linux:**
- bubblewrap releases and advisory: <https://github.com/containers/bubblewrap/releases>, <https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx>
- Ubuntu userns restriction: <https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces>, 25.04 notes: <https://documentation.ubuntu.com/release-notes/25.04/>; Claude Code issue: <https://github.com/anthropics/claude-code/issues/87680>
- Flatpak userns requirements: <https://raw.githubusercontent.com/wiki/flatpak/flatpak/User-namespace-requirements.md>
- seccomp(2), seccomp_unotify(2), landlock(7), openat2(2), pidfd_open(2), pid_namespaces(7), PR_SET_PDEATHSIG: <https://man7.org/linux/man-pages/>
- Landlock: <https://docs.kernel.org/userspace-api/landlock.html>; cgroup v2: <https://docs.kernel.org/admin-guide/cgroup-v2.html>; systemd delegation: <https://systemd.io/CGROUP_DELEGATION/>, `user@.service`: <https://github.com/systemd/systemd/blob/main/units/user@.service.in>
- moby clone3 ENOSYS: <https://github.com/moby/moby/pull/42681>; io_uring block: <https://github.com/moby/moby/pull/46762>

**Windows / MXC:**
- <https://github.com/microsoft/mxc> (README, `docs/schema.md`, `docs/backends/process-container/{os-version-support,networking,filesystem,UIPolicy_Schema}.md`, `docs/logging-access-denied.md`, `schemas/stable/mxc-config.schema.1.0.0.json`, releases v1.0.0/v1.0.1)
- Issues: #1061, #1505, #1533, #1629, #1665, #1666, #1706
- VS Code: PRs #317669, #340188, #340446; `src/vs/platform/sandbox/common/settings.ts`
- srt: <https://github.com/anthropics/sandbox-runtime> and PR #766; Codex: <https://learn.chatgpt.com/docs/windows/windows-sandbox>, `codex-rs/mxc-sandbox`, `codex-rs/windows-sandbox-rs`
- Microsoft Learn: AppContainer isolation and implementation, job objects, nested jobs, `UpdateProcThreadAttribute`, restricted tokens, mandatory integrity control, `SetDefaultDllDirectories`, `OBJECT_ATTRIBUTES`, `CreateFileW`, `CreateNamedPipe`, WFP access control
- Project Zero: <https://projectzero.google/2021/08/understanding-network-access-windows-app.html>, <https://projectzero.google/2015/08/windows-10hh-symbolic-link-mitigations.html>, <https://projectzero.google/2015/12/between-rock-and-hard-link.html>
- Chromium sandbox design: <https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md>
- Runner images: <https://github.com/actions/runner-images> (Windows11-VS2026-Arm64-Readme)
- Windows 10 end of support: <https://support.microsoft.com/en-us/windows/deployment/updates-lifecycle/windows-10-support-has-ended-on-october-14-2025>

**Runtime and supply chain:**
- Node permissions: <https://nodejs.org/api/permissions.html>; SECURITY.md: <https://github.com/nodejs/node/blob/main/SECURITY.md>; CLI (`--disable-sigusr1`, `--allow-net`): <https://nodejs.org/api/cli.html>
- SES: <https://github.com/endojs/endo/tree/master/packages/ses>; CVE-2023-39532: <https://github.com/endojs/endo/security/advisories/GHSA-9c4h-3f7h-322r>; CVE-2025-32792: <https://osv.dev/vulnerability/CVE-2025-32792>; MetaMask Snaps executors: <https://github.com/MetaMask/snaps>
- Electron: utilityProcess (37-x-y docs and `node_service.mojom`), web-request, session, security checklist, fuses, asar integrity: <https://www.electronjs.org/docs/latest/>
- VS Code: extension runtime security, workspace trust, agent sandbox settings, 1.109 and 1.142 notes: <https://code.visualstudio.com/>
- Open VSX: <https://github.com/eclipse-openvsx/openvsx/issues/1247>, #1831, #543; Eclipse security updates and Trusted Publishing: <https://blogs.eclipse.org/>
- MCP security best practices (2025-11-25): <https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices>; Invariant Labs: <https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks>; Inspector GHSA-vcc9-3xgm-p9v4: <https://github.com/modelcontextprotocol/inspector/issues/2779>
- TUF: <https://theupdateframework.github.io/specification/latest/>; Sigstore: <https://docs.sigstore.dev/>; GitHub attestations: <https://docs.github.com/en/actions/concepts/security/artifact-attestations>; SLSA: <https://slsa.dev/spec/v1.1/levels>; Squirrel.Mac code signature: <https://github.com/Squirrel/Squirrel.Mac/blob/master/Squirrel/SQRLCodeSignature.m>
- Android: permissions <https://developer.android.com/training/permissions/requesting>, local network <https://developer.android.com/privacy-and-security/local-network-permission>, Privacy Sandbox retirement <https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies>; Chrome LNA: <https://developer.chrome.com/blog/local-network-access>; Apple TN3179: <https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy>
- Incidents:
  - Cursor CVE-2025-54135/54136 (Tenable FAQ);
  - CVE-2025-53773 (NVD);
  - Claude Code CVE-2025-54794/54795 (Cymulate);
  - AWS-2025-015 (Amazon Q);
  - Nx GHSA-cxm3-wv7p-598c;
  - CISA Shai-Hulud alert (2025-09-23);
  - TanStack postmortem;
  - DeepSeek DSec <https://arxiv.org/abs/2609.22978>;
  - CVE-2026-82533 <https://www.ox.security/blog/cve-2026-82533-deepseek-harness-ai-agent-sandbox-escape/>;
  - GlassWorm (Eclipse and CSA notes).

---

## Appendix 1. Behaviour changes for existing users

Each change alters something users or code rely on today. Each ships with a release note and, where stated, a migration.

| Id | Change | Who notices | Migration or mitigation |
|---|---|---|---|
| B-AP-1 | `/api/auth/local` needs a one-time nonce from the desktop app (P0-1). Opening `http://127.0.0.1:<port>/` directly no longer signs in | Users who bookmark the local web UI | The desktop "Open in browser" action adds the nonce; others pair with a code |
| B-AP-2 | Repo MCP servers need Workspace Trust and an approval; on a name clash the user's server wins over the project's (P0-2) | Users relying on repo `.mcp.json` | One approval per server per project; re-approval when the command changes |
| B-AP-3 | Host MCP tokens become per chat with expiry; the URL path alone no longer selects a chat (P0-3) | External tools that copied a host MCP URL | They are internal; none expected |
| B-AP-4 | Extensions can't run `volt.*` commands unless exported (P0-3) | Extensions that call Volt commands | Exported list per capability |
| B-AP-5 | `volt.devices.remoteHosts` moves to application scope (P0-5) | Users who set it per workspace | Values migrate to user settings with a notice |
| B-AP-6 | In-app browser popups open only http(s) externally (P0-5) | Pages using custom schemes | Copy-link fallback |
| B-AP-7 | Release builds fail without signing certificates (S1); updates refuse unsigned feeds and installers (S2) | Forks and local release builds | Developer channel with its own key |
| B-AP-8 | Unsigned Open VSX entries install only as explicitly unsigned third-party extensions (S3) | Users installing unsigned extensions | A one-time consent per extension |
| B-AP-9 | Volt's own implicit git never runs repo hooks or fsmonitor; user-initiated commits show changed hooks first (H1) | Repos relying on hooks during Volt's background `git status` (fsmonitor users) | Fsmonitor stays available to the user's own terminal |
| B-AP-10 | Sandboxed chats: the post-turn test check runs inside the chat's sandbox, network off (H2). Tests needing network fail there | Sandboxed chats with network-dependent tests | The check reports "needs network" and offers a run as a user action |
| B-AP-11 | Sandboxed chats: workflows, worktree setup, `docker_ensure`, probes and title generation run under the chat's principal or are refused (H2) | Sandboxed chats using these | Setting the chat to `Off`, or a user-initiated run |
| B-AP-12 | Agent CLI configs edited from a sandboxed chat no longer persist: new MCP servers, settings, skills, `CLAUDE.md` (H3) | Users who let agents configure their CLI | Make such changes from a chat at `Off`, or in the CLI directly |
| B-AP-13 | Codex in sandboxed chats runs under Volt's sandbox with its own sandbox off (H4) | Codex users at `workspace-write` | Same experience; Codex's own approval prompts no longer appear for sandboxed chats |
| B-AP-14 | Child chats from a sandboxed chat can't target other projects or the main checkout with write access (H4) | Orchestration flows | Child runs read-only there, or the user starts it |
| B-AP-15 | Search tools in sandboxed chats don't follow symlinks out of the workspace (H5) | Monorepos with symlinked packages outside the workspace | Add the target as a project root |
| B-AP-16 | Sandboxed chats get a separate signed-out browser profile that follows the chat's network rules; agents can't listen on arbitrary ports (H5) | Agents testing signed-in sites or local dev servers | Grant `net.listen:<port>` for dev servers; use an unsandboxed chat for signed-in browsing |
| B-AP-17 | macOS sandboxes can't use other terminals' ttys or the system DNS socket (H7) | Tools resolving DNS directly | They go through the proxy |
| B-AP-18 | Linux sandbox requires bubblewrap ≥ 0.12 or a backported build (H7, D-04) | Ubuntu 24.04 and Debian 12 users | Install guidance in the refusal |
| B-AP-19 | Linux agents read only system folders, toolchains, the workspace and their own state (D-14) | Agents that read other projects | Add folders as read grants |
| B-AP-20 | Third-party extensions run one per host, sandboxed, network off by default, no raw workspace writes (P2, P8) | Extensions needing network, home config, Docker | Live "Allow host", presets, declared paths, critical grants |
| B-AP-21 | Desktop with the agent server off doesn't run third-party Node extensions (P6) | Users who turned the server off | Turn it on, or accept the refusal |
| B-AP-22 | Extensions consuming another third-party extension's `exports` break unless granted (P2, D-10) | Extension pairs | The combined critical grant |
| B-AP-23 | Windows: Git Bash and WSL commands are refused in sandboxed chats (C7, D-15) | Windows agents using bash | PowerShell, or a chat at `Off` |

