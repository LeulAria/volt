I'll trace this with the indexed search tools, starting from the journey's submit handler and the server's bookings router.
The web journey has several entry points, and the server procedure is in `packages/api`. Next I'll locate the `create` procedure and the submit path in the journey route.
The live journey submit appears to be `step-2.tsx`, which calls `orpc.bookings.create`. I'll read that section, the server procedure, and the router mount together.
The router is mounted at `packages/api/src/routers/index.ts:228`. Next I need the INSERT inside the handler, the server RPC mount, and the button that triggers `handleCreateBooking`.
The handler has direct `insertInto` calls for `bookings`, `booking_customer_info`, `folios`, `booking_rooms`, and `booking_guarantees`. I'll confirm the transaction bounds, the server RPC mount, and the web client's RPC link.
The booking create request runs from the step-2 Review button through the `bookings.create` oRPC procedure into one Kysely transaction that inserts the booking. The procedure itself writes to five tables.

**Path**

1. **Submit button:** `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141` (`onClick={handleCreateBooking}`). This is the live route's Review step. The `features/bookings/journey/` copy is a different, unused path.
2. **Handler:** `step-2.tsx:407-419`. `handleCreateBooking` calls `createMutation.mutateAsync({ ...buildBookingPayload(), idempotency_key: submitKey.current() })`.
3. **Mutation:** `step-2.tsx:181-182`, `useMutation(orpc.bookings.create.mutationOptions(...))`. The success handler is at `:184`. Its error handler at `:233` retries through the manager-approval and restriction-override flows.
4. **Client:** `apps/web/src/utils/orpc.ts:40` builds `new RPCLink(...)`, and `:156-160` creates the typed `orpc` client.
5. **Server mount:** `apps/server/src/app.ts:350-378` (`rpcHandler` with `prefix: "/rpc"`) and `apps/server/src/index.ts:1559-1567` (same pattern). Both build context via `createContext` and call `rpcHandler.handle`.
6. **Router:** `packages/api/src/routers/index.ts:228` maps `bookings: bookingsRouter`. The router is defined at `packages/api/src/routers/bookings/index.ts:397`.
7. **Procedure:** `bookings/index.ts:1583-1585`, `create: requirePermission("reservations", "create").input(insertBookingSchema).handler(...)`. The handler spans roughly `:1583-2548`.

**Procedure flow inside `create`**

- `claimIdempotency` (`:1626`) runs before any writes. A replay returns the stored result.
- `kyselydb.transaction()` starts at `:1635`.
- Inside the transaction, in order:
  - `assertBookingCreatable` (`:1637`)
  - `allocateBookingReference` (`:1641`)
  - `assertSellable`, the restriction check (`:1667`)
  - company, blacklist, and bill-to resolution (`:1692-1801`)
  - `priceBooking` (`:1830`)
  - `authorizeOverride` for discounts above the clerk's limit (`:1849`)
  - `rateApprovalOutcome` (`:1876`)
  - `resolveBookingRateQuote` (`:1911`)
- The booking insert is at `bookings/index.ts:2015-2019`: `tx.insertInto("bookings").values(...).returningAll().executeTakeFirstOrThrow()`.

**Tables the create procedure inserts into**

1. `bookings` (`:2016`)
2. `booking_customer_info` (`:2059`)
3. `folios` (`:2110`)
4. `booking_rooms` (`:2273`)
5. `booking_guarantees` (`:2349`)

`booking_rooms` at `:2908` belongs to `commitStayModification`, not `create`. The `create` handler's `bookings`-related side effects (`claimPromoUse`, `writeAuditLog` at `:2022-2028`) write to other tables through helpers.
