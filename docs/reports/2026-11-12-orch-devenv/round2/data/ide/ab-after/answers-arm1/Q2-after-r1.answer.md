Two oRPC procedures reach `resolveBookingStayRent`: `bookings.quote` and `bookings.create`. Both are on the `bookings` router, mounted at `packages/api/src/routers/index.ts:228`.

**Call chains**

1. **`bookings.quote`** (`packages/api/src/routers/bookings/index.ts:1576`)
   → `quoteBooking` (`packages/api/src/services/bookingQuote.ts:788`)
   → `priceBooking` (`bookingQuote.ts:815`, defined at `:313`)
   → `resolveBookingStayRent` (`bookingQuote.ts:362`, defined at `packages/api/src/lib/bookingPricing.ts:146`)

2. **`bookings.create`** (`packages/api/src/routers/bookings/index.ts:1583`, handler through `:2549`)
   → `priceBooking` directly (`bookings/index.ts:1830`)
   → `resolveBookingStayRent` (`bookingQuote.ts:362`)

No other procedure reaches it. `resolveBookingStayRent` is referenced only from `bookingQuote.ts`, and `priceBooking` is called only from the two sites above. `repriceBooking` in `packages/api/src/services/booking/negotiatedRate.ts:152` does not reach it.

**Web callers**

- **`bookings.quote`**
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69`, the hook used by `BookingSummaryAside.tsx:78`. That component is rendered from `step-1.tsx:1265`.
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381`, which calls `orpc.bookings.quote.queryOptions` directly.
- **`bookings.create`**
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182`.
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323`, which uses `(orpc as any).bookings.create`. It is mounted from `apps/web/src/lib/url-overlays/bodies/check-in.tsx:13`.

These were found by grep, not a full call-graph analysis. The `(orpc as any)` cast would hide a caller from type-based search, so I searched for the name strings. I searched `apps/web/src` only. Nothing was modified.