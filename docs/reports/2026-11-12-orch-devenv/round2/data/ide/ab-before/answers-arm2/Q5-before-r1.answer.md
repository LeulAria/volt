**Registrations** (all in `apps/web/src`, store defined at `store/tourStore.ts:61-63`):

- `registerCreateDrawer`: `components/shared/CrudLayout/index.tsx:433-449`. Registers an object at `:440` and clears it on unmount (`:444`). This is the only registrar.
- `registerTableTour`: `components/shared/Table/index.tsx:1551`, cleared at `:1587`.
- `registerDetailTour`: `features/customer-details/list.tsx:186`, cleared at `:208`.

**Readers of `createDrawer`** (via `useTourStore((s) => s.createDrawer)`, calling `.close()` on save/cancel):

- `features/room-types/create.tsx:62`, close at `:132`
- `features/room-types/update.tsx:61`, close at `:141`
- `features/staff/roles/CreateRoleForm.tsx:91`, close at `:186`
- `features/staff/members/InviteMemberForm.tsx:52`, close at `:70`

`store/tourStore.ts` itself also reads `createDrawer` at lines 79, 85, 102–150 to drive open/close during tour steps.
