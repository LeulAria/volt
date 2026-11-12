**No, they are not the same schema.** There are two separate `insertBookingSchema` definitions with the same name. The web form uses the one in the shared `validations` package. The `bookings.create` procedure uses a private copy inside the API router. The bodies have diverged: the API version adds `number_of_infants`, `override_approval`, `restriction_override`, `special_requests`, `expected_arrival_time`, `rate_currency`, `rate_foreign_nightly`, and more, and it changes `promo_code` (trim and nullable).

**Definitions**
- `packages/validations/src/bookings/validations.ts:14` (shared package, exported via `packages/validations/src/index.ts:11`)
- `packages/api/src/routers/bookings/validations.ts:18` (local to the API router)

**Schemas derived from the shared definition (`:14`)**
- `packages/validations/src/bookings/validations.ts:94`: `updateBookingSchema = insertBookingSchema.omit(...)`

**Schemas derived from the API definition (`:18`)**
- `packages/api/src/routers/bookings/validations.ts:203`: `quoteBookingSchema = insertBookingSchema.pick(...)`
- `packages/api/src/routers/bookings/validations.ts:238`: `insertBookingShapeWithoutDefaults`, built from `insertBookingSchema.shape`
- `packages/api/src/routers/bookings/validations.ts:250`: its own `updateBookingSchema`, built from that shape. This is a different `updateBookingSchema` from the shared one at `:94`.

**Files that use the shared definition (web form)**
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:2,8` (`.extend` chain; used by the resolver at `:135`, and the type at `:83`)
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:1,20,44` (`.extend`; also imports the shared `updateBookingSchema` and extends it at `:28`)
- `apps/web/src/features/bookings/journey/BookingJourney.tsx:2,14,52,65,77,105` (`.extend`, `.pick` for steps 1 and 2, and the form config)
- `apps/web/src/features/bookings/journey/useFormState.tsx:1,12,27` (`.extend`, type export)

**Files that use the API definition**
- `packages/api/src/routers/bookings/index.ts:111` imports `insertBookingSchema`, `quoteBookingSchema`, and the other schemas from `./validations`.
- `packages/api/src/routers/bookings/index.ts:1584`: `create` procedure, `.input(insertBookingSchema)`.

The web form's `create` payload is therefore validated on the client by the shared schema and on the server by the API copy, and the two can drift apart. I did not check whether `quoteBookingSchema` is used in a procedure beyond its import. This was read-only; no files were changed.