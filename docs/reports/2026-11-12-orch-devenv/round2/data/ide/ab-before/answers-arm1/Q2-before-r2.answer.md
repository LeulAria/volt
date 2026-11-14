**Procedures that reach `resolveBookingStayRent`:** two, both on `bookings`, mounted at `packages/api/src/routers/index.ts:228`.

1. **`bookings.quote`**
   - `packages/api/src/routers/bookings/index.ts:1576-1581` (handler calls `quoteBooking` at :1580)
   - → `quoteBooking` (`services/bookingQuote.ts:788`), which calls `priceBooking` at :815
   - → `priceBooking` (`services/bookingQuote.ts:313`), which calls `resolveBookingStayRent` at :362
   - → `resolveBookingStayRent` (`lib/bookingPricing.ts:146`)

2. **`bookings.create`**
   - `packages/api/src/routers/bookings/index.ts:1583` (handler calls `priceBooking` directly at :1830)
   - → `priceBooking` (`services/bookingQuote.ts:313`)
   - → `resolveBookingStayRent` (`lib/bookingPricing.ts:146`)

No other procedure reaches it. `priceBooking` has only these two callers, and `resolveBookingStayRent` has only the one call site.

**Web files calling these procedures** (excluding tests, e2e, and the generated `.tanstack/tmp` copy):

`bookings.quote`
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381` (`orpc.bookings.quote.queryOptions`)
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69` (the shared hook; it is used by `_components/BookingSummaryAside.tsx:78`, which step-1 renders)

`bookings.create`
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182` (`orpc.bookings.create.mutationOptions`)
- `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` (`(orpc as any).bookings.create.mutationOptions`)

Type-only references, not calls: `features/bookings/journey/components/BookingQuoteSummary.tsx:15` and `_utils/useBookingQuote.ts:16`.

I made no file changes.