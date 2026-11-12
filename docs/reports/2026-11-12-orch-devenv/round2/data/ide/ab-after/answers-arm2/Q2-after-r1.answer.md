Two oRPC procedures reach `resolveBookingStayRent`: `bookings.quote` and `bookings.create`. No other procedure reaches it through the static call graph, and the web app calls both.

**Call chains**

1. **`bookings.quote`** (`packages/api/src/routers/bookings/index.ts:1576`, calls `quoteBooking` at `:1580`)
   `bookings.quote` → `quoteBooking` (`packages/api/src/services/bookingQuote.ts:788`, calls `priceBooking` at `:815`) → `priceBooking` (`bookingQuote.ts:313`, calls `resolveBookingStayRent` at `:362`) → `resolveBookingStayRent` (`packages/api/src/lib/bookingPricing.ts:146`)

2. **`bookings.create`** (`packages/api/src/routers/bookings/index.ts:1583`, calls `priceBooking` directly at `:1830`)
   `bookings.create` → `priceBooking` (`bookingQuote.ts:313`) → `resolveBookingStayRent` (`bookingPricing.ts:146`)

`priceBooking` is only called from `quoteBooking` and from `bookings.create`. `resolveBookingStayRent` is only called from `priceBooking`. The other procedures in the same router (`modifyStay`, `modifyStayPreview`, `update`) do not reach it. `update` goes through `repriceBookingDiscount` instead.

The `bookingQuote.ts:257` hit is only a type reference (`Awaited<ReturnType<typeof resolveBookingStayRent>>`), not a call.

**Web files calling these procedures**

For `bookings.quote`:
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69` (`orpc.bookings.quote.queryOptions`, the debounced live-quote hook)
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381` (`orpc.bookings.quote.queryOptions`)

For `bookings.create`:
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182` (`orpc.bookings.create.mutationOptions`)
- `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` (`(orpc as any).bookings.create.mutationOptions`)

Type-only references, not calls: `apps/web/src/features/bookings/journey/components/BookingQuoteSummary.tsx:15` and `useBookingQuote.ts:16`.

Also outside app code: the e2e helper `apps/web/e2e/helpers/rpc.ts:50` calls `bookings.create` by string name.

The static search covers imports and direct calls. It would miss dynamic dispatch, so a string-keyed call I haven't seen could exist, though the grep for `bookings.quote` / `bookings.create` found none beyond the list above.
