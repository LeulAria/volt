I'll start by locating the booking submit handler and the bookings INSERT in the repo.
The journey's step-2 page calls `orpc.bookings.create`. Next I'll read the submit handler, the procedure, and the server mount.
The `create` procedure is at `bookings/index.ts:1583` and the INSERT at `:2016`. I'll read the procedure body and the server mount.
The procedure calls a series of services before the INSERT. I'll list every write inside the procedure and the imported service call sites.
The INSERT at `:2016` and four other writes fall in the create range. I'll confirm where the procedure ends and read the INSERT plus the service calls it makes.
The procedure body runs to just before `modifyStayPreview` at `:2549`. I'll check the two unlabelled `await tx` writes, the procedure tail, and which tables the helper services insert into.
I have the procedure's writes and helper writes. Last, I'll confirm the web oRPC client endpoint and the `/rpc` mount in the server entry.
**Request path: booking submit to `bookings` INSERT**

1. **Web journey submit.** The Review step's "Create" button (`apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1139-1141`) calls `handleCreateBooking` (`step-2.tsx:407-419`). That calls `createMutation.mutateAsync({...buildBookingPayload(), idempotency_key})`. The mutation is `orpc.bookings.create.mutationOptions(...)` (`step-2.tsx:181-182`). The payload is built at `step-2.tsx:270`.
2. **Client.** `orpc` is a TanStack Query wrapper over an `RPCLink` (`apps/web/src/utils/orpc.ts:40-41`) pointed at `${VITE_SERVER_URL}/rpc`. The JWT is attached in that link's `fetch`.
3. **Server mount.** `apps/server/src/index.ts:1559-1567`: `rpcHandler = new RPCHandler(appRouter, …)` is mounted with `prefix: "/rpc"` inside an `app.use("/*")` handler. `apps/api/src/legacy.ts:20` also documents an `/rpc` mount, so confirm which server is deployed.
4. **Router.** `packages/api/src/routers/index.ts:19,228` maps `bookings: bookingsRouter`. `bookingsRouter` is at `packages/api/src/routers/bookings/index.ts:397`. The `create` procedure is at `:1583`, guarded by `requirePermission("reservations", "create")` (`services/rbac/permissions.ts:174`) and validated with `insertBookingSchema`.
5. **Procedure body** (`bookings/index.ts`):
   - `claimIdempotency` (`:1626`), then a `kyselydb.transaction()` (`:1635`).
   - `assertBookingCreatable` (`services/booking/createPreflight.ts`, `:1637`).
   - `allocateBookingReference` (`utils/bookingReference`, `:1641`).
   - `assertSellable` (`:1667`), `loadCompany` (`:1693`).
   - `priceBooking` (`services/bookingQuote.ts`, `:1830`), `resolveBookingRateQuote` (`services/fxRates`, `:1911`).
   - `pickCancellationPolicy` (`:1992`).
   - **INSERT into `bookings`** at `:2015-2018`.

**Tables the create procedure inserts into directly:**
- `bookings` (`:2015`)
- `booking_customer_info` (`:2058`)
- `folios` (`:2109`)
- `booking_rooms` (`:2272`)
- `booking_guarantees` (`:2348`)

It also runs `UPDATE bookings` to set `guarantee_id` and `hold_expires_at` (`:2383`).

**Writes made by helpers called inside the same transaction** (not in the procedure body):
- `booking_guests` via `replaceBookingGuests` (`lib/bookingGuests.ts:56`, called at `:2064`).
- `booking_room_extra_options` via `insertBookingRoomExtraOptions` (`lib/bookingExtraOptions.ts:318`, called at `:2290`).
- `payments`, `folio_payments`, `payment_allocations`, `folio_charges` via `recordHeldDeposit` (`services/money-spine/deposits.ts`, called at `:2128`).
- `invoice_series` via `allocateFolioNumber` (`services/money-spine/folioNumber.ts`, `:2072`).
- `audit_log` via `writeAuditLog` (`:2028`, `:2396`).
- `rooms` and `room_status_history` via `setRoomStatus` (`utils/roomStatus.ts`, `:2308`, conditional).

Not traced: `applyBookingBillTo` (`:2420`) and the approval services, which may write further tables.
