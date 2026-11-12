**No, they are not the same schema.** There are two independent definitions with the same name, and the API's copy is a superset of the shared one.

**Definition A: shared package (used by the web form)**
- Defined at `packages/validations/src/bookings/validations.ts:14`. Re-exported by `packages/validations/src/index.ts:11`.
- Derived schemas:
  - `updateBookingSchema`: `packages/validations/src/bookings/validations.ts:94`
- Web-side derivations, all `insertBookingSchema.extend(...)`:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:8` (`insertBookingSchemaClient`, used at :83 and :135)
  - `apps/web/src/features/bookings/journey/BookingJourney.tsx:14`, with `.pick()` at :65 and :77 and an alias at :52
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:20` (`formSchema` at :44)
  - `apps/web/src/features/bookings/journey/useFormState.tsx:12` (`BookingFormData` at :27)
- Files using it: the four web files above. `_journey.tsx:32` extends the package's `updateBookingSchema`, not the insert schema.

**Definition B: API router-local (used by `bookings.create`)**
- Defined at `packages/api/src/routers/bookings/validations.ts:18`. It is not exported from the package.
- Derived schemas:
  - `quoteBookingSchema`: `packages/api/src/routers/bookings/validations.ts:203` (`.pick()`)
  - `updateBookingSchema`: `packages/api/src/routers/bookings/validations.ts:250`, built from the non-exported `insertBookingShapeWithoutDefaults` at :237
- Files using it: `packages/api/src/routers/bookings/index.ts:111` (import), and `packages/api/src/routers/bookings/index.ts:1584` (`create`'s `.input(insertBookingSchema)`).

**How they differ**
- B adds fields A lacks: `number_of_infants`, `override_approval`, `restriction_override`, `package_ids`, `special_requests`, `special_request_tags`, `expected_arrival_time`, `rate_currency`, `rate_foreign_nightly`, `guarantee_policy_id`, `cancellation_policy_id`, `accompanying_guest_ids`, `idempotency_key`.
- `room_ids` items differ: in A, `room_id` is required; in B it is optional, with a `room_type_id` alternative and a refine requiring one of them.
- `promo_code` differs: in A it is a plain optional string; in B it is trimmed and nullable.
- The update schemas omit different fields. B's also omits `tax_rate`, `payment_status`, and the rate and policy fields.

**Consequence:** the web form validates against A, and the server validates against B. Every key in A also exists in B, so the shape does not drop web fields. But the web can pass validation and still fail on the server, for example on the `room_ids` rules or the `promo_code` handling. I only grepped for `insertBookingSchema`, so I did not check how the web form submits to `bookings.create`.