**Registering a controller** (all in `apps/web/src`):
- `registerCreateDrawer`: `components/shared/CrudLayout/index.tsx:433-449`. Registers the create-drawer controller, or `null` when the create drawer isn't available.
- `registerTableTour`: `components/shared/Table/index.tsx:837` (selector) and `1551-1588` (registration and cleanup).
- `registerDetailTour`: `features/customer-details/list.tsx:183-209`.

**Reading the `createDrawer` controller** (`useTourStore((s) => s.createDrawer)`):
- `features/room-types/create.tsx:62`, calls `createDrawer?.close()` at line 132.
- `features/room-types/update.tsx:61`, calls `createDrawer?.close()` at line 141.
- `features/staff/members/InviteMemberForm.tsx:52`, calls `createDrawer?.close()` at line 70.
- `features/staff/roles/CreateRoleForm.tsx:91`, calls `createDrawer?.close()` at line 186.

The store itself also reads it in `closeTour` and `runTourAction` (`store/tourStore.ts:79, 102`). I found no `getState()` reads of `createDrawer` outside the store.
