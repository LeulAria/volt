I'll find where `CommandDefinition` is declared and which commands implement it.
The interface is at `kernel.ts:77`. Next I'll find every `defineCommand` call and the registry.
Two commands so far: `rooms.setStatus` and `rateRestrictions.set`. Now I need the web callers for `setRoomStatus` and where the server writes audit entries.
Still need the server audit write path and whether any web code issues `rooms.setStatus` through the command pipeline.
Two business commands implement `CommandDefinition`. Only one has a web UI that issues it through the command pipeline.

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`)
- Type string: `"rooms.setStatus"`, line 31. Defined via `defineCommand` at line 30.
- Load: `rooms.ts:35`. Reads the room and its open DND log.
- Decide: `rooms.ts:43`. Checks the transition, moves housekeeping status, appends `room_status_history`, ends DND if the room stops being occupied.
- Audit: `rooms.ts:112`. Returns `null` when the status is unchanged.
- Registered: `packages/domain/src/commands/registry.ts:10`.
- Web UI: none found that issues this command. `apps/web/src/features/room-status/components/RoomLifecyclePanel.tsx:94` calls `orpc.rooms.setStatus`, which is the legacy server router, not this command. `apps/web/src/sync/SyncProvider.tsx:108` only maps the label.

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`)
- Type string: `"rateRestrictions.set"`, line 122. Defined via `defineCommand` at line 121.
- Load: `rates.ts:126`. Checks room types exist and loads overlapping `rate_restrictions` rows.
- Decide: `rates.ts:143`, delegating to `paintWrites` at `rates.ts:62`.
- Audit: `rates.ts:147`. Returns an `AuditEntry` with action `rate_restrictions_set` or `rate_restrictions_cleared`.
- Registered: `registry.ts:11`.
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129`, via `useCommand()` (`apps/web/src/sync/useCommand.ts:16`, `runLocalCommand` at `:47`).

**Shared execution**
- Permission per command: `rooms.ts:33` (`revenue`/`update` is at `rates.ts:124`).
- Device and server both use `runCommand` (`kernel.ts:122`).
- Server side, `apps/api/src/sync/commands.ts`: `commandFor` at `:233`, permission check at `:236`, `runCommand` at `:301`, audit write via `writeAudit` (`:163`) at `:317`.
