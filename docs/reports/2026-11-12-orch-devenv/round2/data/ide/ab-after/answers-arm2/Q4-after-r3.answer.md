**Request path: booking submit → `INSERT INTO bookings`**

1. **Submit button:** `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:1141` (`onClick={handleCreateBooking}`).
2. **Client handler:** `step-2.tsx:407` `handleCreateBooking` calls `createMutation.mutateAsync({...buildBookingPayload(), idempotency_key})` at `:411`.
3. **Mutation:** `step-2.tsx:181-182` `useMutation(orpc.bookings.create.mutationOptions(...))`.
4. **oRPC client:** `apps/web/src/utils/orpc.ts:159-160` builds `client` and `orpc` on `createORPCClient(link)`. The `link` `fetch`es the request at `:137`.
5. **Server mount:** `apps/server/src/index.ts:1559-1569` creates `rpcHandler = new RPCHandler(appRouter)` and calls `rpcHandler.handle(req, {prefix: "/rpc"})` inside `app.use("/*")` at `:1563`. The same mount exists in `apps/server/src/app.ts:377-378`. `apps/api/src/legacy.ts:20` also describes serving `/rpc`, which I did not trace further.
6. **Router:** `packages/api/src/routers/index.ts:228` maps `bookings: bookingsRouter`, which is defined at `packages/api/src/routers/bookings/index.ts:397`.
7. **Procedure:** `bookings/index.ts:1583` `create: requirePermission("reservations", "create").input(insertBookingSchema).handler(...)`.
8. **Inside the handler:**
   - `:1626` `claimIdempotency`, which returns early on replay.
   - `:1635` `kyselydb.transaction().execute(tx => ...)`.
   - `:1637` `assertBookingCreatable`.
   - `:1641` `allocateBookingReference`.
   - `:1667` `assertSellable` (stop-sell, CTA/CTD, min/max stay).
   - `:1693` `loadCompany`.
   - `:1830` `priceBooking` (the same pricing `bookings.quote` shows).
   - `:1849` `authorizeOverride` (discount above the clerk's limit).
   - `:1876` `rateApprovalOutcome`.
   - `:1911` `resolveBookingRateQuote`.
   - `:1992` `pickCancellationPolicy`.
   - `:2002` `createWithTenantContext`.
   - **`:2016` `tx.insertInto("bookings").values(dataWithTenant).returningAll()`**, the INSERT into `bookings`.

**Tables written by the create procedure (in the same transaction, after the `bookings` insert):**

- `bookings`: `bookings/index.ts:2016`
- `booking_customer_info`: `:2059`
- `folios`: `:2110`
- `booking_rooms`: `:2273`
- `booking_room_extra_options`: via `insertBookingRoomExtraOptions` at `:2290`, which inserts at `packages/api/src/lib/bookingExtraOptions.ts:318`
- `booking_guarantees`: `:2349`
- `claimPromoUse` is called at `:2023`, but I did not check whether it inserts into a table.

Nothing was modified.
