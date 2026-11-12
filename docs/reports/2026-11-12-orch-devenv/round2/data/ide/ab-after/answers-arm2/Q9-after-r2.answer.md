Two separate definitions exist. I need to confirm which one the router imports and the derived schemas' definitions.
They are **not** the same schema. There are two independent `insertBookingSchema` definitions, and the web form does not validate against the one the API uses.

**Definitions**
- `packages/validations/src/bookings/validations.ts:14`: the shared schema, imported by the web app as `@my-better-t-app/validations`.
- `packages/api/src/routers/bookings/validations.ts:18`: the API-local schema, imported by the router at `packages/api/src/routers/bookings/index.ts:111`.

**Schemas derived from the shared one (`packages/validations`)**
- `updateBookingSchema`: `packages/validations/src/bookings/validations.ts:94`.
- Web-local `insertBookingSchemaClient` (via `.extend()`): `apps/web/src/features/bookings/journey/BookingJourney.tsx:14`, `apps/web/src/features/bookings/journey/useFormState.tsx:12`, `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:20`, `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:8`.
- Also in `BookingJourney.tsx`: `updateBookingSchemaClient` (alias, line 52), `step1Schema` (line 65) and `step2Schema` (line 77), both `.pick()`s of the client schema.

**Schemas derived from the API-local one (`packages/api`)**
- `quoteBookingSchema`: `packages/api/src/routers/bookings/validations.ts:203` (`.pick()`).
- `packages/api/src/routers/bookings/validations.ts:238-247`: a type helper that maps over `insertBookingSchema.shape`.

**Files using each**
- Shared schema (`packages/validations`): the four web files above, plus `BookingJourney.tsx`. Nothing in `packages/api` imports it.
- API-local schema (`packages/api`): `packages/api/src/routers/bookings/index.ts:111` (import) and `:1584` (`.input(insertBookingSchema)` on `bookingsRouter`), and `packages/api/src/routers/bookings/validations.ts` for `quoteBookingSchema` and the type helper.

The two files are separate copies that have diverged, so fields validated in the web form may not match what `bookings.create` accepts. I did not verify the `@my-better-t-app/validations` package mapping in `package.json`; the path is inferred from the directory name. No files were modified.
