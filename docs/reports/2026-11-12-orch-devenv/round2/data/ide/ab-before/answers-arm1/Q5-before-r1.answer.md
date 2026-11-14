**Register into the store:**
- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433-444` (registers on mount, clears on unmount)
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:837`, `1551-1588` (registers, clears on unmount)
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:183-209` (registers, clears on unmount)

**Read `createDrawer` from the store (`useTourStore((s) => s.createDrawer)`):**
- `apps/web/src/features/room-types/create.tsx:62`
- `apps/web/src/features/room-types/update.tsx:61`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`

The store itself also reads `createDrawer` internally to open or close it during tour steps (`apps/web/src/store/tourStore.ts:79`, `102-150`).

The other `createDrawer` matches in the codebase are local variables from `useUrlDrawer` and do not touch the tour store.