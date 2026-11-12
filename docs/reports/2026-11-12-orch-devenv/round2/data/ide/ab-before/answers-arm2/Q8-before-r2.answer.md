I'll start by reading the file that defines `query()` and searching the index for `query` declarations.
The index shows three `query` method implementations and some `reader.query(` call sites, but the grep output may be incomplete. I'll search for `reader.query(` specifically and ask the language server for the interface's implementations.
The language-server lookup needs a column too, so I'll retry it with one, and read the three implementation sites.
Three implementations found. Before reporting, I'll confirm the declared type of `reader` at each call site and search for call sites that use other variable names.
**Interface declaration:** `packages/domain/src/commands/query.ts:43` (`StateReader.query(query: Query)`)

**Call sites** (`reader.query(...)` on a `StateReader`):
- `packages/domain/src/commands/kernel.ts:219`: `findById`
- `packages/domain/src/commands/rates.ts:131`: `setRateRestrictions.load`, room types lookup
- `packages/domain/src/commands/rates.ts:135`: `setRateRestrictions.load`, rate restrictions lookup
- `packages/domain/src/commands/kernel.test.ts:50`: `setRoomStatus.load` in the test

`requireById` (`kernel.ts:236`) reads through `findById`, so it isn't a direct call.

**Implementations:**
- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, in-memory store used by tests
- `packages/sync/src/commands.ts:41`: `sqliteReader`, device reader over local SQLite
- `apps/api/src/sync/commands.ts:90`: `postgresReader`, server reader that runs `SELECT ... FOR UPDATE`

The language server is off for this checkout, so the implementations list comes from a text search for `StateReader` and a symbol search, not from a language-server lookup. The call-site search covers `reader.query(` and `.query({ table`, so a call through a differently named variable could be missed.
