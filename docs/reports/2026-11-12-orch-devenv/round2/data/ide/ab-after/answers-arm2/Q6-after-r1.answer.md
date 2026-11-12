Two business commands implement `CommandDefinition`: `rooms.setStatus` and `rateRestrictions.set`. Only `rateRestrictions.set` is issued from the web UI, through `runCommand`.

**1. `rooms.setStatus`** (`setRoomStatus`, `packages/domain/src/commands/rooms.ts`)
- Type string: `"rooms.setStatus"` (rooms.ts:31)
- Permission: `{ resource: "rooms", action: "update" }` (rooms.ts:33)
- Load: rooms.ts:35
- Decide: rooms.ts:43
- Audit: rooms.ts:112
- Registered: `COMMANDS` in `packages/domain/src/commands/registry.ts:10`
- Web UI: none issues this command. `RoomLifecyclePanel.tsx:94` calls the legacy oRPC `orpc.rooms.setStatus`, not the command path. `SyncProvider.tsx:108` only maps the type to a display label.

**2. `rateRestrictions.set`** (`setRateRestrictions`, `packages/domain/src/commands/rates.ts`)
- Type string: `"rateRestrictions.set"` (rates.ts:122)
- Permission: `{ resource: "revenue", action: "update" }` (rates.ts:124)
- Load: rates.ts:126
- Decide: rates.ts:143
- Audit: rates.ts:147
- Registered: `COMMANDS` in `packages/domain/src/commands/registry.ts:11`
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129` calls `runCommand(setRateRestrictions, variables)`.

**Server side for both:** `apps/api/src/sync/commands.ts:233` and `:285` resolve the type via `commandFor`, check `permissionFor`, and run the command authoritatively. Unknown types are stored as `UNKNOWN_COMMAND`.

No files were modified.
