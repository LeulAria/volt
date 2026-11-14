I'll locate the `StateReader` declaration and its `query` method first, then trace the references.
The language server only reports the interface itself, so I need to check the candidate files for the actual `.query(` call sites and implementations.
Next I'll read the `postgresReader` and `sqliteReader` bodies and search for other `reader.query` call sites across the repo.
Three call sites so far are in `kernel.ts`, `kernel.test.ts`, and `rates.ts`. I'll confirm their receivers are typed `StateReader`, and sweep the repo for `.query({` calls that take a `Query` object, which is the StateReader signature.
**Call sites of `StateReader.query()`** (4 total):

- `packages/domain/src/commands/kernel.ts:219`: `reader.query({...})` inside `findById`, where `reader: StateReader` (param at line 214).
- `packages/domain/src/commands/kernel.test.ts:50`: `reader.query({...})` inside the `load` of a test command. `reader` is typed by `CommandDefinition.load` (`kernel.ts:82`), so it is a `StateReader`.
- `packages/domain/src/commands/rates.ts:131`: `reader.query({ table: "room_types", ... })` inside `setRateRestrictions.load`.
- `packages/domain/src/commands/rates.ts:135`: `reader.query({ table: "rate_restrictions", ... })` in the same `load`.

**Implementations of `query()`** (4 total):

- `packages/domain/src/commands/query.ts:43`: the interface declaration, `query(query: Query): Promise<Row[]>`.
- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, the in-memory implementation (`class MemoryStore implements StateReader` at line 9).
- `apps/api/src/sync/commands.ts:90`: `postgresReader(...)`'s returned `query`, which runs `FOR UPDATE` against Postgres.
- `packages/sync/src/commands.ts:41`: `sqliteReader(...)`'s returned `query`, which runs against the local SQLite transaction.

The language server only type-checks the domain project, so I matched the other call sites by name and read them. I searched the whole repo for `reader...query(` and for `.query({` and `.query(query`, and found no other StateReader calls. A call through a differently named variable that is not a `Query` object literal would not have matched that search.
