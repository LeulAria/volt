**Short answer: no, they are two different schemas that share a name.** The web form uses the package version. `bookings.create` uses the API-local version. Confirmed differences: the API version adds `number_of_infants` (api `validations.ts:42`) and `override_approval` (api `validations.ts:57`), and neither appears in the package version.

**Definitions**
- `packages/validations/src/bookings/validations.ts:14`, exported as `@my-better-t-app/validations`
- `packages/api/src/routers/bookings/validations.ts:18`, imported only inside the API router (`index.ts:119`)

**Derived from the package version (`@my-better-t-app/validations`)**
- `packages/validations/src/bookings/validations.ts:94` `updateBookingSchema` (`.omit`, etc.)
- `apps/web/src/features/bookings/journey/useFormState.tsx:12` `insertBookingSchemaClient` (`.extend`), exports `BookingFormData` at line 27
- `apps/web/src/features/bookings/journey/BookingJourney.tsx:14` `insertBookingSchemaClient` (`.extend`), with `updateBookingSchemaClient` at line 52 and `step1Schema`/`step2Schema` via `.pick` at lines 65 and 77
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:20` `insertBookingSchemaClient` (`.extend`), used as `formSchema` at line 44
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:8` `insertBookingSchemaClient`, used as the zod resolver at line 135

**Derived from the API version (`packages/api/src/routers/bookings/validations.ts`)**
- `packages/api/src/routers/bookings/validations.ts:203` `quoteBookingSchema` (`.pick`)
- `packages/api/src/routers/bookings/validations.ts:238-247` a type-level mapping over `insertBookingSchema.shape`

**Consumers of the API version**
- `packages/api/src/routers/bookings/index.ts:1584` `.input(insertBookingSchema)` on `bookingsRouter` (I did not confirm the procedure name is `create`)

I did not modify any files.
