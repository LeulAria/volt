I'll read the defining file and grep the repo for `.query(` call sites in parallel.
The grep hits are partial, so I'll ask the language server for the method's references and implementations, and grep for `reader` call sites directly.
The API and sync readers are confirmed. Next I'll check `MemoryStore` in `memory.ts` and sweep for any `.query({` calls that use a differently named variable.
**Calls of `StateReader.query()`** (4):

- `packages/domain/src/commands/kernel.ts:219` (in `findById`)
- `packages/domain/src/commands/kernel.test.ts:50` (in `load`)
- `packages/domain/src/commands/rates.ts:131` (in `load`, `room_types` lookup)
- `packages/domain/src/commands/rates.ts:135` (in `load`, `rules` lookup)

**Implementations of `query()`** (3, plus the interface declaration):

- `packages/domain/src/commands/query.ts:43`: interface declaration (`StateReader`)
- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, the in-memory reader used by domain tests
- `packages/sync/src/commands.ts:41`: `sqliteReader`, the on-device reader
- `apps/api/src/sync/commands.ts:90`: `postgresReader`, the server reader, which adds `FOR UPDATE`

No files were modified.
