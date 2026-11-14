**Calls of `reader.query(...)` on a StateReader** (4):

- `packages/domain/src/commands/kernel.ts:219`
- `packages/domain/src/commands/kernel.test.ts:50`
- `packages/domain/src/commands/rates.ts:131`
- `packages/domain/src/commands/rates.ts:135`

**Interface declaration:** `packages/domain/src/commands/query.ts:43` (`StateReader.query`)

**Implementations** (3):

- `packages/domain/src/commands/memory.ts:20` (`MemoryStore`, in-memory)
- `packages/sync/src/commands.ts:41` (`sqliteReader`, device-side)
- `apps/api/src/sync/commands.ts:90` (`postgresReader`, server-side)