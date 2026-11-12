**Implementations of `StateReader`** (`packages/domain/src/commands/query.ts:41`), non-test:

1. **`sqliteReader`**: `packages/sync/src/commands.ts:39`. Reads the device's SQLite via PowerSync.
2. **`postgresReader`**: `apps/api/src/sync/commands.ts:88`. Reads Postgres with `FOR UPDATE` inside the upload transaction.
3. **`MemoryStore` class**: `packages/domain/src/commands/memory.ts:9`. Implements the interface, but no production code calls it. Its only callers are tests (`kernel.test.ts`, `rooms.test.ts`, `rates.test.ts`).

No object literal typed as `StateReader` exists anywhere in the repo, test or production.

**Call chains into `runCommand`** (`packages/domain/src/commands/kernel.ts:122`):

**1. Device, `sqliteReader`**
- UI: `SetRestrictionsForm` (`apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123, 129`) calls `useCommand()`.
- Route: `/dashboard/reservations/rates/restrictions` (`apps/web/src/routes/_dashboard_layout/dashboard/reservations/rates/restrictions.tsx:19`) renders `RateRestrictionsGrid` (`list.tsx:75`), which renders `SetRestrictionsForm` at `list.tsx:462`.
- Hook: `useCommand` (`apps/web/src/sync/useCommand.ts:46-47`) calls `powerSync.writeTransaction((tx) => runLocalCommand(tx, ...))`.
- `runLocalCommand` (`packages/sync/src/commands.ts:95`) calls `runCommand(..., sqliteReader(tx, organizationId), TABLES)` at lines 108–112.

**2. Server, `postgresReader`**
- HTTP: `POST /api/sync/upload` (`apps/api/src/routes/sync.ts:149`, mounted at `apps/api/src/app.ts:106`).
- `applyUpload` (`apps/api/src/sync/apply.ts:269`) → `applyCommands` (`apps/api/src/sync/apply.ts:274`) → `applyCommands` (`apps/api/src/sync/commands.ts:193`).
- `applyCommands` calls `runCommand(command, payload, context, postgresReader(tx, entry.orgId), TABLES)` at `apps/api/src/sync/commands.ts:301–307`, inside `sql.transaction`.

**Note:** the device path is the same command run locally, and the server re-runs it authoritatively on upload.