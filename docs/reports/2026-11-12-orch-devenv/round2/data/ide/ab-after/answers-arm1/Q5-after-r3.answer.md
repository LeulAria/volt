**Registrations**

- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433-444`. It's registered in an effect and cleared on unmount.
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:1551-1588`. Also registered in an effect and cleared on unmount.
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:183-209`. Also registered in an effect and cleared on unmount.

The store defines these setters at `apps/web/src/store/tourStore.ts:61-63` and implements them at `:88-98`.

**Readers of `createDrawer`**

- `apps/web/src/features/room-types/create.tsx:62` (calls `close()` at `:132`)
- `apps/web/src/features/room-types/update.tsx:61` (calls `close()` at `:141`)
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52` (calls `close()` at `:70`)
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91` (calls `close()` at `:186`)

The store itself also reads `createDrawer` to drive the tour (`apps/web/src/store/tourStore.ts:79-150`, calling `open()` and `close()`).