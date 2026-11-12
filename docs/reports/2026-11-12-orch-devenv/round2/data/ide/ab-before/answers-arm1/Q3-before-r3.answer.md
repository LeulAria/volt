**Summary:** 17 files reference `special_request_tags`. The web app doesn't reference the column directly, so no UI form changes are needed unless the UI reads it through the API.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458` (Drizzle column definition, source of truth)
- `packages/database/drizzle/0127_rate_completeness.sql:100` (historical `ADD COLUMN`; leave it alone and add a new rename migration)
- No Drizzle snapshot under `drizzle/` contains the column. I didn't check whether snapshots are committed at all.

**Generated code** (regenerate rather than hand-edit)
- `packages/contracts/src/generated/records.ts:692` (record field, `jsonTextSchema.default("[]")`)
- `packages/contracts/src/generated/records.ts:6613` (field-type map entry `"json"`)
- `packages/sync/src/generated/schema.ts:342`
- `packages/auth/src/resource-fields.gen.ts:234` (field-permission list)

**Zod validation / DTO schemas**
- `packages/api/src/routers/bookings/validations.ts:72` (field in `insertBookingSchema`, line 18; `updateBookingSchema` at line 250 is derived from it)

**API handlers / services**
- `bookings` router, `create` procedure (`packages/api/src/routers/bookings/index.ts:1583`):
  - `:1610` input field passed through
  - `:1945-1946` insert value via `normalizeRequestTags(specialRequestTags)`
- `bookings` router, `update` procedure (`index.ts:2574`):
  - `:2683` in the terminal-status whitelist (`remarks`, `advance_remarks`, `special_request_tags`)
  - `:3003-3006` normalization on update
- `frontDesk` router, `getArrivals` (`packages/api/src/routers/frontDesk/index.ts:48`):
  - `:30` row type `special_request_tags: string[] | null`
  - `:69` SQL select
  - `:208` mapped to `specialRequestTags`
- `checkIn` service, `getCheckInContext` (`packages/api/src/services/checkIn.ts:758`):
  - `:773` SQL select (`"b.special_request_tags"`)
  - `:954` mapped to `specialRequestTags`

**Tests**
- `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293` (raw SQL fixture and assertion)

**Web UI forms / components**
- None found. A search of `apps/` for the column name and `specialRequestTags` returned nothing.
- The reports under `apps/web/src/features/reports/front-office/` and `packages/api/src/routers/reports/` use `specialRequests` (free text), which is a different field and not affected by this rename.
- If a tag picker exists, it would have to go through the `bookings.create`/`update` input, and I didn't find one.