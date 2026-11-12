No web UI form references the column, so the change set is almost entirely API, generated code, and the migration. Nothing was modified.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition, `bookings` table.
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. A rename needs a new migration; this file should not be edited.

**Generated code** (regenerate rather than hand-edit; I did not check the generator commands)
- `packages/contracts/src/generated/records.ts:692`: `bookingsRecordSchema` field.
- `packages/contracts/src/generated/records.ts:6613`: `SYNCED_TABLE_META` entry.
- `packages/sync/src/generated/schema.ts:342`: sync column definition.
- `packages/auth/src/resource-fields.gen.ts:234`: `RESOURCE_COLUMNS` entry.

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags` in `insertBookingSchema` (line 18). Its sibling `special_requests` at line 71 is a different column and is not affected.

**API handlers / services**
- `packages/api/src/routers/bookings/index.ts` (`bookingsRouter`):
  - `create` (procedure at line 1583): line 1610 maps the input field and line 1945–1946 writes `normalizeRequestTags(...)` into the insert.
  - `update` (procedure at line 2574): line 2683 is the whitelist of fields editable on terminal-status bookings. Renaming without updating this list silently blocks edits to the tags.
  - `update` (same procedure): lines 3003–3006 normalise `preparedUpdateData.special_request_tags`.
- `packages/api/src/routers/frontDesk/index.ts`:
  - Line 30: `ArrivalRow` type.
  - Line 69: raw SQL select inside `getArrivals` (handler at line 50).
  - Line 208: maps the row to `specialRequestTags`.
- `packages/api/src/services/checkIn.ts`:
  - Line 773: raw SQL string `"b.special_request_tags"` in `getCheckInContext` (line 758).
  - Line 954: `booking.special_request_tags` read in the same function.
- `packages/api/src/services/reservationDetails.ts:53,66`: `normalizeRequestTags` and the `SPECIAL_REQUEST_TAGS` constant. These are code identifiers, not the column, so they only change if you rename the concept too.

**Tests**
- `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`: fixture and assertions use the column name.
- `packages/api/src/services/ratePlanRules.test.ts:29, 463` use `normalizeRequestTags` only, so they are unaffected by a column rename.

**Web UI forms / components**
- None found. A repo-wide search (`git grep`, including `apps/` and `packages/`) returned no references to the tags column or `SPECIAL_REQUEST_TAGS` in `apps/web`. The web reports use `specialRequests`, which is the separate `special_requests` column.

Note: the `apps/api` and `apps/server` paths in the project listing don't contain this column; the implementation lives under `packages/`.
