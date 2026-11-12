Two production commands so far: `setRoomStatus` in `rooms.ts` and `setRateRestrictions` in `rates.ts`. Next I'll read `rooms.ts` and find where they're registered.
That grep was too broad. Narrowing to the command identifiers and the registry.
Registration is in `registry.ts`. Now I need the registry body, the web call sites, and how the server applies commands.
The `--include` flag broke under zsh, so I'm rerunning the web and sync search with the file-type filter applied afterwards.
The web room-status panel calls the oRPC `rooms.setStatus` endpoint, not the domain command, so I need to confirm which implementation that endpoint uses. I'll also collect the `rates.ts` line numbers and the server rooms router.
Two business commands implement `CommandDefinition`: `rooms.setStatus` and `rateRestrictions.set`. Both are registered in `registry.ts`. Only the rate-restrictions form issues its command through the sync pipeline; the room-status panel calls a separate server endpoint.

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`)
- Type: `"rooms.setStatus"` (rooms.ts:31)
- `load`: rooms.ts:35 (reads the room and its open DND log)
- `decide`: rooms.ts:43 (transition check, housekeeping axis, history row, DND end)
- `audit`: rooms.ts:112 (returns `null` when status is unchanged)
- Registered: `registry.ts:10` in `COMMANDS`. `commandFor` at registry.ts:14 looks it up.
- Web UI: none through the command pipeline. `apps/web/src/features/room-status/components/RoomLifecyclePanel.tsx:94` calls `orpc.rooms.setStatus`, a legacy server endpoint (`packages/api/src/routers/rooms/index.ts:1124`) that uses `setRoomStatusManually` rather than this command. The web sync label at `apps/web/src/sync/SyncProvider.tsx:108` only names the type.

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`)
- Type: `"rateRestrictions.set"` (rates.ts:122)
- `load`: rates.ts:126 (checks room types exist, reads overlapping rules)
- `decide`: rates.ts:143 (calls `paintWrites`)
- `audit`: rates.ts:147 (recomputes the writes to count retired and created rows)
- Registered: `registry.ts:11`.
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129` runs `runCommand(setRateRestrictions, variables)` via `useCommand`.

**Server and device execution**
- The server applies commands at `apps/api/src/sync/commands.ts:233` (`commandFor`) and `:301` (`runCommand`, using `postgresReader`).
- The device runs them at `packages/sync/src/commands.ts:95` (`runLocalCommand`) and `:108` (`runCommand`).

The other `defineCommand` hits (`kernel.test.ts`, `rooms.test.ts`, `rates.test.ts`) are test fixtures, not production commands. No files were modified.
