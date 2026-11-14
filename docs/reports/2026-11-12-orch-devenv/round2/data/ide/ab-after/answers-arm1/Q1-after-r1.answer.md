Three types implement `StateReader`. Two are production readers, one is test-only. The two production readers return object literals typed as `StateReader`, so the "object literal" part of the question is covered by them.

**Interface:** `packages/domain/src/commands/query.ts:41` (`query(query: Query): Promise<Row[]>`). The consumer is `runCommand(..., reader: StateReader, ...)` at `packages/domain/src/commands/kernel.ts:122-127`.

### 1. Device reader: `sqliteReader` (production)
Defined at `packages/sync/src/commands.ts:39`, an object literal returned as `StateReader`.

Call chain, UI → kernel:
1. UI component: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123,129` calls `runCommand(setRateRestrictions, variables)`. Other forms use the same hook.
2. Hook: `apps/web/src/sync/useCommand.ts:46-47` calls `powerSync.writeTransaction((tx) => runLocalCommand(tx, command, payload, ctx))`.
3. `packages/sync/src/commands.ts:95-112`, `runLocalCommand`, calls `runCommand(command, payload, context, sqliteReader(tx, ctx.organizationId), TABLES)`.
4. Kernel: `packages/domain/src/commands/kernel.ts:122`.

### 2. Server reader: `postgresReader` (production)
Defined at `apps/api/src/sync/commands.ts:88`, an object literal returned as `StateReader`. It runs `SELECT ... FOR UPDATE` inside the upload transaction.

Call chain, HTTP → kernel:
1. Route: `apps/api/src/app.ts:106` mounts `syncRoutes` at `/api/sync`. `apps/api/src/routes/sync.ts:149-186` handles `POST /upload` and calls `applyUpload`.
2. `apps/api/src/sync/apply.ts:269-274`, `applyUpload`, dispatches command batches to `applyCommands`.
3. `apps/api/src/sync/commands.ts:193`, `applyCommands`, opens `sql.transaction` and at `:301-307` calls `runCommand(command, entry.payload, context, postgresReader(tx, entry.orgId), TABLES)`.
4. Kernel: `packages/domain/src/commands/kernel.ts:122`.

### 3. `MemoryStore` (class, `packages/domain/src/commands/memory.ts:9`)
This is the only `implements StateReader` class. It is exported from `packages/domain/src/commands/index.ts:3`, but its only consumers are tests (`kernel.test.ts`, `rooms.test.ts`, `rates.test.ts`). I found no production call chain for it, so it is excluded from the chains above.

I did not check whether the web app's own `powersync.writeTransaction` wraps the call in additional layers beyond the hook shown. The traces above stop at the `runCommand` call sites.