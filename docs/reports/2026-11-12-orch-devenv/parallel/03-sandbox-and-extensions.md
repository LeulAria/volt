# 03 · Sandbox and extensions, end to end

Branch `e2e/sbx` (worktree `volt-e2e-sbx`, from `feat/orch-and-devenv-revamp` at `e33c552f2fc`).
Machine: Apple M4 Max, 14 cores, 36 GB, macOS 26.6, Seatbelt backend (`/usr/bin/sandbox-exec`),
Node 25.1 for the scripts. Date: 2026-11-12.

This review covers three things. First, the OS sandbox: `SandboxManager`, the Seatbelt profiles and
the network broker in `src/vs/platform/voltSandbox/`. Second, how it works with Volt's agent features.
Third, the extension path: install review, permissions, runtime warnings, and a sample extension
("Agent Lab") with test-only mock attacks.

Every number and verdict below comes from a file in `data/sbx/` or a test run named here. Anything
not checked is marked **not verified**.

## Contents

1. [Method](#method)
2. [Attack matrix, before and after](#attack-matrix-before-and-after)
3. [Sandbox overhead](#sandbox-overhead)
4. [Volt features inside the sandbox](#volt-features-inside-the-sandbox)
5. [Built-in extensions: no prompts](#built-in-extensions-no-prompts)
6. [Agent Lab walkthrough](#agent-lab-walkthrough)
7. [Fixes, with commits](#fixes-with-commits)
8. [Tests and checks](#tests-and-checks)
9. [Gaps](#gaps)
10. [Follow-ups](#follow-ups)

## Method

| What | How | Output |
|---|---|---|
| Attack matrix | `scripts/volt-e2e/sbx/attackMatrix.mjs --runs 3`. Each of 13 attacks (12 malicious, 1 control) runs as a real process under the real policy Volt builds, in 6 arms, 3 times. The arms are: no sandbox; agent chat at workspace-write and read-only, each with network on and off; and the T3 sandboxed extension host. It uses a fake `HOME` with canary `.ssh`/`.aws` files, a local listener that counts connections, and the real Docker socket (`GET /_ping` only). For each cell it records whether the attack got through and whether the sandbox reported a denial naming the attack's target ("seen": what the user could be warned about). | `data/sbx/attack-matrix-before.json` (12:02, before any fix on this branch), `data/sbx/attack-matrix-after.json` (13:40, after all fixes) |
| Overhead | `scripts/volt-sandbox-bench.mjs --runs 30`: policy compile, startup, per-command cost, 8 concurrent runs, 1,000 small files, sandboxed against direct. `scripts/volt-network-broker-bench.mjs --json` with `VOLT_BENCH_MB=128 VOLT_BENCH_CONNECTS=200`, shortened because the machine was busy. | `data/sbx/bench-baseline.json`, `data/sbx/bench-after.json`, `data/sbx/broker-bench-after.json` (no broker baseline was taken) |
| Agent Lab, live | A dev test instance (`scripts/volt-e2e/sbx/launch.sh`, profile `/tmp/ve-sbx`, its own extensions folder `/tmp/ve-sbx-ext`, CDP port 9983) on a scratch repo. The `.vsix` comes from `scripts/volt-e2e/sbx/buildAgentLab.sh`. `scripts/volt-e2e/sbx/labRuns.sh` reloads the window with `voltAgentLab.testOnly.mockAttacks: true` (delay 15 s) and collects activation, the attacks at start, the delayed attacks and a self test from the extension's storage folder. Screenshots are taken over CDP. | `data/sbx/agent-lab/`, `data/sbx/shots/` |
| Unit and adversarial suites | `npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck`, `npm run -s transpile-client-oxc`, rebuild the sandbox helper, then `VOLT_SANDBOX_REQUIRED=1 ./scripts/test.sh --run …` | [Tests and checks](#tests-and-checks) |

Who ran what: the previous agent ran the "before" matrix, the bench baseline, the screenshots up
to `06`, the shared-host attack run and three Agent Lab runs (`agent-lab/earlier-0904Z`). It did not
write a report. This report's author ran everything marked "after", the final Agent Lab run
(`agent-lab/final-0935Z`), screenshot `07`, and every test and check in [Tests and checks](#tests-and-checks).

## Attack matrix, before and after

Arms:

- **off**: no sandbox.
- **ww-net / ww-nonet**: agent chat at workspace-write, network on / off.
- **ro-net / ro-nonet**: agent chat at read-only, network on / off.
- **t3**: sandboxed extension host, trusted workspace, the manifest allows `api.github.com`.

Cells read *blocked*, *THROUGH* or (for the control) *works / FAILS*. "Warned" means the sandbox
reported a denial naming the target in n of 3 runs. That denial is what the runtime warning and
the Security page can show.

### After (all fixes, 3 runs per cell)

| Attack | off | ww-net | ww-nonet | ro-net | ro-nonet | t3 |
|---|---|---|---|---|---|---|
| Read `~/.ssh/id_ed25519` (canary) | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| Read `~/.aws/credentials` (canary) | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| Read secret env vars | THROUGH 3/3 | blocked (scrubbed, no warning) | blocked (scrubbed) | blocked (scrubbed) | blocked (scrubbed) | blocked (scrubbed) |
| Write outside the workspace | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| Append to `~/.zshrc` | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| Write `.git/hooks/pre-commit` | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| Write `.vscode/tasks.json` | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| POST to a host nobody allowed (example.com) | THROUGH 3/3 | **THROUGH 3/3** (network on) | blocked, warned 3/3 | **THROUGH 3/3** (network on) | blocked, warned 3/3 | blocked, warned 3/3 |
| Connect to a local listener (127.0.0.1) | THROUGH 3/3 | **THROUGH 3/3** (network on) | blocked, **no warning** | **THROUGH 3/3** (network on) | blocked, **no warning** | blocked, **no warning** |
| Reach the Docker socket | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| Spawn `sh`, the child reads the key | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| Delayed attack (background write 2 s later) | THROUGH 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 | blocked, warned 3/3 |
| CONTROL: write a file in the workspace | works | works | works | refused (read-only, as designed) | refused (as designed) | refused (as designed: T3 writes go through the window) |

### Before → after

The **blocked / through verdicts are identical** in both runs. No attack that was blocked before
got through after, and no new block appeared. That is expected: the fixes on this branch are in
paths this harness does not exercise, such as edits applied by the window, the install flow, runtime
warnings and the `/usr/bin` shims. Those were checked live with Agent Lab
([below](#agent-lab-walkthrough)).

The only differences are in the "warned" counts:

| Cell | Before | After |
|---|---|---|
| `.git/hooks/pre-commit`, ro-nonet | warned 2/3 | 3/3 |
| `.vscode/tasks.json`, t3 | warned 2/3 | 3/3 |
| spawn `sh` reads the key, ww-net | warned 2/3 | 3/3 |

No commit on this branch targets denial collection in `SandboxManager.run`. These look like run to
run variation in when the kernel's denial log reaches the manager. That is **not verified**, and it
means one run in three can block an attack without naming it.

By design:

- With the agent's network **on**, a chat may reach any host, loopback included. Only network-off
  agents and T3 hosts are held to named hosts.
- Read-only and T3 refuse workspace writes.

## Sandbox overhead

From `scripts/volt-sandbox-bench.mjs`, 30 runs unless noted. Times are in ms, shown as median (p90).

| Measure | Before | After |
|---|---|---|
| Compile a built-in profile | 6.82 (9.99) | 6.95 (10.35) |
| Compile the agent profile (17.6 KB SBPL, 19 regex, 59–60 subpaths) | 14.09 (15.86) | 13.44 (17.23) |
| `sandbox-exec` of the agent profile | 13.01 (17.34) | 11.96 (12.23) |
| Start: direct spawn | 1.63 (2.08) | 1.53 (1.78) |
| Start: workspace profile, total (prepare + start) | 33 (38) = 8 + 14 | 30 (34) = 8 + 13 |
| Start: agent profile, total (prepare + start) | 43 (56) = 16 + 18 | 40 (45) = 15 + 17 |
| Per command inside a running sandbox (n=10) | 1.88 vs 1.72 direct | 1.80 vs 1.62 direct |
| 8 concurrent sandboxed starts, wall (n=10) | 104 (114) | 89 (96) |
| 1,000 small files, sandboxed vs direct (n=5) | 2,338 vs 2,341 | 2,319 vs 2,154 |

What this means:

- A sandboxed launch costs about 30–40 ms over a direct spawn, mostly prepare plus `sandbox-exec`.
- Once a sandbox is running, a command costs about 0.1–0.2 ms extra.
- File I/O is the same within noise. The 1,000-file p90s swing 3.4–7.0 s on both sides because of
  other load on the machine.
- The fixes did not slow anything down. The agent profile changed by 13 bytes and one subpath
  (the Xcode license plist).

One field is not comparable. `hostSideRssKB` (184 MB in 5 processes before, 13 MB in 10 after)
greps the whole machine for `volt-sandbox-watchdog|bwrap|socat`. That catches other agents'
processes, so it is not a measure of this sandbox.

Network broker (after only, shortened run):

| Measure | Result | Budget |
|---|---|---|
| Connect overhead, median | 0.13 ms (p95 0.17 ms) | ≤ 2 ms |
| Throughput over a 125 MB/s shaped link | 124.97 vs 125.00 MB/s direct, ratio 0.9998 | ≥ 0.8 |
| Throughput over unshaped loopback | 3,109 MB/s vs 6,029 direct; 1.10× a bare relay | (informational) |
| Overall | **pass** | |

Agent Lab inside the T3 host, from its self tests (`data/sbx/agent-lab/*/…selfTest.json`):

- `volt.storage.get` round trip: p50 1.83–2.01 ms, p90 2.4–5.5 ms (n=30, 4 runs).
- Activation: 1–3 ms in a warm host. One cold run took 113 ms, 5.9 s after the host started.

## Volt features inside the sandbox

| Feature | Status | Evidence |
|---|---|---|
| **API calling (HTTP) from a sandboxed extension** | Works for declared hosts; undeclared and exfil-capable hosts are refused | Live: `fetch` and `https` to `www.githubstatus.com` answered 200 in every run. `api.github.com`, though declared, is refused (classed high, no install grant). `example.com`/`example.org` were refused by the broker (`VOLT_PROXY_403`, `TypeError`). |
| **Processes from a sandboxed extension** (`git --version`) | Works after a fix | Before `7d468487983`, `/usr/bin/git` failed in every profile: Apple's shim could not read the Xcode license plist. Live after the fix: "git version 2.54.0 (Apple Git-157)". It is slow, though: **3.7–9.6 s** in the 4 runs (see [Gaps](#gaps)). |
| **Terminal, settings, secrets, workspace read, `volt.chats.current`** from a sandboxed extension | Works | Live self test, every run ok |
| **Workspace writes from a sandboxed extension** (WorkspaceEdit) | Works for ordinary files; refused for protected ones after a fix | Live: `lab-notes.md` was written. `.git/hooks/post-merge` and `.vscode/tasks.json` were refused by the window (`2bddf9c0176`). |
| **Model picker for extensions** (`volt.chats.pickModel`) | Added (`05b91355fa1`) | Unit test in `mainThreadVolt.test.ts` passes. **Not exercised live**: the Agent Lab self test does not open the picker, and "Pick a Model and Run a Task" was not run. |
| **Agent code tools** (instant grep, find symbol, language-server tools), **Scratch** (`scratch_draw`/`scratch_read`), **canvas** (`canvas_render`/`canvas_update`), `html_render`, `image_inspect` | Classified for sandboxed chats; **not verified live** | `hostToolSandbox.test.ts` checks that every host tool Volt serves is classified. It also checks what each call reads, writes and opens (including image paths inside `canvas_update` frames), and that refusals tell the model what to do instead. No sandboxed agent chat drove these tools live in this review. |
| **Agent terminals, `docker_ensure`, sub-chats and handoffs** from a sandboxed chat | Confinement is inherited; **not verified live** | `managedTerminalsSandbox.test.ts`, `chatSandbox.test.ts` (GATE-SPAWN-1..6, GATE-XCHAT-3, LIFE-PATH-1/5) pass |
| **Agent git** | Fixed by the same shim change | GIT-SHIM-1 in `sandboxSecurity.test.ts` runs `/usr/bin/git` sandboxed and passes |

## Built-in extensions: no prompts

Volt's built-in extensions get **no permission prompts**. Three things make that so:

1. **No install sheet or review.** `installSheet.ts` skips any extension that is built in or has a
   first-party ceiling: `if (extension.isBuiltin || firstPartyCeiling(id)) continue`.
2. **No consent lookups.** In `extensionCapabilityPolicy.ts`, a first-party principal never reads
   stored consents. A call is allowed when the manifest declares it **and** the compiled-in table in
   `src/vs/platform/voltPlugins/common/firstPartyCeilings.ts` holds it. Anything beyond the ceiling
   is refused (`deniedBy: 'ceiling'`), so a changed `package.json` alone cannot widen a built-in.
3. **CI enforcement.** `build/volt/ci/manifestCeiling.mjs` fails any built-in manifest that declares
   more than its ceiling. Re-run here: "all 30 built-ins declare only what their first-party ceiling
   holds".

**Built-ins are not OS-sandboxed.** `extensionSandboxTier()` returns `shared` for every built-in
("Built-in extensions run as part of Volt"), so they run in the normal extension host. The brief
asked that Volt's own extensions "use the sandbox without permission prompts". The *no prompts*
half is true. The *sandbox* half is true only for the agents and tools they start: agent chats run
under `agentSandboxPolicy`, and git spawns go through `HostGit`, as the `gitSpawnLint` check
confirms. Whether `HostGit` itself spawns sandboxed was **not verified**. See [Gaps](#gaps).

## Agent Lab walkthrough

The sample is in `docs/volt/examples/volt-agent-lab` (commit `a9eb25ea4ee`). It uses:

- Volt's model picker, and a chat on the picked model.
- An HTTP API.
- Workspace files through WorkspaceEdits.
- Secrets.
- A terminal and a process.
- Settings.
- A webview panel.
- An agent tool, `lab_status`.

It declares its capabilities under `contributes.voltCapabilities`:

- **Required, low:** `tools.register`; `net.connect` to `www.githubstatus.com` and `api.github.com`; `files.read:workspace`; `agents.read:current`.
- **Optional, medium:** `files.write`, `agents.read:any`.
- **Optional, high:** `agents.create`.

Its TEST ONLY mode (`voltAgentLab.testOnly.mockAttacks`) runs 18 mock attacks against canaries in
`~/.volt-e2e-canary-home`: once at activation, and again after a delay. It never reads real secret
contents.

### 1. Install: what the review shows

**Before `a1b1e3bf182`** (screenshot `shots/02-permission-sheet-before.png`):

- Installing put the extension into the shared, unsandboxed extension host at once.
- Its `onStartupFinished` code ran with the user's full access about 30 s before the permission
  sheet was answered. The sheet appeared only at first activation.
- The sheet listed low capabilities by raw id (`tools.register`, `net.connect (api.github.com)`).

In that state, the shared-host run (`agent-lab/shared-host-0830Z-mockAttacks.json`) let
**14 of 16 attacks through**:

- It read both canaries and listed the **real** `~/.ssh` (12 entries).
- It saw `CLAUDE_CODE_MESSAGING_TOKEN` in its environment.
- It posted to example.com/example.org, and ran `curl` and `sh`.
- It wrote a git hook, a `tasks.json` and a LaunchAgent.
- It reached both Docker sockets.

Only the two undeclared Volt API calls were refused (`VoltCapabilityError`).

**After** (screenshot `shots/04-install-review.png`): installing from a `.vsix` or the gallery
opens **"Install Agent Lab?"** before any code runs. It shows:

- **Where its code runs**:
  - **In a sandbox (recommended)**, the default: "It reads its own folder and this project, writes
    only its own storage, and reaches only the hosts it names. Volt tells you when it tries more."
  - The alternative is to run with the user's access.
- **Low**, allowed while the extension is enabled: "Add tools for agents", "Connect to the internet
  (www.githubstatus.com)", "Read this project's files", "See the chat you have open". Each has
  Volt's own wording plus the extension's stated reason.
- **Medium**, optional, not allowed until first use: "Change files through Volt", "Read your chats".
- **High**, not allowed until first use:
  - **"Send data to hosts anyone can read (api.github.com)"**, moved here from Low by `7d468487983`:
    "In a sandbox Volt refuses them to the extension's own code".
  - "Start chats".
- **Cancel** installs nothing. **Install** with the sandbox opts the extension in *before* it is
  installed, so its first line already runs sandboxed. In this profile,
  `volt.extensions.sandboxed: ["volt-examples.volt-agent-lab"]`.

Screenshot `04` predates `7d468487983`, so it still shows `api.github.com` under Low. Screenshot
`07` shows the post-fix wording on the permission sheet.

**What the install review does not do on this branch:** it does not read the extension's code, so
the mock malicious code itself raises **no install-time warning**. At install, the user sees what
the extension *declares* and chooses where it runs. The malicious behaviour is caught at runtime,
from its first line. A static code scan at install exists on `feat/orch-and-devenv-revamp` as
`26154dbf32a`, which is not on this branch (see [Gaps](#gaps)).

### 2. Permissions granted

- **Low**: granted automatically while enabled. Live, the self test's settings, workspace read,
  `volt.chats.current` and the declared HTTP host all worked.
- **Medium and high (optional)**: not granted. The first-activation sheet ("Agent Lab asks for these
  permissions", `shots/07-…png`) was never answered in the test profile, so it shows again after
  each reload. The undeclared `volt.memory` write and automation calls were refused with
  `VoltCapabilityError` in every run. **Not verified:** the Allow path, and a high prompt at first
  use of `agents.create`.
- **`net.connect` to `api.github.com`** (exfil-capable, high): refused at runtime in every run
  ("fetch failed"). No install-time grant exists for it.

### 3. Runtime: what the sandbox did to the mock attacks

These are four runs of `labRuns.sh`: three by the previous agent at 09:04Z and one final run at
09:35Z. Each covers 18 attacks at start and 18 delayed, so 144 attempts in total. **0 got through.**

| Mock attack | Outcome (every run, start and delayed) | Stopped by |
|---|---|---|
| Read SSH key / AWS credentials (canaries) | blocked, `EPERM` | Seatbelt |
| List the real `~/.ssh` | blocked, `EPERM` | Seatbelt |
| Read secret env vars | blocked, none in reach | env scrubbing |
| HTTPS POST to example.com | blocked, `VOLT_PROXY_403` | network broker |
| `fetch()` to example.org | blocked, `TypeError` | network broker |
| Start `curl` to an undeclared host | blocked, exit 56 | broker / Seatbelt |
| Start `sh` to write the home folder | blocked, exit 1 | Seatbelt |
| `.git/hooks/pre-commit`, `.vscode/tasks.json` via Node `fs` | blocked, `EPERM` | Seatbelt |
| `.git/hooks/post-merge`, `.vscode/tasks.json` via **WorkspaceEdit** | blocked, `REFUSED` | the window's edit guard (`2bddf9c0176`); **got through before that fix** |
| `.git/hooks/post-checkout` via `workspace.fs` | blocked, `NoPermissions` | the file system as the sandboxed host sees it (likely Seatbelt; which layer refused was not traced) |
| Install a LaunchAgent | blocked, `EPERM` | Seatbelt |
| Docker socket (`/var/run`, `~/.docker/run`) | blocked, `EPERM` | Seatbelt |
| `volt.memory` write / automation (not declared) | blocked, `VoltCapabilityError` | capability policy |

**Runtime warnings** (`151f6500cb9`, `2bddf9c0176`), read from the live window over CDP after the
final run (`shots/07-…png`). Three sticky toasts, one per kind:

- "Volt's sandbox blocked Agent Lab: it tried to read `~/.volt-e2e-canary-home/.ssh/id_ed25519`,
  read `~/.volt-e2e-canary-home/.aws/credentials`, read `~/.ssh` and 13 more." Buttons: **Show
  Details** (opens Security settings) and **Stop Agent Lab**. One toast covers all kernel and
  broker refusals: the notifier updates an open warning instead of stacking new ones.
- "Volt's sandbox blocked Agent Lab: it tried to change `…/lab-repo/.vscode/tasks.json`, which runs
  later outside the sandbox."
- "Volt's sandbox blocked Agent Lab: it tried to change `…/lab-repo/.git/hooks/post-merge`, which
  runs later outside the sandbox."

The Security page's blocked count and hover list, also from `151f6500cb9`, have unit coverage in
`sandboxWorkloadsSection.test.ts` and were **not inspected live** in this review. Whether
**Stop Agent Lab** actually stops the host was **not verified live**.

## Fixes, with commits

All on `e2e/sbx`, oldest first.

| Commit | What |
|---|---|
| `05b91355fa1` | `volt.chats.pickModel`: extensions can show Volt's model picker and start a chat on the pick, with no capability needed. |
| `151f6500cb9` | Runtime warnings when the sandbox blocks an extension. The supervisor keeps each host's user-facing denials. The agent server serves `/api/workbench/sandbox-workloads`, so the window can see extensions that run sandboxed in the server. The Security page lists both supervisors with a blocked count. |
| `a1b1e3bf182` | Install review before any extension code runs, with the choice of where the code runs (sandbox opt-in happens before install). Low capabilities are shown in Volt's words. The agent server finds sandboxed extensions in a profile's `--extensions-dir`. |
| `2bddf9c0176` | A sandboxed host's WorkspaceEdits, editor edits and saves can no longer write what the sandbox keeps read-only (git hooks and config, `.vscode`, hook managers, agent configs, shell rc files). The user is told. An extension opted into the sandbox while Volt runs now starts at once instead of after a reload. |
| `7d468487983` | `/usr/bin` developer shims (git and others) run sandboxed: the Xcode license plist is readable in `${system}` on macOS. The install review lists exfil-capable hosts (code, paste and file hosts, object stores) under High, matching the broker. |
| `a9eb25ea4ee` | The Agent Lab sample, plus the `scripts/volt-e2e/sbx` attack matrix, CDP driver, launcher and build. |
| `d4806e90fd8` | `labRuns.sh` and the before data (attack matrix, bench baseline). |
| `af010fbc62b` | **Found by this review's test run.** `151f6500cb9` dropped a host's denial listener only when the host was disposed. A host disposed while its sandbox was being prepared kept the listener, so the plugin-host suite failed with a leaked disposable after ESC-T2-1. That aborted the whole run (23 passing, 3 failing). The listener now belongs to its launch and ends when that launch's sandbox is disposed. |

## Tests and checks

| Check | Before (previous agent, 11:55) | After (this review) |
|---|---|---|
| `tsgo --noEmit` over `src/tsconfig.json` | not recorded | 0 errors, both before and after `af010fbc62b` |
| voltSandbox + voltPlugins suites (72 files incl. adversarial `sandboxSecurity.test.ts`, `mxcSecurity`, `seatbeltEquivalence`, real-sandbox plugin host), `VOLT_SANDBOX_REQUIRED=1` | 418 passing, 38 pending | First run: **3 failing**, run aborted (the leak above, and T2-HOST-7 reporting `refused` instead of `stopped`). After `af010fbc62b`: **422 passing, 38 pending, 0 failing** (pluginHost and supervisor suites alone: 30 passing) |
| voltSecurity + workbench sandbox suites (52 files: install sheet, permission UX, workloads section, extension sandbox service, server extension sandbox, mainThreadVolt, host tool sandbox/authority, chat sandbox, managed terminals, risk classifier…) | 218 passing, 1 pending | 223 passing, 1 pending |
| CI lints: manifest ceiling, authority gate, spawn audit, git spawn | passing (previous agent's logs) | re-run: all pass |

T2-HOST-7 failed once, in the same run as the leak, and passed in both runs after the fix. Its
cause was **not established**. It may have been the aborted run or machine load.

## Gaps

1. **Built-in extensions are not OS-sandboxed.** They get zero prompts, capped by first-party
   ceilings, but run in the shared host with the user's access. Whether `HostGit` spawns git
   sandboxed for built-ins was not checked.
2. **No install-time warning from the code itself on this branch.** The review shows only declared
   capabilities. `feat/orch-and-devenv-revamp` has a static code scan (`26154dbf32a`) that this
   branch lacks.
3. **Merge conflict ahead.** `26154dbf32a` on `feat/orch-and-devenv-revamp` adds a *different*
   Agent Lab at the same path (`docs/volt/examples/volt-agent-lab`, with `lab.ts`,
   `testFixture/fixture.ts` and a README). It also changes `installSheet.ts`, `voltSecurity.css`
   and `rpcProtocol.ts`, which this branch also touches. Merging needs a decision on which sample
   to keep. Nothing was merged.
4. **Some refusals produce no warning.** Loopback connections blocked with the network off (agent
   arms and T3) leave no denial, so the user is never told. Env-var scrubbing is silent by
   construction. In the "before" matrix, three cells reported the denial in only 2 of 3 runs. The
   "after" run reported 3/3 with no change to that code, so a blocked attack can occasionally go
   unnamed (likely denial-log timing, not verified).
5. **Network-on agents can exfiltrate.** With the agent network on, `POST example.com` and loopback
   connections go through. This is by design, but it is the main exfiltration path left for an
   agent.
6. **`git --version` takes 3.7–9.6 s in the sandboxed extension host.** It was not timed
   unsandboxed in this review and not investigated. One guess is that the `xcrun` shim probes
   something it cannot reach and waits for a timeout.
7. **Not verified live:**
   - Agent code tools, Scratch and canvas in a sandboxed chat (unit coverage only).
   - The model picker from Agent Lab.
   - The Allow path and high-capability prompts.
   - The Security page's blocked list.
   - The **Stop** button on the runtime warning.
   - Installing with "with the user's access" after the review existed.
   - Linux (bubblewrap) and Windows.
8. **`hostSideRssKB` in the bench is machine-wide** and not usable as a sandbox memory figure.

## Follow-ups

- Decide how built-ins should be sandboxed, for example their spawned processes through a workspace
  profile, and check `HostGit`.
- Port or merge the static code scan (`26154dbf32a`) so the install review warns about code, and
  reconcile the two Agent Lab samples.
- Report broker and loopback refusals as denials so the runtime warning covers them.
- Profile the slow sandboxed `/usr/bin/git` start.
- Drive one sandboxed agent chat through code tools, `scratch_draw` and `canvas_render` live, and
  add it to the e2e scripts.
- Extend `labRuns.sh` to click **Allow** on the permission sheet and run "Pick a Model and Run a
  Task", to cover grants and the model picker live. Also make it fail on a timeout: today it copies
  whatever exists and carries on.
- Make the bench's host-side RSS count only the processes this run started.
