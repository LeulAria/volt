**Two oRPC procedures reach `resolveBookingStayRent`**, both in `packages/api/src/routers/bookings/index.ts`. No other procedure reaches it.

**1. `bookings.quote`** (`bookings/index.ts:1576`)
`quote` → `quoteBooking` (`bookings/index.ts:1580`) → `priceBooking` (`services/bookingQuote.ts:815`) → `resolveBookingStayRent` (`services/bookingQuote.ts:362`)

**2. `bookings.create`** (`bookings/index.ts:1583`)
`create` → `priceBooking` (`bookings/index.ts:1830`) → `resolveBookingStayRent` (`services/bookingQuote.ts:362`)

`resolveBookingStayRent` is defined at `lib/bookingPricing.ts:146`. Its only runtime importer is `services/bookingQuote.ts` (line 25).

**Checked and excluded:**
- `bookings.update` (`:2574`) calls `repriceBookingDiscount` (`:3053`), which uses `computeBookingMoney` and `resolveTaxRuleForPosting`, not `priceBooking`.
- `rateApproval.ts:31` imports `NegotiatedLinePrice` as a type only, so it adds no runtime path.
- `modifyStay`, `groups`, `negotiatedRates`, and `bookingApprovals` don't import `bookingQuote`.

**Web files calling these procedures:**
- `bookings.quote`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381` (direct `orpc.bookings.quote.queryOptions`)
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69` (shared hook). Its consumers are `step-1.tsx` and `_components/BookingSummaryAside.tsx`.
  - `_components/BookingQuoteSummary.tsx:15` only references the type (`typeof client.bookings.quote`), so it is not a runtime caller.
- `bookings.create`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182`
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323`

No files were modified.