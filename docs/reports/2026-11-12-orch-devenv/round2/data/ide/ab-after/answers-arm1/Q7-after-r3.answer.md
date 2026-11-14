**Procedures that can reach `register()`** (all call sites of `issueFinalInvoiceTx` or `issueCheckoutInvoices`, which in turn calls `issueFinalInvoiceTx`):

1. **`invoicesRouter.issue`** (`packages/api/src/routers/invoices/index.ts:713`) calls `issueFinalInvoiceTx` at `:786`, which reaches `getFiscalAdapter().register(...)` at `services/invoicing/finalInvoice.ts:332`.

2. **`invoicesRouter.creditNote`** (`invoices/index.ts:912`, runs to `:1723`) calls `issueFinalInvoiceTx` for replacement invoices at `:1477` and `:1613`.

3. **`checkoutRouter.settle`** (`packages/api/src/routers/checkout/index.ts:1210`) calls `issueCheckoutInvoices` at `:1427`. That function (`finalInvoice.ts:436`) calls `issueFinalInvoiceTx` at `finalInvoice.ts:578`, which reaches `:332`.

4. **`checkoutRouter.expressCheckout`** (`checkout/index.ts:1542`) calls `issueCheckoutInvoices` at `:1591`, then the same chain as 3.

5. **`quickServiceRouter.quickCheckout`** (`packages/api/src/routers/quickService/index.ts:393`) calls `issueCheckoutInvoices` at `:531`, then the same chain as 3.

6. **`bookingGuaranteeProcedures.cancelWithPolicy`** (`packages/api/src/routers/bookings/guarantee.ts:369`) calls `closeCancelledFolio` at `:469`. That function (`services/money-spine/policyFee.ts:398`) calls `issueCheckoutInvoices` at `policyFee.ts:408` when the folio nets to zero and has charges, then the same chain as 3.

**Checked and not reaching `register()`:** `reservationSweep` (`applyReservationSweep` / `planReservationSweep`) uses `postPolicyFee`, which does not call `closeCancelledFolio` or `issueCheckoutInvoices`. `checkout.closeStay` and `postCheckoutTenders` also don't reach it. The invoice `update` and `cancel` procedures don't call either function.

**What implements `FiscalAdapter`:** only `NoOpFiscalAdapter` (`fiscal-adapter.ts:25`), which returns `null` for both fields. The "ERCA-certified" implementation mentioned in the header comment does not exist in the repo. Because `fiscalNumber` is null, `finalInvoice.ts:340` falls back to the invoice number.

**Is the adapter ever swapped?** No. `activeAdapter` is initialised to a `NoOpFiscalAdapter` (`fiscal-adapter.ts:31`). `setFiscalAdapter` (`fiscal-adapter.ts:38`) has no callers anywhere in the repo, so the no-op is always active. `getFiscalAdapter` is called only at `finalInvoice.ts:332`.