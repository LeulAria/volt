**Request path: booking submit → `bookings` INSERT**

**Web (client)**
1. Submit button: `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141` (`onClick={handleCreateBooking}`).
2. `handleCreateBooking`: `step-2.tsx:407-419`. Blocks on `createBlockedReason`, then calls `createMutation.mutateAsync({...buildBookingPayload(), idempotency_key})` at `:411`.
3. Payload: `buildBookingPayload`, `step-2.tsx:270-377`.
4. Mutation: `orpc.bookings.create.mutationOptions(...)`, `step-2.tsx:181-267`. `onSuccess` navigates to step-3 (`:224`); `onError` handles approval and restriction overrides (`:237-251`).
5. Step-1 submit (`_hooks/useBookingSubmit.tsx:18-39`) only stores form data and navigates to step-2. It does not write.
6. Client transport: `apps/web/src/utils/orpc.ts:41` (`RPCLink` to `${VITE_SERVER_URL}/rpc`), `:156-160` (`createORPCClient` / `orpc`).

**Server (mount)**
7. `apps/server/src/app.ts:363` builds `rpcHandler`. `:377-378` routes `/rpc` requests to it.
8. On Lambda, `apps/server/src/apiApp.ts` wraps the legacy app, which handles `/rpc`.

**Router / procedure**
9. Root router mounts it at `packages/api/src/routers/index.ts:228` (`bookings: bookingsRouter`).
10. `create` is at `packages/api/src/routers/bookings/index.ts:1583`: `requirePermission("reservations","create")` (`services/rbac/permissions.ts:174`), with `.input(insertBookingSchema)` at `:1584`. `protectedProcedure` is at `packages/api/src/index.ts:69`.

**Key calls inside `create`** (all within `kyselydb.transaction` at `:1635` unless noted)
- Idempotency claim `:1626` → `services/idempotency.ts:21`
- `assertBookingCreatable` `:1637` → `services/booking/createPreflight.ts:72`
- `allocateBookingReference` `:1641` → `utils/bookingReference.ts:104`
- `assertSellable` `:1667` → `services/rateRestrictions.ts:559`
- `priceBooking` `:1830` → `services/bookingQuote.ts:313`
- `authorizeOverride` `:1849` (discounts above the clerk's limit)
- `resolveBookingRateQuote` `:1911`
- `pickCancellationPolicy` `:1992`
- `assertInventoryOrOverbook` `:2199` → `services/overbooking.ts:328`
- `setRoomStatus` `:2308`
- `checkInStay` `:2512` (immediate check-in only) → `services/checkIn.ts:240`
- `completeIdempotency` `:2534` → `services/idempotency.ts:69`

**Direct INSERT into `bookings`:** `packages/api/src/routers/bookings/index.ts:2015-2016` (`tx.insertInto("bookings").values(dataWithTenant).returningAll()`).

**Tables the create procedure body inserts into directly**
- `bookings` (`:2016`)
- `booking_customer_info` (`:2059`)
- `folios` (`:2110`)
- `booking_rooms` (`:2273`)
- `booking_guarantees` (`:2349`)

The procedure also runs `updateTable("bookings")` at `:2384` and `:2450`.

**Tables written through helpers called by `create`** (not inserted in the procedure body)
- `audit_log` via `writeAuditLog` (`:2028`, `:2396`, `:2458`; `services/money-spine/auditLog.ts:26`)
- `booking_guests` via `replaceBookingGuests` (`:2064`; `lib/bookingGuests.ts:56`)
- `booking_room_extra_options` via `insertBookingRoomExtraOptions` (`:2290`; `lib/bookingExtraOptions.ts:318`)
- `booking_rate_approvals` via `recordRateApprovalsAtCreate` (`:2495`; `services/booking/rateApproval.ts:147`)
- `rate_restrictions` via `recordRestrictionOverride` (`:2488`; `services/rateRestrictions.ts:760`)
- `promo_codes` via `claimPromoUse` (`:2023`; `services/ratePlans.ts:486`)
- Deposit and payment rows via `recordHeldDeposit` (`:2128`; `services/money-spine/deposits.ts:167`)
- `idempotency_records` (`services/idempotency.ts:32`)

I did not trace every nested write inside `recordHeldDeposit` or `checkInStay`. No files were modified.