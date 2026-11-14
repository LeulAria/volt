A rename of `bookings.special_request_tags` touches 9 files across the database, contracts/sync, auth, and API layers. The web UI has no direct references.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition in `bookings`. Rename the TS key and the SQL name here.
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. Leave it as history and add a new migration with `RENAME COLUMN`.

**Generated code** (regenerate, don't hand-edit)
- `packages/contracts/src/generated/records.ts:692`: `bookingsRecordSchema` field.
- `packages/contracts/src/generated/records.ts:6613`: `SYNCED_TABLE_META` entry.
- `packages/sync/src/generated/schema.ts:342`: sync schema column.
- `packages/auth/src/resource-fields.gen.ts:234`: `RESOURCE_COLUMNS` entry.

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `insertBookingSchema`, the `special_request_tags` array (max 20 items, each 1–40 chars). I did not confirm whether `update` uses this same schema.

**API handlers / services**
- `packages/api/src/routers/bookings/index.ts:1610`: `bookingsRouter.create`, destructures the input as `special_request_tags: specialRequestTags`.
- `packages/api/src/routers/bookings/index.ts:1945-1946`: `bookingsRouter.create`, writes the normalized value to the insert.
- `packages/api/src/routers/bookings/index.ts:2683`: `bookingsRouter.update`, whitelist of fields editable after check-out, cancellation or no-show.
- `packages/api/src/routers/bookings/index.ts:3003-3006`: `bookingsRouter.update`, normalizes the field before saving.
- `packages/api/src/routers/frontDesk/index.ts:30`: `ArrivalRow` type.
- `packages/api/src/routers/frontDesk/index.ts:69`: raw SQL select `b.special_request_tags` in `frontDeskRouter.getArrivals`.
- `packages/api/src/routers/frontDesk/index.ts:208`: maps the row to `specialRequestTags` in `getArrivals`.
- `packages/api/src/services/checkIn.ts:773`: raw SQL select `"b.special_request_tags"` in `getCheckInContext` (758–1016).
- `packages/api/src/services/checkIn.ts:954`: maps the value to `specialRequestTags` in the per-stay mapping inside `getCheckInContext`.
- `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`: test fixtures and assertions, which will also need updating.

**Web UI forms / components**
- No references to `special_request_tags` or `specialRequestTags` in `apps/web`. The only matches for the related `special_requests` name are unrelated report and pre-arrival files. The UI reaches this field only through the generated contracts and API procedures above, so it should break at compile time after regeneration.

Two things to check:
- `normalizeRequestTags` (`packages/api/src/services/reservationDetails.ts:53`) takes the value without a column name, so it needs no change.
- No Drizzle snapshot JSON under `packages/database/drizzle/meta/` mentions the column. If snapshots are kept, the rename's snapshot may need regenerating; I did not check the meta folder directly.

I made no file changes.
