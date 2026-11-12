I'll trace this from the web booking journey down to the bookings INSERT, starting with where `BookingJourney` is mounted and what its submit calls.
The live journey appears to be under `routes/journey-steps/.../_journey/`, with `useBookingSubmit.tsx` as the submit hook. I'll read that hook and find the `bookings.create` procedure.
`useBookingSubmit` only stores form state and navigates, so the actual submit should be in step 3. I'll read that and the `create` procedure.
Now I need the actual `insertInto` calls inside the create handler, the step-2 submit call site, and the server mount chain.
The index can't run that pattern in this sandbox, so I'll use `grep -n` directly to find the INSERTs and the router mount.
The create handler has five direct `insertInto` calls. I'll confirm where the handler ends, check the 2016 INSERT context, and verify the live server mount and web client URL.
Five direct INSERTs sit inside the `create` handler (lines 1583–2548); the `booking_rooms` insert at 2908 belongs to a different procedure. One last check for the client base URL, the lambda entry, and the service-call line numbers.
The live request path is `step-2.tsx:407` → `orpc.bookings.create` → `apps/server/src/index.ts:1563` → `packages/api/src/routers/bookings/index.ts:1583` → `bookings` INSERT at `:2016`. The `create` procedure itself inserts into five tables.

**Hops**

1. **Web submit.** `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx`
   - `handleCreateBooking` (`:407-419`) calls `createMutation.mutateAsync({ ...buildBookingPayload(), idempotency_key })`.
   - `createMutation` is `orpc.bookings.create.mutationOptions(...)` (`:181-182`). Its `onSuccess` (`:184`) navigates to `/journey-steps/booking/step-3`; `onError` (`:233`) retries after manager approval or restriction override.
   - `buildBookingPayload` is at `:270`.
   - Step 1 (`useBookingSubmit.tsx:18-39`) only prepares form data and navigates to step 2; it does not call the API.
2. **Web client.** `apps/web/src/utils/orpc.ts:41` sends to `${VITE_SERVER_URL}/rpc` via `RPCLink`.
3. **Server mount.** `apps/server/src/index.ts:1559` creates `RPCHandler(appRouter)`. The `app.use("/*")` at `:1563-1566` dispatches requests with the `/rpc` prefix. `apps/server/src/app.ts:363-378` has the same wiring; I did not confirm which file the Lambda build uses.
4. **Router.** `packages/api/src/routers/index.ts:228` maps `bookings: bookingsRouter`, imported from `./bookings/index` (`:19`).
5. **Procedure.** `packages/api/src/routers/bookings/index.ts:1583`: `create: requirePermission("reservations","create").input(insertBookingSchema).handler(...)`. The handler runs inside `kyselydb.transaction()` (`:1635`).
   - Key service calls: `claimIdempotency` (`:1626`), `assertBookingCreatable` (`:1637`, from `services/booking/createPreflight`), `allocateBookingReference` (`:1641`), `assertSellable` (`:1667`, restriction check), `loadCompany` (`:1693`), `priceBooking` (`:1830`, from `services/bookingQuote`), and `replaceBookingGuests` (`lib/bookingGuests`, `:2064`).

**Tables the `create` procedure inserts into directly** (all within lines 1583–2548):

| Line | Table |
|---|---|
| 2016 | `bookings` (the booking row, the one the request ends on) |
| 2059 | `booking_customer_info` |
| 2110 | `folios` |
| 2273 | `booking_rooms` |
| 2349 | `booking_guarantees` |

Other tables are written indirectly through helpers: `booking_guests` via `replaceBookingGuests`, and `booking_room_extra_options` via `priceBooking`. I did not trace those helpers. The `insertInto("booking_rooms")` at `:2908` belongs to a different procedure, not `create`.

Note: `apps/web/src/features/bookings/journey/BookingJourney.tsx` also exists with an `onSubmit` prop, but the route above is the live journey that calls `bookings.create`.
