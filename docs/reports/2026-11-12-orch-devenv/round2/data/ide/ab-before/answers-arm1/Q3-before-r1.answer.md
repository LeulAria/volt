No file in `apps/web` reads or writes `special_request_tags` directly, so the web UI group is empty. The column is reached through the API as `specialRequestTags` only in two read paths, which nothing in the web app consumes. Read-only; I changed nothing.

**1. Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition (source of truth).
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. Leave it as is and add a new migration that renames the column.

**2. Generated code** (regenerate, don't hand-edit)
- `packages/sync/src/generated/schema.ts:342`
- `packages/contracts/src/generated/records.ts:692` (record type) and `:6613` (`"json"` field-type map)
- `packages/auth/src/resource-fields.gen.ts:234`

**3. Zod / DTO validation**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags: z.array(z.string().trim().min(1).max(40)).max(20).optional()`. This is the only Zod schema for the field; the input for `create` and `update` uses it.

**4. API handlers and services**
- `bookings` router, `create` (starts at `bookings/index.ts:1583`):
  - `:1610` passes `special_request_tags: specialRequestTags` through the create input.
  - `:1945-1946` writes `normalizeRequestTags(specialRequestTags)` into the insert payload.
- `bookings` router, `update` (starts at `:2574`):
  - `:2683` lists `special_request_tags` in the whitelist of fields that can change on in-house stays.
  - `:3003-3006` normalizes the value before saving.
- `packages/api/src/services/reservationDetails.ts:53`: `normalizeRequestTags`, the shared helper behind the two spots above.
- `frontDesk` router, `getArrivals` (starts at `packages/api/src/routers/frontDesk/index.ts:48`):
  - `:30` is the row type.
  - `:69` is the raw SQL `SELECT`.
  - `:208` maps it to `specialRequestTags`.
- `packages/api/src/services/checkIn.ts`, `getCheckInContext` (starts at `:758`):
  - `:773` is the raw SQL select.
  - `:954` maps it to `specialRequestTags`.

**5. Web UI forms / components**
- None reference `special_request_tags` or `specialRequestTags`. The matches for "special request" in `apps/web` are the free-text `specialRequests` column in the movement reports (`features/reports/front-office/...`) and an unrelated match-rule option in `features/pre-arrival/components/MatchRuleBuilder.tsx:12`. Nothing in the web app would need changing for this rename.

**Tests** (update with the rename): `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`.

**Caveat:** this is a text search for the name and its camelCase form. Anything that builds the column name dynamically would not show up, and I did not check the generator scripts that produce the `generated/` files.