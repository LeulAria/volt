**Procedures that reach `resolveBookingStayRent`: two, `bookings.quote` and `bookings.create`.** Nothing else in the router reaches it. `update`, `modifyStay`, `modifyStayPreview` and `repriceBookingDiscount` do not.

**1. `bookings.quote`**
- `packages/api/src/routers/bookings/index.ts:1576`: the procedure handler calls `quoteBooking` (`:1580`).
- `packages/api/src/services/bookingQuote.ts:788`: `quoteBooking` calls `priceBooking` in a read-only transaction (`:815`).
- `packages/api/src/services/bookingQuote.ts:313`: `priceBooking` calls `resolveBookingStayRent` (`:362`).
- `packages/api/src/lib/bookingPricing.ts:146`: the definition.

**2. `bookings.create`**
- `packages/api/src/routers/bookings/index.ts:1583`: the procedure handler calls `priceBooking` directly (`:1830`).
- `priceBooking` then calls `resolveBookingStayRent` as in step 1.

**Ruled out:** `priceBooking` has only these two callers. `quoteBooking` is referenced only by `bookings.quote`. `bookingsRouter.create` is referenced only from scripts and tests. `repriceBookingDiscount` (`index.ts:199`, used in `update` at `:3053`) and `negotiatedRate.ts`'s `repriceBooking` never reach `priceBooking` or `resolveBookingStayRent`.

**Web callers**
- `bookings.quote`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381` (`useQuery`)
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69`. This hook is consumed by `_components/BookingSummaryAside.tsx:78`.
  - `apps/web/src/features/bookings/journey/components/BookingQuoteSummary.tsx:15` is a type-only reference (`typeof client.bookings.quote`), not a call.
- `bookings.create`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182` (mutation)
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` (mutation, via `(orpc as any)`)
- Playwright e2e files also call `bookings.create` through an RPC helper: `apps/web/e2e/helpers/rpc.ts:50`, `apps/web/e2e/check-in/direct/check-in-gates.spec.ts:93`, `apps/web/e2e/companies/accounts/company-accounts.spec.ts:316`.

No files were modified.