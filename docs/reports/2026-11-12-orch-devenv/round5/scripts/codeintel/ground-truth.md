# Ground truth: openclaw fixture (round 5, codeintel)

Fixture: `~/.volt-r5/codeintel/fx/openclaw`, a clone of openclaw at `d2a729374` plus one commit removing the
root `AGENTS.md` and `CLAUDE.md` (4,217 TypeScript files, 1,362 tests, no `node_modules`). Found with `git grep`,
reading, and for t2/t5 the code index's importers and structural search, checked line by line. `grade.mjs`
applies these.

| Task | Ground truth | Right (1) / partly (0.5) |
|---|---|---|
| t1 impact of a new parameter on `resolveThreadSessionKeys` | Callers of the `src/routing/session-key.ts` function: `src/discord/monitor/message-handler.process.ts:274`, `src/infra/outbound/outbound-session.ts:232/274/583`, `src/slack/monitor/message-handler/prepare.ts:205`, `src/telegram/bot-handlers.ts:227`, `src/telegram/bot-message-context.ts:196`, `src/telegram/bot-native-commands.ts:546`; test `src/slack/monitor/message-handler/prepare.test.ts:334`. Trap: `extensions/mattermost/src/mattermost/monitor.ts:506` calls the extension's own `resolveThreadSessionKeys` (`monitor-helpers.ts:78`) and is not affected. | all 7 files and mattermost not listed as affected / at least 5 |
| t2 non-test importers of `src/logger.ts` | 25 files (`gt-t2.txt`, from the import statements resolved to `src/logger.ts`; 2 more are tests, and 3 tests only `vi.mock` it). | count 25 and 24+ files / 20+ files |
| t3 direct callers of `sanitizeAgentId` | `pickFirstExistingAgentId` (`src/routing/resolve-route.ts:118`, 4 calls 121-132), `normalizeCronJobInput` (`src/cron/normalize.ts:288`, call 305), `registerCronAddCommand` (`src/cli/cron-cli/register.cron-add.ts:61`, call 158), `registerCronEditCommand` (`register.cron-edit.ts:25`, call 131). `resolveAgentRoute` (`resolve-route.ts:295`) reaches it through `pickFirstExistingAgentId` (310). | 4 callers and the chain / 3 and the chain, or 4 |
| t4 `resolveHeartbeatIntervalMs` | Order: `overrideEvery`, `heartbeat.every`, `cfg.agents.defaults.heartbeat.every`, `DEFAULT_HEARTBEAT_EVERY`. Null when: no value, the trimmed value is empty, `parseDurationMs` throws, `ms <= 0`. | order and 4 cases / order and 3, or 4 |
| t5 `setTimeout` with a literal delay of 1000 ms or more, non-test `src/` | `acp/client.ts:170` 30_000, `agents/sandbox/browser.ts:34` 1000, `auto-reply/reply/export-html/template.js:1269` 1500, `browser/extension-relay.ts:270` 30_000, `commands/doctor-config-flow.ts:331` 4000, `hooks/gmail-ops.ts:345` 2000, `hooks/gmail-watcher.ts:112` 5000 and `:221` 3000, `infra/ssh-tunnel.ts:173` 1500, `infra/tailscale.ts:39` 3000. Six of the ten span several lines (a line grep for `setTimeout(..., 1000)` finds none of those). | 9+ / 6+ |
| t6 implementations of `MemorySearchManager` | `MemoryIndexManager` (`src/memory/manager.ts:42`), `QmdMemoryManager` (`src/memory/qmd-manager.ts:74`), `FallbackMemoryManager` (`src/memory/search-manager.ts:75`). | 3 / 2 |
| t7 rename `buildGroupHistoryKey` | 2 files: the declaration (`session-key.ts:236`) and `src/web/auto-reply/monitor/on-message.ts` (import 6, call 78). | both files, old name gone / some renamed |
| t8 `sanitizeAgentId(value, fallback)` | Signature and both `DEFAULT_AGENT_ID` returns use `fallback`; 7 call sites pass `DEFAULT_AGENT_ID` (resolve-route 4, normalize 1, cron-add 1, cron-edit 1), in 4 files, with imports (5 files changed with the declaration's). | all / definition and 5+ sites |
