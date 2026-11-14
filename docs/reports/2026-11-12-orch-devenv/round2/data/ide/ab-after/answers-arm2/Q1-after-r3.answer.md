I'll locate the `StateReader` declaration and its implementations, then trace the callers that feed `runCommand`.
Two object-literal readers (`postgresReader`, `sqliteReader`) and one class (`MemoryStore`) turned up. Next I'll trace who calls them and up to the entry points.
Call hierarchy doesn't work on these factory functions, so I'll use references to find where they're invoked.
The `runCommand` call sites are in `apps/api/src/sync/commands.ts:301` and `packages/sync/src/commands.ts:108`. I need the enclosing functions and their callers to reach the HTTP route and UI entry points.
Both `runCommand` sites are inside named functions. I'll trace callers of those functions up to the routes and UI.
The Postgres path runs through `applyCommands` (lines 193–323). Now I'll get the references for `applyCommands` and `runLocalCommand` to reach the HTTP route and UI.
Next I need the function around `apply.ts:274` and every consumer of `runLocalCommand` from `packages/sync/src/index.ts`.
The web side goes through `apps/web/src/sync/useCommand.ts:47`, and the API side through `applyUpload` in `apply.ts:269`. I'll trace callers of both and read the route.
The server path is `POST /upload` → `applyUpload` → `applyCommands` → `runCommand`, and the device path is `useCommand` → `runLocalCommand` → `runCommand`. Remaining: the UI consumers of `useCommand`, the route mount prefix, and whether `MemoryStore` is used outside tests.
Only `SetRestrictionsForm` consumes `useCommand`. One last check on how the device's queued writes reach `/api/sync/upload`.
`StateReader` has three implementations: `MemoryStore` (test-only) and two production factories, `postgresReader` and `sqliteReader`. Both production paths reach `runCommand` (`packages/domain/src/commands/kernel.ts:122`).

**Implementations**

- `packages/domain/src/commands/memory.ts:9`: `class MemoryStore implements StateReader`. It is re-exported from `packages/domain/src/commands/index.ts:3`, but only the tests construct it (`kernel.test.ts`, `rates.test.ts`, `rooms.test.ts`). No production chain.
- `apps/api/src/sync/commands.ts:88`: `postgresReader(tx, organizationId): StateReader`, an object literal with a `query` method (90–103). Server side.
- `packages/sync/src/commands.ts:39`: `sqliteReader(tx, organizationId): StateReader`, an object literal. Device side.

**Server chain (Postgres)**

1. Entry: `POST /api/sync/upload`, defined at `apps/api/src/routes/sync.ts:149–150`, mounted at `apps/api/src/app.ts:106`.
2. `syncRoutes` calls `applyUpload` at `routes/sync.ts:186`.
3. `applyUpload` (`apps/api/src/sync/apply.ts:269`) calls `applyCommands` at `apply.ts:274`.
4. `applyCommands` (`apps/api/src/sync/commands.ts:193`) calls `runCommand` at `commands.ts:301`, passing `postgresReader(tx, entry.orgId)` at `commands.ts:305`.

**Device chain (SQLite)**

1. Entry: `SetRestrictionsForm` (`apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123`) calls the `useCommand()` hook and invokes it at line 129. That call is a local `const runCommand`, not the kernel function.
2. `useCommand` (`apps/web/src/sync/useCommand.ts:16`) runs `powerSync.writeTransaction` and calls `runLocalCommand` at `useCommand.ts:47`.
3. `runLocalCommand` (`packages/sync/src/commands.ts:95`) calls `runCommand` at `commands.ts:108`, passing `sqliteReader(tx, ctx.organizationId)` at `commands.ts:112`.

The device writes are queued and later uploaded to `/api/sync/upload`, which re-runs the same command on the server (`packages/sync/src/index.ts` and `packages/contracts/src/sync.ts:5`).

I made no changes.
