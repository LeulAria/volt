**No, they are not the same schema.** Two separate `z.object` definitions share the name. `bookings.create` validates with the API-local one, and the web form validates with the one from `@my-better-t-app/validations`. I compared the definitions' locations and derivations but did not diff their fields, so I can't say how far they differ.

**Definitions**
- `packages/api/src/routers/bookings/validations.ts:18`: the API-local schema. `bookings.create` uses it via `packages/api/src/routers/bookings/index.ts:1584` (`.input(insertBookingSchema)`), imported at `index.ts:119`.
- `packages/validations/src/bookings/validations.ts:14`: the shared schema. The web app imports it from `@my-better-t-app/validations`.

**Schemas derived from the API-local definition** (`packages/api/src/routers/bookings/validations.ts`)
- `quoteBookingSchema` (`:203`): `.pick({...})` of the price-affecting fields. Used by the quote procedure in `index.ts`.
- `insertBookingShapeWithoutDefaults` (`:237`): internal helper that unwraps `.default()` from every field.
- `updateBookingSchema` (`:250`): built from that helper, then `.omit(...)`.

**Schemas derived from the shared definition** (`packages/validations/src/bookings/validations.ts`)
- `updateBookingSchema` (`:94`): `insertBookingSchema.omit(...)`.

**Web files deriving from the shared definition**
- `apps/web/src/features/bookings/journey/useFormState.tsx:12`: `insertBookingSchemaClient = insertBookingSchema.extend(...)`. Exports `BookingFormData` (`:27`).
- `apps/web/src/features/bookings/journey/BookingJourney.tsx:14`: `insertBookingSchemaClient = .extend(...)`. Also `:52` (`updateBookingSchemaClient`, an alias of the same), `:65` (`step1Schema` via `.pick`), `:77` (`step2Schema` via `.pick`), `:105` (form type).
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:20`: `insertBookingSchemaClient = .extend(...)`, used as `formSchema` at `:44`.
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:8`: `insertBookingSchemaClient = insertBookingSchema.extend(...)`. Exports `BookingFormValues` (`:83`) and is passed to `zodResolver` (`:135`).

**Files using each definition**
- API-local: `packages/api/src/routers/bookings/validations.ts` (defines it and the derived `quoteBookingSchema`/`updateBookingSchema`) and `packages/api/src/routers/bookings/index.ts` (`:111`, `:119`, `:1584`).
- Shared: `packages/validations/src/bookings/validations.ts` (defines it and `updateBookingSchema`), plus the four web files above.

The web code never imports the API-local schema, and the API never imports the shared one. The file list comes from an indexed text search for `insertBookingSchema`, so it does not cover other symbols derived from these schemas, such as consumers of `quoteBookingSchema` or `updateBookingSchema`. No files were modified.
