**Request path: web submit → `INSERT INTO bookings`**

1. **Submit button**: `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141` (`onClick={handleCreateBooking}`), defined at `step-2.tsx:407`. It sends `buildBookingPayload()` (`step-2.tsx:270`) plus an `idempotency_key`.
2. **Mutation**: `step-2.tsx:182`, `orpc.bookings.create.mutationOptions(...)`, called at `step-2.tsx:411`.
3. **Client transport**: `apps/web/src/utils/orpc.ts:` `RPCLink` with `url: ${VITE_SERVER_URL}/rpc`, attaching the JWT.
4. **Server mount**: `apps/server/src/index.ts:1559` creates `RPCHandler(appRouter)`. The catch-all at `index.ts:1563-1567` dispatches `/rpc` requests to it. `apps/server/package.json` has `main: src/index.ts`. `apps/server/src/app.ts:363-378` has a parallel copy of this wiring that is not the entry.
5. **Root router**: `packages/api/src/routers/index.ts:19` imports `bookingsRouter`, and `:228` mounts it as `bookings`.
6. **Procedure**: `packages/api/src/routers/bookings/index.ts:1583`, `create: requirePermission("reservations", "create")`. The permission helper is at `packages/api/src/services/rbac/permissions.ts:174`.
7. **Handler flow** (`bookings/index.ts`, 1583 onward):
   - `extractTenantContext` at ~1585.
   - `claimIdempotency` at 1626.
   - `kyselydb.transaction()` at 1635.
   - Inside the transaction: `assertBookingCreatable` (createPreflight.ts) at 1637, `allocateBookingReference` at 1641, `assertSellable` at 1667, `priceBooking` at 1830, `resolveBookingRateQuote` at 1911, `pickCancellationPolicy` at 1992.
   - **INSERT into bookings**: `bookings/index.ts:2016`, `tx.insertInto("bookings")`.
   - After the insert: `claimPromoUse` and `writeAuditLog` (2023, 2028), `replaceBookingGuests` (2064), `allocateFolioNumber` (2072), `recordHeldDeposit` (2128), `assertRoomsAvailableForStay` (2155), `assertInventoryOrOverbook` (2199), `setRoomStatus` (2308), `pickGuaranteePolicy` (2324), `applyBookingBillTo` (2420), `recordRestrictionOverride` (2488), `recordRateApprovalsAtCreate` (2495), `checkInStay` for walk-ins (2512).
   - After the transaction: `completeIdempotency` (2534) and `notifyBookingConfirmation` (2536).

**Tables the create procedure inserts into directly** (within the `create` handler, lines 1583–2548):
- `bookings`: 2016
- `booking_customer_info`: 2059 (only when `customer_id` is set)
- `folios`: 2110 (only when `customer_id` is set)
- `booking_rooms`: 2273
- `booking_guarantees`: 2349

**Tables written indirectly through helpers** (for reference):
- `booking_guests`: `lib/bookingGuests.ts:56`
- `booking_room_extra_options`: `lib/bookingExtraOptions.ts:318`
- `payments`: `money-spine/deposits.ts:203` (held deposit)
- `invoice_series`: `money-spine/folioNumber.ts:79`
- `booking_rate_approvals`: `booking/rateApproval.ts:147`
- `audit_log`: `money-spine/auditLog.ts:26`
- `room_status_history`: `utils/roomStatus.ts:110`
- `idempotency_records`: `services/idempotency.ts:32`

The create handler also issues `UPDATE bookings` at 2384 and 2450. I did not modify any files.