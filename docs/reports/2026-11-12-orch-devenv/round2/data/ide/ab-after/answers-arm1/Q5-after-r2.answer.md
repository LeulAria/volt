**Registering a controller into the tour store**

- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433-449`. Registers at line 440 and clears on unmount at line 444.
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:837` (selector), `:1551` (register), `:1587-1588` (cleanup).
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:183` (selector), `:186` (register), `:208` (cleanup).

**Reading the `createDrawer` controller from the store**

- `apps/web/src/features/room-types/create.tsx:62`
- `apps/web/src/features/room-types/update.tsx:61`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`

The store itself also reads `createDrawer` in `apps/web/src/store/tourStore.ts:79` and `:102`, calling `open()`/`close()` during tour transitions (`:113-150`).

The `createDrawer` identifiers in `CrudLayout/index.tsx:397`, `room-block/create.tsx:131`, and the `adjustments/*Tab.tsx` files are local `useUrlDrawer` hooks, not tour-store reads, so I left them out.