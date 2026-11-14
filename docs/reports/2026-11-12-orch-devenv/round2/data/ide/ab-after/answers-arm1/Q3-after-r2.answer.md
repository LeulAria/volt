**Result:** the rename touches the schema, generated code, DTOs, API, and tests. I found no web UI that reads or writes `special_request_tags`, so that group is empty. This was read-only; I changed nothing.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition (`text("special_request_tags").array()...`).
- `packages/database/drizzle/0127_rate_completeness.sql:100`: the migration that added the column. A rename needs a new migration, not an edit to this one.

**Generated code** (regenerate rather than hand-edit)
- `packages/contracts/src/generated/records.ts:692` and `:6613`: record type and a column-type map.
- `packages/sync/src/generated/schema.ts:342`: sync schema column.
- `packages/auth/src/resource-fields.gen.ts:234`: resource field list.

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags` in `insertBookingSchema` (defined at `:18`). `updateBookingSchema` (`:250`) is the other place to check, since it may derive from the insert schema.

**API handlers / services**
- `bookings.create` (`packages/api/src/routers/bookings/index.ts`, handler from `:1583`):
  - `:1610`: destructures `special_request_tags: specialRequestTags` from input.
  - `:1945-1946`: writes `normalizeRequestTags(specialRequestTags)` to the insert.
- `bookings.update` (same file, handler from `:2574`):
  - `:2683`: `"special_request_tags"` in the terminal-status whitelist of fields editable after check-out, cancellation or no-show.
  - `:3003-3006`: normalizes `preparedUpdateData.special_request_tags` before the update.
- `frontDeskRouter.getArrivals` (`packages/api/src/routers/frontDesk/index.ts`, `:48`):
  - `:30`: row type field.
  - `:69`: SELECT list.
  - `:208`: maps to `specialRequestTags`.
- `getCheckInContext` (`packages/api/src/services/checkIn.ts`, `:758`):
  - `:773`: SELECT `"b.special_request_tags"`.
  - `:954`: maps to `specialRequestTags`.
- `normalizeRequestTags` (`packages/api/src/services/reservationDetails.ts:53`): takes a plain array and does not reference the column name, so it needs no change.

**Tests**
- `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`: fixture and assertions on the column name.

**Web UI forms / components**
- None found. `apps/web` has no reference to `special_request_tags`, `specialRequestTags`, or `requestTags`. The only `special_request*` hits are in pre-arrival match rules and front-office reports, which use other fields. If a booking form exists in a different app or package, search there, since this check was limited to `apps/web` and the packages listed above.