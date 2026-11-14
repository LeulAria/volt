**Procedures that reach `FiscalAdapter.register()`** (the only call site is `finalInvoice.ts:332`, inside `issueFinalInvoiceTx`, `finalInvoice.ts:245`):

1. **`invoices.issue`**: `routers/invoices/index.ts:713` → `issueFinalInvoiceTx` at `:786` → `register` (`finalInvoice.ts:332`).
2. **`invoices.creditNote`**: `routers/invoices/index.ts:912` → `issueFinalInvoiceTx` at `:1477` (reissue branch) and `:1613` (replacement invoice) → `register`.
3. **`checkout.settle`**: `routers/checkout/index.ts:1210` → `issueCheckoutInvoices` at `:1427` → `issueCheckoutInvoices` (`services/invoicing/finalInvoice.ts:436`) → `issueFinalInvoiceTx` at `:578` → `register`.
4. **`checkout.expressCheckout`**: `routers/checkout/index.ts:1542` → `issueCheckoutInvoices` at `:1591` → `issueFinalInvoiceTx` at `:578` → `register`.
5. **`quickService.quickCheckout`**: `routers/quickService/index.ts:393` → `issueCheckoutInvoices` at `:531` → `issueFinalInvoiceTx` at `:578` → `register`.
6. **`bookings.cancelWithPolicy`**: `routers/bookings/guarantee.ts:369` → `closeCancelledFolio` at `:469` → `issueCheckoutInvoices` at `services/money-spine/policyFee.ts:408` → `issueFinalInvoiceTx` at `finalInvoice.ts:578` → `register`. This path only runs when the folio balance is settled and `totalCharges > 0` (`policyFee.ts:403-407`). `cancelWithPolicy` is spread into `bookingsRouter` at `routers/bookings/index.ts:398`.

The no-show sweep (`services/booking/reservationSweep.ts`) calls `postPolicyFee` but does not reach `issueCheckoutInvoices`, so it is not on a path.

**Implementations:** `FiscalAdapter` (interface at `routers/invoices/fiscal-adapter.ts:20`) has one implementation, `NoOpFiscalAdapter` (`:25`), which returns null fiscal fields. Language servers are off in this checkout, so I checked this with a repo-wide text search rather than `implementations`.

**Is it swapped?** Not in this code. The adapter is a module-level variable initialised to `NoOpFiscalAdapter` (`:31`). `setFiscalAdapter` (`:38`) exists, but a repo-wide search finds no caller outside its definition, including tests. `getFiscalAdapter()` is only called at `finalInvoice.ts:332`. The file's doc comment anticipates ERCA-certified adapters slotting in, but none exist yet.
