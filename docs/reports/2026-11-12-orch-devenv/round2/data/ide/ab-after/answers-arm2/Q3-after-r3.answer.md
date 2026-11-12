The column is referenced in 11 files across the schema, generated code, API and tests. The web UI does not reference it at all.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition (`text("special_request_tags").array()`). Change this.
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. Leave it alone and add a new migration with `RENAME COLUMN`. I did not check whether the repo keeps Drizzle snapshot files that would also need regenerating.

**Generated code** (regenerate rather than hand-edit)
- `packages/auth/src/resource-fields.gen.ts:234`: `RESOURCE_COLUMNS` entry.
- `packages/contracts/src/generated/records.ts:692`: `bookingsRecordSchema` field.
- `packages/contracts/src/generated/records.ts:6613`: `SYNCED_TABLE_META` entry.
- `packages/sync/src/generated/schema.ts:342`: sync schema column.

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags` in `insertBookingSchema`. Rename the key. The update path appears to reuse this schema, but I did not confirm that.

**API handlers and services**
- `bookingsRouter.create` (`packages/api/src/routers/bookings/index.ts:1610`, `1945-1946`): maps the input and writes the column through `normalizeRequestTags`.
- `commitStayModification` helper (`packages/api/src/routers/bookings/index.ts:2683`): column name in a list of updated fields. This sits within the `bookingsRouter.update` line range (2574–3129).
- `bookingsRouter.update` (`packages/api/src/routers/bookings/index.ts:3003-3006`): sets and normalizes the column on updates.
- `frontDeskRouter` arrivals query (`packages/api/src/routers/frontDesk/index.ts:30`, `69`, `208`): raw SQL select, `ArrivalRow` type, and mapping to `specialRequestTags`.
- `getCheckInContext` (`packages/api/src/services/checkIn.ts:773`): raw SQL select string `"b.special_request_tags"`.
- `roomNotBlockedForStay` (`packages/api/src/services/checkIn.ts:954`): reads `booking.special_request_tags`.

Raw SQL strings in `frontDesk` and `checkIn` will break at runtime rather than at compile time, so search for them explicitly.

**Tests**
- `packages/api/src/services/ratePlans.integration.test.ts:274`, `285`, `293`: fixture and assertions use the column name.
- `packages/api/src/services/ratePlanRules.test.ts` only imports `normalizeRequestTags`, so it needs no change.

**Web UI forms / components**
- None. Neither the exact column name nor `specialRequestTags` appears under `apps/web`. The only web hits for `special_requests` are in `features/reports/front-office/` (`MovementListPage.tsx`, `MovementReportPage.tsx`, `useMovementColumns.tsx`, `useMovementListColumns.tsx`). Those match the separate free-text `special_requests` column, so they are not affected by renaming the tags column.

No files were modified.
