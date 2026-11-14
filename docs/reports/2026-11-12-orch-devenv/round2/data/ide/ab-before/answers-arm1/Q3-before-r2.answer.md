No web form or component reads or writes `special_request_tags`, so the UI list is empty. Nothing was modified.

**Schema / migrations**
- `packages/database/src/schema/hotel.ts:458`: Drizzle column definition (source of truth).
- `packages/database/drizzle/0127_rate_completeness.sql:100`: original `ADD COLUMN`. A rename needs a new migration after `0310_hotel_timezone_fast.sql`, not an edit to this file.

**Generated code** (regenerate, don't hand-edit)
- `packages/contracts/src/generated/records.ts:692` and `:6613`: Zod record schema and field-type map. Produced by `packages/sync/scripts/render.ts` (line 496).
- `packages/sync/src/generated/schema.ts:342`: PowerSync client schema. Produced by `packages/sync/scripts/render.ts` (line 497).
- `packages/auth/src/resource-fields.gen.ts:234`: resource field list. Produced by `packages/auth/scripts/gen-resource-fields.ts`.

**Zod validation (DTO)**
- `packages/api/src/routers/bookings/validations.ts:72`: `special_request_tags` input schema.
- `packages/api/src/routers/preArrival/matchRules.ts` and `generateHelpers.ts`: not affected. They use `special_request` as a rule key, which is a different name.

**API handlers / services**
- `bookings.create` (`packages/api/src/routers/bookings/index.ts`): `:1610` (input passed through), `:1945-1946` (insert, normalized via `normalizeRequestTags`).
- `bookings.update` (same file): `:2683` (whitelisted fields), `:3003-3006` (normalize and write).
- `frontDesk.getArrivals` (`packages/api/src/routers/frontDesk/index.ts`): `:29-30` (row type), `:69` (SELECT), `:208` (mapped to `specialRequestTags`).
- `getCheckInContext` service (`packages/api/src/services/checkIn.ts`, function at `:758`): `:773` (SELECT), `:954` (mapped to `specialRequestTags`).
- Tests: `packages/api/src/services/ratePlans.integration.test.ts:274`, `:285`, `:293`.
- `packages/api/src/services/reservationDetails.ts:53` (`normalizeRequestTags`) holds no column reference, so it doesn't change unless you rename the helper too.

**Web UI forms / components**
- None found. The only web hits are report columns for `specialRequests` (`apps/web/src/features/reports/front-office/`), which come from the free-text `special_requests` column (`packages/api/src/routers/reports/frontOffice.ts:446`, `:512`). Those are unaffected by a tags rename.