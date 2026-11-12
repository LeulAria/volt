**No, they are not the same schema.** There are two separate `insertBookingSchema` definitions with the same name. The web form reads the shared package copy, and `bookings.create` validates against the API-local copy.

**Definitions**
- **A (shared package):** `packages/validations/src/bookings/validations.ts:14`. Exported via `@my-better-t-app/validations` (`packages/validations/src/index.ts:11`).
- **B (API-local):** `packages/api/src/routers/bookings/validations.ts:18`. Not exported from the package. `packages/api/src/routers/bookings/index.ts:111` imports it from `./validations`.

**Schemas derived from A**
- `updateBookingSchema`: `packages/validations/src/bookings/validations.ts:94` (`insertBookingSchema.omit/partial…`)
- Web `.extend()` wrappers, all of which inherit from A:
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:8` (`insertBookingSchemaClient`; type at :83, zodResolver at :135)
  - `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:20` (`insertBookingSchemaClient`; `formSchema` at :44). Also `_updateBookingSchemaClient` extends `updateBookingSchema` at :32.
  - `apps/web/src/features/bookings/journey/BookingJourney.tsx:14` (`insertBookingSchemaClient`; `updateBookingSchemaClient` at :52; `step1Schema`/`step2Schema` `.pick` at :65 and :77)
  - `apps/web/src/features/bookings/journey/useFormState.tsx:12` (`insertBookingSchemaClient`; type `BookingFormData` at :27)
- Also from A: `apps/web/src/features/bookings/update.tsx:23` (`updateBookingSchemaClient`, extends `updateBookingSchema` from A)

**Schemas derived from B**
- `quoteBookingSchema`: `packages/api/src/routers/bookings/validations.ts:203` (`.pick`). Used as the input of the quote procedure at `packages/api/src/routers/bookings/index.ts:1577`.
- `insertBookingShapeWithoutDefaults`: `packages/api/src/routers/bookings/validations.ts:238` (reads `.shape`, strips `ZodDefault`).
- `updateBookingSchema`: `packages/api/src/routers/bookings/validations.ts:250`. Used as the input of the update procedure at `packages/api/src/routers/bookings/index.ts:2575`.
- `bookings.create` input: `packages/api/src/routers/bookings/index.ts:1584` (`.input(insertBookingSchema)`).

**Files that use each**
- **A:** the four `apps/web` files listed above, plus `apps/web/src/features/bookings/update.tsx`. `packages/api` does not import A's `insertBookingSchema`; it only uses other exports from the package.
- **B:** `packages/api/src/routers/bookings/index.ts` only.

**Caveats**
- Both use the same name for `updateBookingSchema`, so the same ambiguity applies there. The API's `update` uses B's copy, while the web's `update` form uses A's copy.
- I compared the definitions by location and role, not field by field. Whether the two definitions have identical fields and validation rules is not verified. A field-level diff of `packages/validations/src/bookings/validations.ts` against `packages/api/src/routers/bookings/validations.ts` would settle that.

I did not modify any files.