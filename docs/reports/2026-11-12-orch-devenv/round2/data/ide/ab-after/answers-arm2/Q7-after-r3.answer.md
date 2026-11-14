**Callers of `register()`**

`register()` has one call site: `packages/api/src/services/invoicing/finalInvoice.ts:332`, inside `issueFinalInvoiceTx` (line 245). Every oRPC procedure below reaches it through that function.

1. `checkoutRouter.settle` (`routers/checkout/index.ts:1210`) → `issueCheckoutInvoices` (1427) → `issueFinalInvoiceTx` (`finalInvoice.ts:578`) → `register` (332)
2. `checkoutRouter.expressCheckout` (`routers/checkout/index.ts:1542`) → `issueCheckoutInvoices` (1591) → `issueFinalInvoiceTx` (578) → `register` (332)
3. `quickServiceRouter.quickCheckout` (`routers/quickService/index.ts:393`) → `issueCheckoutInvoices` (531) → `issueFinalInvoiceTx` (578) → `register` (332)
4. `invoicesRouter.issue` (`routers/invoices/index.ts:713`) → `issueFinalInvoiceTx` (786) → `register` (332)
5. `invoicesRouter.creditNote` (`routers/invoices/index.ts:912`) → `issueFinalInvoiceTx` (1477 and 1613) → `register` (332)
6. `bookingGuaranteeProcedures.cancelWithPolicy` (`routers/bookings/guarantee.ts:369`) → `closeCancelledFolio` (469; defined `services/money-spine/policyFee.ts:398`) → `issueCheckoutInvoices` (`policyFee.ts:408`) → `issueFinalInvoiceTx` (578) → `register` (332)

The `issueFinalInvoiceTx` test at `finalInvoice.integration.test.ts:166` is not an oRPC path.

I mapped each call to its procedure by line ranges and did not read the full bodies of `quickCheckout`, `creditNote` or `cancelWithPolicy`. Code navigation also misses dynamic dispatch, so a call made through a callback or a dynamic key would not appear here.

**Implementations**

- `FiscalAdapter` is declared at `packages/api/src/routers/invoices/fiscal-adapter.ts:20`.
- Its only implementation is `NoOpFiscalAdapter` at `fiscal-adapter.ts:25`, with `register` at line 26.

**Is the adapter swapped?**

No code in the repo swaps it. The module holds `let activeAdapter` (line 31), initialised to `new NoOpFiscalAdapter()`. `getFiscalAdapter()` (line 33) returns it. `setFiscalAdapter()` (line 38) is the only way to replace it, and nothing in the project calls it, so the NoOp adapter is what runs.
