Two business commands implement `CommandDefinition`. Both are registered in `COMMANDS` (`packages/domain/src/commands/registry.ts:9-12`). `memory.ts` is a test store, not a command.

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`)
- **Type:** `"rooms.setStatus"`, line 31. Payload schema at lines 14-23. Permission `{ resource: "rooms", action: "update" }` at line 33.
- **load:** lines 35-41.
- **decide:** lines 43-110.
- **audit:** lines 112-125 (returns `null` when the status is unchanged).
- **Registration:** `registry.ts:10`.
- **Web UI:** none issues this command. `apps/web/src/sync/SyncProvider.tsx:108` only maps its label ("Room status change"). The room lifecycle panel calls a different, server-only oRPC endpoint, `orpc.rooms.setStatus` (`apps/web/src/features/room-status/components/RoomLifecyclePanel.tsx:94`).

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`)
- **Type:** `"rateRestrictions.set"`, line 122. Payload schema at lines 17-46. Permission `{ resource: "revenue", action: "update" }` at line 124.
- **load:** lines 126-141.
- **decide:** lines 143-145, which delegates to `paintWrites` (lines 62-112).
- **audit:** lines 147-163.
- **Registration:** `registry.ts:11`.
- **Web UI:** `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129` calls `runCommand(setRateRestrictions, …)` through the `useCommand` hook (`apps/web/src/sync/useCommand.ts:25`).

**Execution path (both commands):**
- Device: `packages/sync/src/commands.ts:108` runs `runCommand`.
- Server: `apps/api/src/sync/commands.ts:233` looks the command up with `commandFor`, `:301` runs `runCommand`, and `:317` writes the audit entry.

The e2e specs call `rateRestrictions.set` over the separate oRPC route (`packages/api/src/routers/rateRestrictions/index.ts:38`), not through the command.