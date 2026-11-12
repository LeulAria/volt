A rename would touch about 15 places across the database schema, generated code, API validation, the bookings and front-desk handlers, and check-in. No web UI file references the column.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition. Change the name here.
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. Leave it, and add a new migration with `RENAME COLUMN`, since applied migrations shouldn't be edited.

**Generated code** (regenerate rather than hand-edit; I did not check the generator sources)
- `packages/contracts/src/generated/records.ts:692` (`bookingsRecordSchema`) and `:6613` (`SYNCED_TABLE_META`)
- `packages/sync/src/generated/schema.ts:342`
- `packages/auth/src/resource-fields.gen.ts:234` (`RESOURCE_COLUMNS`)

**Zod DTO schemas**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags` in `insertBookingSchema`.
- `packages/api/src/routers/bookings/validations.ts:250`: `updateBookingSchema`. I did not open it to confirm it inherits the field.
- `packages/validations/src/bookings/validations.ts:14` and `:94` contain no reference to the column, so they need no change.

**API handlers / services**
- `bookings.create` (`packages/api/src/routers/bookings/index.ts`, handler at `:1585`): the field is mapped at `:1610`, and the insert at `:1945-1946` goes through `normalizeRequestTags`.
- `bookings.update` (`index.ts`, handler at `:2576`): `:2683` is the whitelist of editable fields on terminal-status bookings, and `:3003-3007` normalizes the value.
- `frontDesk.getArrivals` (`packages/api/src/routers/frontDesk/index.ts`): the `ArrivalRow` type at `:30`, the SQL select at `:69`, and the mapping at `:208`.
- `getCheckInContext` (`packages/api/src/services/checkIn.ts:773`): raw SQL `"b.special_request_tags"`.
- `roomNotBlockedForStay` (`packages/api/src/services/checkIn.ts:954`): maps `booking.special_request_tags`.
- Tests: `packages/api/src/services/ratePlans.integration.test.ts:274`, `:285`, `:293`.
- No change needed: `normalizeRequestTags` and the `SPECIAL_REQUEST_TAGS` constant in `packages/api/src/services/reservationDetails.ts:53` and `:66` don't reference the column name.

**Web UI forms / components**
- None. A case-insensitive search of `apps/web` for `special_request_tags`, `specialRequestTags`, `SPECIAL_REQUEST_TAGS` and `request_?tags` found nothing. Four report and rule-builder files matched the broader `specialRequest` pattern, which most likely refers to the free-text `special_requests` field. I did not open them.

No files were modified.
