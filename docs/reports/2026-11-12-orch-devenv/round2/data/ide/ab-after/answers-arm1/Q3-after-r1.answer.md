**Short answer:** a rename touches the schema, one migration, three generated files, the booking DTO, and several API/service reads and writes. The web UI has no references to the column, so no web forms would need changes. This is read-only; I changed nothing.

**1. Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition `special_request_tags: text("special_request_tags").array()...`
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. Leave this file alone and add a new migration that renames the column.

**2. Generated code** (regenerate from the schema rather than hand-edit; I didn't check which generator produces each)
- `packages/contracts/src/generated/records.ts:692` (record type) and `:6613` (`"json"` field-type map)
- `packages/auth/src/resource-fields.gen.ts:234`
- `packages/sync/src/generated/schema.ts:342`

**3. Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags` in `insertBookingSchema` (line 18). `updateBookingSchema` (line 250) inherits it.

**4. API handlers / services**
- `packages/api/src/routers/bookings/index.ts`
  - `bookingsRouter.create` (line 1583): `:1610` and `:1945–1946` (`normalizeRequestTags(specialRequestTags)` in the insert payload)
  - `bookingsRouter.update` (line 2574): `:2683` (field whitelist) and `:3003–3006` (normalization before write)
- `packages/api/src/routers/frontDesk/index.ts`
  - `frontDeskRouter.getArrivals` (line 48): raw SQL select at `:69`, mapped to `specialRequestTags` at `:208`
- `packages/api/src/services/checkIn.ts`
  - `getCheckInContext()` (line 758): select at `:773`, output at `:954`
- `packages/api/src/services/reservationDetails.ts:53`: `normalizeRequestTags()`. This is a function name, not the column, so it needs no change.
- Tests to update:
  - `packages/api/src/services/ratePlans.integration.test.ts:274, 285, 293`
  - `packages/api/src/services/ratePlanRules.test.ts:29, 463` (uses `normalizeRequestTags`, which needs no change)

**5. Web UI forms / components**
- None. A search of `apps/` finds no reference to `special_request_tags`, `specialRequestTags`, or `requestTags`. The reports screens use `special_requests` / `specialRequests` (free text), which is a different column and is unaffected.