**Procedures that reach `FiscalAdapter.register()`** (called at `packages/api/src/services/invoicing/finalInvoice.ts:332`, inside `issueFinalInvoiceTx`, defined at `finalInvoice.ts:245`):

1. **`invoices.issue`** (`packages/api/src/routers/invoices/index.ts:713`) → `issueFinalInvoiceTx` at `invoices/index.ts:786` → `register` at `finalInvoice.ts:332`.
2. **`invoices.creditNote`** (`invoices/index.ts:912`) → `issueFinalInvoiceTx` at `invoices/index.ts:1477` and `:1613` → `finalInvoice.ts:332`. Both call sites fall inside the `creditNote` handler's range, which ends before `deliver` at `:1724`.
3. **`checkout.settle`** (`packages/api/src/routers/checkout/index.ts:1210`) → `issueCheckoutInvoices` at `checkout/index.ts:1427` → `issueFinalInvoiceTx` at `finalInvoice.ts:578` → `register` at `finalInvoice.ts:332`.
4. **`checkout.expressCheckout`** (`checkout/index.ts:1542`) → `issueCheckoutInvoices` at `checkout/index.ts:1591` → `finalInvoice.ts:578` → `finalInvoice.ts:332`.
5. **`quickService.quickCheckout`** (`packages/api/src/routers/quickService/index.ts:393`) → `issueCheckoutInvoices` at `quickService/index.ts:531` → `finalInvoice.ts:578` → `finalInvoice.ts:332`.
6. **`bookings.cancelWithPolicy`** (`packages/api/src/routers/bookings/guarantee.ts:369`) → `closeCancelledFolio` at `guarantee.ts:469` → `issueCheckoutInvoices` at `packages/api/src/services/money-spine/policyFee.ts:408` → `finalInvoice.ts:578` → `finalInvoice.ts:332`. This only happens when the folio balance is settled and `totalCharges > 0` (`policyFee.ts:403-407`).

Not on a path: `checkout.settleWindow` (`checkout/index.ts:1457`), and `reservationSweep.ts:442`, which only calls `postPolicyFee`. Integration tests also call `issueFinalInvoiceTx` directly, but they aren't procedures.

**What implements `FiscalAdapter`:** only `NoOpFiscalAdapter` (`packages/api/src/routers/invoices/fiscal-adapter.ts:25`), which returns `{ fiscalNumber: null, fiscalSignature: null }`. A repo-wide search finds no other implementation.

**Is the adapter ever swapped:** no. The module-level `activeAdapter` is initialized to a `NoOpFiscalAdapter` (`fiscal-adapter.ts:31`). `setFiscalAdapter` (`fiscal-adapter.ts:38`) is defined but never called anywhere in the repo, so every chain above hits the no-op for the life of the process. The no-op returns null, so `finalInvoice.ts:340` falls back to the invoice number as `fiscal_number`.