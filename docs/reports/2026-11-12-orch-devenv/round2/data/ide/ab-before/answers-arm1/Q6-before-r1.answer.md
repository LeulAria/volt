Two business commands implement `CommandDefinition`. Both are defined with `defineCommand` (`kernel.ts:90`), which just returns the definition.

**1. `rooms.setStatus`** (`setRoomStatus`)
- Definition: `packages/domain/src/commands/rooms.ts:30`
- Permission: `rooms.ts:33` (`rooms` / `update`)
- Load: `rooms.ts:35`
- Decide: `rooms.ts:43`
- Audit: `rooms.ts:112` (returns `null` when the status is unchanged, `rooms.ts:116`)
- Registration: `packages/domain/src/commands/registry.ts:10`, in `COMMANDS`, which the server reads through `commandFor` (`registry.ts:14`).
- Web UI: no command-path issuer. `apps/web/src/features/room-status/components/RoomLifecyclePanel.tsx:94` calls the server RPC `orpc.rooms.setStatus`, not the command. `apps/web/src/sync/SyncProvider.tsx:108` only maps the type to a display label for queued commands.

**2. `rateRestrictions.set`** (`setRateRestrictions`)
- Definition: `packages/domain/src/commands/rates.ts:121`
- Permission: `rates.ts:124` (`revenue` / `update`)
- Load: `rates.ts:126`
- Decide: `rates.ts:143` (delegates to `paintWrites`, `rates.ts:62`)
- Audit: `rates.ts:147` (always returns an entry)
- Registration: `packages/domain/src/commands/registry.ts:11`
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129`, via `useCommand` (`SetRestrictionsForm.tsx:123`, implemented in `apps/web/src/sync/useCommand.ts:16`). This runs the command on the device first.

The server runs both through `apps/api/src/sync/commands.ts:285–301`. I did not open the device-side `packages/sync/src/commands.ts` beyond its `runCommand` call at line 108.

I made no changes.