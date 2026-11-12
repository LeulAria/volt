**Registering a controller into the store**

- `registerCreateDrawer`: `apps/web/src/components/shared/CrudLayout/index.tsx:433-449`. Called with a controller object in an effect, and cleared with `null` on cleanup.
- `registerTableTour`: `apps/web/src/components/shared/Table/index.tsx:837` (selector), `:1551` (register), `:1587-1588` (cleanup to `null`).
- `registerDetailTour`: `apps/web/src/features/customer-details/list.tsx:183` (selector), `:186` (register), `:208-209` (cleanup to `null`).

The store definitions are in `apps/web/src/store/tourStore.ts:53-63` (state and action signatures) and `:88-98` (implementations).

**Reading the `createDrawer` controller**

- `apps/web/src/features/room-types/create.tsx:62`, which calls `createDrawer?.close()` at `:132`
- `apps/web/src/features/room-types/update.tsx:61`, which calls `createDrawer?.close()` at `:141`
- `apps/web/src/features/staff/members/InviteMemberForm.tsx:52`, which calls `createDrawer?.close()` at `:70`
- `apps/web/src/features/staff/roles/CreateRoleForm.tsx:91`, which calls `createDrawer?.close()` at `:186`

The store also reads `createDrawer` internally in `tourStore.ts` (`:79`, `:85`, `:102`, `:113`, `:116`, `:119`, `:150`) to open or close it during tour steps.

Other files that use `useTourStore` (`DashboardTour.tsx`, `useStartPageTour.ts`, `registerBillingTour.ts`, `RoomBlocksList.tsx`, `final-invoices/list.tsx`) don't reference `createDrawer` and aren't part of this answer.