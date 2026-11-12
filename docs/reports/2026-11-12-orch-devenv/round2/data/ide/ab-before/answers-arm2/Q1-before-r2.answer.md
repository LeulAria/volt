I'll search the codebase for `StateReader` implementations and object literals typed as it.
The grep found two production implementations (`postgresReader`, `sqliteReader`), plus `MemoryStore`. Next I'll look for callers of `runCommand` and any untyped object literals with a `query` method.
Both production readers are called from a single `runCommand` site each. I'll trace the callers upward to the HTTP route and UI entry points.
That search was too broad. I'll narrow it to the callers of the two server and device entry functions.
The code-nav calls need line numbers, so I'll use narrow greps to get the call sites instead.
I have the call sites. Now I'll read the actual code around each one to confirm the chain and the route path.
The device and server paths are clear. I still need the HTTP method and path of the upload route, and which UI code uses `useCommand`.
I'll do one more search to see whether `useCommand` has other UI callers beyond the rate restrictions form.
Three types implement `StateReader`: two production readers and one in-memory store used by tests. No object literal is annotated as `StateReader` anywhere in the repo.

**Production implementations**

1. **Server (Postgres):** `postgresReader` at `apps/api/src/sync/commands.ts:88`, with `query` at `:90`.
   - Entry point: `POST /api/sync/upload`, defined at `apps/api/src/routes/sync.ts:149-150` and mounted at `apps/api/src/app.ts:106`. The Lambda app in `apps/server/src/apiApp.ts` also serves this route.
   - `routes/sync.ts:186` calls `applyUpload`, which at `apps/api/src/sync/apply.ts:269-274` forwards to `applyCommands` (`apps/api/src/sync/commands.ts:193`).
   - `apps/api/src/sync/commands.ts:301-307` calls `runCommand(command, entry.payload, context, postgresReader(tx, entry.orgId), TABLES)` inside the upload transaction.

2. **Device (SQLite):** `sqliteReader` at `packages/sync/src/commands.ts:39`, with `query` at `:41`.
   - UI entry point: the rate restrictions form. `apps/web/src/features/rates/restrictions/SetRestrictionsForm.tsx:123` gets `runCommand` from `useCommand()`, and `:129` calls `runCommand(setRateRestrictions, variables)`. The form is rendered from `apps/web/src/features/rates/restrictions/list.tsx:462`.
   - `apps/web/src/sync/useCommand.ts:46-48` wraps `runLocalCommand` in `powerSync.writeTransaction`.
   - `packages/sync/src/commands.ts:95` (`runLocalCommand`) calls `runCommand` at `:108`, passing `sqliteReader(tx, ctx.organizationId)` at `:112`.
   - `runLocalCommand` is exported from `packages/sync/src/index.ts:26`.
   - `SetRestrictionsForm` is the only UI consumer of `useCommand` in `apps/web/src`.

**Test-only implementation**

3. **`MemoryStore`:** `packages/domain/src/commands/memory.ts:9`, with `query` at `:20`. It is used by `packages/domain/src/commands/kernel.test.ts` and has no production call chain.

**Where `runCommand` is defined:** `packages/domain/src/commands/kernel.ts:122`. The `reader: StateReader` parameter is at `:126`.

I did not open `kernel.test.ts`'s `hotel()` helper. The grep found no `StateReader`-typed literal there, so I assume it returns `MemoryStore`. I did not trace how the device's sync connector uploads queued commands to `/api/sync/upload`. I made no file changes.
