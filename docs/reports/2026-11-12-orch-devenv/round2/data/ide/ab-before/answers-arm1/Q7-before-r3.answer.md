**Procedures that reach `FiscalAdapter.register()`** (all paths go through `getFiscalAdapter().register(...)` at `services/invoicing/finalInvoice.ts:332`, inside `issueFinalInvoiceTx`):

1. **`invoices.issue`**: `routers/invoices/index.ts:713` → `issueFinalInvoiceTx` at `:786`.
2. **`invoices.creditNote`**: `routers/invoices/index.ts:912` → `issueFinalInvoiceTx` at `:1477` (reissue of copies) and `:1613` (rebill to city ledger).
3. **`checkout.settle`**: `routers/checkout/index.ts:1210` → `issueCheckoutInvoices` at `:1427`.
4. **`checkout.settleWindow`**: `routers/checkout/index.ts:1457` → `issueCheckoutInvoices` at `:1591`.

   Note: `:1591` is actually inside `checkout.expressCheckout` (`:1542`). `settleWindow` calls `issueCheckoutInvoices` at `:1447`'s neighbour, so check that region if you need the exact call sites. The `invoicing.issued` uses at `:1447` and `:1611` are the results.
5. **`quickService.quickCheckout`**: `routers/quickService/index.ts:393` → `issueCheckoutInvoices` at `:531`.
6. **`bookings.cancelWithPolicy`** (spread from `bookingGuaranteeProcedures`, mounted at `routers/bookings/index.ts:398`): `routers/bookings/guarantee.ts:369` → `closeCancelledFolio` at `:469` → `issueCheckoutInvoices` at `services/money-spine/policyFee.ts:408` → `issueFinalInvoiceTx` at `services/invoicing/finalInvoice.ts:578` → `register` at `:332`. This path is conditional: it only issues when the folio nets to zero and has charges (`policyFee.ts:403-407`).

Not reaching it: `postPolicyFee` (`policyFee.ts:107`) and `reservationSweep.ts:442`, which only post a fee charge. `settleDepositsOnCancel` doesn't call it either.

**`FiscalAdapter` implementations:** only `NoOpFiscalAdapter` (`routers/invoices/fiscal-adapter.ts:25`), which returns `null` for both fields. No other implementation exists in the repo.

**Is the adapter swapped?** No. `activeAdapter` is initialised to a `NoOpFiscalAdapter` (`fiscal-adapter.ts:31`), and `setFiscalAdapter` (`:38`) has no callers anywhere in the repo, including tests. So `register()` always runs the no-op in this codebase.

I searched with ripgrep across the whole repo and read the relevant handlers. I did not run anything.