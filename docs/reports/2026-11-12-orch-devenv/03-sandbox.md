# 03 — OS sandbox: security, speed, first-party vs third-party

Area: `src/vs/platform/voltSandbox/**`, `src/vs/platform/voltStdio/**`, the network broker, the extension
sandbox service. Machine: Apple M4 Max (14 cores, 36 GB), macOS 26.6 (Darwin 25.6.0), Node 25.1, Seatbelt
backend with `out/volt-helpers/volt-sandbox-helper`. The machine was shared with many other agents the whole
time: the 1-minute load average ran from 15 to over 120 (noted next to the timings). Absolute numbers are
therefore inflated; every before/after comparison below is interleaved (same process or alternating runs) so
load drift hits both sides alike.

## Summary

- **Tests:** baseline 395 passing / 38 pending / 3 failing (load flakes in the MCP host suites); final run of the
  same 45 files plus the first-party policy suites (48 files) **486 passing / 39 pending / 0 failing**.
  Adversarial suite with `VOLT_SANDBOX_REQUIRED=1`: 34 → **40 passing**, 0 failing. tsgo 0 errors, eslint clean.
- **Speed (interleaved A/B, p50):** agent-profile prepare 41 → **9 ms** (load 18) and 136 → 21 ms (load 49);
  launcher path with a state key 133 → **70 ms** total, `launcher.prepare` 63 → 19 ms (p95 201 → 31). Causes:
  560 serial `realpath` calls per agent resolve, the Seatbelt regex merge rebuilt every launch, and a locked
  `~/.claude.json` merge before every launch (which also serialised concurrent launches in 100 ms steps).
  Profile text and resolved policies are byte-identical before/after (33 cases). Broker: 0.1–0.6 ms per CONNECT,
  unchanged, inside budget.
- **Agent start (claude-agent-acp, low load 9–16):** plain 0.81–0.83 s, sandboxed 0.84–1.05 s; 3 at once
  0.78–0.92 s plain, 0.94–1.37 s sandboxed. The dev instance's 4–8 s did not reproduce with a bare
  `session/new`; a launch **without** a state key does take 6.8–7.6 s (unreadable `~/.claude.json`).
- **Security fixes:** SIIT `::ffff:0:a.b.c.d` was classified as a **public** address (loopback/LAN/metadata through
  an IPv6 rule on a translated network); a granted listen port was refused for some port numbers (63000, 65351).
  Probes for hard/sym-link, `~/.ssh`/`~/.aws`, `.git` rename/swap/commondir, launchd/open/osascript, signals and
  argv/env leaks all held; 8 new adversarial/broker tests pin them (and NET-4, NET-PROP-1/2, NET-LISTEN-1 are extended). B-12 (`KERN_PROCARGS2`) remains.
- **First party:** built-ins were refused and offered "Allow host" prompts on the network broker (untargeted
  `net.connect` dropped, ceiling refusals promptable). Fixed: declared ∩ ceiling, never prompted, beyond refused;
  third parties still asked (NET-FP-1). The `vscode.volt` API layer already behaved (EXT-CAP-1/2/5, M5 tests).
- **Coordinator findings fixed:** Claude Code's housekeeping denials (`skills/synced`, `skills/.trash`,
  `plugins/store`, `sessions`, version locks, home listing) and the run's own canary no longer reach the
  "Blocked by the sandbox" card (logged instead); `cachedGrowthBookFeaturesAt`-style bookkeeping no longer
  triggers "Sandbox kept config changes".

## Setup

```sh
npm run -s transpile-client-oxc                       # then node build/volt/syncOut.mjs <changed files>
unset ELECTRON_RUN_AS_NODE
./scripts/test.sh $(for f in <the 45 files below>; do printf -- '--run %s ' $f; done)
VOLT_SANDBOX_REQUIRED=1 ./scripts/test.sh --run src/vs/platform/voltSandbox/test/node/sandboxSecurity.test.ts
node scripts/volt-sandbox-bench.mjs --runs 40 [--out <copy of out/>]
node scripts/volt-sandbox-bench.mjs --launcher --runs 30 [--out <copy of out/>]     # new: the launcher path
node scripts/volt-network-broker-bench.mjs [--out <copy of out/>]
```

"Before" is an APFS clone of `out/` taken before any performance change of mine (`cp -cR out /tmp/voltbench/sb/out-before`;
it already held the first-party broker and SIIT address fixes, which are off the measured paths); both bench scripts gained `--out <dir>` to run it.

Files of the suite run: every `*.test.ts` under `src/vs/platform/voltSandbox/test/**` (34) and
`src/vs/platform/voltStdio/test/**` (4), plus `voltRuntime/test/common/{chatSandbox,hostToolSandbox,managedTerminalsSandbox}.test.ts`,
`extensions/test/browser/voltExtensionSandboxService.test.ts`, `api/test/node/voltSandboxed{ExtensionHost,ExtensionSmoke}.test.ts`,
`server/test/node/voltAgent/serverExtensionSandbox.test.ts` (45 files, one Electron run).

## 1. Baseline

| run | passing | pending | failing |
|---|---|---|---|
| all 45 files, one run (5 min) | 395 | 38 | 3 |
| adversarial suite, `VOLT_SANDBOX_REQUIRED=1` | 34 | 2 (Linux-only) | 0 |
| rerun of the two failing suites alone (`sandboxMcpHost`, `voltStdioMcpHost`) | 16 | 0 | 0 |

The 38 pending are platform-gated tests (Windows/MXC, Linux bubblewrap/seccomp) skipped on macOS.

Baseline failures (all three pass when the two suites run alone: load/order dependent, not regressions):
1. `MCP-QUOTA-MEM` (sandboxMcpHost.test.ts): 120 s timeout. Mid-test the `grow` tool's `dd bs=64M | sleep 60` was
   gone while the server's `/bin/sh` root was still alive, so no `exit` came. Under the full run's load the polled
   footprint most likely never crossed 32 MB before `sleep 60` ended. Flaky under load.
2. and 3. `voltStdioMcpHost.test.ts` "after each" of `MCP-HOST-1`: a leaked disposable from `shellEnv.ts`
   (`resolveShellEnv`'s cancellation listener still pending at the end of the test) and "unexpected console
   output". Follows failure 1 (the previous suite's timeout left work running).

## 2. Performance

### Where the time went (before)

CPU profile of 200 policy compiles plus a count of filesystem calls, and the launcher's phases timed by wrapping
its methods (`/tmp/voltbench/sb/launch-phases.mjs`):

| hot spot | cost before | cause |
|---|---|---|
| `resolveSandboxPolicy`, agent profile | 560 `realpath` + 127 `stat` calls, one at a time (307 distinct paths); 50 ms cold | every deny/read entry canonicalised serially, most below the same missing parents (`~/.config/…`) |
| `buildSeatbeltProfile`, agent profile | ~10 ms CPU per launch | `groupRegexes` rebuilt the same prefix trees (credential denies, git allow list) and bisected the 1000-byte literal limit by rebuilding the whole alternation per probe, every launch |
| `AgentStateOverlay.prepare` (launcher, stateKey set) | 19–85 ms p50 | 8 sequential mkdir/chmod, a full merge of `~/.claude.json` (170 KB: 3 parses, a deep compare, a lock, a rewrite) even when the run changed nothing, links and seeds one by one |
| spawn → attested (`sandbox-exec` compile + prologue + attestation) | 20–60 ms | `sandbox-exec` compiling the profile (12.7 ms for the 17.6 KB agent profile alone); not changed |
| network broker, per CONNECT | 0.12–0.57 ms median overhead, p95 ≤ 1.9 ms (with the audit log) | within the 2 ms budget; not changed |

### Changes

1. `sandboxResolver.ts`: one `canonicalResolver()` per resolution memoises each path's answer and each `realpath`,
   and every list (reads, writes, denies, protects, sockets, toolchains, system paths, git protections) is looked
   up concurrently, then walked in the original order. Nothing is kept across runs, so a path a workload changes
   is read again by the next run.
2. `seatbelt.ts`: merged regex groups are memoised by their inputs (suffix, case rule, the sorted set of
   prefixes), bounded at 256 entries; the same for the `.env`-style name alternations of pattern filters. Pure
   functions, so the text is byte-identical.
3. `agentStateOverlay.ts`: the before-launch `sync()` skips a seed the run did not change (same JSON) without
   taking the lock on the user's file; the overlay's folders are made together; links and seeds (disjoint names:
   seeds are never protected) are written concurrently.

Equivalence: for 6 policies × 3 repetitions (workspace, restricted, network, agent network off/on, read-only
through a symlinked workspace, a hostile folder name, a `core.hooksPath`) the old and new resolver return
byte-identical JSON and the old and new generator byte-identical profile text (`/tmp/voltbench/sb/equiv.mjs`,
33 cases, 0 differences). `seatbeltEquivalence.test.ts` (SB-EQ-1 under the real `sandbox-exec`) and
`seatbeltMerge.test.ts` pass.

### Results (before / after, interleaved in one process, `/tmp/voltbench/sb/ab-interleaved.mjs 30`)

30 runs per side, alternating side by side; load average during the run 46–57 (median 49).

| p50 / p95 ms | before | after |
|---|---|---|
| `SandboxManager.run` workspace, total | 170 / 343 | 136 / 311 |
| of which prepare | 58 / 217 | 33 / 162 |
| `SandboxManager.run` agent profile, total | 236 / 544 | 119 / 230 |
| of which prepare | 136 / 402 | 21 / 132 |
| launcher, stateKey set (`VoltSandboxLauncher.prepare` → spawn → attested → exit) | 365 / 606 | 140 / 307 |
| of which `launcher.prepare` | 199 / 498 | 51 / 195 |
| of which spawn to attested | 59 / 170 | 58 / 183 (unchanged, as expected) |

The same, re-run at the end at lower load (`ab-interleaved.mjs 20`, load 17–18):

| p50 / p95 ms | before | after |
|---|---|---|
| `SandboxManager.run` workspace, total | 71 / 180 | 59 / 203 |
| of which prepare | 24 / 106 | 9 / 40 |
| `SandboxManager.run` agent profile, total | 113 / 256 | 62 / 252 |
| of which prepare | 41 / 201 | 9 / 33 |
| launcher, stateKey set, total | 133 / 266 | 70 / 172 |
| of which `launcher.prepare` | 63 / 201 | 19 / 31 |
| of which spawn to attested | 40 / 175 | 36 / 114 |

`node scripts/volt-sandbox-bench.mjs --launcher --runs 15` on the final build at load 19: with a state key prepare
22 / p95 111 ms, start 39 ms, total 74 / p95 183 ms; without one, total 62 ms; compile cache 26 hits, 6 misses.

Separately (alternating processes, `--launcher --runs 30`, load 30–72): launcher with stateKey, prepare p50
295 → 19 ms and 556 → 48 ms in two rounds; total p50 445 → 69 ms and 732 → 141 ms. Phase timing at load ~40
(`launch-phases.mjs`, 24 launches): `overlay.prepare` p50 18.7 → 15.9 ms (84.5 → 12.1 in a busier round),
`backend.launch` (profile text) 11.0 → 3.7 ms, `manager.prepare` 72 → 12 ms.

The profile text alone (`buildSeatbeltProfile` inside `backend.launch`): 11–13 ms → 3.7–4 ms per agent launch
once its groups are in the memo (the first launch of a process pays the full merge).

Not changed, and why: the CONNECT path is one tunnel per connection, and plain-HTTP forwarding opens one upstream
per request on purpose (each request is judged again; a pooled connection would outlive a revocation between
requests); its overhead is 0.1–0.6 ms median, well inside the 2 ms budget. `sandbox-exec` compiling the profile
is the largest fixed cost left in "start" (~12 ms for the agent profile); a compiled-profile cache would need the
per-run paths moved into `(param …)`s, a larger change.

### Agent CLI start (claude-agent-acp: spawn → initialize → session/new)

Reported by the coordinator: ~0.9 s unsandboxed vs ~5 s sandboxed (9–10 s for 3) in the dev instance. Reproduced
with the real launcher around the same binary (`/tmp/voltbench/sb/acp/acpsbx.mjs`: warm launcher as in the agent
server, network on, a state key per chat, no MCP servers), against plain spawns of the same binary.

**At low load (the numbers that count), final build, load 9–16:**

| | plain | sandboxed, before | sandboxed, after |
|---|---|---|---|
| 1 agent (two rounds) | 0.81, 0.83 s | 0.82, 0.87 s | 0.84, 1.05 s |
| 3 at once (each, four alternating rounds for the sandboxed sides) | 0.78–0.92 s | 0.81–1.94 s | 0.94–1.37 s |
| of which launcher prepare, 3 at once | — | 37 / 135 / 248 ms (serialised) | 35–72 ms each |
| of which attestation | — | 17–23 ms | 17–28 ms |

So at low load the sandbox adds about 0–0.2 s to a start, and 3 starts at once take what 1 does. The before
build serialised concurrent launches of the same CLI in ~100 ms steps (the before-launch merge took the lock on
`~/.claude.json`, polled every 100 ms); the after build skips that lock when the run changed nothing. The 4–8 s
seen in the dev instance did not reproduce with a bare `session/new`; what differs there is Volt's MCP servers
and chat settings in `session/new` and the machine's load at the time.

**Under heavy load** (load 20–120, the rest of this pass) the run-to-run noise was 2–5×, larger than any
sandbox effect: e.g. at load 88–111 plain 5.6 s / sandboxed 2.9–3.5 s single, at load 74–98 plain 1.7 s /
sandboxed before 6.9 s / after 2.0 s, at load 21 plain 3 at once 2.6 s / sandboxed 3.5–5.8 s; these swung both
ways between rounds. (Those "after" rounds ran a variant with `~/.local/state/claude/locks` writable, which was
not kept: an experiment adding only that to the before build swung the same way, 1.1–4.9 s vs 1.2–3.4 s.)

What did reproduce consistently:
- **Without a state key** (no overlay), `session/new` took 6.8–7.6 s every time (5 of 5) against 1.3–6.5 s plain
  in the same minutes: `~/.claude.json` is unreadable then, so Claude Code starts without its cached feature
  flags and fetches them (4 TLS connections to api.anthropic.com open during the stall, main thread idle in
  `kevent64`). Volt's chats always pass a state key (`acpProvider.ts`: `stateKey: req.sessionId ?? 'default'`);
  any launch path that does not pays this (see Bugs).
- Claude Code reads `~/.local/state/claude/locks` and lists the home folder and `~/.claude` at start (denied);
  it writes `skills/synced`, `skills/.trash`, `plugins/store`, `sessions` below the real `~/.claude` (denied by
  design, through the overlay's read-only links). None of these delays the start measurably here; they were
  the cards the coordinator saw, now logged instead (see Fixes).

## 3. Security

### What the adversarial suite already covered

Reads outside the workspace (`../`, symlinks), credential canaries for every profile (case variants on APFS),
hard links to credentials, writes into protected names (`.git/config`, hooks, `.vscode`, `.envrc`, `.mcp.json`,
`.husky`, npx cache), agent config overlays (PERS-AGENT-*), narrow reads, listen ports, env allow list,
`.git` allow list (PERS-1..3: commondir, gitdir, config, hooks, info, alternates), background/setsid/double-fork
processes, signals to a host process (workspace profile only), fds, timeouts, network none, proxy mode against
loopback/metadata/`[::ffff:127.0.0.1]`, unix sockets, repository policy widening, hostile names, unenforceable
policies, the home folder as a workspace, CPU/file-size limits, concurrency, shutdown, and Apple Events /
LaunchServices / launchd / cfprefsd / pasteboard for the network-on agent profile. The broker suite (NET-1..20)
covers DNS rebinding, IDNA, NAT64, IPv4-mapped, 6to4, decimal/octal/hex/short forms, CONNECT smuggling, CL/TE,
pipelining, slowloris, token reuse, live grants and revocation, metadata, redirects, wildcards and exfil hosts.

### Probes run (`/tmp/voltbench/sb/probe.mjs`, fake HOME with canaries, workspace + agent network off/on)

All held on macOS 26.6: hard links to a toolchain binary, to the CLI's linked `settings.json`, to `~/.zshrc`, to a
file outside and to the workspace's protected `.git/config` (`ln` refused: no link, nothing written through);
writes through planted symlinks to another folder, `~/.ssh` (also for the network-on agent, which may read
`~/.ssh`) and `~/.aws`; direct writes to `~/.ssh/authorized_keys`, `~/.ssh/config`, `~/.aws/config`; renaming
`.git`, `.git/hooks` or `.git/config` aside or replacing it by rename; a `commondir` symlink; a nested `.git`
symlink; `launchctl submit/bootstrap`, `open -a/-b`, `osascript` (its `do shell script` runs inside the sandbox
and is refused); `kill -STOP/-TERM/-0` on a host process from agent profiles; `ps -axww` / `ps -axwwE` see only
the sandbox's own processes; no secret variables in `env`.

Address spellings checked against the broker's normaliser and classifier (`/tmp/voltbench/sb/addr.mjs`, 50
spellings: `localhost.`, `127.1`, `0x7f000001`, `2130706433`, `0`, `0.0.0.0`, `[::]`, `[::1]`, `[::127.0.0.1]`,
`[::ffff:7f00:1]`, `fe80::1%en0`, full-width and circled digits, `%2e` escapes, NUL, NAT64, 6to4, Teredo, CGNAT,
metadata on both families, ...). One hole, fixed (below): `::ffff:0:a.b.c.d`.

### New adversarial tests (all pass, `VOLT_SANDBOX_REQUIRED=1`)

| test | file | what it proves |
|---|---|---|
| ESC-LINK-1 | sandboxSecurity.test.ts | no hard link to a readable-but-not-writable file (toolchain, linked CLI config, rc file, outside file, `.git/config`) is made, for workspace and both agent profiles; the toolchain binary is unchanged |
| ESC-LINK-2 | sandboxSecurity.test.ts | writes through workspace symlinks to another folder, `~/.ssh`, `~/.aws`, and direct writes/mkdir in `~/.ssh`, all fail; the folders hold exactly what they held |
| ESC-GIT-1 | sandboxSecurity.test.ts | `.git` and `.git/hooks` cannot be renamed aside, `.git/config` cannot be replaced by rename or `ln -f`, no `commondir` symlink (Linux: asserts the `filesystem.protectNew` residual is reported instead of the rename checks) |
| ESC-GIT-2 (macOS) | sandboxSecurity.test.ts | a nested `.git` symlink or `.Git` gitdir file pointing outside cannot be planted |
| ESC-PROC-1 | sandboxSecurity.test.ts | agent profiles (network off and on) cannot STOP/TERM/probe a host process, and `ps` shows neither its argv secret nor its environment |
| ESC-MAC-1 (macOS) | sandboxSecurity.test.ts | launchd, LaunchServices (`open -a/-b`) and Apple Events (`osascript`, Terminal `do script`) run nothing outside for the workspace and network-off agent profiles (the existing test covered only the network-on agent) |
| NET-21 | networkBroker.test.ts | 17 localhost aliases through `CONNECT` under `*`, `::/0`, `0.0.0.0/0` (nip.io-style answers, `.localhost`, short/hex/zero forms, IPv6 spellings, zone ids, SIIT, NAT64, `%2e`), and the system resolver's `localhost`/`LOCALHOST.`/`LocalHost`: 4xx, nothing resolved to a connection, never promptable |
| NET-4 (extended) | networkBroker.test.ts | SIIT forms `[::ffff:0:127.0.0.1]`, `[::ffff:0:a00:1]`, `[::ffff:0:a9fe:a9fe]` refused |
| NET-PROP-1/2 (extended) | networkAddress.test.ts | the SIIT spelling joins the property test's encodings of every special and metadata address |

Adversarial suite: 34 → 40 passing (2 Linux-only pending).

### Residuals confirmed (not fixed, documented before)

- **B-12 / MAC-ENV-1:** a sandbox reads another process's argv and environment with `sysctl(KERN_PROCARGS2)` (a
  compiled reader). `ps` is refused, but the sysctl is not: `(deny sysctl-read (sysctl-name "kern.procargs2"))`,
  `sysctl-name-prefix`, `(deny process-info*)` and `(deny process-info* (target others))` were all tried on macOS
  26.6 and none blocks it. A Volt sandbox's own `HTTPS_PROXY` token is readable that way, but a token is only
  valid on its own route and the OS lets each sandbox reach only its own route port (B-31), so it is useless
  elsewhere.
- Linux `filesystem.protectNew`: a renamed-aside `.git` (ESC-GIT-1) and new names below protected folders are
  the documented residual; the test asserts the run reports it.

## 4. First party vs third party

Where a built-in `volt.*` extension's call is decided, and what the tests show:

| layer | first party (built-in, in `FIRST_PARTY_CEILINGS`) | third party | tests |
|---|---|---|---|
| `vscode.volt` API (`VoltExtensionCapabilityPolicy`, `voltExtensionApiService.requestConsent`) | declared ∩ ceiling allowed, no consent lookup; beyond the ceiling refused with `deniedBy: 'ceiling'`, never `promptable`; `requestConsent` returns false for a built-in without a dialog | low = install-time grant; medium/high need consent, `promptable` when never answered | EXT-CAP-1/2/5, M5-ZERO-PROMPT-1/2, M5-ENFORCE-1 (existing; rerun, pass) |
| network broker route (T2 plugin host, any non-chat principal) | **was prompted, now fixed:** see below | undeclared host: 403 with an "Allow host" offer (G.12 budget) | NET-FP-1 (new), NET-VIEW-1, NET-T3-1 |
| extension hosts (T3) | built-ins never run in a sandboxed extension host (`extensionSandboxTier` → `not-needed`) | opt-in per extension | voltExtensionSandboxService.test.ts (existing) |

`volt.net.fetch` (the API's HTTP client) checks `net.connect` against the policy and then throws "unavailable"
(the broker path is not wired yet), so no prompt there either.

**Bug fixed (networkBroker.ts):** a built-in's route was judged like a plugin's. `routeManifest` drops untargeted
and `*` `net.connect` declarations (right for third parties, H.7), so a built-in whose manifest and ceiling say
"any host" (`volt.usage`, `volt.automations`) was refused for every host, and the refusal was `promptable`:
the user would have been asked to "Allow host" for Volt's own feature. And a built-in going beyond its ceiling
(a tampered manifest naming `evil.test`, or another port) was also offered an "Allow host", whose grant could
never have helped (first-party grants are ignored). Now, for a `firstparty:` subject: the manifest is judged as
declared (the Authority's ceiling check caps it), no denial is ever approvable or promptable, `approve()` finds
nothing to approve and `allowHosts()` commits nothing. The floor still holds for built-ins (loopback, private,
metadata, exfil hosts by wildcard: all refused in NET-FP-1).

## Fixes made

| file | what | why |
|---|---|---|
| `src/vs/platform/voltSandbox/node/networkBroker.ts` | first-party routes: manifest as declared (ceiling caps it), denials never approvable/promptable, `allowHosts` a no-op | built-ins were refused for in-ceiling hosts and offered "Allow host" prompts (section 4) |
| `src/vs/platform/voltSandbox/common/networkAddress.ts` | `::ffff:0:a.b.c.d` (SIIT, RFC 6145) is judged as its IPv4 address | it classified as **public**: `[::ffff:0:127.0.0.1]`, `[::ffff:0:10.0.0.1]`, `[::ffff:0:169.254.169.254]` passed the address floor under an IPv6 `::/0` rule; on a network with a stateless translator that reaches loopback/LAN/metadata of the far side. On a plain host the kernel routes it as IPv6 (no loopback), so severity is low, but the table must not call it public |
| `src/vs/platform/voltSandbox/common/seatbelt.ts` (listen ports) | a granted listen port's `network-inbound` rule names `localhost:<port>` and `*:<port>` (the bind rule still names `localhost:<port>`) | **a granted port was refused by its number**: macOS 26.6 checks `listen()` as inbound on `*:<port>` for some ports (63000 and 65351 refused, 50123/61234/62000/64000/65000/65535 fine, deterministic; log: `deny(1) network-inbound local:*:63000`). It made NET-LISTEN-1 fail whenever its random port was one of those (it failed once in this pass on 65351). NET-LISTEN-1 now also grants 63000 and 65351, network on and off |
| `src/vs/platform/voltSandbox/node/sandboxResolver.ts` | per-resolution memo + concurrent canonicalisation | 560 serial `realpath` calls per agent launch (section 2) |
| `src/vs/platform/voltSandbox/common/seatbelt.ts` | memoised merged regex groups and name alternations (bounded) | ~10 ms CPU of profile text per agent launch |
| `src/vs/platform/voltSandbox/node/agentStateOverlay.ts` | before-launch sync skips unchanged seeds (no lock), concurrent mkdirs/links/seeds | 19–85 ms per stateKey launch |
| `src/vs/platform/voltSandbox/common/sandboxPolicy.ts` | `AGENT_HOUSEKEEPING` table + `isAgentHousekeepingDenial()` | Claude Code's own background writes (`skills/synced`, `skills/.trash`, `plugins/store`, `sessions`, `.local/state/claude/locks`, ...) produced "Blocked by the sandbox" cards whose "Allow Folder" would make a folder the user's own CLI runs code from writable (coordinator finding 1) |
| `src/vs/platform/voltSandbox/node/sandboxLauncher.ts` | denials of the CLI's housekeeping, the run's own attestation canary, and reads of the home folder / its parent / the CLI's real config folder as folders are logged once per target (`housekeeping denial, not shown`) instead of reaching `onViolation` | same; the canary read (`~/.volt/sandbox/runs/<run>/canary`, the attestation's own probe) also reached `onViolation` on every launch |
| `src/vs/platform/voltSandbox/common/agentState.ts` | `AGENT_QUIET_KEYS` (Claude Code's caches, counters, seen marks, ids) + `quietPatternCovers`; `mergeAgentState(..., quiet)` keeps them in the chat without reporting | "Sandbox kept config changes in this chat — … (cachedGrowthBookFeaturesAt)" after every turn (coordinator finding 2). Settings (`mcpServers`, `env`, `allowedTools`, `hasTrustDialogAccepted`, `oauthAccount`, ...) are still reported |
| `scripts/volt-sandbox-bench.mjs` | `--launcher` (the launcher path with a state key, fake HOME with a 170 KB `.claude.json`) and `--out <dir>` | the brief's launcher measurement; A/B against a copy of `out/` |
| `scripts/volt-network-broker-bench.mjs` | `--out <dir>`; the broker writes its audit log as in production | per-request overhead including the audit line |

The housekeeping list and the quiet keys are their own tables, not fields of `AGENT_FOOTPRINTS`/`AGENT_OVERLAYS`:
those two are mirrored by the provider manifests and `cliAgentParity.test.ts` (M2-PARITY-4) fails on any
difference; neither new table widens what a sandbox may read or write.

Tests added: NET-FP-1, NET-21, NET-4 (SIIT), NET-PROP-1/2 (SIIT encodings), HOUSEKEEPING-1 (sandboxPolicy.test.ts),
QUIET-1 (agentState.test.ts), ESC-LINK-1/2, ESC-GIT-1/2, ESC-PROC-1, ESC-MAC-1.

## Bugs found and not fixed

- **No-state-key Claude launches start slowly** (6.8–7.6 s `session/new`, 5 of 5): without an overlay
  `~/.claude.json` is unreadable and Claude Code refetches its feature flags. Volt's chats always pass a state key;
  any launch path that does not (a pool warm-up, the Tab predictor if it ever goes sandboxed) pays this. Fix
  outside my scope: always pass a state key (acpProvider/agent pool are another agent's).
- `MCP-QUOTA-MEM` and the `voltStdioMcpHost` after-each leak are load-dependent flakes (baseline failures 1–3).
- `seatbeltMerge.test.ts` "PERF-SB law" takes 3.5 s against a 5 s timeout at load ~40 (timed out once in this
  pass); it is a pure property test that the memo cannot speed up (300 random, unique policies).
- Claude Code reads `~/.local/state/claude/locks` at start and is refused (now not shown). Making it readable needs
  the footprint changed in core and in `extensions/volt-provider-claude/package.json` + the generated agent table
  (M2-PARITY-4), outside my scope; making it writable was measured and not kept (no measurable gain; a planted or
  removed lock steers the user's own updater).

- A granted listen port is reachable on every interface, not only loopback: Seatbelt's `localhost` in a
  `local ip` bind filter matched `0.0.0.0` and the LAN address too (measured before any change: an agent granted
  64000 listened on `0.0.0.0:64000` and `192.168.0.104:64000`). Not an escape (the port was granted), but a dev
  server an agent starts on a granted port is visible on the LAN. Closing it needs a bind rule per loopback address
  (`127.0.0.1`/`::1` are not expressible in SBPL filters, only `localhost` and `*`), so it is left documented.

## Open issues

- The 4–8 s sandboxed agent start seen in the dev instance did not reproduce here with a bare `session/new` at
  load 20–120; the remaining differences are Volt's MCP servers and chat settings in `session/new`. Worth one
  more trace inside the dev instance with `log stream --predicate 'eventMessage CONTAINS "VOLTSBX-"'` and the new
  `housekeeping denial` log lines, at low load.
- Claude Code's synced claude.ai skills and plugin store cannot be written from a sandboxed chat (the overlay
  links `skills` and `plugins` read-only). Silent now, but those features do not work inside a sandboxed chat; a
  per-chat writable `skills/synced` would need the overlay to link `skills/*` entries one by one.
- B-12 (`KERN_PROCARGS2`) stays open; no Seatbelt rule blocks it on macOS 26.6.

## Final results

| run | passing | pending | failing |
|---|---|---|---|
| the 45 baseline files + `extensionCapabilityPolicy`, `featureCapabilityMode`, `cliAgentParity` (one run) | 486 | 39 | 0 |
| adversarial suite, `VOLT_SANDBOX_REQUIRED=1` | 40 | 2 (Linux-only) | 0 |
| `npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck` | 0 errors | | |
| `npx eslint` on every changed file | clean | | |

## Changed files

Source:
- `src/vs/platform/voltSandbox/common/agentState.ts`
- `src/vs/platform/voltSandbox/common/networkAddress.ts`
- `src/vs/platform/voltSandbox/common/sandboxPolicy.ts`
- `src/vs/platform/voltSandbox/common/seatbelt.ts`
- `src/vs/platform/voltSandbox/node/agentStateOverlay.ts`
- `src/vs/platform/voltSandbox/node/networkBroker.ts`
- `src/vs/platform/voltSandbox/node/sandboxLauncher.ts`
- `src/vs/platform/voltSandbox/node/sandboxResolver.ts`

Tests:
- `src/vs/platform/voltSandbox/test/common/agentState.test.ts` (QUIET-1)
- `src/vs/platform/voltSandbox/test/common/networkAddress.test.ts` (SIIT encodings)
- `src/vs/platform/voltSandbox/test/common/sandboxPolicy.test.ts` (HOUSEKEEPING-1)
- `src/vs/platform/voltSandbox/test/node/networkBroker.test.ts` (NET-FP-1, NET-21, NET-4)
- `src/vs/platform/voltSandbox/test/node/sandboxSecurity.test.ts` (ESC-LINK-1/2, ESC-GIT-1/2, ESC-PROC-1, ESC-MAC-1, NET-LISTEN-1)

Scripts and report:
- `scripts/volt-sandbox-bench.mjs` (`--launcher`, `--out`)
- `scripts/volt-network-broker-bench.mjs` (`--out`, audit log on)
- `docs/reports/2026-11-12-orch-devenv/03-sandbox.md`

Not changed: `voltStdio/**` (nothing found to fix there), `voltExtension*.ts` (nothing needed; and
`voltExtensionSandbox.ts`/`voltExtensionSandboxService.ts` are changed on the other chat's `e2e/sbx` branch).
Overlap with `e2e/sbx` (`git diff feat/orch-and-devenv-revamp...e2e/sbx`): none of my files; that branch touches
`voltSandbox/common/sandboxWorkloads.ts`, `voltSandbox/node/supervisor.ts` and `sandboxSupervisor.test.ts`.

Scratch tools (not in the repo): `/tmp/voltbench/sb/` (`probe.mjs`, `addr.mjs`, `equiv.mjs`, `count-fs.mjs`,
`compile-micro.mjs`, `launch-phases.mjs`, `ab-interleaved.mjs`, `listen.mjs`, `acp/acpsbx.mjs`, `acp/kc.mjs`), and
the before build `/tmp/voltbench/sb/out-before`. Nothing was left in `~/.volt/sandbox/agent-state` by this pass
(`bench-chat`, `bench-overlay` there are not mine). No dev instance was started.
