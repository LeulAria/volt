# Volt Sandbox: Known Limitations and Future Work

What the sandbox does **not** guarantee today. Each limit comes with the reason, and with its mitigation where there is one.

## Limits of the OS mechanisms

1. **macOS: a fully detached process can outlive its run** (`process.tree` is `partial`).
   - **Why:** macOS has no PID namespace. The kill reaches the process group, every descendant reachable through parent pids, every process still carrying the run's `VOLT_SANDBOX_TAG`, and (through the watchdog) the group when Volt itself dies. The sandbox helper also tracks each run from its root (kqueue fork and exit events) and kills every process the disclaimed root is responsible for, which a double-forked, `setsid`, environment-cleared daemon still is (TREE-MAC-1).
   - **The gap:** a process that does all of that and also disclaims its responsibility again is invisible to all of these.
   - **What still holds:** it stays inside Seatbelt (sandboxes are inherited and cannot be dropped) and inside its rlimits, so it is persistence, not an escape. The adversarial suite checks that such a survivor still cannot write outside.
2. **macOS: process and memory limits are best effort** (`partial`). RLIMIT_NPROC counts every process of the user, and RLIMIT_AS/RSS are not enforced.
   - **Processes:** the run gets RLIMIT_NPROC at the user's count plus its limit, and the helper's fork watchdog stops and kills the whole tree the moment it passes the limit (RES-MAC-2).
   - **Memory:** the tree's physical footprint is polled every second and the tree is killed over the limit (RES-MAC-1), so a fast allocation can pass the limit for up to a second.
3. **Linux: paths that do not exist at launch cannot be guarded** (`filesystem.protectNew` is `partial`). bubblewrap binds existing paths; it cannot deny creating `.vscode/tasks.json` or a new nested `.git` inside a writable workspace.
   - **What still holds:** existing protected paths are read-only binds, and `**/` patterns are expanded at launch over a bounded walk.
   - **Landlock** runs inside bubblewrap where the kernel has it (a second check on reads and writes), but it only grants rights to whole folders, so it cannot carve such holes either (LNX-FS-3 stays open); an overlay with review on exit (the "cells" design) would.
4. **Linux: without a delegated cgroup, memory limits are virtual memory** (RLIMIT_AS). V8 and Wasm reserve far more address space than they use, so a tight value breaks Node.
   - Where systemd's user manager delegates the memory controller (systemd 252+), a run with a memory limit gets its own `systemd-run --user --scope` instead: memory.max on the whole tree, enforced (RES-LNX-1), and no RLIMIT_AS.
5. **Linux specifics.**
   - **Single home files can't be replaced atomically.** Files written in place (`~/.claude.json`) are single-file binds, so an agent that replaces one by rename gets `EBUSY`.
   - **Servers in the sandbox can't be reached from the host.** A server a sandboxed workload starts with `listen` is reachable only inside its network namespace, not from the host's browser.
   - **The sandbox's tmpfs mounts have no size cap.**
   - **No OS denial reports.** The kernel does not report denials the way the macOS log does, so the transcript shows Linux denials only from command output and the proxy.
   - **No ssh-agent.** It is not exposed to Linux agents (F-L7).
   - **Containers need an init.** When Volt runs as PID 1 in a container, run it with an init so finished sandboxes are reaped.
   - **`.env` files deep in a home toolchain may stay readable.** `**/.env` and the other deny patterns are expanded at launch by a bounded walk. The workspace, the writable folders and a readable home must be walked whole, or the run is refused (B-27). With narrow reads the home is not readable, only the toolchains in it (`~/.cargo`, `~/.dotnet`, `~/go`, `~/.local/bin`). Those, and the shared temp folders an agent may write (`/tmp`, `/var/tmp`, `/dev/shm`), are walked after the rest, with what is left of the budget, best effort: a multi-gigabyte SDK or a busy `/tmp` would otherwise refuse every run. A `.env` the walk did not reach there (a project kept under `~/go/src`, a checkout unpacked in `/tmp`) stays readable on Linux; macOS denies it by regex. A workspace in `/tmp` is its own root and is still walked whole.
   - **Interface and route lists are readable (deviation from the spec's family allow list).** seccomp lets `socket(AF_NETLINK, ..., NETLINK_ROUTE)` through, and no other netlink protocol: libc's `getifaddrs` needs it, and Node's `os.networkInterfaces()` (which dev servers call at startup) throws without it. It shows only the interfaces and routes of the sandbox's own network namespace (only `lo` with the network off or through the proxy; the host's, as with the network on, when the chat has network). Changing them needs `CAP_NET_ADMIN`, which the sandbox lacks. Netlink audit, uevent, netfilter and sock_diag fail with `EAFNOSUPPORT` (LNX-SECCOMP tests).
6. **Seatbelt's future.** `sandbox-exec` has been documented as deprecated for years and still ships. If it goes, the backend moves to `sandbox_init` in a small signed helper; the policy model does not change.
7. **Windows (MXC) is weaker than macOS and Linux.** DNS resolves in proxy mode (MXC#1666); single loopback ports, "no new processes" and hard memory or process limits are not available; Git Bash, MSYS2, Cygwin and WSL are refused (MXC#1061); start-up costs about 450 ms per command on the `windows-11-arm` runner (PERF-WIN-1), above the 300 ms budget, so Windows stays off by default.

## Limits of the policy

8. **The agent profile is deliberately weaker than the workload profiles.**
   - **Reads:** it reads the whole filesystem except credentials.
   - **macOS services:** it reaches system services, with the escape hatches denied.
   - **Keychain:** items readable by the `security` tool (Claude Code stores its login that way) are readable, because the agent needs its own and the Keychain's per-item access lists, not the sandbox, guard the rest.
   - **Network on:** when the chat's network is on, it has unfiltered network, including loopback services, which is the user's choice.
9. **Exfiltration through the agent's own API channel cannot be stopped by any sandbox.** Whatever the agent can read, the model can repeat to its provider. Credential denies limit what it can read.
10. **Proxy filtering is by hostname, without TLS inspection.**
   - Domain fronting through an allowed CDN can carry other traffic.
   - A wildcard such as `*.example.com` lets the workload make the proxy resolve any name under that domain, which is a DNS channel when the attacker controls it.
   - Anything that ignores proxy variables (raw sockets, UDP, plain ssh) simply has no network.
11. **Hard links that already exist.** A hard link created *before* the run inside the workspace, pointing at a secret, is read by its workspace path; path-based sandboxes cannot see the inode. New hard links into denied folders are refused.
12. **Paths containing `"` or control characters are refused** rather than expressed (SBPL regex literals cannot carry a `"` safely).
13. **File access Volt performs for the agent (ACP `fs/*`, host tools) is checked, then performed** by Volt's own process. A workload that swaps a symlink between the check and the write can redirect it. Closing it needs no-follow opens in Volt's file service.
14. **Protected files can enter through git history.** An agent can commit `.vscode/tasks.json` or a hook manager's config into a branch (git objects are writable so commits work). Checking that branch out *outside* the sandbox materialises them. Volt reads worktree setup only from the main checkout, but other host tools that check out agent branches should treat them as untrusted.
15. **Worktree setup still runs unsandboxed.** The setup *file* is trusted (read from the main checkout), but `npm ci` in a new worktree runs that branch's `package.json` scripts. Host tools refuse new-worktree starts from sandboxed chats for this reason.

## Pathways not covered yet

16. **Native in-process models ignore the sandbox setting.** Only ACP agent chats are sandboxed; Volt's own model loop runs its shell tool through `exec` without a sandbox request. **Next:** pass the chat's sandbox to `IVoltExecRequest.sandbox`, which is implemented and tested.
17. **The extension host is not sandboxed** (stock VS Code; ADR-1). This is the marketplace phase's first item: a sandboxed extension host kind launched through `SandboxManager`.
18. **Volt's own stdio MCP servers** (`.mcp.json`, `.volt/mcp.json`) still run unsandboxed and without a trust check. Agents cannot plant those files (they are protected), but a cloned repository's file runs when native models start. **Next:** a trust prompt, then the `network` profile with the server's declared capabilities.
19. **Model probes, title generation and commit-message generation** run agent CLIs unsandboxed, with tools turned off.
20. **The relay runner** starts Claude with `bypassPermissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`, with the full environment including the relay enrol key. Its container is the only boundary. **Next:** run it through `SandboxManager` (Linux) and strip its environment.
21. **The in-app browser's own network** (page scripts, `browser_evaluate`) is not filtered per chat. The host-tool gate judges the URLs an agent names and withholds what a page shows when it leaves the allowed set.
22. **Reading other chats.** `thread_read`, `thread_search`, `workspace_status` and `terminal_output` let a sandboxed chat read other chats' transcripts and terminals.
23. **User and repository policy files are defined, not loaded.** The schema, parser and narrow-only composition exist and are tested, but the agent path builds its policy from the chat settings only. **Next:** load `~/.volt/sandbox.json` (trusted) and `<workspace>/.volt/sandbox.json` (untrusted) into the agent profile, and surface `ignored` in the UI.
24. **PTY workloads** (sandboxed terminals) need file-based confirmation, because node-pty cannot pass extra file descriptors. Not built; host terminal tools are refused for sandboxed chats instead.

## Found in the 2026-11-09 review, not fixed yet

25. **A managed policy change takes up to a minute.** The execution host reads it again every minute and sends each change to the launcher, plugin hosts, the network broker and the windows' gates (ADMIN-LIVE-1); there is no file watch on `/etc/volt/policy.json` or the MDM domain.
26. **A sandboxed extension's tool flows are judged by its declarations only.** The host-tool gate doesn't see the "Allow host" grants the broker adds for that extension. Not reachable today (no tool owner is marked sandboxed), but it must carry the granted hosts before one is.
27. **Settings-only comparison** (no scopes) still counts unknown folders as writing nothing; it is kept for settings math only. Every caller that compares two chats (subagents, automations, run groups, the orchestrator, `thread_send`) passes both chats' roots, so an unknown folder fails closed there (SCOPE-27a..c).
28. **Decision-log replay doesn't prove the logged request**, only the snapshot and the call context. Adding a request digest changes the log's record format, which its reader checks strictly.
29. **A grant store written by a newer Volt takes no new grants.** Revoking works there (GS-NEWER-3): revokes and dropped subjects go to `grants.revoked`, a log every version applies over the store; adding a grant stays refused.
30. **A chat's proxy credential is readable by any process of the same user on macOS.** Seatbelt can't hide another process's environment (`sysctl KERN_PROCARGS2` passes even an explicit `sysctl-read` deny), and agent CLIs are not platform binaries, whose environment macOS hides. Another chat with network off still can't use it: only the chat's own sandbox reaches its route's port, and the route refuses every other route's token with an audit event naming whose it was (NET-E2E-7, NET-E2E-4, NET-12). A process with an open network (a chat with network on, anything unsandboxed) can reach the port and use the token; it gains no network it lacks, but its requests count against that chat's budgets and show in its denial cards. **Next:** verify the connecting peer (its pid's sandbox) per connection, within the 2 ms budget.

## Future work, in order

1. Load user and repository policy layers (item 23), and use the sandbox for native models (item 16).
2. A sandboxed extension host plus capability manifests in packages: the start of the marketplace.
3. Windows: an x64 runner for the WIN-* suite, packaging `wxc-exec.exe` and `volt-mxc-helper.exe` with the app, and Git Bash on the AppContainer-compatible MSYS2 runtime once its distribution is decided (WIN-MSYS-2 passes in CI).
4. Supply-chain pipeline extension points, which the sandbox does not block:
   - package integrity (a hash lockfile);
   - publisher identity and signed artifacts (Sigstore or Volt-signed);
   - dependency analysis and an install-time scan for hidden Unicode;
   - capabilities declared in the manifest and diffed on every update;
   - update verification.
5. cgroups v2 limits on Linux; a signed macOS helper for `sandbox_init` and process sweeps.
6. "Cells": copy-on-write workspaces with review on exit, as a strict opt-in mode.
