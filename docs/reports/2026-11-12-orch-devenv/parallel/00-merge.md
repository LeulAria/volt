# 00 · Merging the open PRs into feat/orch-and-devenv-revamp

## Summary

| PR | Branch | State before | Result |
|---|---|---|---|
| main | `main` (dfdcff7e3ef) | already merged | no change |
| #93 | `feat/agent-dev-environment` | already merged | no change |
| #94 | `feat/orchestra` | already merged (415e80f71a0) | no change |
| #92 | `feat/volt-sandbox` (189 commits) | merge stopped with 12 conflicted files | merged as `5f6e819dc98` |
| #95 | `cursor/supervised-default-access-98bd` | not merged | merged as `e33c552f2fc`, no conflicts |
| #81 | `fix/settings-skill-navigation` | draft | skipped, as asked |

After both merges: `tsgo` type-check 0 errors, the full unit suite 15 794 passing with the 7 failures
the merge caused all fixed (re-run green), and all of Volt's CI lints green (feature imports, authority
gate, git spawns, listeners, manifest ceilings, spawn audit, command visibility, and their own tests).

## Why #92 conflicted

#92 replaces the sandbox core. This branch had hardened the *old* core (one `ISandboxPlan` turned into
one allow-default Seatbelt profile). #92 brings resolved policies, per-OS backends (Seatbelt,
bubblewrap, MXC), the Policy Authority, an attested launch protocol and allow-list environments. So
for every conflict the rule was: **take #92's design, then carry over each piece of this branch's
hardening that the new design does not already cover.**

| Conflict | Kept from #92 | Carried over from this branch | Dropped (why) |
|---|---|---|---|
| `seatbelt.ts` | whole new profile builder | — | the container-socket deny block: the new profiles deny every unix socket unless granted |
| `sandboxPolicy.ts` | allow-list footprints, `agentSandboxPolicy` | `strongerSandboxLevel` | `scrubSandboxEnv`/`isSecretEnvName` copy (the new env is an allow list, and `sandboxProfiles.isSecretEnvName` is stricter); `denyUnixSockets`; later also `attenuateSandbox`/`chatSandboxRequest` (unused once callers moved to `chatExec`) |
| `sandboxLauncher.ts` | new launcher | — | the old plan path |
| `sandboxProxy.ts` | DNS-checked destinations, auth, idle and header timeouts | **20 s connect timeout → 504** (`PROXY_CONNECT_TIMEOUT_MS`) | — |
| `voltStdio*.ts` | ExecContext, refusals, build-entry guard, launch protocol | `execFile` with a sandbox, rewritten on the attested launch protocol (`execFileSandboxed`) | `baseEnv`/`prepareSandbox` (the launch's env is complete) |
| `codeIntelligence.contribution.ts` | the feature became a fenced module (`contrib/voltCodeIntelligence`) | code_nav / diagnostics / code_action host tools → new `contrib/voltAgent/browser/ide/languageServerHostTools.ts`; call/type hierarchy → `ide/codeIntelHierarchy.ts` | — |
| `registry.ts` | `exec` context for shell/git tools | `writeComputedEdit` for language-server edits, `createIdeTools` | — |
| `voltSettingsEditor.ts` | Access page, devices as a module | Orchestration page | the old `DevicesPage` import |
| `agentEditor.contribution.ts` | `voltAgentWindowService` | profiler, hierarchy, language-server tools | `gitGraph.contribution` import (#92 moved Git Graph to a module) |
| `agentOrchestratorService.test.ts` | its subagent-confinement test | the verify-rounds test | the duplicate sandbox test and the duplicate fake-runtime members |

## Problems the merge exposed (and fixes)

1. **Duplicate subagent confinement.** Both branches confined a subagent to its parent's sandbox
   (`confineChatSandbox` every turn from #92, `inheritSandbox` from here). The second pass now only
   applies the `volt.agent.multitask.sandbox: confine` setting (`confineSubagent`).
2. **Processes started without an ExecContext** (type errors after the merge, refusals at runtime):
   the IDE capability CLI, delegate_task verify commands, the Test Explorer runner and `watch_job`
   checks. Each now says who it runs for: the IDE CLI and verify commands run as the chat in its
   sandbox (`chatExec`), the Test Explorer as the user (`userExec`).
3. **`watch_job` checks ran agent-written commands outside the chat's sandbox.** They now run as the
   chat, inside its sandbox (`agentJobWaits.check`).
4. **The IDE git capability spawned git directly** (git-spawn lint). New `IdeCli.git`: HostGit
   (`runGitThrough`) for unsandboxed chats; for sandboxed chats git runs inside the chat's sandbox with
   HostGit's guards (no fsmonitor, hooks or `ext::`), as the native git tools do.
5. **code_nav / diagnostics / code_action were unclassified** for the sandbox gate, so a sandboxed chat
   would have been refused (and the gate's completeness test failed). Classified: code_nav and
   diagnostics `reads` (path, or the workspace), code_action `writes` (its path; `fixes` only reads;
   `rename` writes every file that uses the symbol → `escapes`). The legacy shadow rules refuse
   `writes` for read-only chats, so the Authority and the shadow agree (SHADOW-1).
6. **Feature fence.** Putting the language-server tools inside the Code Intelligence module broke the
   feature-import fence (6 core imports). They live in core (`voltAgent/browser/ide`) instead.
7. **Command visibility.** 11 commands added on this branch (HTTP client, Profiler, IDE activity tab,
   machine capacity) had no `visibility`; all `internal`.
8. **New dependency.** #92 needs `ses@2.3.0` (plugin host); copied into `node_modules` from a temp
   install (a normal `npm install` will add it from package.json).

## Tests run

- `npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck`: 0 errors.
- Full `./scripts/test.sh` run: 15 794 passing, 213 pending, 7 failing → all 7 fixed:
  sandbox policy (agent state now goes to an overlay, not in place), workspace surfaces (`http`),
  Code Intelligence module (×3, tools moved out), host-tool classes, SHADOW-1. Re-run of those files:
  68 passing, 0 failing.
- `accessModes.test.ts` after #95: 3 passing.
- `build/volt/ci/*`: all lints and their own tests pass.
