I'll start by locating `FiscalAdapter` and its `register` method, then trace callers.
The call graph shows the chains. Next I'll check who calls `setFiscalAdapter` and read the adapter file to confirm the swap logic.
The adapter is a no-op by default and `setFiscalAdapter` has no callers. Before reporting, I'll confirm that the router entries are oRPC procedures and check for any remaining direct callers of `issueFinalInvoiceTx` and `issueCheckoutInvoices`.
`FiscalAdapter.register()` is reached from six oRPC procedures. The only implementation is a no-op, and the adapter is never swapped in the codebase.

**Call chains** (all end at `packages/api/src/services/invoicing/finalInvoice.ts:332`, `issueFinalInvoiceTx`, which calls `getFiscalAdapter().register(...)`)

1. `invoicesRouter.issue`: `routers/invoices/index.ts:713` → `issueFinalInvoiceTx` at `:786`
2. `invoicesRouter.creditNote`: `routers/invoices/index.ts:912` → `issueFinalInvoiceTx` at `:1477` and `:1613`
3. `checkoutRouter.settle`: `routers/checkout/index.ts:1210` → `issueCheckoutInvoices` at `:1427` → `issueFinalInvoiceTx` at `finalInvoice.ts:578`
4. `checkoutRouter.expressCheckout`: `routers/checkout/index.ts:1542` → `issueCheckoutInvoices` at `:1591` → `issueFinalInvoiceTx`
5. `quickServiceRouter.quickCheckout`: `routers/quickService/index.ts:393` → `issueCheckoutInvoices` at `:531` → `issueFinalInvoiceTx`
6. `bookingGuaranteeProcedures.cancelWithPolicy`: `routers/bookings/guarantee.ts:369` → `closeCancelledFolio` at `:469` → `services/money-spine/policyFee.ts:408` (`issueCheckoutInvoices`) → `issueFinalInvoiceTx`

`issueFinalInvoiceTx` also has a direct call from `finalInvoice.integration.test.ts:166`, which is not a procedure. The depth-4 caller trace did not check whether `closeCancelledFolio` has callers beyond `cancelWithPolicy`.

**Implementations and swapping**

- The only implementation is `NoOpFiscalAdapter` (`packages/api/src/routers/invoices/fiscal-adapter.ts:25`). It returns `{ fiscalNumber: null, fiscalSignature: null }` and records nothing.
- The active adapter is a module-level variable initialised to `new NoOpFiscalAdapter()` (`fiscal-adapter.ts:31`). `getFiscalAdapter()` returns it (`:33`).
- `setFiscalAdapter()` (`:38`) is the only way to replace it, but it has no callers in the repo. In practice the adapter is never swapped, so every register call hits the no-op.
