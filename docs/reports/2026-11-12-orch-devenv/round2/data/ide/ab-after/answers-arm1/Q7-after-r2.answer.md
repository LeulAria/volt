**Direct caller:** `issueFinalInvoiceTx` (`packages/api/src/services/invoicing/finalInvoice.ts:245`) calls `getFiscalAdapter().register(...)` at `:332`.

**oRPC procedures that reach `register()`:**

All paths are under `packages/api/src/`.

1. **`invoices.issue`** (`routers/invoices/index.ts:713`) calls `issueFinalInvoiceTx` at `:786`.
2. **`invoices.creditNote`** (`routers/invoices/index.ts:912`) calls `issueFinalInvoiceTx` at `:1477` and `:1613`.
3. **`checkout.settle`** (`routers/checkout/index.ts:1210`) calls `issueCheckoutInvoices` at `:1427`, which then calls `issueFinalInvoiceTx` at `finalInvoice.ts:578`.
4. **`checkout.expressCheckout`** (`routers/checkout/index.ts:1542`) calls `issueCheckoutInvoices` at `:1591`, then as in 3.
5. **`quickService.quickCheckout`** (`routers/quickService/index.ts:393`) calls `issueCheckoutInvoices` at `:531`, then as in 3.
6. **`bookings.cancelWithPolicy`** (`routers/bookings/guarantee.ts:369`) calls `closeCancelledFolio` at `:469` (conditional), which is `services/money-spine/policyFee.ts:398`. That calls `issueCheckoutInvoices` at `policyFee.ts:408`, then as in 3.

**Non-oRPC paths that do not reach `register()`:** `applyReservationSweep` (`services/booking/reservationSweep.ts:459`) and its callers (`scheduledJobs/runner.ts:164`, `closeBusinessDay.ts:141`, `applyDateBasedStatusTransitions.ts:32`). Its fee path uses `postPolicyFee`, which does not issue invoices. `autoApplyDepositsForBooking` (`routers/billing/deposit-helpers.ts:212`) does not either.

**Implementations of `FiscalAdapter`:** Only one exists, `NoOpFiscalAdapter` (`routers/invoices/fiscal-adapter.ts:25`). It returns null fiscal number and signature.

**Is the adapter swapped?** No. `activeAdapter` is initialised to a `NoOpFiscalAdapter` (`fiscal-adapter.ts:31`). `setFiscalAdapter` (`:38`) exists, but nothing in the repo calls it. Every `register()` call therefore hits the no-op.