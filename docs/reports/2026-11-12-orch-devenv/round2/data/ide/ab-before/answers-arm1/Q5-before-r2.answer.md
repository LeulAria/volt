**Register a controller** (`registerCreateDrawer` / `registerTableTour` / `registerDetailTour`):

- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433-444`, in an effect that registers on mount and clears with `registerCreateDrawer(null)` on unmount (`:437`, `:444`).
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:1551`, cleaned up at `:1587`.
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:186`, cleaned up at `:208`.

**Read the `createDrawer` controller** (`useTourStore((s) => s.createDrawer)`):

- `apps/web/src/features/room-types/create.tsx:62`
- `apps/web/src/features/room-types/update.tsx:61`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`

The store itself also reads `createDrawer` internally in `apps/web/src/store/tourStore.ts` (lines 79, 102, 113–150) to open and close it during tour steps. The type and actions are declared at `tourStore.ts:53-63`.