**Registrars (write a controller into the store):**
- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433-449`. It registers on mount when `canRegisterCreateDrawer` is true and clears with `null` otherwise or on unmount.
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:837` (selector), `:1551` (register), `:1587` (cleanup `null`).
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:183` (selector), `:186` (register), `:208` (cleanup `null`).

**Readers of `createDrawer` from the store (`s.createDrawer`):**
- `apps/web/src/features/room-types/create.tsx:62`
- `apps/web/src/features/room-types/update.tsx:61`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`

The store itself is defined in `apps/web/src/store/tourStore.ts` (`useTourStore` at line 67, register methods at lines 88-96). I did not modify any files.
