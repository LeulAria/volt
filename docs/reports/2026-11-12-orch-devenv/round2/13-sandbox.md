# 13: Sandbox, round 2: round 1's open items and a live pass over every feature

Branch `e2e2/sbx` (worktree `volt-e2e-sbx`, base `81563ca39e4`). Machine: Apple M4 Max, macOS 26.6
(Darwin 25.6.0), Seatbelt backend, Node 25.1 for scripts, Claude Code CLI 2.1.322. Four other agents
ran at the same time: the load average is given with every timing, and it ran from 8 to 241.

Two agents did this round: the first (commits `717d776` to `60494db`) stopped part way ("Sign in to
continue"); the second (commits `7fc3034` onwards) reused its data and scripts, did not repeat its
runs, and finished the live checks.

## Summary

- **Sandboxed `/usr/bin/git` is 13x faster.** Cause: Apple's `/usr/bin/git` is an `xcode-select`
  shim. In a deny-default sandbox (extension hosts) it could not ask `com.apple.bsd.dirhelper` where
  the user's temp folder is, so it never found xcrun's cache and ran `xcodebuild -find git` on every
  call. Fixed in `79e5d41`. `git --version` from a fresh sandboxed run, N=7 interleaved at load 8:
  **2,349 ms -> 185 ms median** (2,263-4,269 -> 157-249). At load 41-93, N=5: 32,288 -> 2,199 ms.
- **Attack matrix: every attack is now blocked and reported in every sandbox profile.** Before, an
  agent chat with its network on could POST to a host nobody allowed and connect to a local listener
  (THROUGH 3/3 each, in both network-on profiles), and 2 of 3 Docker-socket refusals in the read-only
  profiles went unreported. After: every attack cell in the 5 sandboxed profiles is blocked, all
  "seen 3/3".
- **Adversarial suite (`VOLT_SANDBOX_REQUIRED=1`): 46 passing, 2 pending (Linux-only), 0 failing**
  (round 1 ended at 40), with 5 new tests this round: NET-AGENT-1, FX-1, GIT-SHIM-2, LOG-FORGE-2,
  DENIAL-FLUSH-1. All CI lints pass; tsgo 0 errors.
- **The live pass found and fixed 6 user-visible defects**, each checked again in the window:
  "Stop" on a misbehaving extension restarted it 2.5 s later along with every other extension host;
  a sandboxed install never showed the code scan's findings; every sandboxed Claude chat opened with
  one or two false "Blocked by the sandbox" cards (`/tmp/cc-socks` peer sockets, a Datadog log
  intake); the Security page's list of blocked actions sat below the window's edge in a run-on
  tooltip; and it said "0 hosts allowed" for an extension that reaches its declared host.
- **The Agent Lab sample works end to end in the sandbox** (install review, scout through the npm
  registry, model picker, hand-off to a new Haiku chat, plan on Scratch), and its test build's mock
  malware got nothing out: 15 attempts, 0 requests at the exfil server, the canary never read, every
  refusal named in a runtime warning. The 3 "got through" the fixture reports are not escapes (see
  the Agent Lab table).

## Setup

```sh
cd /Users/leularia/Desktop/VOLT/volt-e2e-sbx
npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
node build/volt/syncOut.mjs <changed src files>

# dev test window (CDP 9954), its own profile and extensions folder
scripts/volt-e2e/sbx/launch.sh . /tmp/v2-sbx-ud 9954
#   settings: window.dialogStyle custom, files.simpleDialog.enable (to type the .vsix path)
# git shim bench: each run is a fresh SandboxManager run under the T3 extension-host policy
node docs/reports/2026-11-12-orch-devenv/round2/scripts/sbx/gitShimBench.mjs /tmp/v2-sbx/out-before ./out 7
# attack matrix (round 1's script): 6 profiles x 13 attacks x 3 runs
node scripts/volt-e2e/sbx/attackMatrix.mjs <out> 3
# adversarial suite; every sandbox / plugin / extension-sandbox / Security-page suite
VOLT_SANDBOX_REQUIRED=1 ./scripts/test.sh --run src/vs/platform/voltSandbox/test/node/sandboxSecurity.test.ts
bash docs/reports/2026-11-12-orch-devenv/round2/scripts/sbx/suites.sh
# fx ACP start through the real VoltSandboxLauncher
node docs/reports/2026-11-12-orch-devenv/round2/scripts/sbx/fxStart.mjs <out> sbx on|off
# Agent Lab test build
cd docs/volt/examples/volt-agent-lab && node build.mjs --fixture   # dist/volt-agent-lab-0.1.0-fixture.vsix
```

`/tmp/v2-sbx/out-before` is `out/` transpiled at the base commit `81563ca39e4` (the "before" arm).
Live agent turns: Claude Haiku 5.5 (`agent:seed-claude-code:claude-haiku-5-5`), 4 short turns, plus
2 one-word `claude -p` runs for the telemetry measurement. Agent Lab fixture: all eight switches on
(`readCanary`, `exfiltrate`, `spawnShell`, `readSecrets`, `undeclaredApi`, `criticalApi`, `delayed`
at 20 s, `obfuscated`), a canary `~/.ssh/volt-agent-lab-canary` ("VOLT-CANARY-<ts> not a real key")
and a local exfil server on 127.0.0.1:47913 that logs every request to `/tmp/v2-sbx/exfil.log`.

## Results

### (e) Sandboxed git: before / after

`/usr/bin/git --version`, T3 extension-host policy, A/B interleaved, one fresh process tree per run.
Raw: `data/sbx/git-shim-bench.json`, `data/sbx/git-shim-bench-load8.json`.

| arm | N | median | range | load (1 min) |
|---|---|---|---|---|
| before (`81563ca`) | 7 | 2,349 ms | 2,263-4,269 ms | 7.5-8.3 |
| after | 7 | **185 ms** | 157-249 ms | 7.5-8.3 |
| before (`81563ca`) | 5 | 32,288 ms | 17,923-39,028 ms | 41-93 |
| after | 5 | **2,199 ms** | 1,786-3,311 ms | 60-93 |

Where the time went: the shim's `xcodebuild -find git`, a full Xcode toolchain lookup that is
CPU-bound and grows with load (round 1 saw 3.7-9.6 s at its load). After the fix the shim reads
xcrun's cache (`$TMPDIR/xcrun_db`, read-only to the sandbox: it says which binary the user's own git
runs, so no agent may write it) and execs git directly. The remaining 185 ms is the sandboxed launch
(profile, attestation, canary) plus git's own start. GIT-SHIM-2 pins it.

### (g) Attack matrix: before / after

Round 1's `attackMatrix.mjs`, 3 runs per cell, real Seatbelt. "seen" = the refusal reached Volt's
denial stream, so the user is told. Raw: `data/sbx/attack-matrix-{before,after}.json`, the before
table in `data/sbx/attack-matrix-before.md`.

| attack | profiles | before | after |
|---|---|---|---|
| read `~/.ssh`, `~/.aws`, write outside, `~/.zshrc`, `.git/hooks`, `.vscode/tasks.json`, a child reads the key, delayed attack | all 5 sandboxed | blocked, seen 3/3 | blocked, seen 3/3 |
| read secret env vars | all 5 sandboxed | blocked | blocked |
| POST to a host nobody allowed (example.com) | ww-net, ro-net | **THROUGH 3/3** | blocked, seen 3/3 |
| connect to a local listener | ww-net, ro-net | **THROUGH 3/3** | blocked, seen 3/3 |
| connect to a local listener | ww-nonet, ro-nonet, t3 | blocked, not seen | blocked, seen 3/3 |
| reach the Docker socket | ro-net, ro-nonet | blocked, seen 2/3 | blocked, seen 3/3 |
| every attack | off (no sandbox) | THROUGH 3/3 | THROUGH 3/3 |
| CONTROL: write in the workspace | ww-net, ww-nonet, off | works | works |

Load: before 44 -> 19 (20:18-20:20), after 46 -> 92 (21:22-21:25). The read-only profiles' control
write fails by design.

### (g) Test suites

| run | passing | pending | failing | load |
|---|---|---|---|---|
| adversarial, `VOLT_SANDBOX_REQUIRED=1`, round 1 end | 40 | 2 | 0 | - |
| adversarial, `VOLT_SANDBOX_REQUIRED=1`, now (`data/sbx/adversarial-suite-after.txt`) | **46** | 2 (Linux-only) | 0 | 155-241 |
| `suites.sh` (53 files: sandbox, plugins, extension sandbox, Security page), first agent, 20:51 | 511 | 37 | 0 | 27-32 |
| touched suites after this round's fixes (sandboxCore, sandboxPolicy, extensionHostSandbox, cliAgentParity, sandboxWorkloadsSection, installSheetCodeScan) | 118 | 0 | 0 | 8-150 |

The `suites.sh` re-run after the last fix is under "Final checks".

### (a) CI lints

All pass on the last commit: `listenerLint` (35 reviewed sites), `spawnAudit` (165 sites in 82
files), `authorityGate` (12 reviewed sites; `extensionCodeScan.ts`'s host match is one, `717d776`),
`manifestCeiling` (30 built-ins), `featureImportLint` (9 fences), `gitSpawnLint`,
`volt-command-visibility-check` (4/4), `valid-layers-check`.

### (b) fx and Antigravity in sandboxed chats

fx (`fx acp`: `initialize`, then `session/new`), through the real `VoltSandboxLauncher`,
workspace-write. Raw: `data/sbx/fx-start.txt`, load 98-150.

| arm | initialize | session/new |
|---|---|---|
| before (`81563ca`), network on | **fails**: "Failed to load startup state" | not reached |
| after, network on | ok, 3,453 ms | ok, 7 ms |
| after, network off | ok, 2,250 ms | ok, 36 ms |

fx lists the home folder and `chmod`s `~/.fx` at start; the new `filesystem.list` and
`filesystem.chmod` policy fields grant exactly that (names only, mode only; FX-1 and LIST-HOME-1 check
nothing else is reachable). It still logs 5 refusals at start (see Bugs found and not fixed).

Antigravity listens on a random port, and Seatbelt can't hold a listener to this machine: a bind on
`0.0.0.0` or on the LAN address passes a `localhost` filter (measured with `seatbeltListen.mjs` and
`seatbeltRemoteLocalhost.mjs`). So on macOS a sandboxed chat refuses Antigravity before launch, with
that reason (AGY-1, AGY-2 pass), and the model picker marks it "Runs only with the sandbox off".
Linux keeps it in its own network namespace. No live Antigravity turn was run.

### (c) Hostname rules for agents with their network on

Before, "network on" meant any host. Now every agent launch goes through its network broker route:
its API hosts, the package registries and the hosts the user allowed. Anything else is refused with
an Allow offer, and the OS lets the process reach only the route (clearing the proxy variables
reaches nothing). Tests: NET-HOST-1 (policy), NET-AGENT-1 (real Seatbelt: API, registries and the
user's hosts reached; other hosts, raw and IPv6 addresses, rebinding names, loopback and other ports
refused and reported), MCP-6. Live: the two matrix rows above, and sandboxed Haiku chats work through
the route (4 turns). Found live and fixed: Claude Code's Datadog log intake was refused with a card on
every chat (fix 3 below).

### (d) Refusals of connections to this machine, named

Live, from Agent Lab's sandboxed host sending to 127.0.0.1:47913: the runtime warning reads "Volt's
sandbox blocked Agent Lab: it tried to connect to port 47913 on this machine and read
~/.ssh/volt-agent-lab-canary." (`shots/04`), and the Security page lists "Blocked: connect to port
47913 on this machine (2x, ...)". The kernel logs these as `remote:*:47913`, without the address; a
deny rule for `localhost:*` with its own message suffix lets Volt say "on this machine"
(LOCAL-DENIAL-1).

### (f) Live checks in the dev window

Screenshots in `data/sbx/shots/`.

| check | result | shot |
|---|---|---|
| Review before install (Extensions: Install from VSIX, fixture build) | "Install Agent Lab?", "Where its code runs: In a sandbox (recommended)", the 9 capabilities by class with the extension's reasons; Install opted it into the sandbox | `02-install-review-sheet.png` |
| Code scan warning at install | **before the fix: never shown** for an install into the sandbox. After: "What Volt found in Agent Lab's code", 8 findings (the 3 hidden-code ones marked), "It runs in Volt's sandbox, which blocks what it is not allowed", OK only | `03-code-scan-findings-after-sandboxed-install.png` |
| Permission sheet at first activation (the CLI-installed attack build) | findings first, then Low / Medium / High | `01-permission-sheet.png` |
| Consent, Allow, then the extension works | `agents.send` (medium) and `agents.create` (high) dialogs. After Allow: the model list came back, a chat "Upgrade 2 dependencies" started on Haiku 5.5, marked "Started by Agent Lab (external)", the plan drawn on Scratch | `05`, `08` |
| Agent Lab: Scout Dependencies | in the sandbox, through the broker to registry.npmjs.org: "2 of 2 dependencies are behind" (left-pad 1.0.0 -> 1.3.0, lodash 4.17.0 -> 4.18.1) | - |
| Model picker | "Agent Lab: which model?": Volt's default model, 5 Ollama models, fx, Claude and the rest; filtering "haiku 5.5" leaves "Haiku 5.5 (Claude)" | `08-agent-lab-model-picker.png` |
| Runtime warnings | the sandbox's ("connect to port 47913 on this machine, read ~/.ssh/volt-agent-lab-canary, read ~/.volt/trust/grants.json and 2 more", Show Details / Stop Agent Lab) and the API's ("tried to use automations.schedule, usage.report, browser.read and 3 more", Show Details / Show Extension) | `04`, `05` |
| Show Details | "What Volt blocked Agent Lab from doing": each refused call, its capability and why | `06-show-details.png` |
| Security page, blocked actions | the row says "13 blocked"; the hover's "Blocked:" lines (canary 8x, .npmrc, .aws/credentials, grants.json, port 47913 2x) were **below the window's edge, in one run-on paragraph**; fixed (fix 4) | `07-security-page.png` |
| Stop (warning or Security page) | **before the fix: the host was killed, and 2.5 s later it was back with the main local extension host and the other sandboxed host restarted too.** After: only Agent Lab's host exits; the local host (pid 33293) and the attack build keep running; Agent Lab stays off the page until reload | `09-security-page-after-stop.png` |
| A fresh sandboxed Claude chat | "ok", no "Blocked" card (before: `/tmp/cc-socks/<pid>.sock`, and with the hostname rules also the Datadog intake) | `10-fresh-sandboxed-claude-chat-no-cards.png` |
| Built-in extensions | 30 built-ins declare Volt capabilities (memory, Scratch, visuals, browser, usage, the providers...). In this fresh profile none showed a sheet or a consent: the only `[volt install review]` and `[volt extension watch]` log lines name the Agent Lab builds, while Memory, Scratch and the providers were in use. The sheet skips built-in and first-party-ceiling extensions; `manifestCeiling` holds them to their ceilings | - |

#### Agent Lab's mock malware (fixture, all switches, sandboxed host)

15 attempts by the fixture's own count; afterwards `exfil.log` held only my own probe request.

| switch | outcome | detail |
|---|---|---|
| readCanary, delayed:readCanary (3 activations) | blocked | `EPERM` on `~/.ssh/volt-agent-lab-canary` |
| exfiltrate, delayed:exfiltrate | blocked | `connect EPERM 127.0.0.1:47913` |
| spawnShell, delayed:spawnShell | blocked | the shell's `cat` of the canary: "Operation not permitted", so `curl` had nothing to send; `id -un` ran |
| readSecrets:file (grants.json, .aws/credentials, .npmrc) | blocked | `EPERM` x3 |
| readSecrets:env | "succeeded" (false) | the only names it saw were `npm_config_proxy` and `npm_config_https_proxy`: the sandbox's own route out, set by Volt. The fixture now leaves them out |
| undeclaredApi (automations.schedule, usage.get, browser.readPage) | blocked | "Volt refused ... (manifest)" |
| undeclaredApi: registerTool(memory_write) | "succeeded" (false) | Volt refused it ("tools.register: full ... critical", in Show Details), but the API returns a disposable, so the fixture can't tell (round 1's open item, still open) |
| criticalApi (terminal_start, manage_automations) | blocked | terminals.run (manifest), spawn.unsandboxed (critical) |
| obfuscated:eval | "succeeded" | `eval` of `40+2` inside the extension's own process: no OS sandbox stops in-process JS; the install scan flags it ("Builds a sensitive name from pieces to hide it") |
| obfuscated:exec | error | the shell's `cat` / `curl` of the canary failed |

## Fixes made

By the first agent (committed before this restart; summarized from the commits):

| commit | what | why | tests |
|---|---|---|---|
| `717d776` | `extensionCodeScan.ts`'s host match is a reviewed authority-gate site; a bare `*` and wildcard patterns no longer hide drop hosts | the authorityGate CI failure (a); a scan bypass | EXT-SCAN-6b |
| `79e5d41` | hostname rules for network-on agents; fx `list` / `chmod` grants; `/usr/bin/git`: dirhelper and a read-only xcrun cache; Antigravity refused on macOS; `localhost:<port>` refusals named | (b), (c), (d), (e) | NET-HOST-1, LIST-HOME-1, AGY-1/2, LOCAL-DENIAL-1, NET-AGENT-1, FX-1, GIT-SHIM-2, MCP-6 |
| `08558f9` | refusals accepted only from the kernel (pid 0, Sandbox.kext); one-shot runs wait up to 2 s for a flush marker; the picker marks Antigravity | a sandboxed process could forge a "Blocked" card with `logger` whose "Allow Folder" widened its own sandbox (measured); the matrix's "seen 2/3" | LOG-FORGE-1/2, DENIAL-FLUSH-1 |
| `60494db` | the spawn audit lists the logger flush | CI | spawnAudit |

By this agent:

| commit | file | what | why | test |
|---|---|---|---|---|
| `e40eb1a` | `platform/voltSandbox/common/sandboxDenials.ts` | a network refusal of `/tmp/cc-socks/<x>.sock` is noise; it stays refused | Claude Code knocks on every other session's socket at start, so every sandboxed Claude chat opened with "Network access to /private/tmp/cc-socks/68979.sock was blocked" and Run Outside Sandbox. Those sockets must stay closed: a sandboxed chat could hand a prompt to the user's unsandboxed sessions | `sandboxPolicy.test.ts` (kinds, noise); live `shots/10` |
| `e40eb1a` | `contrib/voltSecurity/browser/installSheet.ts` | after an install into the sandbox from Volt's UI, the scan's high findings are said once ("What Volt found in X's code", OK only) | the review before install sees only the manifest, and the sheet after it was skipped for reviewed, sandboxed extensions: the findings were never shown | UX-SHEET-LAB-4; live `shots/03` |
| `1af823e` | `platform/voltSandbox/common/sandboxPolicy.ts`, `extensions/volt-provider-claude/package.json`, the generated manifests | sandboxed Claude runs get `DISABLE_TELEMETRY=1` | with the hostname rules, `http-intake.logs.us5.datadoghq.com` (Claude Code's usage logs) was refused with a card on every chat. Not allowed instead: a Datadog intake takes logs for any account's key, an exfil channel. Measured through a logging CONNECT proxy (CLI 2.1.322): a default run opened 1 connection to it, with the variable 0; api.anthropic.com and mcp-proxy.anthropic.com unchanged | `sandboxCore.test.ts`, cliAgentParity; live `shots/10` |
| `1af823e` | `contrib/voltSecurity/browser/sandboxWorkloadsSection.ts`, `contrib/voltAgent/browser/media/agentTooltip.css` | the refusals lead a process's hover; plain tooltips keep their line breaks (`white-space: pre-line`) | the "Blocked:" lines came after ~40 lines of read paths, below the window's edge, in one run-on paragraph | `sandboxWorkloadsSection.test.ts` |
| `1af823e` | `platform/voltSandbox/common/sandboxWorkloads.ts`, `platform/voltSandbox/node/supervisor.ts` | "N hosts allowed" adds the hosts the broker routes for a host (declared `net.connect` targets, approved grants) | Agent Lab showed "0 hosts allowed" while it reached registry.npmjs.org; now 1 (the attack build 2) | T3-NET-2; live |
| `1af823e` | `docs/volt/examples/volt-agent-lab/src/testFixture/fixture.ts` | `npm_config_(https_)proxy` are not counted as secrets | a false "got through" | live |
| `d0eb53d` | `services/extensions/common/abstractExtensionService.ts`, `services/extensions/electron-browser/nativeExtensionService.ts` | a sandboxed extension host's end is its own: `stopOne`, no restart until reload | a sandboxed host is of the local-process kind, so the desktop's crash handler ran "terminated unexpectedly, restarting" for it: Stop brought the stopped extension back (its delayed attacks re-armed) and restarted every other host, the main one included | live, logs (no unit harness for the native service) |

## Bugs found and not fixed

- **`registerTool` refusals stay silent to the extension** (round 1, unchanged): the call returns a
  disposable; the user is warned, the extension can't tell.
- **Test windows write the real `~/.volt/trust/grants.json`** (round 1, unchanged): the Allows in
  this run (`agents.send` and `agents.create` for Agent Lab, and two older ones for the attack build)
  landed in the user's own grant store. The file held only those four test grants; they were removed
  at the end.
- **fx logs 5 refusals at every sandboxed start** (`osascript` asking `coreservicesd`,
  `/Library/Components`, `/Library/Audio/Plug-Ins/Components`, a read of `/private`, the DNS socket
  with the network on). They don't stop it (session/new works), but in a live fx chat they may show
  as a "Blocked" card. Not run live (it needs an fx turn).
- **Other agents' telemetry under the hostname rules was not checked.** Only Claude Code was measured
  (fix 3); Codex, Cursor, Grok, OpenCode and the others may knock on unlisted telemetry hosts and show
  cards.
- **Show Details** names a chat by its raw id ("browser.read (agent-67e59105-...)").
- **After Stop** an extension stays off until the window reloads; there is no "Start Again".

## Open issues

- Linux (bubblewrap) was not run this round; the 2 pending adversarial tests are Linux-only.
- The review before install can't show the code scan (it has only the manifest); the findings now
  come right after install. Scanning the `.vsix` before install would put them on the first sheet.
- No unit test covers the native extension service's crash path (`d0eb53d`); it was verified live and
  through the logs only.
- The git timings use `git --version`. A sandboxed `git status` in a real repository was not timed.

## Final checks

(Filled in at the end of the run.)
