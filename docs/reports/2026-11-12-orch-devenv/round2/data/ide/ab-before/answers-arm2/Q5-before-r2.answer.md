I'll search `apps/web` for the three register functions and for readers of `createDrawer`.
The results were truncated, so I'll narrow the search to `src` and to the store reads.
**Registering a controller** (each via a `useEffect` that calls the setter with `null` on cleanup):
- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:440` (selector at 433)
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:1551` (selector at 837)
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:186` (selector at 183)

**Reading `createDrawer` from the store** (`useTourStore((s) => s.createDrawer)`):
- `apps/web/src/features/room-types/create.tsx:62`
- `apps/web/src/features/room-types/update.tsx:61`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`

The store itself also reads `createDrawer` in `closeTour` (`apps/web/src/store/tourStore.ts:79`) and `runTourAction` (`tourStore.ts:102`).
