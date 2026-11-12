I'll locate `resolveBookingStayRent` and then trace its callers through the oRPC router.
The direct caller is `priceBooking` (bookingQuote.ts:362). Next I need the callers of `priceBooking` and `quoteBooking`, and the router procedures that use them.
The router has two entry points into `priceBooking`/`quoteBooking` (lines 1580 and 1830). I'll read those sections to get the procedure names.
Two procedures reach the function: `bookings.quote` (index.ts:1576) and `bookings.create` (index.ts:1583, with `priceBooking` at line 1830). Next I'll check for other importers of `bookingQuote` and the web call sites.
Most web hits are comments or tests. I still need to confirm whether `features/bookings/create.tsx` and `list.tsx` call `bookings.create`, since they matched a broader pattern.
Two oRPC procedures reach `resolveBookingStayRent`: `bookings.quote` and `bookings.create`. Both go through `priceBooking`. Nothing was modified.

**Call chains**

- **`bookings.quote`**: `routers/bookings/index.ts:1576-1581` → `quoteBooking` (`services/bookingQuote.ts:788`) → `priceBooking` (`bookingQuote.ts:815`) → `resolveBookingStayRent` (`bookingQuote.ts:362`; defined at `lib/bookingPricing.ts:146`)
- **`bookings.create`**: `routers/bookings/index.ts:1583` (handler through line 2546) → `priceBooking` (`index.ts:1830`) → `resolveBookingStayRent` (`bookingQuote.ts:362`)

**Web call sites**

- `bookings.quote`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69`, consumed by `BookingSummaryAside.tsx:78`
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381`
- `bookings.create`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182`
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323`
- Only in e2e helpers and specs: `apps/web/e2e/helpers/rpc.ts:50`, `apps/web/e2e/check-in/direct/check-in-gates.spec.ts:93`, `apps/web/e2e/companies/accounts/company-accounts.spec.ts:316`.

**Not on a path**

- `applyNegotiatedRates` (`bookingQuote.ts:257`) only uses `resolveBookingStayRent` in a type position, so it is not a call path.
- `repriceBookingDiscount` (`routers/bookings/index.ts:199`, called from `commitStayModification`) does not call `priceBooking` or `quoteBooking`.
- The `update`, `modifyStay` and `modifyStayPreview` procedures contain no references to `priceBooking` or `quoteBooking`.

The call graph is from name-based search plus the language server's references; the call-hierarchy op was unavailable, so the transitive step was checked by reading references rather than a traced call tree.
