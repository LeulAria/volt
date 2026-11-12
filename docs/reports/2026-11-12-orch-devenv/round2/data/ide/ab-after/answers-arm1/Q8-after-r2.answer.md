**Calls of `StateReader.query()`** (5 total)

- `packages/domain/src/commands/kernel.ts:219`: `findById`, via `reader.query({...})`. Its `requireById` wrapper (line 230) delegates to it.
- `packages/domain/src/commands/rates.ts:131`: `reader.query({ table: "room_types", ... })` in the `rateRestrictions.set` load step.
- `packages/domain/src/commands/rates.ts:135`: `reader.query({ table: "rate_restrictions", ... })` in the same load step.
- `packages/domain/src/commands/kernel.test.ts:50`: `reader.query({ table: "room_status_history", ... })` in a test command's `load`. The `reader` is the `StateReader` that `load` receives.

**Implementations of `StateReader.query()`** (3 total)

- `packages/domain/src/commands/query.ts:43`: the interface declaration itself.
- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, the in-memory class that `implements StateReader`.
- `packages/sync/src/commands.ts:41`: `sqliteReader`, the on-device reader over SQLite.
- `apps/api/src/sync/commands.ts:90`: `postgresReader`, the server reader inside the upload transaction.

I excluded `.query` calls on SQL runners and DB clients, such as `apps/api/src/sync/apply.ts`, `apps/api/src/lib/sql.ts:8`, and `apps/api/src/sync/commands.ts:97`.