**Production implementations of `StateReader`** (`packages/domain/src/commands/query.ts:41`), with the two `runCommand` call sites that receive them:

There are two. Both are object literals returned under a `StateReader` return type. No production code passes an inline `{ query }` literal to `runCommand`.

1. **Device reader: `sqliteReader`**
   - Defined at `packages/sync/src/commands.ts:39`. The object literal with `query` is at `:40-53`.
   - Chain, from the UI down:
     1. Route `apps/web/src/routes/_dashboard_layout/dashboard/reservations/rates/restrictions.tsx:19` renders `RateRestrictionsGrid`.
     2. `apps/web/src/features/rates/restrictions/list.tsx:462` renders `SetRestrictionsForm` as the create form.
     3. `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123` calls `useCommand()`, and `:129` calls `runCommand(setRateRestrictions, variables)` inside a `useMutation`.
     4. `apps/web/src/sync/useCommand.ts:46-48` runs `powerSync.writeTransaction((tx) => runLocalCommand(tx, …))`.
     5. `packages/sync/src/commands.ts:95` is `runLocalCommand`. At `:108-114` it calls `runCommand(command, payload, context, sqliteReader(tx, orgId), TABLES)`.
     6. `packages/domain/src/commands/kernel.ts:122` is `runCommand`. It calls `command.load(reader, …)` at `:141`.

2. **Server reader: `postgresReader`**
   - Defined at `apps/api/src/sync/commands.ts:88`. The object literal is at `:89-104`. It runs `SELECT … FOR UPDATE` inside the upload transaction.
   - Chain, from the HTTP entry point down:
     1. `POST /api/sync/upload`. `apps/api/src/app.ts:106` mounts `syncRoutes` at `/api/sync`, and `apps/api/src/routes/sync.ts:149` defines `app.post("/upload")`.
     2. `apps/api/src/routes/sync.ts:186` calls `applyUpload(…)`.
     3. `apps/api/src/sync/apply.ts:269` is `applyUpload`. At `:273-274` a batch containing `sync_commands` rows goes to `applyCommands`.
     4. `apps/api/src/sync/commands.ts:193` is `applyCommands`. Inside `sql.transaction` (`:260`), `:301` calls `runCommand(command, entry.payload, context, postgresReader(tx, entry.orgId), TABLES)`, with the reader created at `:305`.
     5. `kernel.ts:122` is `runCommand`, as above.
   - The device sends that upload from `packages/sync/src/api.ts:38` (`POST api/sync/upload`). I did not trace the PowerSync connector that calls it.

**Not in the production path:**
- `MemoryStore` (`packages/domain/src/commands/memory.ts:9`) implements `StateReader`. It is re-exported from `packages/domain/src/commands/index.ts:3`, but I found no non-test caller, so it is used by tests only.
- Test files were excluded from the search. Their `runCommand` calls are in `kernel.test.ts`, `rooms.test.ts` and `rates.test.ts`.

I made no changes.