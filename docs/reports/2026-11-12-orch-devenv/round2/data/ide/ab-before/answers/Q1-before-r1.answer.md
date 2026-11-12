I'll search the codebase for `StateReader` implementations and object literals typed as it.
Three candidates so far: `postgresReader`, `sqliteReader`, and `MemoryStore`. Next I'll read their bodies, find the `runCommand` callers, and check for untyped object literals passed as readers.
The three production readers are clear. Next I need the callers of `runLocalCommand` (device side), `applyCommands` (server side), and any test-file object literals typed as `StateReader`.
The server chain is `syncRoutes` → `applyUpload` → `applyCommands` → `postgresReader`. Now I need to confirm where `syncRoutes` is mounted, which UI components call `useCommand`, and whether any test declares an inline reader literal.
Only one UI component calls `useCommand`. I'll read that hook and confirm the server mounts `/api/sync` on the path that serves requests.
Three production classes/factories implement `StateReader`. No object literal typed as `StateReader` exists in the repo, including tests. `MemoryStore` is the only class that implements it, and it is not on any production path.

**1. Server: `postgresReader`** (`apps/api/src/sync/commands.ts:88`)
- Entry: `app.route("/api/sync", syncRoutes(...))` (`apps/api/src/app.ts:106`), which `createApp` builds.
- `apps/server/src/apiApp.ts:11,42` wraps `createApp` in `createApiApp()`. `apps/server/src/lambda.ts:85-88` serves it on Lambda. I did not confirm that `apps/server/src/index.ts:1633` (`fetch: app.fetch`) serves the same app.
- `POST /upload` → `syncRoutes` handler (`apps/api/src/routes/sync.ts:149-186`) → `applyUpload` (`apps/api/src/sync/apply.ts:269-274`) → `applyCommands` (`apps/api/src/sync/commands.ts:193`) → inside `sql.transaction`, `runCommand(command, payload, context, postgresReader(tx, entry.orgId), TABLES)` (`commands.ts:301-307`).

**2. Device: `sqliteReader`** (`packages/sync/src/commands.ts:39`)
- Entry: `SetRestrictionsForm` (`apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:85`), rendered from `RestrictionToken` in `apps/web/src/features/rates/restrictions/list.tsx:462`.
- It calls `useCommand()` (`SetRestrictionsForm.tsx:123`) → `useCommand` (`apps/web/src/sync/useCommand.ts:16`) → `powerSync.writeTransaction((tx) => runLocalCommand(tx, command, payload, ctx))` (`useCommand.ts:46-47`) → `runLocalCommand` (`packages/sync/src/commands.ts:95`), which calls `runCommand(..., sqliteReader(tx, ctx.organizationId), TABLES)` (`commands.ts:108-114`).
- `useCommand` is the only UI consumer of `runLocalCommand`. Only `SetRestrictionsForm` consumes it.

**3. `MemoryStore`** (`packages/domain/src/commands/memory.ts:9`)
- An in-memory `StateReader` documented as for domain tests. The non-test search found no production caller, so it is not on a production `runCommand` path. I did not check whether `packages/domain` tests use it.

**Not implementations:** `StateReader` in `packages/domain/src/commands/query.ts:41` is the interface itself. `kernel.ts` (`runCommand` :126, `findById` :214, `requireById` :230) only accepts a reader.
