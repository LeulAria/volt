**Registering a controller into the tour store:**

- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433`, which registers at `:440` and clears on unmount at `:444`.
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:837` (selector), registers at `:1551`, clears at `:1587`.
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:183` (selector), registers at `:186`, clears at `:208`.

**Reading the `createDrawer` controller:**

- `apps/web/src/features/room-types/create.tsx:62`
- `apps/web/src/features/room-types/update.tsx:61`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`

The store itself also reads `createDrawer` internally in `apps/web/src/store/tourStore.ts:79–150` to open, close, and reset it during tour actions. The store definitions are at `tourStore.ts:53–63`.
