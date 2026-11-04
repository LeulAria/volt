# Volt Sandbox: Architecture Decisions

Short ADRs. Each one says what we chose, what we rejected and why. Sources are listed at the end. "srt" is Anthropic's [sandbox-runtime](https://github.com/anthropics/sandbox-runtime).

## ADR-1: The sandbox is an OS-enforced foundation, not a permission list

**Decision.** Isolation is enforced by the kernel (namespaces and seccomp on Linux, Seatbelt on macOS). Capabilities and manifests describe what a workload asks for, but they never enforce anything. The sandbox ships, and is useful, before any plugin exists: it contains agent CLIs, the commands they run, and the host tools they call.

**From VS Code we adopt:**
- Process separation.
- Workspace Trust's lesson that configuration shipped inside a repository is untrusted input.

**We improve on:**
- Extensions run with the full privileges of the app ("any action that VS Code can perform, an extension can also perform").
- Permission declarations ([#52116](https://github.com/microsoft/vscode/issues/52116)) are only as strong as the honesty of whoever wrote them.

**Rejected:** a JavaScript sandbox (vm, SES) or command-string allowlists as the boundary. Both are bypassable, so they can only ever be hints for the UX.

## ADR-2: One backend interface, an honest capability matrix, fail closed

**Decision.**
- **Backend interface.** `ISandboxBackend` exposes `probe()`, which returns per-dimension enforcement (`enforced` / `partial` / `unsupported`) with notes and diagnostics, and `launch()`, which returns a spawn spec plus `confirm`, `terminate` and `dispose`.
- **Refusal.** The manager compares the policy's dimensions with the matrix and refuses any dimension that isn't enforced, unless the policy itself marks it best effort.
- **Isolation states:** `unavailable`, `partial` (lists the exact unenforced dimensions), `initialized`, `failed` and `completed`.
- **Confirmation.** `initialized` is only reported after the backend confirms the sandbox. bubblewrap confirms through its `--json-status-fd`; on macOS a marker is written after `sandbox_init` succeeds, before `exec`.

**Rejected:** silently downgrading, or warning and running anyway. That is what Volt did before, and the warning was dropped before anyone saw it (see assessment G-1).

## ADR-3: Linux uses bubblewrap. Landlock is not a backend

**Decision.** bubblewrap with these settings:
- **Namespaces and lifetime:** `--unshare-user/pid/ipc/uts/cgroup`, `--unshare-net` unless network is `host`, `--die-with-parent`, and `--disable-userns` (bwrap ≥ 0.8).
- **Terminal:** `--new-session`, except on a PTY, where seccomp blocks TIOCSTI instead (CVE-2017-5226).
- **Mounts:** fresh `/proc` and `/dev`; tmpfs over `/tmp`, `/run` and `/dev/shm`; minimal read-only binds of system folders (or `/` for the agent profile, with the socket folders masked).
- **Writes:** writable binds, then protected paths re-bound read-only and denied paths masked.
- **Seccomp:** a filter passed by file descriptor.

The process tree is the PID namespace, so killing bwrap kills everything.

**Rejected: Landlock-only.**
- It cannot isolate unix sockets.
- ABI 4 limits TCP connect only, so UDP stays open (DNS exfiltration).
- It has no deny-inside-allow, so `.git/hooks` stays writable inside a writable workspace.
- Volt's helper had to be compiled with `cc` at run time and failed open.

Codex reached the same conclusion: its Linux README calls Landlock "legacy" because "it cannot isolate app-server Unix sockets". Landlock is a candidate for a *second* layer inside bubblewrap later (future work).

**Risk.** Ubuntu 24.04+ restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`). The probe detects this and says exactly what to change. We never fall back.

## ADR-4: macOS uses Seatbelt, deny-by-default for workloads

**Decision.** `/usr/bin/sandbox-exec -p <profile>`, at a hard-coded path as Codex does. Profiles are generated only from resolved, validated policies, with every string escaped by one function.

- **Workloads** (commands, MCP servers, future plugins) get `(deny default)`, starting from Chrome's renderer baseline as Codex does. Only the policy's reads and writes, a short list of system services, and the proxy port are allowed.
- **Agent CLIs** need Keychain, launchd and other OS services, so their policy sets `host.systemServices`. That gives an `(allow default)` base with explicit denies for:
  - writes outside the plan, and protected paths;
  - credential reads;
  - unix sockets other than the ones granted;
  - loopback other than the proxy and MCP ports;
  - Apple Events, LaunchServices, the pasteboard, WindowServer (synthetic input), and signals to processes outside the sandbox.

  This mode is reported as weaker and documented as such.
- **Case and Unicode.** Paths are canonicalised with `realpath`. Denies and protections use case-insensitive regexes, because APFS is case-insensitive by default.

**Risk.** `sandbox-exec` has been documented as deprecated since at least 2017. It still ships, and Codex, srt, VS Code (macOS 15+) and Gemini CLI all depend on it. If Apple removes it, the backend can move to `sandbox_init` through a small signed helper; the policy model does not change.

## ADR-5: Windows refuses; MXC is the recommended future backend

**Decision.** Windows has no backend in this work. Every sandboxed run there is refused with a clear reason, and the UI shows the levels as unavailable. This replaces today's silent unsandboxed run.

**MXC evaluation** (time-boxed; facts from the sources below):
- **Maturity.** MIT licence. v1.0.0 (2026-10-07) and v1.0.1 (2026-10-17) are stable, after eight months of pre-releases.
- **Adoption.** Already used by GitHub Copilot and OpenAI Codex; Codex now *prefers* MXC on Windows.
- **Platform split.** On macOS and Linux it wraps the same Seatbelt and bubblewrap we use, so it adds nothing there. Its value is Windows ProcessContainer: AppContainer, plus `CreateProcessSecurityEnvironment`, plus Windows Filtering Platform egress rules.
- **Windows requirements.** Windows 11 24H2 or 25H2 at specific builds only, with no Windows 10 support. Some tiers need an administrator to prepare the host once.
- **Network.** WFP enforces IP/port/protocol rules only. DNS-name rules are out of GA scope, and its proxy setting reaches only WinHTTP clients, so Volt would keep its own filtering proxy.
- **Node SDK.** It needs Node 24+, and Electron 37 ships Node 22. We would call its signed `wxc-exec` binary, or wait for an Electron with Node 24.

**Recommendation.** Add an `mxc` backend for Windows 11 24H2+ behind the existing interface. Probe it with `getPlatformSupport()`, pin versions, and run the adversarial suite on a Windows runner. Keep refusing on Windows 10. Not added as a dependency in this work.

## ADR-6: Network: none, proxy or host, and only what is enforceable is claimed

**Decision.**
- **`none`.** Linux uses a network namespace with nothing in it. Seatbelt uses `(deny network*)` and also denies the DNS mach services, because `getaddrinfo` through mDNSResponder is otherwise an exfiltration path.
- **`proxy`.** The workload can reach only Volt's HTTP/HTTPS CONNECT proxy on loopback. On Linux it gets there through a socat bridge from inside the namespace to a unix socket on the host. The proxy:
  - filters by hostname;
  - resolves the name itself and pins the address it connects to;
  - refuses loopback, private, link-local, CGNAT, ULA and metadata addresses, IPv4-mapped forms included;
  - allows ports 80/443 unless an entry names a port.
- **`host`.** The machine's network, unfiltered. Shown as critical risk.
- Inherited proxy variables are never copied; only the manager sets them.

**Limits, documented.**
- No TLS inspection, so domain fronting through an allowed CDN gets through.
- Anything that ignores proxy variables (raw sockets, UDP, plain ssh) simply has no network.
- A wildcard such as `*.example.com` lets the workload resolve names under that domain through the proxy.

**Rejected:** slirp4netns (which VS Code uses). It adds a user-mode network stack and still needs the same proxy for name filtering.

## ADR-7: A declarative, versioned policy with narrow-only layering

**Decision.**
- **Format.** JSON policy `schemaVersion: 1` with sections `filesystem`, `network`, `process.limits`, `env`, `host`, and `bestEffort`.
- **Strict parsing.** The parser is strict: unknown fields, relative paths, `..`, control characters, non-NFC text, unknown tokens, oversized lists or files, and out-of-range limits are all errors.
- **Tokens.** Paths may use `${workspace}`, `${home}`, `${tmp}`, `${storage}`, `${system}` and `${path}`. Patterns (`**/name`) are allowed only in `deny` and `protect`.
- **Layering.** Built-in profile, then user (trusted), then workspace file (**untrusted**), then per-run request.
  - Untrusted layers may only narrow. Every widening they try is dropped and recorded.
  - Denies and protections only grow.
  - Only a trusted layer may `unmask` a built-in credential deny or set `host.systemServices`.
- **Built-in protections.** Profiles carry credential denies and the protected-write set. No layer removes them.

## ADR-8: Capabilities are vocabulary, never enforcement

**Decision.**
- **Grammar.** `fs.read:workspace`, `fs.write:<path>`, `net.connect:<host>`, `net.host`, `net.listen`, `net.loopback:<port>`, `process.exec`, `git.local`, `git.remote:<host>`, `env:<NAME>` and `socket:<path>`.
- **Risk tiers.** Each capability has a tier (low, medium, high, critical) and an install-sheet sentence.
- **Evaluator.** It starts from `restricted` and adds only capabilities that are both requested and granted. Unknown ids are errors.

Future extensions, MCP servers and automations will use it: a manifest lists capabilities, the user grants them, and the evaluator produces the policy.

## ADR-9: The seccomp filter is generated in TypeScript

**Decision.**
- **Program.** A small classic-BPF generator: check the architecture (kill on mismatch, x32 refused), deny a fixed list of syscalls with `EPERM`, and filter arguments for `clone` namespace flags, `ioctl` TIOCSTI/TIOCLINUX and, optionally, `socket(AF_UNIX)`. `clone3` returns `ENOSYS`, so libc falls back to filterable `clone`.
- **Verification.** Syscall numbers for x64 and arm64 are checked against kernel headers in CI.

**Rejected.**
- libseccomp through a compiled helper: needs a toolchain at run time, or native binaries per architecture.
- Prebuilt BPF blobs, as srt ships: opaque.
- A Rust helper, as Codex has: a new toolchain in the build.

The generator is about a hundred lines and fully unit-tested.

## ADR-10: Agent CLIs: the whole tree is wrapped, the env starts empty

**Decision.** Keep Volt's model of sandboxing the whole agent CLI process tree, unlike Codex and Claude Code, which sandbox only the shell commands. That way the agent's own file tools are confined too.

The agent profile is built from the provider's footprint:
- **State folders** are writable. Folders holding code Volt runs later (`~/.local/share/claude`, `~/.claude/plugins`, `~/.npm/_npx`) are protected, and shared caches are redirected to a sandbox-only folder.
- **Reads.** Everything outside credentials is readable. That covers SSH private keys, cloud and `gh` credentials, browser profiles, `.env` files, and Volt's user data, which holds the agent-server token.
- **Environment.** It starts empty: variables are copied unless they look secret, plus the provider's own key variables.
- **Unix sockets.** All are denied; ssh-agent is granted only when the chat's network is on.
- **Loopback.** Only the proxy and Volt's MCP port are reachable.

## ADR-11: Whole-tree termination

**Decision.**
- **Linux.** PID namespace plus `--die-with-parent`. SIGKILL to bwrap takes every descendant down, including when Volt crashes.
- **macOS** has no PID namespace. The workload runs in its own process group. Termination kills the group and every descendant found through the parent-pid chain, and also any process still carrying the run's `VOLT_SANDBOX_TAG`.
- **macOS watchdog.** A watchdog process (a constant `/bin/sh` script) holds a pipe from Volt and kills the group if Volt dies.
- **Known gap on macOS.** A process that double-forks, calls `setsid` *and* clears its environment outlives the kill. It stays inside the Seatbelt sandbox and its rlimits, so it is persistence rather than an escape. This is why `process.tree` is `partial` on macOS.

## ADR-12: Resource limits are rlimits, plus a wall clock

**Decision.**
- **Wall clock.** Enforced by the manager everywhere.
- **Linux.** `prlimit` runs inside the user namespace and sets CPU, file size, open files, process count and (optionally) address space. Inside the namespace matters: since Linux 5.14, RLIMIT_NPROC is counted per user namespace, which makes a per-sandbox process cap real.
- **macOS.** A constant `/bin/sh` prologue runs `ulimit -t/-f/-n` before `exec`. RLIMIT_NPROC is per user on macOS, so it is not a per-sandbox control.
- **Memory** is `partial` everywhere: RLIMIT_AS counts virtual memory, and V8 reserves gigabytes of it.

**Rejected for now:** cgroups v2. Unprivileged delegation needs a systemd user manager (`systemd-run --user --scope`), which containers and CI usually lack. It is future work for memory and CPU quotas.

## ADR-13: Host tools are deputies, so they get the caller's sandbox

**Decision.**
- **Credentials.** Each agent session gets its own MCP credential bound to its session id; the caller can no longer choose its identity.
- **Gate.** Every host tool call carries the calling chat's sandbox settings. A central allowlist gate refuses, for sandboxed chats, tools that run code or drive apps outside the sandbox. Writes are checked against the same plan the OS enforces. An unclassified tool is refused.
- **Child chats** inherit a sandbox at least as strict as their parent's.

## ADR-14: srt is a reference, not a dependency

**Decision.** We do not depend on `@anthropic-ai/sandbox-runtime`:
- It is a research preview whose "APIs and configuration formats may evolve".
- On Linux it ships prebuilt BPF and an `apply-seccomp` binary, which are native binaries inside an Electron app we sign.
- It sandboxes commands, while Volt wraps whole agent trees.

**What we adopt from it:** mandatory write denies, the socat bridge, seccomp for `AF_UNIX`, deny-default Seatbelt with proxy-port-only network, and its documented limitations. We revisit when it stabilises, and especially for its Windows backend.

## ADR-15: Where the manager lives

**Decision.** `SandboxManager` is a plain Node class (`src/vs/platform/voltSandbox/node/`) with no workbench dependencies. It runs in whichever process owns `VoltStdioService`: the agent server by default, Electron main otherwise. Future callers can construct it the same way: a sandboxed extension host launcher, volt-server for web and mobile.

## Where we disagree with the brief

1. **"All execution pathways route through the SandboxManager."** That makes sense for every pathway *an untrusted party can steer*. It does not make sense for the user's own terminal or Volt's own git operations. Sandboxing those defends against nothing in the threat model and breaks credential helpers, ssh and the user's hooks. Codex and Claude Code don't sandbox the user's terminal either. What matters is that host-side operations never run code a sandboxed workload planted, which is what the protected-write set enforces. So here:
   - agent processes and agent-initiated work are sandboxed;
   - host tools a sandboxed chat calls are gated;
   - user-initiated work is not.
2. **"Default deny for the home directory."** We keep it for every workload profile, but not for agent CLIs, which read their own config and toolchains under home. For agents, home is readable *minus credentials*, and that is a documented, weaker tier.
3. **"Use cgroups where available."** Unprivileged cgroup delegation isn't reliably available, so memory is reported `partial` rather than claimed (ADR-12).
4. **"MXC as a longer-term cross-platform backend."** It is only worth adopting on Windows; on macOS and Linux it wraps what we already call directly (ADR-5).
5. **Process count limits on macOS** cannot be per-sandbox. They are reported, not faked.

## Sources

- VS Code extension runtime security: https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
- VS Code agent sandboxing: https://code.visualstudio.com/docs/agents/run/agent-sandboxing
- VS Code permissions discussion: https://github.com/microsoft/vscode/issues/52116
- bubblewrap: https://github.com/containers/bubblewrap and `bwrap.xml` (TIOCSTI / CVE-2017-5226, `--disable-userns`, `--die-with-parent`, seccomp responsibility)
- MXC: https://github.com/microsoft/mxc, https://learn.microsoft.com/en-us/windows/apps/develop/mxc/ (platform support, process-container networking, OS version support), https://blogs.windows.com/windowsdeveloper/2026/10/07/microsoft-execution-containers-policy-driven-containment-for-ai-agents/
- Anthropic sandbox-runtime: https://github.com/anthropics/sandbox-runtime (`macos-sandbox-utils.ts`, `sandbox-utils.ts`)
- Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing
- Codex sandboxing: https://learn.chatgpt.com/docs/sandboxing; `codex-rs/linux-sandbox/README.md`; `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`; Windows: https://learn.chatgpt.com/docs/windows/windows-sandbox.md
- `sandbox-exec` deprecation: `man sandbox-exec`; https://github.com/openai/codex/issues/215
- Landlock: https://docs.kernel.org/userspace-api/landlock.html
- RLIMIT_NPROC per user namespace (ucounts, Linux 5.14): `kernel/ucount.c`
