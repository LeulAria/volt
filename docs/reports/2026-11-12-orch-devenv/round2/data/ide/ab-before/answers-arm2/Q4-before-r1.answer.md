I'll locate the booking web flow and the create procedure first, then trace each hop.
The Volt search tools aren't loaded yet, so I'll load them.
Key paths so far: `packages/api/src/routers/bookings/` and `apps/web/src/features/bookings/journey/`. Next I'll read the create procedure and the journey submit.
Create procedure is at `routers/bookings/index.ts:1583`, with its transaction at line 1635. Next I'll read the web submit path, the router mount, and every insert inside the procedure.
Inside the create transaction, the direct inserts are `bookings` (2016), `booking_customer_info` (2059), `folios` (2110), `booking_rooms` (2273) and `booking_guarantees` (2349). Next I'll read the web submit, the router mount and the audit write to confirm the rest.
I have the server and submit path. One more check: the web RPC client's base URL, so the hop from browser to `/rpc` is cited.
**Request path: booking submit → `bookings.create` → INSERT**

1. **Submit button**: `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141` (`onClick={handleCreateBooking}`).
2. **Handler**: `step-2.tsx:407-419` `handleCreateBooking` calls `createMutation.mutateAsync({...buildBookingPayload(), idempotency_key})`.
3. **Mutation**: `step-2.tsx:181-182` `useMutation(orpc.bookings.create.mutationOptions(...))`.
4. **Client transport**: `apps/web/src/utils/orpc.ts:40-41` `RPCLink` with url `${VITE_SERVER_URL}/rpc`.
5. **Server mount**: `apps/server/src/app.ts:363-380` `RPCHandler(appRouter)` with `prefix: "/rpc"`, mounted via `app.use("/*")`.
6. **Router**: `packages/api/src/routers/index.ts:19` imports `bookingsRouter`, and `:228` mounts it as `bookings: bookingsRouter`.
7. **Procedure**: `packages/api/src/routers/bookings/index.ts:1583` `create: requirePermission("reservations", "create").input(insertBookingSchema)`.
   - `:1626` `claimIdempotency` (scope `booking.create`), with replay returned early at `:1632`.
   - `:1635` `kyselydb.transaction()` starts.
   - `:1637` `assertBookingCreatable` (`services/booking/createPreflight`).
   - `:1641` `allocateBookingReference`.
   - `:2495` `recordRateApprovalsAtCreate` (inside the transaction).
   - `:2396` `writeAuditLog` (inside the transaction).
   - `:2534` `completeIdempotency`, then `:2535-2540` guest confirmation after commit.

**Tables the create procedure inserts into directly** (all inside the transaction at `index.ts:1635-2533`):
- `bookings`: `:2016`
- `booking_customer_info`: `:2059`
- `folios`: `:2110`
- `booking_rooms`: `:2273`
- `booking_guarantees`: `:2349`

Two other writes come from helpers, not direct inserts in the procedure: the audit log (`writeAuditLog`) and rate approvals (`recordRateApprovalsAtCreate`). I didn't open those helpers, so I can't name their tables. `booking_rooms` is also inserted by `commitStayModification` at `index.ts:2908`, which is a different procedure.

Nothing was modified.
