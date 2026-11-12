I'll trace this with the indexed search tools, starting from the booking journey's submit handler and the server's bookings create procedure.
The live submit appears to be in the route's step-2 (mutation at line 182, `handleCreateBooking` at 407) and `useBookingSubmit.tsx`. Next I'll read those plus the server procedure at `bookings/index.ts:1584`.
The procedure body continues past line 1660, so I need the INSERTs. I'll read the rest of `create` and locate the server mount and the web RPC client in parallel.
Still need the INSERT statements inside `create`, the router composition, and the web RPC client. Reading those in parallel.
The `create` handler inserts into `bookings`, `booking_customer_info`, `folios`, and (at lines 2273 and 2349) `booking_rooms` and `booking_guarantees`, though I still need to confirm those last two fall inside `create`. Reading that section along with the web submit wiring.
I have the write path confirmed. Last pieces: the step-1 submit wiring, the web RPC client base path, the `bookings` router mount, and the end of `create` to confirm the transaction boundary.
The indexed search rejected that combined path query, so I'll fall back to a read-only `rg` for the remaining hops.
The create path runs from the step-1 form submit through a route-level step-2 mutation to `bookings.create` on the oRPC server, which writes the `bookings` row inside one transaction. I made no file changes.

**Request path**

1. **Step 1 form submit:** `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-1.tsx:944-945` wraps `form.handleSubmit` around `handleSubmit`, which is set up at `step-1.tsx:83` from `useBookingSubmit`.
2. **Prepare and stash:** `_hooks/useBookingSubmit.tsx:18-38` calls `prepareBookingFormData` (image uploads), stores the result with `updateFormData`, and navigates to `/journey-steps/booking/step-2`.
3. **Step 2 review and submit:** `step-2.tsx:407-419` (`handleCreateBooking`) calls `createMutation.mutateAsync({ ...buildBookingPayload(), idempotency_key })`. The button is at `step-2.tsx:1141`, and `buildBookingPayload` is at `step-2.tsx:270`.
4. **Mutation:** `step-2.tsx:181-182` binds `orpc.bookings.create.mutationOptions(...)`. `onSuccess` is at `step-2.tsx:184`.
5. **Web RPC client:** `apps/web/src/utils/orpc.ts:40-41` uses `RPCLink` with `url: ${VITE_SERVER_URL}/rpc`. The typed client is created at `orpc.ts:156`.
6. **Server mount:** `apps/server/src/index.ts:1559-1580` builds an `RPCHandler(appRouter)` and serves it under `/rpc` with `prefix: "/rpc"`. `apps/server/src/app.ts:363-378` has the same pattern.
7. **Router:** `packages/api/src/routers/index.ts:302` exports `appRouter`, and line 228 mounts `bookings: bookingsRouter` (imported at line 19).
8. **Procedure:** `packages/api/src/routers/bookings/index.ts:1583-1585` defines `create`, gated by `requirePermission("reservations", "create")` and validated with `insertBookingSchema`.
9. **Key service calls inside the procedure:**
   - `claimIdempotency` (`:1626`) for replay protection.
   - `kyselydb.transaction()` opens at `:1635`.
   - `assertBookingCreatable` (`:1637`), `allocateBookingReference` (`:1641`), `assertSellable` (`:1667`), the blacklist check (`:1767`).
   - Billing resolution: `loadCompany` (`:1693`) and `billTo` logic (`:1731`).
   - `priceBooking` (`:1830`) and discount authorization (`:1849`).
   - `pickCancellationPolicy` (`:1992`) and `createWithTenantContext` (`:2002`).
   - Room checks and writes: `assertRoomsAvailableForStay` (`:2155`), `assertInventoryOrOverbook` (`:2199`), `insertBookingRoomExtraOptions` (`:2290`), `setRoomStatus` (`:2308`).
   - Guarantee: `pickGuaranteePolicy` (`:2324`) and `buildResolvedGuarantee` (`:2335`).
   - Advance payment: `recordHeldDeposit` (`:2128`).
   - Audit: `writeAuditLog` (`:2396`).

**Tables the create procedure inserts into directly**

- `bookings`: `bookings/index.ts:2016` (returns the row used for the rest of the transaction).
- `booking_customer_info`: `:2059`, only when `customer_id` is set.
- `folios`: `:2110`, only when `customer_id` is set.
- `booking_rooms`: `:2273`, once per room line.
- `booking_guarantees`: `:2349`.

It also runs an `UPDATE bookings` (`:2384`) to link `guarantee_id` and `hold_expires_at`, and an `UPDATE bookings` at `:2449` if a credit hold applies.

Helpers it calls also write: `insertBookingRoomExtraOptions` (`booking_room_extra_options`), `recordHeldDeposit` (a held `payments` row), `setRoomStatus` (`rooms`), `replaceBookingGuests`, `claimPromoUse`, and `applyBookingBillTo`. I did not open those helpers, so their target tables are not verified here.

A second web caller exists: `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` also calls `orpc.bookings.create`, with its payload built by `buildCreateBookingPayload.ts`.
