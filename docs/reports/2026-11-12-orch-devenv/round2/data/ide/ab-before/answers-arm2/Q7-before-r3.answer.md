I'll locate `FiscalAdapter` and its `register()` with the code-intelligence tools, then trace the callers.
The adapter module is small, so I'll read it and trace who calls `getFiscalAdapter`, `setFiscalAdapter` and `register`.
I need the enclosing function at line 332 and its callers across the importers.
The register call sits in `issueFinalInvoiceTx`, which is reached from several places. I'll map the procedures and helpers around each call site.
Line 786 is in `issue`. I still need the procedures around lines 1477 and 1613, plus the callers of `issueCheckoutInvoices`.
Now I need the callers of `closeCancelledFolio`, `settleDepositsOnCancel` and `postPolicyFee`, since those reach `issueCheckoutInvoices` and are not procedures themselves.
Two more checks: which procedure in `guarantee.ts` owns lines 438-469, and who calls the `reservationSweep.ts` function that calls `postPolicyFee`.
**Direct caller:** `register()` is called once, at `packages/api/src/services/invoicing/finalInvoice.ts:332`, inside `issueFinalInvoiceTx` (`finalInvoice.ts:245`). The adapter itself is at `packages/api/src/routers/invoices/fiscal-adapter.ts:20-40`.

**Chains to `register()`:**

1. `invoices.issue`: `invoices/index.ts:713` → `issueFinalInvoiceTx` at `:786`
2. `invoices.creditNote`: `invoices/index.ts:912` → `issueFinalInvoiceTx` at `:1477` and `:1613` (replacement invoices)
3. `checkout.settle`: `checkout/index.ts:1210` → `issueCheckoutInvoices` at `:1427` → `finalInvoice.ts:436`, which calls `issueFinalInvoiceTx` at `finalInvoice.ts:578`
4. `checkout.expressCheckout`: `checkout/index.ts:1542` → `issueCheckoutInvoices` at `:1591` → as in 3
5. `quickService.quickCheckout`: `quickService/index.ts:393` → `issueCheckoutInvoices` at `:531` → as in 3
6. `bookings.cancelWithPolicy`: `bookings/guarantee.ts` (procedure handler at `:438-469`) → `closeCancelledFolio` at `:469` → `money-spine/policyFee.ts:398`, which calls `issueCheckoutInvoices` at `policyFee.ts:408` → as in 3

**Paths that do not reach it:** the no-show sweep (`services/booking/reservationSweep.ts:442`) calls `postPolicyFee`, which never reaches `issueCheckoutInvoices`. `settleDepositsOnCancel` (`policyFee.ts:243`) and `checkout/index.ts` `closeStay` (`:256`) also don't reach it.

Caveat: the language server call hierarchy is off for this checkout, so the callers come from name-based references and text search. I checked the enclosing procedure of each call site by reading the file, but the list is not type-checked.

**Implementations:** `NoOpFiscalAdapter` (`fiscal-adapter.ts:25-29`) is the only implementation in the repo. It returns `{ fiscalNumber: null, fiscalSignature: null }`, and the invoice number is used as the fiscal number (`finalInvoice.ts:340`).

**Swapping:** the adapter is never swapped. `activeAdapter` is initialised to `NoOpFiscalAdapter` (`fiscal-adapter.ts:31`). `setFiscalAdapter` (`:38`) has no callers anywhere in `packages/` or `apps/`, including tests.

I made no file changes.
