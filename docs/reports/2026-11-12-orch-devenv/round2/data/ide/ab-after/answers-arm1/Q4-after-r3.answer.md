The create request runs from the review step's submit button through oRPC into `bookingsRouter.create` (`packages/api/src/routers/bookings/index.ts:1583`), and the `bookings` INSERT is at line 2016. The first step's submit (`useBookingSubmit.tsx:18`) only stores form state and navigates to step 2, so it does not create the booking.

**Request path**

1. **Submit button:** `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141` (`onClick={handleCreateBooking}`). Retry also calls it at `:1105`.
2. **Client handler:** `step-2.tsx:407-419` calls `createMutation.mutateAsync({ ...buildBookingPayload(), idempotency_key })`. The payload is built at `:270-377`, and the mutation is defined at `:181-267` as `orpc.bookings.create.mutationOptions(...)`. A quick-login path also calls the same procedure at `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323`.
3. **Web oRPC client:** `apps/web/src/utils/orpc.ts:40-160`. `RPCLink` posts to `${VITE_SERVER_URL}/rpc` with a JWT bearer header.
4. **Server mount:** the running app is `apps/api/src/index.ts`, which loads the legacy server through `apps/api/src/legacy.ts:55-59` (`import("server")`, using its `app` export). That `app` is `apps/server/src/index.ts:107`. The `/rpc` catch-all is at `apps/server/src/index.ts:1563-1569`, where `rpcHandler.handle(..., { prefix: "/rpc" })` runs. `apps/server/src/app.ts` has a parallel mount at `:374-380`, but the `server` package's main is `index.ts`.
5. **Router:** `packages/api/src/routers/index.ts:228` mounts `bookings: bookingsRouter`, defined at `packages/api/src/routers/bookings/index.ts:397`.
6. **Procedure guard:** `bookings/index.ts:1583` is `requirePermission("reservations", "create")`. That is defined at `packages/api/src/services/rbac/permissions.ts:174-201` and builds on `protectedProcedure` (`packages/api/src/index.ts:69`). The guard checks the role's grant via `getCachedAccess` and `checkAccess`.
7. **Handler, before the transaction:** `bookings/index.ts:1585-1632` strips client-supplied money fields and calls `claimIdempotency` (`packages/api/src/services/idempotency.ts:21`, scope `booking.create`).
8. **Transaction:** `bookings/index.ts:1635` opens `kyselydb.transaction()`. Inside it:
   - `assertBookingCreatable` (`services/booking/createPreflight.ts:72`)
   - `allocateBookingReference` (`utils/bookingReference.ts:104`)
   - `assertSellable` (`services/rateRestrictions.ts:559`)
   - `priceBooking` (`services/bookingQuote.ts:313`, called at `bookings/index.ts:1830`)
   - `resolveBookingRateQuote` (`services/fxRates.ts:109`, called at `:1911`)
   - `pickGuaranteePolicy` (`services/guarantee/index.ts:207`)
   - `assertInventoryOrOverbook` (`services/overbooking.ts:328`)
   - `assertRoomsAvailableForStay` (`lib/roomAvailability.ts:103`)
   - `replaceBookingGuests` (`lib/bookingGuests.ts:12`)
   - `allocateFolioNumber` (`services/money-spine/folioNumber.ts:43`)
   - `writeAuditLog` (`services/money-spine/auditLog.ts:24`)
9. **The INSERT:** `bookings/index.ts:2015-2019` is `tx.insertInto("bookings").values(dataWithTenant).returningAll()`.
10. **Post-commit:** `completeIdempotency` (`:2534`), then `notifyBookingConfirmation` (`:2536`, `services/notifications/bookingConfirmation.ts:181`). On failure, `releaseIdempotency` runs (`:2543`).

**Tables the create procedure inserts into directly**

From the handler body in `packages/api/src/routers/bookings/index.ts`:

- `bookings` (`:2016`), always
- `booking_customer_info` (`:2059`)
- `folios` (`:2110`), inside a branch I did not fully read
- `booking_rooms` (`:2273`), once per room
- `booking_guarantees` (`:2349`), when a guarantee policy applies

The helper calls inside the transaction also write rows, but I did not trace every one. Confirmed by grep: `audit_log` (`services/money-spine/auditLog.ts:26`), reached through `writeAuditLog`, and `invoice_series` (`services/money-spine/folioNumber.ts:79`), reached through `allocateFolioNumber`. Helpers I did not open that likely write rows: `replaceBookingGuests`, `insertBookingRoomExtraOptions` (`:2290`), `claimPromoUse`, `recordHeldDeposit`, `setRoomStatus`, `applyBookingBillTo`, `recordRestrictionOverride`, `recordRateApprovalsAtCreate`, `checkInStay`.

I did not modify any files.