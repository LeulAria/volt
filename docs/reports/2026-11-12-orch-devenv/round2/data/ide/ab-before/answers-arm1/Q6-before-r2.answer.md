Two business commands implement `CommandDefinition`. The interface is at `packages/domain/src/commands/kernel.ts:77`, and both are built with `defineCommand` (`kernel.ts:90`).

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`)
- Type string: `"rooms.setStatus"` at `rooms.ts:31`. Permission is `rooms`/`update` at `rooms.ts:33`.
- load: `rooms.ts:35-41`
- decide: `rooms.ts:43-110`
- audit: `rooms.ts:112-125`
- Registered in `packages/domain/src/commands/registry.ts:10`.
- Web UI: none issues this command. `SyncProvider.tsx:108` only has a display label for it. `RoomLifecyclePanel.tsx:94` calls the legacy oRPC `rooms.setStatus` mutation, not the command.

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`)
- Type string: `"rateRestrictions.set"` at `rates.ts:122`. Permission is `revenue`/`update` at `rates.ts:124`.
- load: `rates.ts:126-141`
- decide: `rates.ts:143-145`, delegating to `paintWrites` at `rates.ts:62-112`
- audit: `rates.ts:147-163`
- Registered in `registry.ts:11`.
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123` obtains `useCommand()` and `:129` runs `runCommand(setRateRestrictions, variables)`. The form is mounted from `list.tsx:462`.

**Shared execution path**
- Device: `apps/web/src/sync/useCommand.ts:46-48` calls `runLocalCommand` (`packages/sync/src/commands.ts:95`), which runs `runCommand` against SQLite. The device ignores the audit entry.
- Server: `apps/api/src/sync/commands.ts:233` looks up the command and `:236` checks permission. `:285-301` runs `runCommand` against Postgres, and `:317` writes the audit row.
- `runCommand` itself is at `kernel.ts:122-146`.

Caveat: `apps/web/e2e` specs call an oRPC route also named `rateRestrictions.set` (`packages/api/src/routers/rateRestrictions/index.ts:38`). That is a separate legacy path, not the command.