I'll start by locating `FiscalAdapter` and its `register()` method.
The only direct caller is `finalInvoice.ts:332`. Next I'll find the enclosing function, `getFiscalAdapter`, and any swap points.
The caller tree is depth-limited, so I'll check the remaining references for the swap point and the intermediate functions.
**Procedures that can reach `FiscalAdapter.register()`** (all through `issueFinalInvoiceTx`, except the checkout-cancel path):

1. `invoicesRouter.issue`: `packages/api/src/routers/invoices/index.ts:786` → `issueFinalInvoiceTx` (`finalInvoice.ts:245`) → `getFiscalAdapter().register()` (`finalInvoice.ts:332`)
2. `invoicesRouter.creditNote`: `invoices/index.ts:1477` and `:1613` → `issueFinalInvoiceTx` → `register()`
3. `checkoutRouter.settle`: `packages/api/src/routers/checkout/index.ts:1427` → `issueCheckoutInvoices` (`finalInvoice.ts:436`) → `issueFinalInvoiceTx` (`finalInvoice.ts:578`) → `register()`
4. `checkoutRouter.expressCheckout`: `checkout/index.ts:1591` → `issueCheckoutInvoices` → `issueFinalInvoiceTx` → `register()`
5. `quickServiceRouter.quickCheckout`: `packages/api/src/routers/quickService/index.ts:531` → `issueCheckoutInvoices` → `issueFinalInvoiceTx` → `register()`
6. `bookingGuaranteeProcedures.cancelWithPolicy`: `packages/api/src/routers/bookings/guarantee.ts:469` → `closeCancelledFolio` (`packages/api/src/services/money-spine/policyFee.ts:398`) → `issueCheckoutInvoices` (`policyFee.ts:408`) → `issueFinalInvoiceTx` → `register()`

The only other reference to `issueFinalInvoiceTx` is `finalInvoice.integration.test.ts:166`, which is a test and not a procedure.

**Implementations:** `FiscalAdapter` is declared at `packages/api/src/routers/invoices/fiscal-adapter.ts:20`. The only implementation is `NoOpFiscalAdapter` (`fiscal-adapter.ts:25`), which records nothing.

**Swapping:** The adapter is set at module load to `new NoOpFiscalAdapter()` (`fiscal-adapter.ts:31`). `setFiscalAdapter` (`fiscal-adapter.ts:38`) is the only way to replace it, and it has no callers in the repo, so in practice the no-op adapter is always active. The code comment describes it as "Test / future device wiring."

Caveat: the call graph doesn't follow dynamic dispatch or callbacks passed as values, so a caller that reaches these functions that way would not appear here.
