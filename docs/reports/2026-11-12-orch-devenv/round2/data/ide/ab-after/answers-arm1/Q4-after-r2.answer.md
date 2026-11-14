**Request path: booking create (web journey → `bookings.create` → `bookings` INSERT)**

1. **Submit button:** `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141` (`onClick={handleCreateBooking}`), defined at `step-2.tsx:407`. It calls `createMutation.mutateAsync({...buildBookingPayload(), idempotency_key})` at `step-2.tsx:411-414`.
   - `buildBookingPayload` is at `step-2.tsx:270`.
   - The mutation is `orpc.bookings.create.mutationOptions(...)` at `step-2.tsx:181-182`, with `onError` retrying through approval and restriction overrides (`step-2.tsx:~238-250`).
   - `step-1` submit (`_hooks/useBookingSubmit.tsx:18-40`) only prepares the form and navigates to step-2. `step-4.tsx` is a stub.
   - A second caller exists in `apps/web/src/features/bookings/quick-login/buildCreateBookingPayload.ts`.
2. **Client transport:** `apps/web/src/utils/orpc.ts` builds an `RPCLink` to `${VITE_SERVER_URL}/rpc` with the JWT header.
3. **Server mount:** `apps/server/src/index.ts:1559` (`rpcHandler = new RPCHandler(appRouter, …)`), mounted with `prefix: "/rpc"` at `index.ts:1567` on `app.use("/*")`. This is the live entry (`apps/server/package.json` main/dev). `apps/server/src/app.ts:363-378` is a parallel copy.
4. **Router:** `packages/api/src/routers/index.ts:302` exports `appRouter`, with `bookings: bookingsRouter` at `routers/index.ts:228`. `bookingsRouter` is in `packages/api/src/routers/bookings/index.ts`.
5. **Procedure guards:** `create` at `bookings/index.ts:1583` uses `requirePermission("reservations", "create")`, defined at `services/rbac/permissions.ts:174`. It sits on `protectedProcedure` (`packages/api/src/index.ts:69`: `publicProcedure` → `requireAuth` → `resourcePolicy`). The input schema is `insertBookingSchema`.
6. **Handler flow** (`bookings/index.ts:1583-2541`):
   - Idempotency claim: `claimIdempotency` (`services/idempotency.ts:21`).
   - One transaction at `index.ts:1635` (`kyselydb.transaction()`).
   - Preflight: `assertBookingCreatable` (`services/booking/createPreflight.ts:72`).
   - Reference allocation: `allocateBookingReference` (`utils/bookingReference.ts:104`).
   - Pricing and rates: `priceBooking` (`services/bookingQuote.ts:313`), `resolveBookingRateQuote` (`services/fxRates.ts:109`), `assertSellable` (`services/rateRestrictions.ts:559`), `pickCancellationPolicy` (`services/guarantee/index.ts:522`).
   - Availability and inventory: `assertRoomsAvailableForStay` (`lib/roomAvailability.ts:103`), `assertInventoryOrOverbook` (`services/overbooking.ts:328`).
   - **Main INSERT:** `index.ts:2016`, `tx.insertInto("bookings")`, with `createWithTenantContext` (`utils/tenant.ts:572`) at `index.ts:2002`.
   - After the INSERT: promo claim and audit (`services/ratePlans.ts:484`, `services/money-spine/auditLog.ts:24`), guests (`lib/bookingGuests.ts:12`), folio number (`services/money-spine/folioNumber.ts:43`), held deposit (`services/money-spine/deposits.ts:167`), bill-to (`services/companies/index.ts:496`), guarantee policy (`services/guarantee/index.ts:207`).
   - Commit, then `completeIdempotency` (`services/idempotency.ts:69`) and `notifyBookingConfirmation` (`services/notifications/bookingConfirmation.ts:181`, after the transaction).
   - Immediate check-in is optional: `checkInStay` (`services/checkIn.ts:240`).

**Tables the `create` procedure itself inserts into** (`packages/api/src/routers/bookings/index.ts`):

- `bookings`: line 2016, always.
- `booking_customer_info`: line 2059, only when `customer_id` is set.
- `booking_rooms`: line 2273, once per room in the `room_ids` loop.
- `folios`: line 2110, only when `customer_id` is set.
- `booking_guarantees`: line 2349, in an unguarded block (the policy may resolve to "none").

The helpers listed in step 6 write further tables (for example `booking_guests`, `booking_room_extra_options`, audit log, held deposits). I did not enumerate those tables.