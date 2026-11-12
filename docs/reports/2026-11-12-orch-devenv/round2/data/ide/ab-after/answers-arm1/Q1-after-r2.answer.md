**Non-test implementations of `StateReader`** (`packages/domain/src/commands/query.ts:41`): two object literals, one per database. Both are typed by their function's return type.

1. **Device reader (SQLite)**: `sqliteReader` at `packages/sync/src/commands.ts:39`, which returns the object literal with `query(query)` at `:40-53`.
   - Entry: UI component `RateRestrictionsGrid` (`apps/web/src/features/rates/restrictions/list.tsx:75`), rendered by the route `apps/web/src/routes/_dashboard_layout/dashboard/reservations/rates/restrictions.tsx`. It opens `SetRestrictionsForm` as the `createProp` form (`list.tsx:462`).
   - `SetRestrictionsForm` calls `useCommand()` (`apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:125`), then `runCommand(setRateRestrictions, variables)` in a mutation (`:129`).
   - `useCommand` (`apps/web/src/sync/useCommand.ts:47`) runs `powerSync.writeTransaction((tx) => runLocalCommand(tx, …))`.
   - `runLocalCommand` (`packages/sync/src/commands.ts:95`) builds `sqliteReader(tx, ctx.organizationId)` at `:112` and passes it to the kernel's `runCommand` at `:108`. The device writes locally and inserts a `sync_commands` row (`:124`).

2. **Server reader (Postgres)**: `postgresReader` at `apps/api/src/sync/commands.ts:88`, which returns the object literal with `query` at `:89-104`. It adds `FOR UPDATE` to the reads.
   - Entry: HTTP `POST /api/sync/upload` (`apps/api/src/routes/sync.ts:150`), mounted at `apps/api/src/app.ts:106`.
   - The route calls `applyUpload` (`routes/sync.ts:186`), which is defined at `apps/api/src/sync/apply.ts:269`. For command batches it calls `applyCommands` (`apply.ts:274`).
   - `applyCommands` (`apps/api/src/sync/commands.ts:193`) runs `runCommand(command, entry.payload, context, postgresReader(tx, entry.orgId), TABLES)` at `:301-307`, inside `sql.transaction`.
   - The device reaches this path through `uploadData` in `packages/sync/src/connector.ts:48`, which calls `api.upload` (`packages/sync/src/api.ts:35-38`).

**Not production:** `MemoryStore` (`packages/domain/src/commands/memory.ts:9`) is a class, not an object literal. It is used only by `kernel.test.ts`, `rates.test.ts` and `rooms.test.ts`, and is re-exported from `commands/index.ts:3`. I found no `StateReader` object literal in test code outside those.

I did not trace `apps/server/src/index.ts` to confirm it mounts the API app.