Two business commands implement `CommandDefinition`, both registered in `registry.ts`.

**1. `rooms.setStatus`** (`setRoomStatus`, `packages/domain/src/commands/rooms.ts`)
- Defined at `rooms.ts:30`
- load: `rooms.ts:35`
- decide: `rooms.ts:43`
- audit: `rooms.ts:112`
- Registered at `registry.ts:10`
- Web UI: none issues this command. `RoomLifecyclePanel.tsx:94` calls the legacy oRPC `orpc.rooms.setStatus` (`packages/api/src/routers/rooms/index.ts:1124`), not the command. `SyncProvider.tsx:108` only maps the type to a label in the sync popover.

**2. `rateRestrictions.set`** (`setRateRestrictions`, `packages/domain/src/commands/rates.ts`)
- Defined at `rates.ts:121`
- load: `rates.ts:126`
- decide: `rates.ts:143` (delegates to `paintWrites`, `rates.ts:62`)
- audit: `rates.ts:147`
- Registered at `registry.ts:11`
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123,129` runs it through `useCommand`, so it executes on the device first.

**Shared runners**
- Registry: `registry.ts:9-16` (`COMMANDS`, `commandFor`), exported via `index.ts:4`.
- Device: `packages/sync/src/commands.ts:95` (`runLocalCommand`) calls `runCommand` at `:108`. It never calls `audit`.
- Server: `apps/api/src/sync/commands.ts:233` (`commandFor`), `:301` (`runCommand`), `:317` (`writeAudit`).

Nothing was modified.