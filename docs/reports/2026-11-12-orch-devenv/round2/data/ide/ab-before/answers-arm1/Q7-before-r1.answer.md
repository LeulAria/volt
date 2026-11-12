**Procedures that can reach `FiscalAdapter.register()`** (the call is at `services/invoicing/finalInvoice.ts:332`, inside `issueFinalInvoiceTx`, `finalInvoice.ts:245`):

1. **`invoices.issue`**: `routers/invoices/index.ts:713` → `issueFinalInvoiceTx` at `:786` → `finalInvoice.ts:332`.
2. **`invoices.creditNote`**: `routers/invoices/index.ts:912` → `issueFinalInvoiceTx` for the replacement invoice at `:1477` and `:1613` → `finalInvoice.ts:332`.
3. **`checkout.settle`**: `routers/checkout/index.ts:1210` → `issueCheckoutInvoices` at `:1427` → `finalInvoice.ts:436`, which calls `issueFinalInvoiceTx` at `:578` → `finalInvoice.ts:332`.
4. **`checkout.expressCheckout`**: `routers/checkout/index.ts:1542` → `issueCheckoutInvoices` at `:1591` → `finalInvoice.ts:578` → `:332`.
5. **`quickService.quickCheckout`**: `routers/quickService/index.ts:393` → `issueCheckoutInvoices` at `:531` → `finalInvoice.ts:578` → `:332`.
6. **`bookings.cancelWithPolicy`**: `routers/bookings/guarantee.ts:369` → `closeCancelledFolio` at `:469` (defined `services/money-spine/policyFee.ts:398`) → `issueCheckoutInvoices` at `policyFee.ts:408` → `finalInvoice.ts:578` → `:332`. The procedures are spread into the bookings router at `routers/bookings/index.ts:398`.

Not on the path: `checkout.settleWindow` (`checkout/index.ts:1457`) calls only `postCheckoutTenders`. `guarantee.ts:449` (`settleDepositsOnCancel`) does not reach `issueCheckoutInvoices`. The only other callers are integration tests (`finalInvoice.integration.test.ts:166`), which are not procedures.

**Implementations and swapping:**
- `FiscalAdapter` is declared at `routers/invoices/fiscal-adapter.ts:20`.
- The only implementation is `NoOpFiscalAdapter` (`fiscal-adapter.ts:25`), which returns null fields. `finalInvoice.ts:340` then falls back to the invoice number.
- The active instance is a module-level singleton (`fiscal-adapter.ts:31`), read through `getFiscalAdapter()` (`:33`).
- The adapter is never swapped in the code. `setFiscalAdapter` (`fiscal-adapter.ts:38`) has no callers anywhere in the repo, including tests. Every path above runs the no-op.