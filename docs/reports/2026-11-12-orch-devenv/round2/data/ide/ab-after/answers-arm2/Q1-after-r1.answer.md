I'll start by locating the `StateReader` declaration and its implementations.
The index found one class, two factory functions, and a few usages in `kernel.ts`. Next I'll check for object literals typed as `StateReader` and trace the callers of `runCommand` and the reader factories.
The call-hierarchy output shows only tests for `runCommand`, so I'll check plain references to find the production callers and their entry points.
Production `runCommand` calls are at `apps/api/src/sync/commands.ts:301` and `packages/sync/src/commands.ts:108`. I'll read those, then trace upward to the route and UI entry points.
The server path calls `runCommand` from inside a loop, so I need the enclosing function's name and its callers. I'll also check who calls `runLocalCommand` from the client side.
Client calls to `runLocalCommand` don't appear in the index's references, so I'll grep for the exported name and for `applyCommands`, which is the server-side wrapper.
The server chain goes `applyUpload` → `applyCommands` → `runCommand`, and the client goes `useCommand` → `runLocalCommand` → `runCommand`. I'll find the HTTP route that calls `applyUpload` and the UI components that call `useCommand`.
I have the server and client chains. One last read to confirm the HTTP route path and the component-level entry point.
Two non-test implementations of `StateReader` reach the domain kernel's `runCommand` in production: a server reader over Postgres and a device reader over SQLite. Both are object literals returned from factory functions typed as `StateReader`. `MemoryStore` is a class that implements it, but only tests call `runCommand` with it.

**Implementations**

- **`postgresReader`** (object literal), `apps/api/src/sync/commands.ts:88-105`. Returns a `StateReader` over the upload transaction.
- **`sqliteReader`** (object literal), `packages/sync/src/commands.ts:39`. Returns a `StateReader` over the device's SQLite transaction.
- **`MemoryStore`** (class), `packages/domain/src/commands/memory.ts:9`. Test-only: used by `kernel.test.ts`, `rates.test.ts` and `rooms.test.ts`. The index also re-exports it (`packages/domain/src/commands/index.ts:3`), which I did not check for external consumers.

The `StateReader` interface is at `packages/domain/src/commands/query.ts:41`. The kernel's `runCommand` is at `packages/domain/src/commands/kernel.ts:122`.

**Server chain (Postgres reader)**

1. `POST /upload` handler, `apps/api/src/routes/sync.ts:150-186`, inside `syncRoutes` (`sync.ts:44`). It calls `applyUpload`.
2. `applyUpload`, `apps/api/src/sync/apply.ts:274`, which calls `applyCommands` when the batch is a command batch.
3. `applyCommands`, `apps/api/src/sync/commands.ts:193-323`. Inside its loop, `runCommand(command, entry.payload, context, postgresReader(tx, entry.orgId), TABLES)` is called at line 301-307.

I did not confirm how `syncRoutes` is mounted (`createApp` in `apps/api/src/app.ts:37` is the caller I found), so the URL prefix is unverified.

**Client chain (SQLite reader)**

1. UI components call `useCommand()`, `apps/web/src/sync/useCommand.ts:16`. Found in `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123`. I did not trace further up from that component.
2. `useCommand` calls `runLocalCommand(tx, command, payload, ctx)` inside `powerSync.writeTransaction`, `apps/web/src/sync/useCommand.ts:46-47`.
3. `runLocalCommand`, `packages/sync/src/commands.ts:95`. It calls `runCommand(..., sqliteReader(tx, ctx.organizationId), TABLES)` at lines 108-114.

Read-only: I did not modify any files.
