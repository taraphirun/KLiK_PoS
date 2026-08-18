# klik_pos accounting / calculation audit — findings

**Date:** 2026-08-18
**Scope:** money math across `klik_pos/` (backend) and `klik_spa/` (frontend) — checkout,
returns + store credit, closing-shift reconciliation, payments, multi-currency.
**Method:** static review by five parallel subsystem reviewers, each finding put through an
adversarial refutation pass, then the decisive candidates reproduced live in
`bench --site hd.phirun.me console` inside `frappe.db.rollback()` (nothing persisted).
**Status:** report only. No code was changed. Fix directions are suggestions for a later,
separately-approved pass.

Severity key: **High** = wrong money booked / customer over- or under-charged in a path
that can occur in normal use. **Medium** = wrong figure in a real but narrower path.
**Low** = bounded/edge-case drift or a control that doesn't enforce. **Info** = correctness
nit with no money impact today.

---

## Confirmed findings (ranked)

| # | Sev | Flow | Title |
|---|-----|------|-------|
| 1 | **High** | Checkout tax | Per-item tax over-taxation: an item is taxed by another item's tax account |
| 2 | **High** | Closing shift | Closing reconciliation "expected" excludes standalone counter Payment Entries the live drawer counts |
| 3 | Medium | Payments | Foreign-currency invoices book GL at a 1:1 rate |
| 4 | Medium | Returns | `create_multi_invoice_return` reports `success: True` even when some returns failed |
| 5 | Medium | Returns / shift | Full-return refund is attributed to the *original* invoice's shift, not the shift where the cash leaves |
| 6 | Low | Checkout | `pay_in_full` settles at `grand_total`, not `rounded_total` |
| 7 | Low | Checkout | "Partial payment not allowed" control is unenforceable; no server over/under-payment guard |
| 8 | Low | Checkout | Payment rows truncated to 2 dp while `amountPaid` keeps full precision |
| 9 | Low | Closing shift | Closing totals/taxes accept unvalidated client values |
| 10 | Low | Closing shift | Closing totals use `grand_total`, not `rounded_total` |
| 11 | Low | Closing shift | Admin live summary aggregates the whole day across all shifts |
| 12 | Info | Checkout GL | Forked `get_gl_entries` omits `transaction_currency`/rate on GL rows |

---

### 1. Per-item tax over-taxation — **High**, live-proven

**Location:** `klik_pos/api/sales_invoice.py:3034` `_populate_per_item_taxes` (append block
`3094-3111`).

**Mechanism:** the function builds one invoice-level `On Net Total` tax row per tax account
found across the cart's items, using the **first item's rate** for that account, and appends
it with a **non-zero `rate` and no `set_by_item_tax_template` flag**. ERPNext's native path
(`append_taxes_from_item_tax_template`) instead emits those rows with `rate = 0` and
`set_by_item_tax_template = 1`. That flag is load-bearing: during
`calculate_taxes_and_totals`, `update_item_tax_map` re-seeds **every** item's `item_tax_rate`
with all header rows that are *not* flagged. Because klik's rows are unflagged, every item —
including tax-exempt items — inherits every tax account at the header rate.

**Live evidence** (rolled back, `hd.phirun.me`):
- Cart = VAT-10% item (net 100) + a different-account 5% item (net 100). Correct grand total
  215. **Actual: 230** — VAT charged 20 (both items), the 5% account charged 10 (both items).
- More likely in production: VAT-10% item (net 100) + a **tax-exempt** item with no template
  (net 100). Correct grand 210. **Actual: 220** — the exempt item's `item_tax_rate` was
  rewritten to `{"VAT - HD": 10.0}` and it was taxed 10.

**Impact:** output VAT over-collected and over-remitted; the customer is over-charged; the
frontend (which taxes each line only by its own rate) quotes the correct lower total, so the
tendered cash then under-pays the server's inflated `grand_total`, throwing the sale into the
partial-payment path or booking a phantom outstanding balance.

**Current exposure on `hd.phirun.me`:** only one Item Tax Template exists today
(`Cambodia Tax - HD`, VAT 10%), so a cart of only-VAT items is charged correctly. The bug
fires the moment a cart **mixes a taxed item with a tax-exempt item**, or a second tax
template is added. Given VAT-exempt goods are common, treat this as live.

**Fix direction:** when appending per-item tax rows, set `set_by_item_tax_template = 1` and
`rate = 0` (let core fill per-item amounts); or drop `_populate_per_item_taxes` entirely and
let ERPNext's own `set_taxes()` / `append_taxes_from_item_tax_template` build the rows.
Re-run the two live repros above and confirm 215 and 210.

**Repro script:** `scratchpad/test_peritem_tax.py`, `test_peritem_tax2.py`.

---

### 2. Closing reconciliation excludes standalone counter Payment Entries — **High** (by code)

**Location:** `klik_pos/api/pos_entry.py:197` `_calculate_payment_reconciliation` vs
`klik_pos/api/payment.py:518` `get_opening_entry_payment_summary` (`_fetch_*_payment_entry_data`
`636/660`).

**Mechanism:** the closing-entry "expected per mode" sums only `Sales Invoice Payment` rows
for the shift. The live in-shift drawer summary additionally sums standalone `Payment Entry`
receipts (counter payments against outstanding invoices). The two figures therefore disagree
for any shift that took a counter payment.

**Live evidence:** counter payments do get created and *do* carry an `opening_entry` link —
`create_customer_payment_entry` returned `success: True`, `ACC-PAY-2026-00025`,
`opening_entry: POS-OPE-2026-00003`. So the discrepancy is reachable in normal operation.

**Impact:** the cashier's closing screen shows an expected-cash figure that omits money
actually taken at the counter, producing a false "over" variance and pushing staff to
mis-count the drawer.

**Fix direction:** include standalone Payment Entry receipts in
`_calculate_payment_reconciliation` on the same `opening_entry` scope the live summary uses
(or exclude them from both consistently and surface them separately).

---

### 3. Foreign-currency invoices book GL at 1:1 — **Medium** (latent on this site)

**Location:** `klik_pos/api/sales_invoice.py:2371-2376` `_set_pos_profile_fields` — `doc.currency`
is taken from the customer's `default_currency` while `doc.conversion_rate` is hardcoded `1.0`.
Same 1:1 hardcode in `create_payment_entry:3524-3525` and `payment.py:124`.

**Mechanism:** a customer whose `default_currency` differs from the company currency yields an
invoice where `base_grand_total == grand_total`, i.e. the base-currency GL is posted at par.

**Current exposure:** company currency is USD and current customers are USD, so this does not
fire today. It becomes a real mis-posting the moment a non-USD customer is transacted.

**Fix direction:** resolve the real rate via `erpnext.setup.utils.get_exchange_rate`
(already wrapped at `customer.py:340`) and set `conversion_rate`/`plc_conversion_rate`
accordingly; or explicitly block non-company-currency customers in POS if multi-currency is
out of scope.

---

### 4. Multi-invoice return hides partial failure — **Medium**

**Location:** `klik_pos/api/sales_invoice.py:3980` `create_multi_invoice_return` (`4008-4017`).

**Mechanism:** the loop calls `create_partial_return` per invoice, logs any per-invoice
exception, and still returns `{"success": True}`.

**Impact:** if one invoice in a multi-invoice return fails, the cashier is told the whole
return succeeded — the customer can be under-refunded with no visible error.

**Fix direction:** collect per-invoice outcomes and return an aggregate that reports partial
failure (which invoices refunded, which did not).

---

### 5. Full-return refund attributed to the original shift — **Medium** (residual)

**Note:** the stronger candidate — "full-return refund is invisible to shift reconciliation
because `custom_pos_opening_entry` is never set" — was **refuted**. Live test: the field is
`no_copy = 0`, so `get_mapped_doc` copies it, and the return carries
`custom_pos_opening_entry = POS-OPE-2026-00004`; the reconciliation query does include the
−100 refund.

**Residual issue:** because the field is *inherited from the original invoice*, a refund
processed in a later shift is booked to the **original** invoice's opening entry, not the shift
whose drawer the cash actually leaves. If that original shift is already closed, the current
shift shows a cash surplus and the refund lands on a closed period.

**Location:** `klik_pos/api/sales_invoice.py:3296` `return_sales_invoice` (relies on
`get_mapped_doc` inheritance; never re-points to the current open entry).

**Fix direction:** on return creation, set `custom_pos_opening_entry` to the currently-open
POS Opening Entry for the profile/user, not the copied original value. Confirm against the
same-shift and cross-shift refund cases.

**Repro script:** `scratchpad/test_full_return_ope.py`.

---

### 6-12. Lower-severity confirmed items

- **6. `pay_in_full` uses `grand_total` not `rounded_total`** (`sales_invoice.py:1423/1432/1436`).
  Opt-in backfill path only (e.g. delivery reconciliation). On rounding-enabled sites it leaves
  a permanent sub-unit residual outstanding (or change). Fix: `flt(doc.rounded_total or doc.grand_total)`.
- **7. `validate_full_payment` early-returns on any positive payment** (`sales_invoice.py:3443`).
  The POS "partial payment not allowed" control can't be enforced server-side, and there is no
  server guard on paid-vs-total. Note over-payment itself is safe (see refuted list — core books
  it as change). Fix: enforce the partial-payment flag server-side.
- **8. Payment rows truncated to 2 dp** while `amountPaid` keeps currency precision. Only bites
  3-dp currencies (not USD). Fix: round payment amounts to `currency_precision`.
- **9. Closing totals/taxes accept client values** — `pos_entry.py:402-405` falls back to client
  totals when the SQL total is 0/falsy; `417-425` appends closing tax rows verbatim. Fix:
  recompute server-side; never trust client tax rows.
- **10. Closing totals use `grand_total` not `rounded_total`** (`pos_entry.py:273`). Sub-unit
  drift when rounding is active.
- **11. Admin live summary aggregates the whole day across all shifts** (`payment.py:593`), so an
  admin's drawer view differs from the per-shift closing math. Fix: scope to the opening entry.
- **12. Forked `get_gl_entries` omits `set_transaction_currency_and_rate_in_gl_map`**
  (`sales_invoice.py:3472`), leaving `transaction_currency`/`transaction_exchange_rate` NULL on
  Sales Invoice GL rows. No money impact today; a forward-compat/reporting nit and an upgrade
  drift risk (it is a verbatim fork of core's method).

---

## Refuted / checked-and-safe

These candidates were examined and found **not** to be money bugs — recorded so they aren't
re-chased:

- **Gift-card / coupon "typed value"** (`GiftCouponPopover.tsx:70`): the value a cashier parses
  out of a coupon code is **display-only**. The backend `parse_invoice_data` has no coupon
  handling (`grep coupon *.py` = 0 hits) and `checkoutGrandTotal` comes from the backend
  preview, so a coupon does **not** reduce the booked invoice and does **not** let goods leave
  for free. It only causes a cosmetic receipt-vs-invoice mismatch. (Worth removing the
  simulated-value code to avoid confusion, but no money leaks.)
- **Over-payment (paid > total)**: live-proven safe — core sets `change_amount` (e.g. pay 150 on
  a 100 invoice → `paid_amount 150, change_amount 50, outstanding 0`), GL balances.
- **Hand-set `paid_amount`/`outstanding_amount`** (`sales_invoice.py:1440-1443`): overwritten by
  core's recompute at submit; harmless.
- **Per-item `discountPercentage`/`discountAmount` never written to the line**: the client already
  sends the net (post-discount) `rate`, so totals are correct; only ERPNext's discount *columns*
  are blank (reporting cosmetic, not a money error).
- **`get_refundable_amount` arithmetic**, **return discount proration by `rate`**, and
  **`validate_return_payout` coverage**: reviewed across multi-partial-return sequences — sound;
  `validate_return_payout` is the global over-refund guard and fires on all return paths.
- **`reconcile_payment_entry_with_invoice` allocation override** and
  **`create_customer_payment_entry` cap**: bounds hold; no over-allocation.
- **B2B "separate Payment Entry" path** (`create_payment_entry`): dead code — `business_type` is
  never persisted on the invoice, so it never runs (its currency hardcodes are moot).
- **`is_billing_contact` column missing** (raised as an env blocker for counter payments):
  refuted — `create_customer_payment_entry` succeeded live.

---

## What changed in the repo

Nothing. This is a report. Live verification ran inside `frappe.db.rollback()`; `git status`
is unchanged. Reproduction scripts live in the session scratchpad and are referenced per
finding above; they can be promoted into the Phase-4 test suite once fixes are approved.
