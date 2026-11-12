They are not the same schema. There are two separate `insertBookingSchema` definitions, and the web form and the API procedure each use a different one.

**Definitions**
1. `packages/validations/src/bookings/validations.ts:14`: the shared package, imported by the web app as `@my-better-t-app/validations`.
2. `packages/api/src/routers/bookings/validations.ts:18`: a local copy inside the API package. It imports other helpers from the shared package (line 8) but defines its own object.

The two field lists overlap heavily but are not identical. The API version has a few extra fields and differences in details such as `check_in` and `check_out`.

**Schemas derived from each**
- From `packages/validations/.../validations.ts:14`:
  - `updateBookingSchema`, line 94 (`.omit(...)`).
  - `insertBookingSchemaClient` in four web files, each using `.extend(...)`.
  - `step1Schema` and `step2Schema` in `BookingJourney.tsx`, via `.pick(...)` at lines 65 and 77.
  - `updateBookingSchemaClient`, `BookingJourney.tsx:52`, which is just an alias of the client schema.
- From `packages/api/.../validations.ts:18`:
  - `quoteBookingSchema`, line 203 (`.pick(...)`).
  - A shape-mapping type at lines 238–247 that reads `insertBookingSchema.shape`. It is a type only, not an exported schema.

**Files using each**
- Package version (`packages/validations/.../validations.ts:14`):
  - `apps/web/src/features/bookings/journey/BookingJourney.tsx:2`, `:14`, `:52`, `:65`, `:77`, `:105`.
  - `apps/web/src/features/bookings/journey/useFormState.tsx:1`, `:12`, `:27`.
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:1`, `:20`, `:44`.
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:2`, `:8`, `:83`, `:135`.
- API version (`packages/api/src/routers/bookings/validations.ts:18`):
  - `packages/api/src/routers/bookings/index.ts:111` imports it from `./validations` (line 119).
  - `packages/api/src/routers/bookings/index.ts:1584` uses it as `.input(insertBookingSchema)` in `bookingsRouter`, which is the `bookings.create` procedure.

Because the web app and the API parse the same request with different schemas, a field accepted by one can be rejected by the other. Reconciling the two is probably worth doing. No files were changed.
