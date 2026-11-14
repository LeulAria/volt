**Registering a controller** (all call the setter from a `useEffect`, with a cleanup that passes `null`):

- `createDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:440` (`registerCreateDrawer({...})`, cleanup at `:444`)
- `tableTour`: `apps/web/src/components/shared/Table/index.tsx:1551` (`registerTableTour({...})`, cleanup at `:1587`)
- `detailTour`: `apps/web/src/features/customer-details/list.tsx:186` (`registerDetailTour({...})`, cleanup at `:208`)

**Reading the `createDrawer` controller** (via `useTourStore((s) => s.createDrawer)`, then calling `.close()` or `.open()`):

- `apps/web/src/features/room-types/create.tsx:62`, closes at `:132`
- `apps/web/src/features/room-types/update.tsx:61`, closes at `:141`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`, closes at `:70`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`, closes at `:186`

The store itself also reads `createDrawer` internally (`apps/web/src/store/tourStore.ts:79`, `:102`, and the `open()`/`close()` calls around `:113`–`:150`). Those are not consumers outside the store.