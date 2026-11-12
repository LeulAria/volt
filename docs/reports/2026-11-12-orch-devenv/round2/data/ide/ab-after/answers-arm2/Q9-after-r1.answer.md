No, they are two separate schemas with different fields. The web form imports the copy in `packages/validations`, and `bookings.create` uses the copy in `packages/api`.

**Definitions**
- `packages/validations/src/bookings/validations.ts:14`: `insertBookingSchema = z.object({...})`. Imported by the web app as `@my-better-t-app/validations`.
- `packages/api/src/routers/bookings/validations.ts:18`: a second `insertBookingSchema = z.object({...})`. Imported by `packages/api/src/routers/bookings/index.ts:111` from `./validations`.

**Differences I saw** (I read the first ~60 lines of the API copy and the first ~100 of the validations copy):
- The API copy has `override_approval` (line 57) and no `booking_source`, `promo_code`, `commission_*`, `booking_status`, `payment_status`, `room_ids` or `rate_season_id`.
- The validations copy lacks `override_approval`.
- The two copies also import different helpers (`bookingBillToFields` from `../companies/validations` in the validations copy).

**Schemas derived from the `packages/validations` definition (line 14)**
- `packages/validations/src/bookings/validations.ts:94`: `updateBookingSchema = insertBookingSchema.omit({...})`.

**Schemas derived from the `packages/api` definition (line 18)**
- `packages/api/src/routers/bookings/validations.ts:203`: `quoteBookingSchema = insertBookingSchema.pick({...})`.
- `packages/api/src/routers/bookings/validations.ts:238-247`: a mapped type over `insertBookingSchema.shape`. It is a type, not a schema.

**Files using the `packages/validations` copy (web)**
- `apps/web/src/features/bookings/journey/useFormState.tsx:1` (import), `:12` (`insertBookingSchemaClient = insertBookingSchema.extend(...)`), `:27` (`BookingFormData` type).
- `apps/web/src/features/bookings/journey/BookingJourney.tsx:2` (import), `:14` (`.extend`), `:52` (`updateBookingSchemaClient` alias), `:54` (type), `:65` and `:77` (`.pick` for step schemas), `:105`.
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey.tsx:1` (import), `:20` (`.extend`), `:44` (`formSchema`).
- `apps/web/src/routes/journey-steps/_journey_layout/booking/_journey/_hooks/useBookingForm.tsx:2` (import), `:8` (`.extend`), `:83` (`BookingFormValues` type), `:135` (`zodResolver`).

**Files using the `packages/api` copy (server)**
- `packages/api/src/routers/bookings/index.ts:111` (import), `:1584` (`.input(insertBookingSchema)` on the create procedure).
- `packages/api/src/routers/bookings/validations.ts:203` and `:238-247` (derived, listed above).

I did not check whether the web's `.extend` calls override any fields that exist in both copies, or whether the server's create input is wired to the same field names the web sends. No files were modified.
