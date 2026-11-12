**Calls of `StateReader.query()`** (5 call sites, all in `packages/domain/src/commands/`):

- `packages/domain/src/commands/kernel.ts:219`: `reader.query({...})` in `findById`
- `packages/domain/src/commands/rates.ts:131`: `reader.query({ table: "room_types", ... })` in `load`
- `packages/domain/src/commands/rates.ts:135`: `reader.query({...})` in `load`
- `packages/domain/src/commands/kernel.test.ts:50`: `reader.query({...})` in `load`

That is 4 call sites in 3 files. I counted 5 above by mistake; the language server reports 4 calls plus the interface declaration at `packages/domain/src/commands/query.ts:43`.

**Implementations of `query()`** (3 total):

- `packages/domain/src/commands/memory.ts:20`: `MemoryStore`, which `implements StateReader` (class at `memory.ts:9`)
- `apps/api/src/sync/commands.ts:90`: `query` method in the object returned by `postgresReader` (`apps/api/src/sync/commands.ts:88`)
- `packages/sync/src/commands.ts:41`: `query` method in the object returned by `sqliteReader` (`packages/sync/src/commands.ts:39`)

The two factory-based implementations were found by name matching, not type-checking, so they are not confirmed by the language server. The `.query(` text search found no other `reader.query` calls.
