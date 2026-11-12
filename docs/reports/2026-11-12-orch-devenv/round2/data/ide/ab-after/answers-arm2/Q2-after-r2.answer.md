Two oRPC procedures reach `resolveBookingStayRent`: `bookings.quote` and `bookings.create`. Both go through `priceBooking`.

**Call chains** (`resolveBookingStayRent` is at `packages/api/src/lib/bookingPricing.ts:146`)

1. `bookings.quote` (`packages/api/src/routers/bookings/index.ts:1576-1580`)
   `bookings.quote` → `quoteBooking` (`services/bookingQuote.ts:788`, called at `:1580`) → `priceBooking` (`services/bookingQuote.ts:313`, called at `:815`) → `resolveBookingStayRent` (called at `services/bookingQuote.ts:362`)

2. `bookings.create` (`packages/api/src/routers/bookings/index.ts:1583`)
   `bookings.create` → `priceBooking` (called directly at `routers/bookings/index.ts:1830`) → `resolveBookingStayRent` (`services/bookingQuote.ts:362`)

The router is mounted as `bookings: bookingsRouter` at `packages/api/src/routers/index.ts:228`, which gives the `bookings.*` names.

Other references to `resolveBookingStayRent` are not calls. `services/bookingQuote.ts:25` is an import, and `:257` uses it only in a `typeof` type position.

**Web files calling these procedures**

- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69` calls `bookings.quote`.
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381` calls `bookings.quote`.
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182` calls `bookings.create`.
- `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` calls `bookings.create`.

Matches in `step-1.tsx`, `BookingQuoteSummary.tsx`, `pendingBookingRoom.ts`, `buildCreateBookingPayload.ts` and `RateCurrencyPicker.tsx` are comments or type-only references, so I left them out.

I did not check whether `BookingSummaryAside.tsx` reaches `bookings.quote` through `useBookingQuote`. The e2e specs under `apps/web/e2e` also call these procedures and are excluded here.

No files were modified.
