**Request path: web "Submit" → `bookings.create` → `INSERT INTO bookings`**

**Web (client)**
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141`: the review-step button, `onClick={handleCreateBooking}`.
- `step-2.tsx:407`: `handleCreateBooking` calls `createMutation.mutateAsync({ ...buildBookingPayload(), idempotency_key })`. `buildBookingPayload` is at `step-2.tsx:270`.
- `step-2.tsx:181`: `useMutation(orpc.bookings.create.mutationOptions(...))`.
- `apps/web/src/utils/orpc.ts:159`: `client` is the typed oRPC client. Its `RPCLink` (around `orpc.ts:50`) posts to `${VITE_SERVER_URL}/rpc` with a JWT bearer header.

**Server (mount)**
- `apps/server/src/index.ts:1566-1567`: `app.use("/*")` runs `rpcHandler.handle(req, { prefix: "/rpc" })`. `rpcHandler` is `new RPCHandler(appRouter)` near `index.ts:1555`.
- `apps/server/src/app.ts:376-378` has the same mount. `apiApp.ts:18` wraps `./index` as `legacyApp` for the Lambda path.

**Router**
- `packages/api/src/routers/index.ts:302`: `appRouter`. `:228` registers `bookings: bookingsRouter`.
- `packages/api/src/routers/bookings/index.ts:397`: `bookingsRouter`.
- `bookings/index.ts:1583`: `create: requirePermission("reservations", "create")`, defined in `services/rbac/permissions.ts:174`.
- `.input(insertBookingSchema)` is in `bookings/validations.ts:18`.

**Create handler (`bookings/index.ts:1583-2540`)**
1. `:1626` `claimIdempotency` (`services/idempotency.ts:21`, scope `booking.create`). A replay returns early.
2. `:1635` `kyselydb.transaction()`.
3. `:~1638` `assertBookingCreatable` (`services/booking/createPreflight.ts:72`).
4. `:1641` `allocateBookingReference` (`utils/bookingReference`).
5. `:~1667` `assertSellable` (restrictions).
6. `:1830` `priceBooking` (`services/bookingQuote.ts:313`). `:1911` `resolveBookingRateQuote`.
7. `:1992` `pickCancellationPolicy`.
8. **`:2016` `INSERT INTO bookings`**, then `claimPromoUse` and `writeAuditLog` at `:2023-2028`.
9. Later steps: `:2064` `replaceBookingGuests`, `:2128` `recordHeldDeposit`, `:2308` `setRoomStatus`, `:2420` `applyBookingBillTo` (`services/companies/index.ts:496`), `:2534` `completeIdempotency`.
10. `:2536` `notifyBookingConfirmation`, after the commit.

**Tables the create procedure inserts into directly (in its own body)**
- `bookings` (`:2016`)
- `booking_customer_info` (`:2059`, only if `customer_id`)
- `folios` (`:2110`, only if `customer_id`)
- `booking_rooms` (`:2273`, one per room line)
- `booking_guarantees` (`:2349`). It also runs `UPDATE bookings` (guarantee link and hold) right after.

**Tables written through helpers it calls (not inserted in the handler body)**
- `booking_guests` (`lib/bookingGuests.ts:56`)
- `booking_room_extra_options` (`lib/bookingExtraOptions.ts:318`)
- `payments`, `folio_payments`, `payment_allocations`, `folio_charges` (`services/money-spine/deposits.ts`, via `recordHeldDeposit`)
- `invoice_series` (`money-spine/folioNumber.ts:79`)
- `audit_log` (`money-spine/auditLog.ts:26`)
- `room_status_history` (`utils/roomStatus.ts:110`)
- `room_type_overbooking` (`services/overbooking.ts:582`)
- `idempotency_records` (`services/idempotency.ts:32`)

I did not trace every helper's internals, so the helper list above may be incomplete. No files were modified.