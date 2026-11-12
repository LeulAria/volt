**Procedures that reach `resolveBookingStayRent`:** two, both on the `bookings` router (`packages/api/src/routers/index.ts:228`).

1. **`bookings.quote`** (`packages/api/src/routers/bookings/index.ts:1576`)
   - `quote` handler (`:1580`) → `quoteBooking` (`packages/api/src/services/bookingQuote.ts:788`)
   - → `priceBooking` (`bookingQuote.ts:815`, defined at `:313`)
   - → `resolveBookingStayRent` (`bookingQuote.ts:362`, imported at `:25`)

2. **`bookings.create`** (`packages/api/src/routers/bookings/index.ts:1583`)
   - `create` handler calls `priceBooking` directly (`bookings/index.ts:1830`)
   - → `resolveBookingStayRent` (`bookingQuote.ts:362`)

`resolveBookingStayRent` is defined at `packages/api/src/lib/bookingPricing.ts:146`. Its only caller is `priceBooking`. `priceBooking` has only two callers, both listed above.

Other paths I checked and ruled out: `negotiatedRate.ts`, `rateApproval.ts`, `modifyStay.ts`, `checkIn.ts` and `roomMove` use only `computeBookingMoney`/`roundMoney` from `bookingPricing.ts`. `bookings.modifyStayPreview` and `bookings.update` don't reach it either.

**Web files calling these procedures:**

`bookings.quote`:
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381`, a direct `orpc.bookings.quote.queryOptions` call.
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69`, the shared hook. It is used by `BookingSummaryAside.tsx:78`, which is rendered by `step-1.tsx:1265`.
- Not calls: `BookingQuoteSummary.tsx:15` and `:438` only reference the type or the component.

`bookings.create`:
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182`
- `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323`, which casts `orpc as any`.
- E2E only: `apps/web/e2e/helpers/rpc.ts:50`, `apps/web/e2e/check-in/direct/check-in-gates.spec.ts:93`, `apps/web/e2e/companies/accounts/company-accounts.spec.ts:316`.

No files were modified.