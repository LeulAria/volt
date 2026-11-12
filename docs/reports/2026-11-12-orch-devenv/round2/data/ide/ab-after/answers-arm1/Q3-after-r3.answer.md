**Short answer:** the column is referenced in 4 schema/generated files, 1 validation schema, 3 backend functions in 2 routers and 1 service, plus tests. I found no web UI code that uses the tags. Nothing was modified.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition (`text("special_request_tags").array()`). Change the name here.
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. Leave it alone and add a new migration with `ALTER TABLE bookings RENAME COLUMN special_request_tags TO <new>`.
- `packages/database/drizzle/meta/`: no snapshot contains this column, so there is no snapshot to update.

**Generated code** (regenerate rather than hand-edit)
- `packages/contracts/src/generated/records.ts:692` (record schema) and `:6613` (field type map)
- `packages/sync/src/generated/schema.ts:342`
- `packages/auth/src/resource-fields.gen.ts:234`

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags: z.array(...).max(20).optional()`. This is the booking input schema, so it also changes the `create` and `update` inputs. I did not confirm which of the two schemas this line belongs to.

**API handlers / services**
- `bookings` router, `create` procedure (`packages/api/src/routers/bookings/index.ts:1583`):
  - `:1610` destructures `special_request_tags` from the input
  - `:1945-1946` writes it into the insert payload via `normalizeRequestTags`
- `bookings` router, `update` procedure (`packages/api/src/routers/bookings/index.ts:2574`):
  - `:2683` lists `special_request_tags` in the terminal-status whitelist
  - `:3003-3006` normalizes `preparedUpdateData.special_request_tags`
- `frontDesk` router, `getArrivals` procedure (`packages/api/src/routers/frontDesk/index.ts:48`):
  - `:30` row type
  - `:69` raw SQL select
  - `:208` maps to `specialRequestTags` in the response
- `getCheckInContext` service function (`packages/api/src/services/checkIn.ts:758`):
  - `:773` select list (`"b.special_request_tags"`)
  - `:954` maps to `specialRequestTags`
  - Called by the `bookings` router's `getCheckInContext` procedure (`bookings/index.ts:3136-3140`), so no separate change there.
- `packages/api/src/services/reservationDetails.ts:53`: `normalizeRequestTags` takes a string array and never names the column, so it needs no change.

**Tests** (not in your list, but they break on a rename)
- `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`

**Web UI forms / components**
- None found. A search of `apps/` and `packages/` for `special_request_tags`, `specialRequestTags`, and `requestTags` returns no UI hits. The only special-request code in `apps/web` is the free-text `specialRequests` field in front-office reports (`apps/web/src/features/reports/front-office/`), which is a different column. If a booking form exists elsewhere, it would have to use a different identifier and would need a separate search.