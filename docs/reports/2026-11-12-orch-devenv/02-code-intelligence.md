# 02 - Code intelligence on the hotel project, with and without Volt's IDE tools

**Status: partial. The agent running this benchmark was stopped by the user before its runs were
recorded.** What is here, the copy of the user's own hotel app and nine relationship questions with
verified ground truth, is kept so the benchmark can be re-run. The finished code-intelligence and
IDE-tooling review is [parallel/02-code-intelligence.md](parallel/02-code-intelligence.md): an A/B
over 12 questions × 3 runs on a public hotel PMS (HAIP), before and after its fixes. Its
uncommitted code changes were not verified and are kept in `git stash` ("cancelled code-intel agent
partial work"), not in the branch.

## Setup

- Project: a copy of the user's hotel app (`~/Desktop/Projects/FALCON/hotel`, untouched) in
  `/private/tmp/vbench-hotel`: `apps/{api,server,web,worker}`, `packages/*`, `tooling/*` and the root
  configs, `rsync` without `node_modules`, `dist`, `.turbo`, reports and images (37 MB, 3,758 files
  in git). `AGENTS.md` removed (it tells agents to run the PMS factory scripts). `git init` + one commit.
- Dependencies: no install. `node_modules` (root and per workspace) are rebuilt as directories of
  symlinks (`/tmp/vbench-linknm.sh`): bun's relative workspace links (`@hotel/* -> ../../packages/*`,
  `.bun/...`) are copied verbatim so they resolve inside the copy, every other entry is an absolute
  link into the original `node_modules` (read only). The TypeScript server resolves cross-package
  imports to the copy.
- The copy is opened by its real path (`/private/tmp/...`): `/tmp` is a symlink on macOS and
  tsserver reports real paths (see the ground-truth note below).
- Model: Claude Haiku 5.5 (`claude-haiku-5-5`) in both arms.
- Arm 1 "agent only": Claude Code 2.1.322 headless, `claude -p <q> --model claude-haiku-5-5
  --output-format stream-json --verbose --strict-mcp-config --mcp-config={"mcpServers":{}}
  --allowedTools Bash,Read,Grep,Glob,Task,Agent,LS`, cwd = the copy, one fresh session per question,
  three sessions in parallel. Driver: `/tmp/vbench-gt/arm1.mjs`.
- Arm 2 "agent + Volt IDE tools": dev build of this branch, `--user-data-dir /tmp/vbench-ide-ud
  --remote-debugging-port=9975`, folder `/private/tmp/vbench-hotel`; the window titled
  "vbench-hotel" on the user's screen is this test instance. Settings: `volt.agent.defaultModel =
  agent:seed-claude-code:claude-haiku-5-5` (claude-agent-acp, Haiku 5.5 Medium). Code index ready
  (3,758 files) and tsserver warmed by opening two TS files before the runs. Each question in a fresh
  chat (Cmd+N), one at a time; numbers from `<ud>/User/voltTraces/<chat>.jsonl` (metrics line) and
  tool names from `tool.start`/`tool.update`. Driver: `/tmp/vbench-gt/arm2.mjs` (clicks "Always Run"
  when an approval appears, see Bugs).
- Same prompt in both arms: the question + "Answer concisely with file:line references. This is a
  read-only question: do not modify any files."

## Questions and ground truth

Ground truth was found with ripgrep and reading, and the reference questions were checked with the
TypeScript language service (`/tmp/vbench-gt/refs.cjs`: `findReferences` over the packages'
tsconfigs, TypeScript 6.0.3 from the project).

| # | Question (short) | Ground truth (file:line) |
|---|---|---|
| Q1 | What implements `StateReader`; production chain into `runCommand` | `MemoryStore` packages/domain/src/commands/memory.ts:9 (tests only); `postgresReader` apps/api/src/sync/commands.ts:88; `sqliteReader` packages/sync/src/commands.ts:39. Server: POST /api/sync/upload (apps/api/src/app.ts:106, routes/sync.ts:149/186) -> `applyUpload` (sync/apply.ts:269/274) -> `applyCommands` (sync/commands.ts:193, runCommand :301 with postgresReader :305). Device: `SetRestrictionsForm.tsx:123/129` -> `useCommand` (apps/web/src/sync/useCommand.ts:16/47) -> `runLocalCommand` (packages/sync/src/commands.ts:95, runCommand :108 with sqliteReader :112). |
| Q2 | oRPC procedures reaching `resolveBookingStayRent` | `bookings.quote` (routers/bookings/index.ts:1576/1580) -> `quoteBooking` (services/bookingQuote.ts:788/815) -> `priceBooking` (:313/362); `bookings.create` (index.ts:1583/1830) -> `priceBooking`. Web: step-2.tsx:182 (create) and :381 (quote), useBookingQuote.ts:69 (quote), QuickLoginBookingForm.tsx:323 (create, through `(orpc as any)`). Trap: `repriceBooking` (negotiatedRate.ts) does not reach it. |
| Q3 | Rename of `bookings.special_request_tags` | schema hotel.ts:458, migration 0127:100; generated sync/src/generated/schema.ts:342, contracts records.ts:692/6613, auth resource-fields.gen.ts:234; zod routers/bookings/validations.ts:72; handlers bookings/index.ts:1610, 1945 (create), 2683, 3003-3006 (update), frontDesk/index.ts:30/69/208, services/checkIn.ts:773/954; web: none. |
| Q4 | Booking creation path | step-2.tsx:182 `orpc.bookings.create` (+ QuickLoginBookingForm.tsx:323) -> utils/orpc.ts:41 RPCLink `/rpc` -> apps/server/src/index.ts:1559/1567 (and app.ts:363/378) RPCHandler -> routers/index.ts:228 -> bookings/index.ts:1583 `create` -> priceBooking :1830 -> `insertInto("bookings")` :2016. Direct inserts: bookings :2016, booking_customer_info :2059, folios :2110, booking_rooms :2273, booking_guarantees :2349. |
| Q5 | Tour store registrations / `createDrawer` readers | registerCreateDrawer CrudLayout/index.tsx:433; registerTableTour shared/Table/index.tsx:837; registerDetailTour customer-details/list.tsx:183. Readers: room-types/create.tsx:62, room-types/update.tsx:61, staff/members/InviteMemberForm.tsx:52, staff/roles/CreateRoleForm.tsx:91. |
| Q6 | Commands implementing `CommandDefinition` | `setRoomStatus` "rooms.setStatus" rooms.ts:30 (load :35, decide :43, audit :112), registry.ts:10, no web issuer (RoomLifecyclePanel.tsx:94 calls the oRPC `rooms.setStatus`, a different path); `setRateRestrictions` "rateRestrictions.set" rates.ts:121 (load :126, decide :143, audit :147), registry.ts:11, web SetRestrictionsForm.tsx:129. |
| Q7 | Procedures reaching `FiscalAdapter.register()` | register at finalInvoice.ts:332 in `issueFinalInvoiceTx` (:245). invoices.issue (invoices/index.ts:713/786), invoices.creditNote (:912/1477/1613), via `issueCheckoutInvoices` (finalInvoice.ts:436/578): checkout.settle (checkout/index.ts:1210/1427), checkout.expressCheckout (:1542/1591), quickService.quickCheckout (quickService/index.ts:393/531), and `closeCancelledFolio` (policyFee.ts:398/408) <- bookings.cancelWithPolicy (guarantee.ts:369/469, spread at bookings/index.ts:398). Only implementation `NoOpFiscalAdapter` (fiscal-adapter.ts:25); `setFiscalAdapter` (:38) never called. |
| Q8 | Calls and implementations of `StateReader.query` | calls kernel.ts:219, rates.ts:131, rates.ts:135, kernel.test.ts:50; implementations memory.ts:20, apps/api/src/sync/commands.ts:90, packages/sync/src/commands.ts:41 (TS `findReferences`, identical to the hand result). |
| Q9 | The two `insertBookingSchema`s | Different schemas. packages/validations/src/bookings/validations.ts:14 (+ `updateBookingSchema` :94) used by the web: useBookingForm.tsx:2/8, _journey.tsx:1/20/32, BookingJourney.tsx:2/14/65/77, useFormState.tsx:1/12, update.tsx:3/23. packages/api/src/routers/bookings/validations.ts:18 -> `quoteBookingSchema` :203, `insertBookingShapeWithoutDefaults` :237 -> `updateBookingSchema` :250; used by bookings.create `.input` index.ts:1584 (quote :1577). |

Scoring: 1 = complete and correct, 0.5 = right core with a missed path or a wrong item, 0 = wrong.
