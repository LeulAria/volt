The type-level lookup found no implementations, and the text search only matched `kernel.ts`. Business commands are probably created with `defineCommand`, so I'll search for that and for `AnyCommand`.
Two commands so far: `rooms.setStatus` and `rateRestrictions.set`. Next I need the web callers of `useCommand` and the other places those type strings appear.
The web UI issues `rateRestrictions.set` through `useCommand`, but `rooms.setStatus` shows up only as an oRPC call, not a command call. I'll check the server upload path and the room-status UI to confirm.
Last check: whether the oRPC `rateRestrictions` router exposes a `set` procedure, and whether `rooms.setStatus` bypasses the command path.
Two business commands implement `CommandDefinition`. Only one of them is issued by the web UI through the command path.

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`, `setRoomStatus`)
- Load: `rooms.ts:35-41`
- Decide: `rooms.ts:43-110`
- Audit: `rooms.ts:112-125`
- Permission: `rooms.ts:33` (`rooms`/`update`)
- Registered: `packages/domain/src/commands/registry.ts:10`
- Web UI: none through the command path. `apps/web/src/sync/SyncProvider.tsx:108` only labels it "Room status change" in the connection popover. The room-status UI, `apps/web/src/features/room-status/components/RoomLifecyclePanel.tsx:94`, calls the oRPC procedure `orpc.rooms.setStatus` instead, which runs `setRoomStatusManually` (`packages/api/src/routers/rooms/index.ts:1124-1137`), not `runCommand`.

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`, `setRateRestrictions`)
- Load: `rates.ts:126-141`
- Decide: `rates.ts:143-145` (delegates to `paintWrites`, `rates.ts:62-112`)
- Audit: `rates.ts:147-163`
- Permission: `rates.ts:124` (`revenue`/`update`)
- Registered: `packages/domain/src/commands/registry.ts:11`
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123-129`, via `useCommand` (`apps/web/src/sync/useCommand.ts:16`), which runs the command on-device in a PowerSync transaction.

Both commands are also run on the server by `applyCommands` (`apps/api/src/sync/commands.ts:193-320`), which looks them up with `commandFor` (`registry.ts:14`) and calls `runCommand` (`kernel.ts:122`).

Two things worth knowing: the `rateRestrictions.set` oRPC procedure (`packages/api/src/routers/rateRestrictions/index.ts:37-48`) is a separate server-side path that the e2e tests call directly, not the command. Also, `code_nav` implementations returned nothing for `CommandDefinition`, so the list comes from text search for `defineCommand` and `CommandDefinition`.
