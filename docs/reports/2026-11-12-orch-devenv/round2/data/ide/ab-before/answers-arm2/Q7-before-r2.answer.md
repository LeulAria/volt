I haven't edited anything; this is a read-only question. The `code_nav` calls failed because they lacked a `line` argument, so I'm switching to indexed search and direct reads.
None of the chains below involve a write. I made no file edits. My earlier `code_nav` calls failed because they lacked the `line` argument, not because of the file contents, so I switched to indexed search and direct reads.

**Every path to `FiscalAdapter.register()` (`finalInvoice.ts:332`)** goes through `issueFinalInvoiceTx` (`finalInvoice.ts:245`). It is the only caller of `register()` in the repo.

Direct callers of `issueFinalInvoiceTx`:

1. **`invoicesRouter.issue`** (`routers/invoices/index.ts:713`), calls at `:786`.
2. **`invoicesRouter.creditNote`** (`routers/invoices/index.ts:912`), calls at `:1477` (same-payer reissue) and `:1613` (city-ledger rebill). I inferred the procedure boundaries from the line ranges.

Indirect callers, via `issueCheckoutInvoices` (`finalInvoice.ts:436`, which calls `issueFinalInvoiceTx` at `:578`):

3. **`checkoutRouter.settle`** (`routers/checkout/index.ts:1210`) → `:1427` → `issueCheckoutInvoices`.
4. **`checkoutRouter.expressCheckout`** (`routers/checkout/index.ts:1542`) → `:1591` → `issueCheckoutInvoices`.
5. **`quickServiceRouter.quickCheckout`** (`routers/quickService/index.ts:393`) → `:531` → `issueCheckoutInvoices`.
6. **Cancellation with fee** (`routers/bookings/guarantee.ts:369` `cancelWithPolicy`) → `:469` `closeCancelledFolio` (`services/money-spine/policyFee.ts:398`) → `:408` `issueCheckoutInvoices`.

I did not confirm that `guarantee.ts` is mounted into the app's router tree, so chain 6 is only reachable if that router is wired in.

**What implements `FiscalAdapter`:** only `NoOpFiscalAdapter` (`routers/invoices/fiscal-adapter.ts:25`). It returns null fiscal number and signature. The interface is at `:20`.

**Is the adapter swapped:** no. The module-level `activeAdapter` is initialised to a `NoOpFiscalAdapter` (`:31`). `setFiscalAdapter` (`:38`) has no callers anywhere in the repo; its comment says "Test / future device wiring". `getFiscalAdapter` (`:33`) is called only at `finalInvoice.ts:332`.
