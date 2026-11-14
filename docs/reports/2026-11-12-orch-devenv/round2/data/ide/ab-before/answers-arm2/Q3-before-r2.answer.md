This is a read-only answer; I changed nothing. The column is referenced in 16 places across the schema, generated code, API, and tests. The web UI has no direct references, so it would not need changes.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition. Change the name here.
- `packages/database/drizzle/0127_rate_completeness.sql:100`: the original `ADD COLUMN`. Don't edit this migration. Add a new migration that runs `RENAME COLUMN`.

**Generated code** (regenerate, or hand-update if regeneration isn't available)
- `packages/sync/src/generated/schema.ts:342`
- `packages/contracts/src/generated/records.ts:692` (`bookingsRecordSchema`) and `:6613` (`SYNCED_TABLE_META`)
- `packages/auth/src/resource-fields.gen.ts:234` (`RESOURCE_COLUMNS`)

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72` in `insertBookingSchema`. The `create` procedure uses this schema (`bookings/index.ts:1584`). I did not check whether `update`'s input is derived from it.

**API handlers / services**
- `bookingsRouter.create` (`packages/api/src/routers/bookings/index.ts:1583`):
  - `:1610` destructures `special_request_tags: specialRequestTags` from the input.
  - `:1945-1946` writes `special_request_tags: normalizeRequestTags(...)` into the insert payload.
- `bookingsRouter.update` (`index.ts:2574`):
  - `:2683` lists `"special_request_tags"` in the whitelist of fields editable after check-out, cancellation, or no-show.
  - `:3003-3007` checks and normalizes `preparedUpdateData.special_request_tags`.
- `frontDeskRouter` (`packages/api/src/routers/frontDesk/index.ts`):
  - `:30` `ArrivalRow` type.
  - `:69` SQL select (`b.special_request_tags`).
  - `:208` maps it to `specialRequestTags`. I did not confirm the enclosing procedure name.
- Check-in service (`packages/api/src/services/checkIn.ts`):
  - `:773` SQL select string in `getCheckInContext`.
  - `:954` maps it to `specialRequestTags`.

**Tests**
- `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`. These fixtures and assertions use the old column name.

**Web UI forms / components**
- None reference the column. The only web hit is `apps/web/src/features/pre-arrival/components/MatchRuleBuilder.tsx:12`, a pre-arrival rule label that is unrelated.
- The API returns camelCase `specialRequestTags` (`frontDesk/index.ts:208`, `checkIn.ts:954`), so the UI should not need changes as long as the API keeps that key. If the column is renamed and the API output key is kept, the web layer is unaffected.

The `SPECIAL_REQUEST_TAGS` constant in `packages/api/src/services/reservationDetails.ts:66` is not a column reference and is unaffected.
