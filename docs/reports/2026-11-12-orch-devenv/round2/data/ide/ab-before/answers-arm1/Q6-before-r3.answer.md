Two business commands implement `CommandDefinition`. Both are registered in `COMMANDS`, and only one is issued by the web UI.

**1. `rooms.setStatus`** (`packages/domain/src/commands/rooms.ts`)
- Type string: `"rooms.setStatus"` (line 31). Permission: `rooms:update` (line 33).
- load: line 35. decide: line 43. audit: line 112 (returns `null` when the status is unchanged).
- Registered: `packages/domain/src/commands/registry.ts:10`, re-exported via `commands/index.ts:4`.
- Web UI: none issues this command. `RoomLifecyclePanel.tsx:94` calls the legacy `orpc.rooms.setStatus`, which is a different procedure (`packages/api/src/routers/rooms/index.ts:1124`). `SyncProvider.tsx:108` only maps the label "Room status change".

**2. `rateRestrictions.set`** (`packages/domain/src/commands/rates.ts`)
- Type string: `"rateRestrictions.set"` (line 122). Permission: `revenue:update` (line 124).
- load: line 126. decide: line 143. audit: line 147.
- Registered: `packages/domain/src/commands/registry.ts:11`, re-exported via `commands/index.ts:6`.
- Web UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129` runs it through `useCommand()` (`apps/web/src/sync/useCommand.ts:16`, which calls `runLocalCommand` at line 47).

**Dispatch (both commands)**
- Device: `runLocalCommand` in `packages/sync/src/commands.ts`.
- Server: `apps/api/src/sync/commands.ts:233` (permission check) and `:285` (authoritative `runCommand`).

The shared pipeline is `runCommand` in `kernel.ts:122-146`: parse, then `load`, `decide` (stamped at 142-144), and `audit`. I did not trace where the returned `AuditEntry` is written to `audit_log`.