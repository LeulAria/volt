**Implementations of `StateReader`** (`packages/domain/src/commands/query.ts:41`)

Two production implementations, both object literals returned from factories annotated `: StateReader`. A third, `MemoryStore`, is a class and is test-only.

**1. `sqliteReader`, device side.** `packages/sync/src/commands.ts:39`

Call chain into `runCommand`:
- Route `/dashboard/reservations/rates/restrictions`: `apps/web/src/routes/_dashboard_layout/dashboard/reservations/rates/restrictions.tsx:2` mounts `RateRestrictionsGrid`.
- `apps/web/src/features/rates/restrictions/list.tsx:462` renders `SetRestrictionsForm`.
- `SetRestrictionsForm.tsx:123` calls `useCommand()`, and `:129` calls `runCommand(setRateRestrictions, variables)`.
- `apps/web/src/sync/useCommand.ts:46-48` runs `powerSync.writeTransaction(tx => runLocalCommand(tx, command, payload, ctx))`.
- `packages/sync/src/commands.ts:95` is `runLocalCommand`. It calls `sqliteReader(tx, ctx.organizationId)` at `:112`, passed to `runCommand` at `:108`.
- Writes then go into the local SQLite database. The `sync_commands` row is queued for upload.

**2. `postgresReader`, server side.** `apps/api/src/sync/commands.ts:88`

Call chain into `runCommand`:
- The device's PowerSync connector uploads to `POST /api/sync/upload`. The route is mounted at `apps/api/src/app.ts:106`. The handler is `apps/api/src/routes/sync.ts:149-186`, which calls `applyUpload` at `:186`.
- `apps/api/src/sync/apply.ts:269` is `applyUpload`. At `:273-274` it short-circuits command batches to `applyCommands`.
- `apps/api/src/sync/commands.ts:193` is `applyCommands`. Inside `sql.transaction` (`:260`), it calls `runCommand(command, entry.payload, context, postgresReader(tx, entry.orgId), TABLES)` at `:301-307`.
- The writes and audit row are then applied in the same transaction.

I did not trace the connector's upload code beyond the comment at `apps/web/src/sync/powersync.ts:11`.

**3. `MemoryStore`, not production.** `packages/domain/src/commands/memory.ts:9`

It is a `class ... implements StateReader`. Its only callers are `*.test.ts` files (`kernel.test.ts`, `rooms.test.ts`, `rates.test.ts`). It is also re-exported from `packages/domain/src/commands/index.ts:3`, but nothing in `apps/` or `packages/` outside tests imports it. It has no production call chain.

**Other object literals typed as `StateReader`:** none. The grep for `StateReader` found only the two factory returns above, plus the type references in `kernel.ts` and `memory.ts`.

No files were modified.