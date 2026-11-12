**Calls of `StateReader.query()`** (3 direct, all `reader.query(...)`):

- `packages/domain/src/commands/kernel.ts:219`: `findById`, which takes `reader: StateReader` (line 214).
- `packages/domain/src/commands/rates.ts:131`: `rateRestrictions.set` `load`, room types lookup.
- `packages/domain/src/commands/rates.ts:135`: same `load`, `rate_restrictions` lookup.

`packages/domain/src/commands/kernel.test.ts:50` also calls `reader.query(...)`, in a test's `load`. It counts as a call site even though it's test code.

Indirect callers: `requireById` (`kernel.ts:236`) calls `findById`, so any command using `requireById` also reaches `query()` through it. I didn't enumerate those.

**Implementations of `StateReader.query`** (3):

- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, in-memory (`implements StateReader` at line 9).
- `packages/sync/src/commands.ts:41`: `sqliteReader`, on-device SQLite via `toSql(..., "sqlite")`.
- `apps/api/src/sync/commands.ts:90`: `postgresReader`, server-side Postgres via `toSql(..., "postgres")`, adding `FOR UPDATE`.

The interface declaration is at `packages/domain/src/commands/query.ts:43`.