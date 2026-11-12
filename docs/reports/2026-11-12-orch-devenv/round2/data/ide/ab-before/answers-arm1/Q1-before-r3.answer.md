**Implementations of `StateReader`** (`packages/domain/src/commands/query.ts:41`)

There are three in the repo. Two are production readers, built as object literals typed by their factory's return type. The third is a class, used only by tests.

1. **`sqliteReader`**, device side: `packages/sync/src/commands.ts:39` (literal at 40–53).
2. **`postgresReader`**, server side: `apps/api/src/sync/commands.ts:88` (literal at 89–104).
3. **`MemoryStore`**, `packages/domain/src/commands/memory.ts:9`. It is not a test file, but it is only used by `rooms.test.ts`, `rates.test.ts` and `kernel.test.ts`, so it has no production chain. It is re-exported from `packages/domain/src/commands/index.ts:3`.

No other object literal is typed as `StateReader`.

**Production call chains into `runCommand`** (`packages/domain/src/commands/kernel.ts:122`)

**A. Device: `sqliteReader`**
- Entry: UI component `SetRestrictionsForm` (`apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123`, `runCommand = useCommand()`, invoked at :129). It is rendered from `apps/web/src/features/rates/restrictions/list.tsx:462`.
- `useCommand()`, `apps/web/src/sync/useCommand.ts:16`. Its callback at :24–51 wraps the call in `powerSync.writeTransaction` (:46).
- `runLocalCommand`, `packages/sync/src/commands.ts:95`. It calls `runCommand` at :108 with `sqliteReader(tx, …)` at :112.
- Kernel: `runCommand` in `kernel.ts:122`.

**B. Server: `postgresReader`**
- Entry: HTTP `POST /api/sync/upload`, `apps/api/src/routes/sync.ts:149`. It is mounted at `apps/api/src/app.ts:106`.
- The route calls `applyUpload` at `routes/sync.ts:186`, which is defined at `apps/api/src/sync/apply.ts:269`.
- Inside `applyUpload`, the command-batch branch at `apply.ts:273–274` calls `applyCommands`, defined at `apps/api/src/sync/commands.ts:193`.
- `applyCommands` opens `sql.transaction` at :260. Inside it, `runCommand` is called at :301 with `postgresReader(tx, entry.orgId)` at :305.
- Kernel: `runCommand` in `kernel.ts:122`.

`MemoryStore` has no production entry point.