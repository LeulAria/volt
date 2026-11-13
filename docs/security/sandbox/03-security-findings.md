# Volt Sandbox: Security Findings

What was found, how it was fixed, and which test covers it.
- **F-01 to F-29** cover the existing sandbox (found in the assessment) and the new code (found by the adversarial suite while it was written).
- **F-L*** entries are from the Linux backend work.

The adversarial suite is `src/vs/platform/voltSandbox/test/node/sandboxSecurity.test.ts`, written "SEC" below. Host-side tests: `hostToolSandbox.test.ts`, `hostToolService.test.ts` and `voltHostMcpMainService.test.ts` ("GATE"), and `sandboxInheritance.test.ts` and `chatSandbox.test.ts` ("LIFE").

Severity:
- **C** (critical): code execution outside the sandbox.
- **H** (high): credential theft, or a deferred escape.
- **M** (medium): a weaker guarantee than the one claimed.
- **L** (low).

## Found in the existing sandbox (Phase 1)

| # | Sev | Finding | Fix | Covered by |
|---|---|---|---|---|
| F-01 | C | With no mechanism (Windows, Linux without Landlock or bwrap), a sandboxed chat ran **unsandboxed**. The warning was dropped before the session existed | Fail closed: `UnsupportedBackend` and unavailable probes refuse. The spawn rejects with `SandboxUnavailableError`, and the UI offers "turn the sandbox off for this chat", never retrying on its own | SEC "a policy the backend cannot enforce is refused", LIFE (refused spawns) |
| F-02 | C | The Landlock helper failed open (`perror`, then ran the agent anyway). It was compiled at run time and reused from user data unverified | Landlock removed as a backend (ADR-3); bubblewrap fails closed | SEC (Linux run) |
| F-03 | C | Seatbelt allowed **every unix-socket connect**, even with network off. That reaches Docker (`docker run -v /:/host`), tmux/screen servers, ssh-agent and the **VS Code main IPC socket**, whose `launch` channel can start an unsandboxed extension host | All unix sockets denied except granted ones (and mDNSResponder with an open network); `VSCODE_*` stripped from the env. Linux: socket folders masked and seccomp blocks `socket(AF_UNIX)` | SEC "unix sockets are unreachable unless granted, even with an open network" |
| F-04 | C | Network off still allowed `localhost:*`, which reaches the **agent-server API**. Its token was readable inside the sandbox, and the API can start any command (`upsertProfile`) | Loopback limited to the proxy and Volt's MCP port; Volt's user data (the token) denied | SEC "network none: no loopback service", "credential canaries are unreadable" |
| F-05 | C | Host MCP tools ran **outside the sandbox** for sandboxed chats: `terminal_start`, `task_watch`, `app_open` (defeats `deny lsopen`), `docker_ensure`, `desktop_act`, `device_*`, `worktree_handoff`. Also `browser_run` edits wrote `.git/config` even at read-only | One allowlist gate on every call. Escapes are refused; writes follow the OS rules; unknown tools are refused (`hostToolSandbox.ts`) | GATE |
| F-06 | C | **Forgeable MCP identity.** There was one token per server and the session id came from the URL, so an agent could act as any chat, including that chat's approvals | Per-session HMAC-SHA256 tokens bound to the session and its tool groups, compared in constant time; groups come from the token | GATE (`voltHostMcpMainService.test.ts`) |
| F-07 | C | The sandbox was dropped on resume-elsewhere, on parked-agent reuse and during a start race. Children (subagents, `thread_launch`, run groups, automations) didn't inherit it; `thread_send` could instruct an unsandboxed chat | A process is reused only for the key it was started with; children inherit a sandbox at least as strict; `thread_send` and `queue_*` refused toward a less strict chat | LIFE |
| F-08 | H | **Deferred escapes through files the host runs**, none of them protected: nested repos' `.git/config`, `.git/modules`, `core.hooksPath` folders, `.pre-commit-config.yaml`, `lefthook.yml`, worktree-setup files, `.volt/mcp.json`, OpenCode plugins, `.envrc`. Also writable: shared caches holding the npx adapters Volt launches, Claude's install folder, and `~/.claude/plugins` | Complete protected-write set, plus the repository's real layout (worktree pointer, `core.hooksPath`), plus a guard against new `.git` entries; caches redirected; CLI binaries and plugins protected | SEC "writes … into protected paths", "a new git repository cannot be planted", the `.npm/_npx` and `.local/share/claude` checks |
| F-09 | H | **Credentials readable:** SSH private keys, `gh` tokens, `.env` files, browser profiles, other agents' tokens, Volt's data. The env carried every variable (`GITHUB_TOKEN`, cloud keys, `VSCODE_IPC_HOOK*`, `ELECTRON_RUN_AS_NODE`) | Credential denies, including private keys detected by content and `.env` at any depth; env built from nothing, secret-like names never copied | SEC "credential canaries…", "secrets and host IPC endpoints never reach the environment" |
| F-10 | H | **Proxy SSRF.** It always allowed `localhost` and `127.0.0.1`; with `*` it reached private ranges and `169.254.169.254`; resolution wasn't pinned (DNS rebinding) | Public addresses only, with IPv4-mapped, NAT64 and 6to4 forms judged as IPv4; one resolution, then connect to the checked address; ports 80/443 unless named | SEC "proxy mode: only allowed hosts, never loopback, private ranges or metadata" |
| F-11 | H | **The preflight dev server** ran `package.json` scripts the agent had edited, outside the sandbox, before the next turn | Not started for sandboxed chats | LIFE |
| F-12 | H | **Worktree setup files** were read from the new worktree first, which the agent can craft through git objects | Read from the main checkout only | LIFE (`agentWorktreeSetupService` tests) |
| F-13 | H | **"Allow folder"** granted whatever folder the agent's denied path implied, including `/Users` | `folderGrantError` | LIFE |
| F-14 | M | **Linux network was overclaimed.** Landlock ABI 4 limits TCP connect only; UDP and DNS stayed open | Network namespace; only enforceable modes are claimed | SEC (Linux) |
| F-15 | M | **macOS escape hatches were open** under `(allow default)`: signals to any process, the pasteboard, WindowServer synthetic input | Denied (see F-20, F-21) | SEC "host processes cannot be signalled", "macOS: … pasteboard …" |
| F-16 | M | **The process group was the only tree control;** no limits | Backend tree kill, watchdog, rlimits | SEC (processes, limits) |

## Found by the adversarial suite (Phases 4–7)

| # | Sev | Finding | Fix | Covered by |
|---|---|---|---|---|
| F-20 | H | **cfprefsd writes preferences past Seatbelt's file rules.** Under `(allow default)`, `defaults write` landed even with `~/Library/Preferences` write-denied, because the daemon writes for the client. Preferences can carry commands (Terminal startup commands) | Deny `mach-lookup com.apple.cfprefsd.agent` in every profile | SEC "macOS: … preferences …" (checks with `defaults read` on the host) |
| F-21 | M | **`(deny signal (target others))` does not stop signals** on macOS 26.6: a sandboxed `kill` terminated a host process | `(deny signal)` then `(allow signal (target same-sandbox))` | SEC "host processes cannot be signalled or listed" |
| F-22 | C | **Seatbelt profile injection.** A `"` cannot be escaped inside an SBPL `#"…"` regex literal; it ends the literal. A path containing `") (allow default) ("` broke out of the protect and deny regexes (string literals do honour `\"`). Here it failed to compile, but a crafted path can compile | The resolver refuses paths containing `"` or control characters; `regexBody` and `sbplString` throw on them as a second line | SEC "hostile workspace names cannot inject…", unit "hostile path text cannot break out" |
| F-23 | H | **Protect patterns were skipped for workspaces under the temp folder.** Patterns skip temp roots (tests create repositories there), but the check matched any path *inside* temp, so a repo in `$TMPDIR` had a writable `.git/config` | Only temp roots themselves are skipped; `.git/config`, `config.worktree`, `hooks` and `modules` are also named outright | SEC "writes … into protected paths" (`.git/config` canary hash) |
| F-24 | M | **A workload could hang the host's run.** A daemon that keeps stdout open meant `close` never fired, so the run never ended | The run ends 250 ms after the workload exits; then the tree is killed and the pipes released | SEC "a daemon that clears its environment and calls setsid" (it used to time out) |
| F-25 | M | **macOS `ulimit -f` counts 1 KiB blocks, not 512 B**, so the file-size limit was twice the policy | Scale fixed (measured) | SEC "CPU and file-size limits are applied by the kernel" |
| F-26 | L | **Restricted runs were refused** because the default working directory was the (unreadable) workspace | Fall back to the run's temp; refuse only an explicit unreadable `cwd`; `${tmp}` always writable | SEC "restricted keeps the workspace and the shared /tmp out of reach" |
| F-27 | L | **Built-in profiles reported the wrong name in diagnostics** (they extend each other by spreading) | Name set last | unit "built-in profiles carry their own names" |
| F-28 | — | **Denial tests could pass because nothing ran** (an early version refused every run, so every "denied" assertion passed) | Every adversarial run must prove it ran: status `completed` plus a marker printed first | the `sh()` helper in SEC |
| F-29 | — | **Bun's child-process pipes sometimes close fd 3** before the prologue writes (the run fails closed with "broken pipe"); Bun's `fs.realpath` cannot resolve names with backslashes | CI runs the suite on Node, the runtime Volt ships | — |

## Linux backend

These come from the bubblewrap backend's work in the Docker rig (`scripts/volt-sandbox-linux-test.sh`). See `04-performance.md` for its numbers.

| # | Sev | Finding | Fix | Covered by |
|---|---|---|---|---|
| F-L1 | C | **`LD_PRELOAD` into the launcher.** bubblewrap runs outside the sandbox, and an untrusted layer could set loader variables that bwrap itself would load on the host | bwrap is spawned with an **empty** environment; the workload's variables reach it as `--setenv` pairs on a pipe (never on the command line); untrusted layers may not set loader or interpreter hooks at all (`isInjectionEnvName`) | rig `env-clear` (launcher environ is 0 bytes), unit composition test |
| F-L2 | H | **The bridge needs `AF_UNIX`; the workload must not have it.** Applying seccomp to the whole sandbox broke the socat bridge; leaving it off opened unix sockets | A holder bwrap owns the network namespace and runs the bridges; the sandbox joins it, so seccomp covers every sandboxed process and the bridges listen before the workload starts | rig `proxy-bridge`, `af-unix-denied`, `loopback-ports` |
| F-L3 | H | **Renaming the parent of a protected path replaced the protection** (`mv .git x; mkdir .git`) | Every folder between a writable root and a protected path is pinned as a mount point (rename fails with EBUSY) | rig `git-protected` (`mv=1 mvhooks=1`) |
| F-L4 | M | **In minimal mode, bwrap's root is a writable tmpfs**, so writes outside the policy "succeeded" into it | `--remount-ro /` | rig `outside-write-denied` |
| F-L5 | C | **The run folder lived in the system temp folder**, which agent profiles write, so bubblewrap's control folder (bridge sockets) would be writable from inside. The backend refused every such launch, which would have blocked every Linux agent | Runs live in `~/.volt/sandbox/runs` (0700), which no profile writes; stale runs are removed | SEC (Linux), all agent-profile tests |
| F-L6 | M | **`protectNew` was undercounted.** A non-pattern protected path that does not exist yet has the same bubblewrap gap but counted as `filesystem.protect` (enforced) | Any deny or protect entry uses `filesystem.protectNew` | unit enforcement tests; rig `protect-new-gap` (reported partial) |
| F-L7 | M | **An ssh-agent grant with a readable filesystem is unenforceable on Linux.** `AF_UNIX` must then be allowed, and every visible socket becomes reachable | The ssh-agent grant is macOS-only (Seatbelt allows exactly one socket); Linux agents use git over HTTPS | rig `readall-socket-refused`, unit agent profile |
| F-L8 | L | **Zombies when Volt is PID 1** (a container): bwrap exits without reaping the sandbox's PID 1 | Documented: run with an init (`docker run --init`) | rig (uses `--init`) |

The rig (`scripts/volt-sandbox-linux-test.sh run`) also checks:
- namespaces (`unshare`, `CLONE_NEWUSER`, `CLONE_NEWNET`, `setns` refused; `clone3` gets `ENOSYS`);
- io_uring, ptrace, mount, keyctl, bpf, perf_event_open, userfaultfd and open_by_handle_at refused;
- TIOCSTI/TIOCLINUX refused;
- `Seccomp: 2`, `NoNewPrivs: 1`, and no capabilities;
- the fork bomb stopped at the process limit;
- the setsid daemon killed;
- only the sandbox's own processes visible;
- no leaked file descriptors;
- launch failures reported, never run.

28 of 28 behave as reported.

## Found in the round-4 security pass (2026-11-13)

| # | Sev | Finding | Fix | Covered by |
|---|---|---|---|---|
| R4-S1 | H | **Agent CLI and editor project configs were writable.** A sandboxed chat could add `.claude/skills/*` (a skill's `allowed-tools` pre-approves tools and it ships scripts), `.gemini/settings.json` and `.gemini/extensions` (MCP servers), `.codex/config.toml` (MCP servers, `notify`), `.zed/settings.json`/`tasks.json`, `.helix/languages.toml`, `.nvim.lua`, `.exrc`. Volt starts those CLIs unsandboxed for the project's other chats; the editors start the servers they name when the folder opens | Added to the protected root names (OS profile and the files broker) | SEC EXEC-LATER-1 (each one existing and planted, case variants, both profiles); what stays writable and why: 05-limitations item 36 |
| R4-S2 | H | **macOS persistence past the operation denies.** `(deny lsopen)`, `(deny appleevent-send)` and `(deny job-creation)` stop `open`, Apple Events and `launchctl submit`, but `SMAppService.register()` (the modern launch-agent / login-item API) **succeeded** from inside the agent sandbox: its app would run its code at the next login, outside the sandbox. The XPC paths it uses stayed reachable — `com.apple.xpc.smd`, `com.apple.backgroundtaskmanagement[agent]`, `com.apple.xpc.loginitemregisterd`, `com.apple.coreservices.sharedfilelistd.xpc` — as did the LaunchServices-database services that register a URL/document handler the host opens later (`com.apple.lsd.modifydb`, `com.apple.lsd.open`, `com.apple.coreservices.launchservicesd`) | Added all of them to `ESCAPE_SERVICES` (denied even with system services on). `SMAppService.register` now fails (socket not connected) and the host shows the service unregistered | SEC MACOS-OUT-2 (every service unreachable with the network on and off, a control service still reachable), MACOS-OUT-1 (open/handler/launchd/launchctl setenv/pasteboard), unit "J.1 … the escape services are denied" |

## Verified behaviour worth knowing (macOS 26.6)

- The agent profile is `(allow default)` then targeted denies (it needs the Keychain, launchd lookups and much more). The mach services it is left reaching, probed with `bootstrap_look_up` (MACOS-OUT-2's method): user/group lookups (`opendirectoryd.*`), the security stack (`tccd`, `authd`, `SecurityServer`, `securityd.xpc`, `syspolicy`, `ctkd` — Keychain and code-signing), trust and network config (`trustd`, `SystemConfiguration.configd`, `nehelper`), the LaunchServices **read** database (`lsd.mapdb` — file-type and UTI lookups a build does), notifications, audio, input methods and disk arbitration. None of these run the agent's code outside the sandbox or write another process's state; the ones that do (preferences, Apple Events, the pasteboard, WindowServer input, LaunchServices **open/modify**, ServiceManagement, Background Task Management, login items) are in `ESCAPE_SERVICES` and denied.
- `SMAppService.register`/`SMJobBless`, `LSSharedFileList` login items and launch agents in `~/Library/LaunchAgents` are the modern launch-agent paths; `(deny job-creation)` and refusing `launchctl load`/`submit` do not cover the XPC ones, so the mach services are denied directly (R4-S2).

- A deny-default process needs `file-read*` on `/` itself, or dyld aborts it (SIGABRT, exit 134).
- `/usr/bin/git` and `python3` are xcrun shims that load frameworks from the selected Xcode's `Contents`, so `${system}` includes `$(xcode-select -p)/..`.
- A hard link into a read-denied folder is refused, and reading the case variant of a denied path (`~/.SSH`) is denied.
- Denying the network also stops DNS: mDNSResponder is reached through a unix socket. With the network open, that socket is allowed explicitly.
- `launchctl submit` is refused for sandboxed callers; `(deny job-creation)` is kept as a second line.
- Denying `~/Library/Keychains` file reads breaks Keychain lookups (`security` exits 44), and agent CLIs keep their logins there. The agent profile therefore keeps it readable; workload profiles deny it.
