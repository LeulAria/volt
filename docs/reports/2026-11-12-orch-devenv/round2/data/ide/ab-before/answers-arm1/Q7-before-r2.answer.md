**Procedures that reach `FiscalAdapter.register()`:** all reach it through `issueFinalInvoiceTx` or `issueCheckoutInvoices`. The only call to `register` is `packages/api/src/services/invoicing/finalInvoice.ts:332`, inside `issueFinalInvoiceTx` (`:245`).

1. **`invoices.issue`** (`packages/api/src/routers/invoices/index.ts:713`), calls `issueFinalInvoiceTx` at `:786`.
2. **`invoices.creditNote`** (`routers/invoices/index.ts:912`), calls `issueFinalInvoiceTx` at `:1477` and `:1613` (replacement invoices).
3. **`checkout.settle`** (`packages/api/src/routers/checkout/index.ts:1210`), calls `issueCheckoutInvoices` at `:1427`, which calls `issueFinalInvoiceTx` at `finalInvoice.ts:578`.
4. **`checkout.expressCheckout`** (`routers/checkout/index.ts:1542`), calls `issueCheckoutInvoices` at `:1591`, then the same path.
5. **`quickService.quickCheckout`** (`packages/api/src/routers/quickService/index.ts:393`), calls `issueCheckoutInvoices` at `:531`, then the same path.
6. **`bookings.cancelWithPolicy`** (`packages/api/src/routers/bookings/guarantee.ts:369`), calls `closeCancelledFolio` at `:469`. That calls `issueCheckoutInvoices` at `packages/api/src/services/money-spine/policyFee.ts:408`, then the same path.

`checkout.settleWindow` (`routers/checkout/index.ts:1457`) does not reach it. `reservationSweep` imports from `policyFee.ts` but only uses `postPolicyFee` and `depositMoneyFor`, not `closeCancelledFolio`.

**Implementations of `FiscalAdapter`:** only `NoOpFiscalAdapter` (`packages/api/src/routers/invoices/fiscal-adapter.ts:25`), which returns null numbers. The module-level default is set at `fiscal-adapter.ts:31`.

**Is the adapter swapped?** No. `setFiscalAdapter` (`fiscal-adapter.ts:38`) is defined but nothing in the repo calls it, including tests. The active adapter is always the no-op. The `getFiscalAdapter()` call at `finalInvoice.ts:332` is the only consumer.