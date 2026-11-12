I'll locate the `StateReader` declaration and search the codebase for `.query(` calls and implementations.
Found the interface at `query.ts:43` and calls at `kernel.ts:219`, `rates.ts:131`, `rates.ts:135`, and `kernel.test.ts:50`. Next I'll check the implementations and the other StateReader consumers.
**Calls of `StateReader.query()`** (`reader.query(...)`):

- `packages/domain/src/commands/kernel.ts:219`: `findById`
- `packages/domain/src/commands/rates.ts:131`: `load`, one branch of a ternary
- `packages/domain/src/commands/rates.ts:135`: `load`
- `packages/domain/src/commands/kernel.test.ts:50`: `load` (test code)

**Implementations of `StateReader.query()`**:

- `apps/api/src/sync/commands.ts:90`: `postgresReader`, server side
- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, in-memory store
- `packages/sync/src/commands.ts:41`: `sqliteReader`, device side

The interface declaration is at `packages/domain/src/commands/query.ts:43`. The other `.query(` hits in the repo are SQL runners or HTTP/DOM, so I left them out. I did not modify any files.
