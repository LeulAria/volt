**No, they are not the same schema.** There are two separate `insertBookingSchema` definitions, and the web and the API each use a different one.

**Definitions**

| Definition | Used by |
|---|---|
| `packages/validations/src/bookings/validations.ts:14` (`insertBookingSchema`, a `z.object`) | Web app, via the `@my-better-t-app/validations` package, which re-exports it at `packages/validations/src/index.ts:11` |
| `packages/api/src/routers/bookings/validations.ts:18` (`insertBookingSchema`, a `z.object`) | `packages/api/src/routers/bookings/index.ts:111` (imported from `./validations`), used as the `create` input at `index.ts:1584` |

The API version has more fields than the shared one. Examples: `number_of_infants`, `override_approval`, `restriction_override`, `package_ids`, `special_requests`, `rate_currency`, `rate_foreign_nightly`, `guarantee_policy_id`, `accompanying_guest_ids`, `idempotency_key`, and `negotiated_rate` / `room_type_id` inside `room_ids`. The shared version has `room_id` required-when-present and no infants field.

**Schemas derived from the shared definition (`packages/validations/.../validations.ts:14`)**
- `updateBookingSchema`, `packages/validations/src/bookings/validations.ts:94` (`.omit` / `.partial` / `.extend`)

**Schemas derived from the API definition (`packages/api/src/routers/bookings/validations.ts:18`)**
- `insertBookingShapeWithoutDefaults`, `validations.ts:237` (internal, not exported; strips `.default()` wrappers)
- `quoteBookingSchema`, `validations.ts:203` (`.pick`), used by the `quote` procedure at `index.ts:1577`
- `updateBookingSchema`, `validations.ts:250` (same name as the shared one, but a different schema), imported at `index.ts:118`

**Web files that use the shared definition**
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:2`, `:8` (`insertBookingSchemaClient`, chained), `:83` (`BookingFormValues` type), `:135` (zod resolver)
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:1`, `:20` (`insertBookingSchemaClient` via `.extend`), `:44` (`formSchema`)
- `apps/web/src/features/bookings/journey/useFormState.tsx:1`, `:12` (`.extend`), `:27` (`BookingFormData` type)
- `apps/web/src/features/bookings/journey/BookingJourney.tsx:2`, `:14` (`.extend`), `:52` (`updateBookingSchemaClient` is just an alias of the insert client schema), `:65` (`step1Schema`, `.pick`), `:77` (`step2Schema`, `.pick`)

No web file imports `insertBookingSchema` from the API package. The web-side schemas therefore omit fields the server `create` accepts, so the web form can't express those fields.