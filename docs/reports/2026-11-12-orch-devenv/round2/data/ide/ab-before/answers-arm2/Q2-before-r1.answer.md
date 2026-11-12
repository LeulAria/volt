I'll start by locating the declaration and its references.
The only direct call is in `bookingQuote.ts:362`. I need the enclosing function and its callers.
The enclosing function is `priceBooking` (313). Next, who calls `priceBooking` and `quoteBooking`.
Two chains reach `priceBooking`: via `quoteBooking` (router line 1580) and directly at router line 1830. I need the procedure names around those lines.
`quote` is confirmed at line 1576. Now I'll check which procedure owns line 1830 and look up the web callers.
Two oRPC procedures reach `resolveBookingStayRent`: `bookings.quote` and `bookings.create`. Both go through `priceBooking`, and the web callers are listed below. The index is name-matched, not type-checked, so treat these as high-confidence rather than proven.

**Direct caller:** `resolveBookingStayRent` is called only at `packages/api/src/services/bookingQuote.ts:362`, inside `priceBooking` (declared at `bookingQuote.ts:313`). Line 818 is a comment, not a call.

**Procedure chains**

1. `bookings.quote`
   - `packages/api/src/routers/bookings/index.ts:1576` (`quote: requirePermission("reservations", "read")`), calling `quoteBooking` at line 1580
   - `packages/api/src/services/bookingQuote.ts:788` (`quoteBooking`), calling `priceBooking` at line 815
   - `packages/api/src/services/bookingQuote.ts:313` (`priceBooking`), calling `resolveBookingStayRent` at line 362

2. `bookings.create`
   - `packages/api/src/routers/bookings/index.ts:1583` (`create: requirePermission("reservations", "create")`), calling `priceBooking` directly at line 1830
   - `packages/api/src/services/bookingQuote.ts:313` (`priceBooking`), calling `resolveBookingStayRent` at line 362

No other procedure reaches `priceBooking` or `quoteBooking`. The other `priceBooking` mentions in `services/companies/index.ts:844` and `services/ratePlans.ts:4` are comments.

**Web callers**

- `bookings.quote`
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_utils/useBookingQuote.ts:69` (`orpc.bookings.quote.queryOptions`)
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:381` (`orpc.bookings.quote.queryOptions`)
  - Type-only references, not calls: `apps/web/src/features/bookings/journey/components/BookingQuoteSummary.tsx:15` and `useBookingQuote.ts:16`.
- `bookings.create`
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/step-2.tsx:182` (`orpc.bookings.create.mutationOptions`)
  - `apps/web/src/features/bookings/quick-login/QuickLoginBookingForm.tsx:323` (`(orpc as any).bookings.create.mutationOptions`)
