**Calls of `reader.query(...)` on a StateReader**

- `packages/domain/src/commands/kernel.ts:219`: `findById`, where `reader: StateReader` (`kernel.ts:214`)
- `packages/domain/src/commands/rates.ts:131`: `setRateRestrictions.load`, room-type lookup
- `packages/domain/src/commands/rates.ts:135`: `setRateRestrictions.load`, rate-restriction lookup
- `packages/domain/src/commands/kernel.test.ts:50`: `room.setStatus` `load`. I didn't read the `reader` type here; it's inferred from the `load(reader: StateReader, …)` signature at `kernel.ts:82`.

The `reader` in the two `rates.ts` calls and the test is also inferred from that `load` signature, not read directly.

**Declaration**

- `packages/domain/src/commands/query.ts:43`: `StateReader.query(query: Query): Promise<Row[]>` (interface method, not an implementation)

**Implementations**

- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query` (class implements `StateReader`)
- `apps/api/src/sync/commands.ts:90`: `postgresReader(...)`, returned object's `query`
- `packages/sync/src/commands.ts:41`: `sqliteReader(...)`, returned object's `query`

I made no file changes.