**No, they are not the same schema.** There are two separate `insertBookingSchema` definitions, and they have drifted apart.

**Definition A: `packages/validations/src/bookings/validations.ts:14`** (the one the web imports, via `packages/validations/src/index.ts:11`)
- Derives `updateBookingSchema` at `:94` (`.omit({...}).partial().extend({id})`).
- Web schemas derived from it:
  - `apps/web/src/features/bookings/journey/BookingJourney.tsx:14` `insertBookingSchemaClient` (`.extend`), with `updateBookingSchemaClient` at `:52`, `step1Schema` at `:65` and `step2Schema` at `:77` (both `.pick`), and the `BookingFormData` type at `:54`.
  - `apps/web/src/features/bookings/journey/useFormState.tsx:12` `insertBookingSchemaClient` (`.extend`), with the `BookingFormData` type at `:27`.
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:20` `insertBookingSchemaClient` (`.extend`), used as `formSchema` at `:44`.
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:8` `insertBookingSchemaClient` (`.extend`), with the `BookingFormValues` type at `:83` and the zod resolver at `:135`.
- Files that import it: the four web files above. `BookingJourney.tsx` and `_journey.tsx` also import `updateBookingSchema` from this package.

**Definition B: `packages/api/src/routers/bookings/validations.ts:18`**
- Derives `quoteBookingSchema` at `:203` (`.pick`).
- Derives `updateBookingSchema` at `:250`, built from `insertBookingShapeWithoutDefaults` at `:237`.
- Files that import it: `packages/api/src/routers/bookings/index.ts:111-121`. The `bookings.create` procedure uses it at `index.ts:1584` (`.input(insertBookingSchema)`).

**How they differ:** B is the newer version. It has fields that A lacks, including `number_of_infants`, `override_approval`, `restriction_override`, `package_ids`, `special_requests`, `expected_arrival_time`, `rate_currency`, `rate_foreign_nightly`, `guarantee_policy_id`, `cancellation_policy_id`, `accompanying_guest_ids` and `idempotency_key`. B's `room_ids` items also differ (`room_type_id`, `corporate_rate_id`, `negotiated_rate`). A's header comment says `scripts/sync-validations.js` copies API validation files into the validations package, so A appears to be a stale copy of B. I did not run the script to confirm.

**Risk:** the web form validates against A and submits to a `create` that validates against B. Any field that B accepts and A lacks can be stripped or rejected on the web side. I did not trace the submit path to confirm this.

No files were modified.