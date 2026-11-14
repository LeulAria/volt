**Business commands implementing `CommandDefinition`:** two, both built with `defineCommand` (which returns the `CommandDefinition` type). No file names `CommandDefinition` outside `kernel.ts`.

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`)
- Type: `rooms.ts:31`. Payload schema: `rooms.ts:14-22`. Permission: `rooms.ts:33` (`rooms`/`update`).
- Load: `rooms.ts:35-41`
- Decide: `rooms.ts:43-110`
- Audit: `rooms.ts:112-125`
- Registered: `registry.ts:10`
- Web UI: none issues this command. `RoomLifecyclePanel.tsx:94` calls the legacy oRPC `rooms.setStatus`, which goes to `setRoomStatusManually` (`packages/api/src/routers/rooms/index.ts:1124-1137`), not the command path.

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`)
- Type: `rates.ts:122`. Payload schema: `rates.ts:17-45`. Permission: `rates.ts:124` (`revenue`/`update`).
- Load: `rates.ts:126-141`
- Decide: `rates.ts:143-145`, which calls `paintWrites` at `rates.ts:62-112`
- Audit: `rates.ts:147-163`
- Registered: `registry.ts:11`
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129` calls `runCommand(setRateRestrictions, variables)` via `useCommand` (`apps/web/src/sync/useCommand.ts:16`).

**Shared runner:** `kernel.ts:122-146` (`runCommand`) calls load, decide and audit in that order. The server runs the command in `apps/api/src/sync/commands.ts`: lookup via `commandFor` at `:233`, permission check at `:235-247`, `runCommand` at `:301`, audit insert at `:317`.

The e2e specs `apps/web/e2e/rates/restrictions/restrictions.spec.ts:51` and `apps/web/e2e/admin/audit-trail/audit-trail.spec.ts:209` call `rateRestrictions.set` over RPC. They are tests, not UI.