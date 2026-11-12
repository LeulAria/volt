I'll start by locating the `StateReader` declaration and every place it's referenced.
Three candidates so far: `MemoryStore` (class), `postgresReader`, and `sqliteReader` (factories). I'll read the interface and the factories, and find who calls them.
Next I'll read the interface, the in-memory class, both factories, and the two `runCommand` call sites.
The core chain is clear. Now I need the HTTP entry point for `applyCommands` and the UI entry points for `runLocalCommand`, plus a check for any untyped reader literals in production code.
Two more reads: the upload function that dispatches to `applyCommands`, and the `useCommand` hook. I also need the HTTP route that calls `applyUpload`.
I need the route path and the UI component's use of `runCommand`, so I'll read both.
Two non-test implementations of `StateReader` reach the kernel's `runCommand` in production, and both are created by factory functions that return object literals. The in-memory `MemoryStore` is the only class implementation, but no production code passes it into `runCommand`.

**Interface:** `packages/domain/src/commands/query.ts:41` (`StateReader` with `query(query: Query): Promise<Row[]>`).

**1. Server reader: `postgresReader`**
- Implementation: `apps/api/src/sync/commands.ts:88-105`. It returns an object literal with `query()`, and it adds `FOR UPDATE` to the SQL.
- Call chain:
  1. HTTP entry: `POST /api/sync/upload`, `apps/api/src/routes/sync.ts:149-150`. The route is mounted at `/api/sync` in `apps/api/src/app.ts:106`.
  2. `applyUpload(...)`, `apps/api/src/routes/sync.ts:186` → `apps/api/src/sync/apply.ts:269`.
  3. `isCommandBatch` routes the batch to `applyCommands(...)`, `apps/api/src/sync/apply.ts:273-274`.
  4. `applyCommands`, `apps/api/src/sync/commands.ts:193`, opens a `sql.transaction`. It calls `runCommand(command, entry.payload, context, postgresReader(tx, entry.orgId), TABLES)` at `apps/api/src/sync/commands.ts:301-307`.
  5. `runCommand`, `packages/domain/src/commands/kernel.ts:122`, passes the reader to `command.load(reader, ...)` at `kernel.ts:141`.

**2. Device reader: `sqliteReader`**
- Implementation: `packages/sync/src/commands.ts:39-54`. It returns an object literal with `query()`, reading via `tx.getAll`.
- Call chain:
  1. UI entry: `SetRestrictionsForm` (`apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123-129`) calls `runCommand` from the `useCommand` hook. That is `apps/web/src/sync/useCommand.ts:16`, which invokes `runLocalCommand` inside `powerSync.writeTransaction` at `useCommand.ts:46-48`.
  2. `runLocalCommand`, `packages/sync/src/commands.ts:95`, calls the kernel `runCommand(command, payload, context, sqliteReader(tx, ctx.organizationId), TABLES)` at `packages/sync/src/commands.ts:108-114`.
  3. The kernel `runCommand` at `kernel.ts:122` passes it to `command.load`.

**3. In-memory: `MemoryStore`**
- Implementation: `packages/domain/src/commands/memory.ts:9` (`class MemoryStore implements StateReader`, with `query` at line 20). It is exported from `packages/domain/src/commands/index.ts:3`.
- Only test files construct it and pass it to `runCommand`: `kernel.test.ts`, `rates.test.ts`, `rooms.test.ts`. No production entry point uses it, so it has no production chain.

**Object literals typed as `StateReader`:** Neither factory annotates its literal with `StateReader`. Each one returns the literal from a function whose return type is `StateReader` (`apps/api/src/sync/commands.ts:88`, `packages/sync/src/commands.ts:39`). I found no other production object literal passed as a reader.
