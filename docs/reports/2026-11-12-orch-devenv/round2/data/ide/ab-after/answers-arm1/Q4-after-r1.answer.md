**Request path: web "Confirm" → `bookings.create` → `bookings` INSERT**

1. **Submit button (web):** `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1139-1141` (Confirm button calls `handleCreateBooking`).
2. **Handler (web):** `step-2.tsx:407-418`. It guards on `createBlockedReason`, then calls `createMutation.mutateAsync({ ...buildBookingPayload(), idempotency_key })`. `buildBookingPayload` is at `step-2.tsx:270`.
3. **Mutation (web):** `step-2.tsx:182` wraps `orpc.bookings.create.mutationOptions(...)`. Its `onSuccess` (`step-2.tsx:~185`) navigates to step-3.
4. **oRPC client:** `apps/web/src/utils/orpc.ts:40-41` builds an `RPCLink` at `${VITE_SERVER_URL}/rpc`. `orpc` is created at `orpc.ts:160`.
5. **Server mount:** `apps/server/src/index.ts:1563-1567` runs `rpcHandler.handle(...)` with `prefix: "/rpc"`. The handler is defined at `index.ts:1559` over `appRouter`.
6. **Router:** `packages/api/src/routers/index.ts:228` mounts `bookings: bookingsRouter` (imported at `:19`).
7. **Procedure:** `packages/api/src/routers/bookings/index.ts:1583`, `create: requirePermission("reservations", "create")`. `requirePermission` is at `packages/api/src/services/rbac/permissions.ts:174`. The handler runs to about `:2541`.
8. **Key service calls in the handler:**
   - `claimIdempotency`: `packages/api/src/services/idempotency.ts:21` (called at `bookings/index.ts:1626`)
   - `assertBookingCreatable`: `packages/api/src/services/booking/createPreflight.ts:72` (called at `:1637`)
   - `priceBooking`: `packages/api/src/services/bookingQuote.ts:313` (called at `:1830`)
   - `allocateBookingReference`: `packages/api/src/utils/bookingReference.ts:104` (called at `:1649`)
   - `createWithTenantContext`: `packages/api/src/utils/tenant.ts:572`
9. **The INSERT:** `bookings/index.ts:2016`, `tx.insertInto("bookings").values(dataWithTenant).returningAll()`, inside a `kyselydb.transaction()` opened at `:1635`.

**Tables the `create` procedure inserts into directly (in its handler body):**
- `bookings`: `:2016`
- `booking_customer_info`: `:2059` (only when `customer_id` is set)
- `folios`: `:2110` (only when `customer_id` is set)
- `booking_rooms`: `:2273` (one per entry in `room_ids`)
- `booking_guarantees`: `:2349`

It also runs an `UPDATE bookings` at `:2384` to set `guarantee_id` and `hold_expires_at`. That is an update, not an insert.

**Writes that happen through service calls, not direct inserts in the procedure:**
- `booking_guests` via `replaceBookingGuests` (`:2064`)
- `booking_room_extra_options` via `insertBookingRoomExtraOptions` (`:2290`)
- `payments` (held advance) via `recordHeldDeposit` (`:2128`)
- `audit_logs` via `writeAuditLog` (`:2028`, `:2396`)
- promo use via `claimPromoUse` (`:2023`)
- room status via `setRoomStatus` (`:2308`)

Step-1's submit (`step-1.tsx:993`, `useBookingSubmit.handleSubmit`) only prepares form data and navigates to step-2. It does not create the booking.