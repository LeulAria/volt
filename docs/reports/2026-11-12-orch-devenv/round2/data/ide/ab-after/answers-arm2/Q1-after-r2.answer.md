**Implementations of `StateReader`**

Production has two implementations, plus one in-memory class that only tests use.

- **SQLite (device):** `sqliteReader`, `packages/sync/src/commands.ts:39`, with its `query` method at line 41.
- **Postgres (server):** `postgresReader`, `apps/api/src/sync/commands.ts:88`.
- **`MemoryStore`:** `packages/domain/src/commands/memory.ts:9`. It is exported from `packages/domain/src/commands/index.ts:3`, but only the `*.test.ts` files instantiate it (`kernel.test.ts`, `rates.test.ts`, `rooms.test.ts`).

I found no non-test object literals typed as `StateReader`. The only other reader-shaped objects are in `kernel.test.ts`, which I did not inspect.

**Production call chains into `runCommand`**

Device path (SQLite):
1. UI: `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:129` calls `runCommand(setRateRestrictions, variables)`, where `runCommand` comes from `useCommand()` (line 123).
2. `apps/web/src/sync/useCommand.ts:46-47` wraps `runLocalCommand(tx, command, payload, ctx)` in `powerSync.writeTransaction`.
3. `packages/sync/src/commands.ts:95` `runLocalCommand` calls `runCommand` at line 108, passing `sqliteReader(tx, ctx.organizationId)` at line 112.
4. `runCommand` is defined at `packages/domain/src/commands/kernel.ts:122`.

Server path (Postgres):
1. HTTP: `POST /api/sync/upload`. The route is at `apps/api/src/routes/sync.ts:149-150`, mounted by `apps/api/src/app.ts:106` under `/api/sync`.
2. `apps/api/src/routes/sync.ts:186` calls `applyUpload`.
3. `apps/api/src/sync/apply.ts:269` `applyUpload` calls `applyCommands` at line 274.
4. `apps/api/src/sync/commands.ts:193` `applyCommands` calls `runCommand` at line 301, passing `postgresReader(tx, entry.orgId)` at line 305.
5. `createApp` is invoked from `apps/api/src/index.ts:52`.

The call-hierarchy tool does not follow dynamic dispatch, so the links from `SetRestrictionsForm` into `useCommand` and from `index.ts` into `createApp` were confirmed by reading the code and grep, not by call-hierarchy output.
