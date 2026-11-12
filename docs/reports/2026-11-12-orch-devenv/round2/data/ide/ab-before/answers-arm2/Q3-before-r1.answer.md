I'll search the codebase for every reference to `special_request_tags`, since that's the only way to find all the places a rename would touch.
The grep found no web UI hits yet, so I'll check the remaining ones: the enclosing procedure names in the bookings router, the `SPECIAL_REQUEST_TAGS` consumers, and any web-side tag form.
Two lookups remain: the procedure names that own the update path and `commitStayModification`, and whether any web form touches these fields under a different name.
Nothing in the web UI writes this column, so the rename touches the DB, generated contracts, API, and tests. Nothing was modified.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition.
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. Leave it as history and add a new migration that renames the column.

**Generated code** (regenerate, don't hand-edit)
- `packages/contracts/src/generated/records.ts:692` (`bookingsRecordSchema`) and `:6613` (`SYNCED_TABLE_META`).
- `packages/sync/src/generated/schema.ts:342`.
- `packages/auth/src/resource-fields.gen.ts:234` (`RESOURCE_COLUMNS`).

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags` in `insertBookingSchema`. Its use in update is unverified; check the update input schema.

**API handlers / services**
- `packages/api/src/routers/bookings/index.ts`, `create` procedure (starts line 1583): destructure at `:1610`, insert payload at `:1945-1946` (`normalizeRequestTags`).
- Same file, `update` procedure (starts line 2574): terminal-status whitelist at `:2683`, and normalization write at `:3003-3008`. The tool labelled `:2683` as `commitStayModification`, but that function is called from `modifyStay` at `:2566`, so the code sits inside `update`.
- `packages/api/src/routers/frontDesk/index.ts:30`, `:69` (SQL select in `frontDeskRouter`), `:208` (maps to `specialRequestTags`).
- `packages/api/src/services/checkIn.ts:773` (`getCheckInContext` SQL select) and `:954` (`roomNotBlockedForStay`).
- `packages/api/src/services/reservationDetails.ts:53` (`normalizeRequestTags`) and `:66` (`SPECIAL_REQUEST_TAGS`). The constant name doesn't include the column name, so it likely doesn't need to change.

**Tests**
- `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`.
- `packages/api/src/services/ratePlanRules.test.ts:29, 463` (only uses `normalizeRequestTags`, so probably unaffected).

**Web UI forms / components**
- None write or read `special_request_tags`. The only web hits are display labels for free-text `special_requests` (e.g. `apps/web/src/features/reports/front-office/_hooks/useMovementListColumns.tsx:318`) and the pre-arrival rule option in `MatchRuleBuilder.tsx:12`. Those use a different field.
