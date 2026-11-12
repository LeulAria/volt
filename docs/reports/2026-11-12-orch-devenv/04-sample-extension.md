# 04: Sample extension (Agent Lab): permissions at install, misbehavior at runtime

Status: done. Depends on `e2e/sbx` for the install review before install, the low-capability copy, two-line
sheet rows and the server finding the desktop's extensions; merge both together (overlaps listed below).

## Summary

- **Sample**: `docs/volt/examples/volt-agent-lab/` ("Agent Lab") scouts a project's npm dependencies on
  its one declared host, serves an agent tool, picks an agent and model through `vscode.volt`, starts or
  messages a chat, draws on Scratch, saves a memory note and opens npm pages in Volt's browser. 9 declared
  capabilities (4 low, 2 medium, 3 high), each with a reason. A separate test build (`--fixture`) adds 8
  harmless misbehavior switches. Live: install from `.vsix`, sheet, Allow, 2 consent dialogs and the whole
  feature worked end to end.
- **Before**: in the default shared host 5 of the 7 switches run live got through (`delayed` was not run
  live: it replays readCanary, exfiltrate and spawnShell on a timer) (canary read and posted 3 times to
  an undeclared server, shell ran, `~/.aws/credentials`, `~/.npmrc`, Volt's own grants readable), with
  **no warning at install or at runtime**; Volt's API refused the undeclared calls but the extension got
  `capability`/`deniedBy` = `undefined`, and an update that added the malicious code did not re-show the sheet.
- **After**: an install-time code scan (10 rules, 2 severities) flags the test build with 6 high and 8
  medium findings on the permission sheet (with "Run in a Sandbox"), the published build with 0, and 0
  high findings across 92 real extensions on this machine (gitlens, remote-ssh, Prisma, Java/Azure packs).
  An update that adds hidden code re-shows the sheet. Undeclared/critical `vscode.volt` calls now warn the
  user ("Volt blocked Agent Lab: it tried to use ..."), and refusals reach the extension with their fields.
- **Sandbox (OS level)**: under the T3 extension-host policy on Seatbelt, every OS misbehavior is blocked
  (EXT-LAB-OS, 5/5): canary/credentials unreadable, 0 requests at the exfil server (direct and through
  the proxy), secret env vars absent, no writes outside its storage, network denials reported.
- **Tests**: 30 new tests in 6 files; the related suites run together: 113 passing, 0 failing; tsgo 0 errors.

## Setup

- Branch `feat/orch-and-devenv-revamp`, dev build from `out/` (shared checkout).
- Test instance (window title "... al-ws", CDP 9973): `./scripts/code.sh --user-data-dir /tmp/al-ud
  --extensions-dir /tmp/al-ext --remote-debugging-port=9973 ... /tmp/al-ws` (window closed after use).
- `.vsix` install: `./scripts/code-cli.sh --user-data-dir /tmp/al-ud --extensions-dir /tmp/al-ext
  --install-extension docs/volt/examples/volt-agent-lab/dist/volt-agent-lab-0.1.0.vsix`.
- Exfil target: a local Node server on 127.0.0.1:47913 logging every request; canary
  `~/.ssh/volt-agent-lab-canary` ("VOLT-CANARY-<ts> not a real key"), removed after the run.

## Results (live, before any fix)

### Benign build, install and permissions

| Step | Result |
|---|---|
| `--install-extension …/volt-agent-lab-0.1.0.vsix` | installed; the sheet "Agent Lab asks for these permissions" opened at first activation |
| Sheet content | 4 low, 2 medium, 3 high, each with the extension's reason |
| Allow (real CDP click) | 2 persistent grants (`agents.read:any`, `agents.send`) written to the grant store |
| Scout Dependencies (6 deps on registry.npmjs.org) | 5 of 6 behind, report stored |
| Hand off: model list via `invokeTool('list_models')` | 30+ models listed, Haiku 5.5 picked |
| `chats.start` (high, consent dialog → Allow) | chat "Upgrade 5 dependencies" started, "Started by Agent Lab (external)" |
| `memory.write` (high, consent dialog → Allow) | note in `/tmp/al-ws/.volt/memory/agent-lab-al-ws.md` |
| `drawOnScratch` | the plan as a mermaid diagram on the Scratch tab |

Pixel issues on the sheet (`/tmp/al-sheet-before.png`): the four low capabilities showed raw ids
("tools.register", "net.connect (registry.npmjs.org)") with "A Volt capability of the extension API."
as text, and every reason was cut off with an ellipsis after ~50 characters, so the extension's claim
could not be read. Both are fixed on `e2e/sbx` (a1b1e3bf182: low-capability copy, two-line rows), so I
did not fix them again here.

### Test build in the default (shared) extension host: the "before"

| Switch | Outcome | Evidence |
|---|---|---|
| readCanary | **got through** | read 63 bytes of `~/.ssh/volt-agent-lab-canary` |
| exfiltrate | **got through** | the exfil server logged the POST with the canary text |
| spawnShell | **got through** | `cat` printed the canary, `curl` posted it (HTTP 200), `id -un` = leularia |
| readSecrets | **got through** | `~/.aws/credentials` (135 B), `~/.npmrc` (74 B) and Volt's own `~/.volt/trust/grants.json` readable; `CLAUDE_CODE_MESSAGING_TOKEN` visible |
| undeclaredApi | blocked (3 of 4) | `automations.schedule`, `usage.get`, `browser.readPage` refused; but the error said `capability: undefined, deniedBy: undefined` |
| undeclaredApi: `registerTool('memory_write')` | blocked, silently | the refusal is only logged in the extension host; `registerTool` returns a disposable as if it worked |
| criticalApi | blocked | `terminal_start`, `manage_automations create` refused (fields undefined, as above) |
| obfuscated | **got through** | `eval` via `globalThis[['ev','al'].join('')]`, `process.getBuiltinModule` reached through `new Function`, base64 host: canary posted (third request) |

No warning at install (the update that added the fixture code did not even re-show the sheet: its key
covers only the declared capabilities) and none at runtime: the user saw nothing.

### Opting the extension into the sandbox (live)

`volt.extensions.sandboxed: ["volt-examples.volt-agent-lab"]`, reload:

- With the brief's recipe (`--extensions-dir /tmp/al-ext`) the agent server could not find the
  extension: `volt-sandbox:unknown: … is not installed where Volt's server runs extensions` (it looks
  only in `~/.vscode-oss-dev/extensions`). The extension stays off with a sticky warning. Fixed on
  `e2e/sbx` ("the server finds the desktop's extensions").
- With an isolated `HOME` for the server, the sandboxed host started (`seatbelt, network=proxy`), and
  its first `require` of the extension's code failed with `EPERM` because the window had told it the
  extension lives in another folder than the one the server allowed: the sandbox did block a read
  outside its folder, and the extension failed to activate with nothing shown to the user.
- The dev agent server restarted twice during the run (other agents rebuilt `out/`), replacing the
  isolated server, and installing the fixture into the shared `~/.vscode-oss-dev/extensions` would have
  put it into other agents' windows. I stopped the live sandbox run there and moved the OS-level check
  into an automated test that runs the fixture's behaviors under the exact T3 policy on the real
  Seatbelt backend (EXT-LAB-OS below).

## Results after the changes

### Install time (live, test build installed as an update over the benign one)

| | Before | After |
|---|---|---|
| Sheet re-shown for the update that adds the fixture code | no (key = declared capabilities only) | yes (key also covers the digest of high findings) |
| What the sheet says about the code | nothing | "Found in its code: It runs with your access. Volt's sandbox would block what it is not allowed." then 8 lines, the 3 high ones in the list warning color (`/tmp/al-sheet-scan3.png`, light: `/tmp/al-sheet-scan-light.png`) |
| Sandbox offered | no | footer "Run in a Sandbox" (opts in, becomes "Sandbox On After Reload", sheet stays for the permissions) |
| Extension without Volt capabilities but with hidden code | never a sheet | the sheet, with the findings only |

Findings on the test build (`out/testFixture/fixture.js`, scanned in 7-14 ms):

| Severity | Rule | Evidence |
|---|---|---|
| high | hidden-name | `eval`, `child_process` (built with `[...].join`) |
| high | encoded-payload | a network address: `127.0.0.1` (base64) |
| high | undeclared-api | `volt.automations.schedule` needs `automations.schedule`, `volt.usage` needs `usage.report`, `volt.browser.readPage` needs `browser.read` |
| medium | raw-host, credential-path, dynamic-code, process-spawn, env-harvest | `http://127.0.0.1`, `~/.ssh/volt-agent-lab-canary`, `.aws`, `.npmrc`, `.volt/trust/grants.json`, `new Function`, `child_process`, `Object.keys(process.env)` |

False positives, measured on every extension installed on this machine (read-only scan, Node, one thread):

| Set | Extensions with code | High findings | Medium only | Clean | Time |
|---|---|---|---|---|---|
| `~/.vscode/extensions` | 64 | **0** | 50 | 14 | 22.8-39 s total, max 2.7 s (19 MB) |
| `~/.cursor/extensions` | 28 | **0** | 27 | 1 | 26.5 s total |
| Agent Lab published build | 1 | 0 | 0 | 1 | 7 ms |
| Agent Lab test build | 1 | 6 | 8 | - | 10 ms |

The first calibration had 5 rules at high and flagged 50 of 64 real extensions; `credential-path` (gitlens
names `~/.ssh/id_ed25519.pub` for commit signing, the spell checker has `id_rsa` in a word list),
`dynamic-code` (d3, ajv), `native-binding` and the network broker's exfil list (api.github.com, S3, Azure
blobs) moved to medium or out; `raw-host` high is now only request catchers, paste sites, chat webhooks
and tunnels. Medium findings are listed on a sheet that is shown anyway, never a reason for one.

### Runtime (live, shared host, switches `undeclaredApi` + `criticalApi`)

| | Before | After |
|---|---|---|
| Extension sees the refusal | `Volt refused undefined (undefined)` | `Volt refused automations.schedule (manifest)`, `... spawn.unsandboxed (critical)` |
| User is told | nothing | one sticky warning: "Volt blocked Agent Lab: it tried to use automations.schedule, usage.report, browser.read and 3 more, which it never declared or Volt never gives an extension." [Show Details] [Run in a Sandbox] [Show Extension] (`/tmp/al-watch-toast.png`); later refusals update it |
| Log | exthost only | renderer: `[volt extension watch] refused volt-examples.volt-agent-lab tools.invoke spawn.unsandboxed on manage_automations (critical): ...` per call |

### OS level under the extension-host sandbox (automated, real Seatbelt)

`VOLT_SANDBOX_REQUIRED=1 ./scripts/test.sh --run src/vs/platform/voltPlugins/test/node/agentLabSandbox.test.ts`

| Test | Switch | Result |
|---|---|---|
| EXT-LAB-OS-1 | positive control | its own folder, the trusted workspace and its storage work |
| EXT-LAB-OS-2 | readCanary, readSecrets | canary, `~/.aws/credentials`, `~/.npmrc`, `~/.volt/trust/grants.json`: unreadable |
| EXT-LAB-OS-3 | readSecrets (env) | `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `NPM_TOKEN` never reach it |
| EXT-LAB-OS-4 | exfiltrate, spawnShell, obfuscated | 0 requests at the exfil server (direct socket, shell `curl`, proxied `webhook.site`); network denials reported |
| EXT-LAB-OS-5 | persistence | no write to `~/.zshrc`, Volt's grants or the workspace |

## Fixes made

| File | What | Why |
|---|---|---|
| `src/vs/platform/voltPlugins/common/extensionCodeScan.ts` (new) | Install-time code scan: a small lexer (comments, strings with `\x`/`\u` unescaping, template literals, regex literals) and 10 rules; folder walk with limits (1500 files, 24 MB, 6 MB a file, depth 12); merged findings; digest | No static signal existed: an extension could read `~/.ssh` and post to a raw IP with no warning |
| `src/vs/workbench/services/extensions/browser/voltExtensionCodeScan.ts` (new) | `IVoltExtensionCodeScanService` (scans a third-party extension's folder once per version through the file service, no symlinks, yields between files, cached in application storage); `VoltExtensionWatchContribution` (warns on a third party's `manifest`/`critical`/`catalog` refusals, once per extension and capability, updated as more come) | Install-time and runtime warnings |
| `src/vs/workbench/contrib/voltSecurity/browser/installSheet.ts` | Findings rows ("Found in its code") before the capabilities, high ones marked; "Run in a Sandbox" in the footer while it runs with the user's access; the sheet also for extensions with high findings and no Volt capabilities; its key includes the high findings' digest | Show the warning where the user decides; an update adding hidden code asks again |
| `src/vs/workbench/contrib/voltSecurity/browser/media/voltSecurity.css` | `.volt-install-sheet-capability.high .title` in `--vscode-list-warningForeground` (no stripe) | Readable in light and dark |
| `src/vs/workbench/services/extensions/common/rpcProtocol.ts` (outside the listed scope, 4 lines) | Keep a serialized error's `code` when rebuilding it | Every `VoltCapabilityError` reached extensions without `capability`, `target`, `deniedBy` (the documented contract) |
| `docs/volt/examples/volt-agent-lab/**` (new) | The sample, its README (feature, capabilities, the test-only switches, a test server), `build.mjs` (published or `--fixture` build, packs a `.vsix` with `zip`), two tsconfigs | The deliverable |

Changes I made to the sample after live testing: the project falls back to the chat in front's project
(the agent window opened no workspace folder), `chats.start` gets `project`, the chat id is parsed from
`thread_launch`'s "(id ...)", the obfuscated switch uses `process.getBuiltinModule` (no `require` in a
`Function` body), quick-pick labels no longer repeat "the chat in front".

### Tests added

| File | Tests |
|---|---|
| `src/vs/platform/voltPlugins/test/common/extensionCodeScan.test.ts` | EXT-SCAN-1..12: clean code, each rule, false-positive guards, lexer edge cases, merging, digest, folder walk |
| `src/vs/platform/voltPlugins/test/node/agentLabSandbox.test.ts` | EXT-LAB-OS-1..5 (above) |
| `src/vs/workbench/services/extensions/test/browser/voltExtensionCodeScan.test.ts` | EXT-SCAN-SVC-1..3 (folder scan, per-version cache across windows, built-ins skipped), EXT-WATCH-1..3 (warn once and update, consent/built-in/unknown ignored, no sandbox offer when sandboxed) |
| `src/vs/workbench/services/extensions/test/common/voltExtensionRefusals.test.ts` | EXT-REFUSE-RPC-1: a refusal crosses RPC with its fields |
| `src/vs/workbench/services/extensions/test/node/voltExtensionAgentLab.test.ts` | EXT-LAB-1..3: manifest validates; both builds type-check; published build scans clean, test build flagged per misbehavior |
| `src/vs/workbench/contrib/voltSecurity/test/browser/installSheetCodeScan.test.ts` | UX-SHEET-LAB-1..3: the sample's 9 capabilities by class with reasons, Allow grants the 2 medium ones; findings rows, Run in a Sandbox |

Verification commands: `npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck` (0 errors);
`npx eslint` on every changed file (0 problems); one run of the 13 related suites (extensionCodeScan,
pluginProtocol, agentLabSandbox, pluginHost, rpcProtocol, voltExtensionRefusals,
voltExtensionSandboxService, voltExtensionCodeScan, voltExtensionAgentLab, installSheetCodeScan,
permissionUx, mainThreadVolt, voltExtensionApi): **113 passing, 0 failing**.

## Overlap with `e2e/sbx` (merge both together)

- `installSheet.ts`: both change `SheetRow`, the renderers, `IInstallSheetRequest`, the footer and the
  contribution's constructor and `check()`. After the merge, `e2e/sbx`'s pre-install review stores
  `installReviewKey(id, groups)`, which `check()` uses to skip the first-activation sheet; that skip must
  not apply when the scan has high findings and the extension is not sandboxed, or the findings are never
  shown for UI installs. The review runs before the files exist (only the manifest), so the scan can only
  run after install.
- `voltSecurity.css`: both append rules at the end of the install-sheet block.
- `installSheet.ts` is what imports `voltExtensionCodeScan.ts` (and so registers the service and the
  watch contribution); keep that import.
- `e2e/sbx` adds `volt.chats.pickModel`; the sample uses `invokeTool('list_models')` + a quick pick because
  that API is not on this branch. Switch to `pickModel` after the merge.

## Bugs found and not fixed (outside scope)

1. **A `network` tool can't be declared with host-scoped `net.connect`.** `voltApi.ts` `tools.register`
   checks the class's capability with the tool's name as the target, so `net.connect` declared for
   `registry.npmjs.org` refuses the registration (`undeclared-target`); only an unscoped `net.connect`
   works, and that gives a sandboxed host no allowed host. The sample's tool is class `reads` for this
   reason (its network call happens in a command).
2. **`registerTool` refusals are silent to the extension**: `extHostVolt.ts` logs the refusal and still
   returns a disposable (the fixture's `registerTool('memory_write')` reports "allowed"). The user is now
   warned; the extension still can't tell.
3. **Test instances write the real grant store** `~/.volt/trust/grants.json` (not per user-data-dir). My
   run created it with 5 test grants for `volt-examples.volt-agent-lab`; I removed the file (it held only
   those).
4. **A sandboxed extension that fails to activate shows nothing**: the T3 host's `EPERM` on its own code
   (window and server disagreeing on the extension's folder) only reached the sandboxed host's log.
5. **`code.sh <folder>` opened the agent window with no workspace folder** on a fresh profile; the folder
   arrived only with `--reuse-window`. And `chats.start` needs a Volt project (a workspace folder is not
   one until picked in the project picker).
6. The dev agent server restarts whenever `out/` changes (other agents compiling), which killed the
   sandboxed host mid-test twice.

## Open issues

- **Medium-only code is quiet by design**: an extension that declares no Volt capability and plainly
  reads `~/.ssh/id_rsa` and posts to `http://1.2.3.4` gets no sheet (both rules are medium because
  gitlens/remote-ssh-style extensions trip them). Only the sandbox stops it. A combination rule (a
  credential path and a raw address in the same file) would need its own calibration run.
- The scan runs in the renderer: once per extension version, up to 2.7 s of work for a 19 MB extension
  (yielding between files, but one 5 MB bundle blocks ~0.5 s). Moving it to the shared process or the
  agent server would remove that.
- "Show Details" on the runtime warning opens `dialogService.info`, which is a native sheet on macOS: its
  content is not visible to CDP and was not screenshotted; it closed with the test window.
- The runtime warning names capability ids (`automations.schedule`), not Volt's words; the copy lives in
  `contrib/voltCustomize` (`voltCapabilityCopy`), which the services layer can't import.
- The live run of the test build inside the sandboxed host (as opposed to the T3 policy test) is still to
  do once `e2e/sbx` is merged (it fixes the extension-folder mismatch); the expected result is what
  EXT-LAB-OS shows plus `sandboxDenialNotifier`'s warning.

## Changed files

New: `docs/volt/examples/volt-agent-lab/{package.json,README.md,build.mjs,tsconfig.json,tsconfig.fixture.json,.gitignore,src/extension.ts,src/lab.ts,src/testFixture/fixture.ts}`,
`src/vs/platform/voltPlugins/common/extensionCodeScan.ts`,
`src/vs/platform/voltPlugins/test/common/extensionCodeScan.test.ts`,
`src/vs/platform/voltPlugins/test/node/agentLabSandbox.test.ts`,
`src/vs/workbench/services/extensions/browser/voltExtensionCodeScan.ts`,
`src/vs/workbench/services/extensions/test/browser/voltExtensionCodeScan.test.ts`,
`src/vs/workbench/services/extensions/test/common/voltExtensionRefusals.test.ts`,
`src/vs/workbench/services/extensions/test/node/voltExtensionAgentLab.test.ts`,
`src/vs/workbench/contrib/voltSecurity/test/browser/installSheetCodeScan.test.ts`, this report.

Modified: `src/vs/workbench/contrib/voltSecurity/browser/installSheet.ts`,
`src/vs/workbench/contrib/voltSecurity/browser/media/voltSecurity.css`,
`src/vs/workbench/services/extensions/common/rpcProtocol.ts`. Nothing under `src/vs/platform/voltSandbox/`.

Cleanup: test window (CDP 9973, title "... al-ws") and its agent server stopped; launchd job
`com.volt.agent-server.913084f8f4a0` (my `/tmp/al-ud`) removed; canary `~/.ssh/volt-agent-lab-canary`,
the exfil server and `/tmp/al-home` removed. Screenshots: `/tmp/al-sheet-before.png`,
`/tmp/al-benign-handoff.png`, `/tmp/al-sheet-scan3.png`, `/tmp/al-sheet-scan-light.png`, `/tmp/al-watch-toast.png`.
