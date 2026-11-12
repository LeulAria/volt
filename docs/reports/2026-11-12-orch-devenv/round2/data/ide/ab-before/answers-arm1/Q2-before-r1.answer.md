**Procedures that reach `resolveBookingStayRent`:** two, both in `bookingsRouter` (mounted as `bookings` at `packages/api/src/routers/index.ts:228`).

**1. `bookings.quote`**
- `packages/api/src/routers/bookings/index.ts:1576-1580` (handler calls `quoteBooking`)
- → `quoteBooking` at `packages/api/src/services/bookingQuote.ts:788`, which opens a read-only transaction
- → `priceBooking` at `bookingQuote.ts:313`, called at `bookingQuote.ts:815`
- → `resolveBookingStayRent` at `bookingQuote.ts:362`, defined at `packages/api/src/lib/bookingPricing.ts:146`

**2. `bookings.create`**
- `packages/api/src/routers/bookings/index.ts:1583` (`create` handler)
- → `priceBooking` at `index.ts:1830`
- → `resolveBookingStayRent` at `bookingQuote.ts:362`

Other procedures do not reach it. `repriceBookingDiscount` (`index.ts:199`, called at `index.ts:3053`) and `repriceBooking` in `services/booking/negotiatedRate.ts:152` never call `priceBooking` or `quoteBooking`.

**Web files calling these procedures** (I searched `apps/web/src`):
- `bookings.quote`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381`
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69`, used by `_components/BookingSummaryAside.tsx:78`
- `bookings.create`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182`
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` (cast through `(orpc as any)`)

The e2e helper `apps/web/e2e/helpers/rpc.ts:50` also calls `bookings.create`, but it is test code, not app code.