I'll start by finding every `defineCommand` call and every import of the kernel.
The registry is clear. Next I need the enqueue path and the web callers that issue these commands.
Two web call sites surfaced. I'll check how `useCommand` is used and whether the rate-restriction UI goes through the command path or the legacy RPC.
The room-status UI calls the oRPC `rooms.setStatus` route, not the command, so I need to confirm that and pin down exact line numbers.
There are two business commands implement `CommandDefinition` in production: `rooms.setStatus` and `rateRestrictions.set`. Only one of them has a web UI that issues it through the command path.

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`)
- **Type:** `"rooms.setStatus"` (rooms.ts:31)
- **Definition:** `setRoomStatus = defineCommand({...})` at rooms.ts:30
- **load:** rooms.ts:35
- **decide:** rooms.ts:43
- **audit:** rooms.ts:112
- **Registered:** `packages/domain/src/commands/registry.ts:10` in `COMMANDS`, which is also exported via `commands/index.ts:4`
- **Web UI:** none through the command path. `apps/web/src/features/room-status/components/RoomLifecyclePanel.tsx:94` calls `orpc.rooms.setStatus`, the server RPC handler at `packages/api/src/routers/rooms/index.ts:1124`, not the domain command. The `"rooms.setStatus"` string in `apps/web/src/sync/SyncProvider.tsx:108` is only a label.

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`)
- **Type:** `"rateRestrictions.set"` (rates.ts:122)
- **Definition:** `setRateRestrictions = defineCommand({...})` at rates.ts:121
- **load:** rates.ts:126
- **decide:** rates.ts:143
- **audit:** rates.ts:147
- **Registered:** `registry.ts:11` in `COMMANDS`
- **Web UI:** `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129`, which calls `runCommand(setRateRestrictions, variables)` via `useCommand()` (`apps/web/src/sync/useCommand.ts:16`). This runs the command locally against PowerSync and queues it for upload.

**Server execution:** `apps/api/src/sync/commands.ts:233` and `:285` call `commandFor(type)` on uploaded `sync_commands` rows, so the server runs both commands authoritatively. `kernel.test.ts` also defines a test-only command at line 40, which isn't counted here.
