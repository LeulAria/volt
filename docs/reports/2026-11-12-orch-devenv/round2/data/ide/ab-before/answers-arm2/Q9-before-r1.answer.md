I'll locate every `insertBookingSchema` definition and its consumers.
Two separate definitions exist. I'll read both to compare them.
The two definitions differ. I'll check where the derived schemas (`quoteBookingSchema`, `updateBookingSchema`) are used so the consumer list is complete.
**No, they are not the same schema.** There are two independent `insertBookingSchema` definitions, and the web form validates against the one in `packages/validations`, while the API validates against the one in `packages/api`.

**Definition A: `packages/validations/src/bookings/validations.ts:14`**
- Used by the web form (imported as `@my-better-t-app/validations`).
- Derived schemas:
  - `updateBookingSchema`, `packages/validations/src/bookings/validations.ts:94` (`.omit().partial().extend()`).
- Web files that derive from it:
  - `apps/web/src/features/bookings/journey/useFormState.tsx:12` `insertBookingSchemaClient` (`.extend`), type at `:27`.
  - `apps/web/src/features/bookings/journey/BookingJourney.tsx:14` `insertBookingSchemaClient` (`.extend`), `:52` `updateBookingSchemaClient`, `:65` and `:77` step schemas (`.pick`).
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:20` `insertBookingSchemaClient`, `:44` `formSchema`, `:32` `_updateBookingSchemaClient` (derives from `updateBookingSchema`).
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:8` `insertBookingSchemaClient` (chained), `:83` type, `:135` `zodResolver`.
  - `apps/web/src/features/bookings/update.tsx:23` `updateBookingSchemaClient` (derives from `updateBookingSchema`).

**Definition B: `packages/api/src/routers/bookings/validations.ts:18`**
- Used by the API router only.
- Derived schemas:
  - `quoteBookingSchema`, `validations.ts:203` (`.pick`).
  - `insertBookingShapeWithoutDefaults`, `validations.ts:237` (type-level strip of `.default()`).
  - `updateBookingSchema`, `validations.ts:250` (built from the stripped shape).
- Consumers:
  - `packages/api/src/routers/bookings/index.ts:111` imports it.
  - `index.ts:1584` `.input(insertBookingSchema)`.
  - `index.ts:1577` `.input(quoteBookingSchema)`.
  - `index.ts:2575` `.input(updateBookingSchema)` (in `commitStayModification`).

**Main differences (B has, A lacks)**
- Fields: `override_approval`, `restriction_override`, `package_ids`, `special_requests`, `special_request_tags`, `expected_arrival_time`, `rate_currency`, `rate_foreign_nightly`, `guarantee_policy_id`, `cancellation_policy_id`, `commission_percent`/`commission_amount`, `accompanying_guest_ids`, `idempotency_key`, `company_id`, and `negotiated_rate`/`corporate_rate_id` on `room_ids`.
- Validation: B's `room_ids` requires a `room_id` or `room_type_id` (refine) and A requires `room_id`. B's `promo_code` is trimmed and nullable; A's is not.

**Implication:** the web form is validated and submitted against A, and zod strips keys it doesn't know. Fields that only exist in B (for example `idempotency_key` or `package_ids`) are not checked client-side. I haven't traced whether the form ever sends them, so that remains unverified.
