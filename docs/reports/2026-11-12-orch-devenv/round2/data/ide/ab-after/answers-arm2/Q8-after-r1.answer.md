I'll locate the `StateReader` declaration and search for `.query(` call sites in parallel.
The declaration is at `packages/domain/src/commands/query.ts:41`. Next I'll pull its references and implementations, and narrow the grep to `reader.query(` call sites.
The declaration and the `MemoryStore` implementation are confirmed. Next I'll find the method bodies in the other two implementations and check how `rates.ts` types its `reader`, since it didn't show up in the references.
Still need the exact `query` method lines in `memory.ts`, `apps/api/src/sync/commands.ts`, and `packages/sync/src/commands.ts`. I'll grep those three files directly.
**Calls of `StateReader.query()`** (4)

- `packages/domain/src/commands/kernel.ts:219` in `findById`, where `reader: StateReader` (line 214)
- `packages/domain/src/commands/rates.ts:131` in `load`, the `room_types` lookup
- `packages/domain/src/commands/rates.ts:135` in `load`, the `rules` lookup
- `packages/domain/src/commands/kernel.test.ts:50` in a test's `load`

The `rates.ts` reader isn't annotated; it is typed through the `load` signature in `kernel.ts:82`. I didn't check the test file's reader type.

**Implementations of `query()`** (3)

- `packages/domain/src/commands/memory.ts:20`: `MemoryStore.query`, the in-memory reader (`class MemoryStore` at line 9)
- `apps/api/src/sync/commands.ts:90`: `query` inside `postgresReader` (line 88)
- `packages/sync/src/commands.ts:41`: `query` inside `sqliteReader` (line 39)

The interface declaration is `packages/domain/src/commands/query.ts:43`.
