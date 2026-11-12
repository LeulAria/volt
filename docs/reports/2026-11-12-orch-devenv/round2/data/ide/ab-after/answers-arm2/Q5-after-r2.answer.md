**Registering a controller**

- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433-449`. Registers a create-drawer controller and clears it with `null` on unmount.
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:837`, with the registration at `:1551-1588`. Clears it with `null` on cleanup.
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:183-209`. Clears it with `null` on cleanup.

The store's setters and types are in `apps/web/src/store/tourStore.ts:61-63` (types) and `:88-96` (implementations).

**Reading `createDrawer` from the store**

- `apps/web/src/features/room-types/create.tsx:62`
- `apps/web/src/features/room-types/update.tsx:61`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`

Other tour consumers (`DashboardTour.tsx`, `useStartPageTour.ts`, and several `startTour` callers) read other store fields and do not touch `createDrawer`.
