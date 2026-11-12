**Implementations of `StateReader.query()`** (interface declared at `packages/domain/src/commands/query.ts:41-44`):

1. `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query()`, an in-memory class (`implements StateReader`, line 9).
2. `packages/sync/src/commands.ts:41`: `sqliteReader()` returns the object's `query`, which reads the device's SQLite via `tx.getAll`.
3. `apps/api/src/sync/commands.ts:90`: `postgresReader()` returns the object's `query`, which reads Postgres via `tx.query`.

**Calls to `StateReader.query()`:**

1. `packages/domain/src/commands/kernel.ts:219`: `reader.query(...)` inside `findById`. `reader` is typed `StateReader` at line 214.
2. `packages/domain/src/commands/rates.ts:131`: `reader.query({ table: "room_types", ... })`.
3. `packages/domain/src/commands/rates.ts:135`: `reader.query({ ... })` for rules.
4. `packages/domain/src/commands/kernel.test.ts:50`: `reader.query(...)` inside a test command's `load`. The `reader` parameter has no annotation and is presumably contextually typed as `StateReader`; I didn't confirm that.

The other `.query(` hits in the repo are SQL runners or clients (`tx.query`, `sql.query`, `appDb.query`, `client.query`), `c.req.query`, or unrelated helpers, so I excluded them. No files were modified.