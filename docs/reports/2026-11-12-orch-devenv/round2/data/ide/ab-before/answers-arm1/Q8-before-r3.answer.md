**Declaration:** `packages/domain/src/commands/query.ts:43` (`StateReader.query(query: Query): Promise<Row[]>`)

**Calls on a StateReader (6 call sites in 3 files):**
- `packages/domain/src/commands/kernel.ts:219`: `findById`, via `reader.query({...})`
- `packages/domain/src/commands/kernel.test.ts:50`: `reader.query({ table: "room_status_history", ... })`
- `packages/domain/src/commands/rates.ts:131`: `reader.query({ table: "room_types", ... })`
- `packages/domain/src/commands/rates.ts:135`: `reader.query({ table: "rate_restrictions", ... })`

`requireById` (`kernel.ts:230`) takes a `StateReader` but has no direct `.query(` call in the search results. I assume it goes through `findById`, but I didn't open the body to confirm.

**Implementations (3):**
- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, which implements `StateReader` (`memory.ts:9`)
- `packages/sync/src/commands.ts:41`: `sqliteReader(...)`, returns an object literal with `query`
- `apps/api/src/sync/commands.ts:90`: `postgresReader(...)`, returns an object literal with `query`

I excluded the `.query(` calls on SQL runners and DB clients (for example `apps/api/src/sync/commands.ts:97`, `tx.query`, and the `sql.query` calls in `apps/api/src/sync/apply.ts`). I made no changes.