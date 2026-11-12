I'll load the Volt code-intelligence tools, then find where `resolveBookingStayRent` is declared and who calls it.
The only direct caller is in `bookingQuote.ts:362`. Next I need the enclosing function there and what calls it.
The enclosing function at line 362 is `priceBooking` (starts at line 313). Now I'll find who calls `priceBooking` and `quoteBooking`.
`quoteBooking` is called from `routers/bookings/index.ts:1580` and `priceBooking` from `:1830`. I'll read those router regions to get the procedure names.
Both paths are confirmed: `quote` (line 1576) calls `quoteBooking`, and `create` (line 1583) calls `priceBooking` at line 1830. Next I'll confirm the router mount name and find the web call sites.
Web call sites are identified. Last check: how the bookings router is mounted in the app router, so the procedure names are exact.
Two oRPC procedures reach `resolveBookingStayRent`: `bookings.quote` and `bookings.create`. The router is mounted as `bookings` (`packages/api/src/routers/index.ts:228`).

**Call chains**

1. **`bookings.quote`**: `routers/bookings/index.ts:1576` → `quoteBooking` (`services/bookingQuote.ts:788`, calls `priceBooking` at `:815`) → `priceBooking` (`services/bookingQuote.ts:313`) → `resolveBookingStayRent` (`services/bookingQuote.ts:362`, declared at `packages/api/src/lib/bookingPricing.ts:146`).
2. **`bookings.create`**: `routers/bookings/index.ts:1583` → `priceBooking` directly at `routers/bookings/index.ts:1830` → `resolveBookingStayRent` (`services/bookingQuote.ts:362`).

`resolveBookingStayRent` has no other callers in the index. The only direct caller is `bookingQuote.ts:362`, inside `priceBooking`.

**Web files calling these procedures**

- `bookings.quote`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69` (`queryOptions`)
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381` (`queryOptions`)
  - `BookingQuoteSummary.tsx:15` and `useBookingQuote.ts:16` reference `client.bookings.quote` only in types, so they are not calls.
- `bookings.create`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182` (`mutationOptions`)
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` (`mutationOptions`)

E2E helpers also call `bookings.create` via RPC: `apps/web/e2e/helpers/rpc.ts:50`, `apps/web/e2e/check-in/direct/check-in-gates.spec.ts:93`, and `apps/web/e2e/companies/accounts/company-accounts.spec.ts:316`.

The web lookup was a text search for `bookings.quote` and `bookings.create`. It would miss calls made through destructuring or a different client alias. The caller data comes from the code index, which matches by name and is not type-checked. No files were modified.
