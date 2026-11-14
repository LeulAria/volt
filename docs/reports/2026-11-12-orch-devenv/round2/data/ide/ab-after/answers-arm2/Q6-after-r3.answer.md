I'll search the repo for `defineCommand` and `CommandDefinition` to find every command, then read each one's `load`, `decide`, and `audit`.
Two commands so far: `setRoomStatus` (rooms.ts) and `setRateRestrictions` (rates.ts). Next I'll read the registry and the room command, and find which UI issues each type string.
Two business commands implement `CommandDefinition`, both registered in `packages/domain/src/commands/registry.ts:9-12`.

**1. `rooms.setStatus` (`setRoomStatus`)** — `packages/domain/src/commands/rooms.ts`
- Definition: `rooms.ts:30`
- `load`: `rooms.ts:35`
- `decide`: `rooms.ts:43`
- `audit`: `rooms.ts:112`
- Registered: `registry.ts:10`
- Web UI: none issues this through the command runner. `apps/web/src/features/room-status/components/RoomLifecyclePanel.tsx:94` calls `orpc.rooms.setStatus.mutationOptions(...)`, which is a server RPC endpoint, not the `rooms.setStatus` command type. `SyncProvider.tsx:108` only maps that type to a display label.

**2. `rateRestrictions.set` (`setRateRestrictions`)** — `packages/domain/src/commands/rates.ts`
- Definition: `rates.ts:121`
- `load`: `rates.ts:126`
- `decide`: `rates.ts:143`
- `audit`: `rates.ts:147`
- Registered: `registry.ts:11`
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129` calls `runCommand(setRateRestrictions, variables)`. That `runCommand` comes from `useCommand()` (`SetRestrictionsForm.tsx:123`), defined in `apps/web/src/sync/useCommand.ts:16`, which calls `runLocalCommand` at `useCommand.ts:47`.

The `rateRestrictions.set` string also appears in e2e specs (`apps/web/e2e/rates/restrictions/restrictions.spec.ts:51`, `apps/web/e2e/admin/audit-trail/audit-trail.spec.ts:209`), but those are test setup, not UI.

The line numbers for `load`/`decide`/`audit` in `rates.ts` are counted from the file content rather than a fresh read, so verify them if you need exact anchors. No files were modified.
