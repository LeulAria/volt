Two oRPC procedures reach `resolveBookingStayRent`, both on the `bookings` router. The only direct caller is `priceBooking`, so both chains pass through it.

**Direct caller:** `priceBooking` calls it at `packages/api/src/services/bookingQuote.ts:362`. The other matches in that file are the import (`:25`), a type-only `ReturnType` use (`:257`), and a comment (`:818`).

**Procedure chains** (`bookings` is mounted at `packages/api/src/routers/index.ts:228`):

1. **`bookings.quote`**: `packages/api/src/routers/bookings/index.ts:1576` → handler `:1580` calls `quoteBooking` (`bookingQuote.ts:788`) → `quoteBooking` calls `priceBooking` at `bookingQuote.ts:815` → `priceBooking` calls `resolveBookingStayRent` at `bookingQuote.ts:362`.
2. **`bookings.create`**: `packages/api/src/routers/bookings/index.ts:1583` → handler calls `priceBooking(tx, …)` at `:1830` → `resolveBookingStayRent` at `bookingQuote.ts:362`.

`priceBooking` also passes the stay result into `applyNegotiatedRates` (`bookingQuote.ts:394`). Nothing else in `packages/api/src` calls `priceBooking` or `quoteBooking`.

**Web callers**

- `bookings.quote`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69` (the live quote hook, the main caller)
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381`
  - Type-only references: `apps/web/src/features/bookings/journey/components/BookingQuoteSummary.tsx:15` and `useBookingQuote.ts:16`
- `bookings.create`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182`
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323`

Caveats: the language-server call-hierarchy ops were unavailable in this checkout, so the chains come from the code index and reading the call sites. The web search covered `apps/**`, and the e2e specs also call `bookings.create` (`apps/web/e2e/check-in/direct/check-in-gates.spec.ts:93`, `apps/web/e2e/companies/accounts/company-accounts.spec.ts:316`, `apps/web/e2e/helpers/rpc.ts:50`), but those are tests, not app code.
