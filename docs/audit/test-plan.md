# klik_pos test-harness plan

**Date:** 2026-08-18
**Status:** design only. No test code is written yet — per the audit-before-tests decision,
the suite is built after the accounting findings are triaged and fixed, so tests encode the
**corrected** behavior, not today's bugs.

**Goal:** lock the four money-critical flows so future edits can't silently break them —
sell + payment + change, returns + store credit, closing-shift reconciliation, and the
delivery/Telegram invoice flows.

---

## Layer 1 — Backend integration tests (primary)

**Where:** `klik_pos/tests/` using `from frappe.tests import IntegrationTestCase` (v16; the
current `test_customer.py` and the 6 doctype stubs import the **deprecated**
`frappe.tests.utils.FrappeTestCase` and must be migrated).
**Runs in:** existing CI (`bench --site test_site run-tests --app klik_pos`) — no new infra.
**Reuse:** ERPNext factories — `erpnext/.../pos_profile/test_pos_profile.py::make_pos_profile`,
`erpnext/.../sales_invoice/test_sales_invoice.py::create_sales_invoice`,
`erpnext/.../test_pos_invoice.py` as the structural model; `make_item`, `make_stock_entry`
for stock setup.

Each test asserts **core-computed** figures (`grand_total`, `rounded_total`, `net_total`,
`outstanding_amount`, `paid_amount`, `change_amount`) and that the resulting `GL Entry` set
nets to zero — never re-derives amounts by hand.

### Flow suites

1. **Checkout** (`test_checkout_flow.py`)
   - single item, cash, exact pay → totals + GL balance.
   - multi-payment (cash + card) summing to total.
   - overpayment → `change_amount` booked, `outstanding == 0` (pins the verified-safe behavior).
   - discount (line + additional) → grand_total correct.
   - credit sale (partial / unpaid) → `outstanding` correct, `allow_partial_payment` respected.

2. **Returns + store credit** (`test_returns_flow.py`)
   - full return of a paid POS invoice → return totals negated, refund path, GL balance.
   - partial return → prorated discount/write-off, `available_qty` decremented.
   - store-credit grant then redeem via `apply_store_credit` → outstanding cleared through
     ERPNext Payment Reconciliation, no direct JE.
   - over-refund attempt → `validate_return_payout` blocks it.

3. **Closing shift** (`test_closing_flow.py`)
   - open entry → 2 sales (cash + card) → close → per-mode expected matches collected.
   - **regression for finding #2**: a shift with a standalone counter Payment Entry — closing
     "expected" must include it (currently excluded).
   - **regression for finding #5**: refund in a later shift is attributed to the shift where
     the cash leaves.

4. **Delivery invoice** (`test_delivery_flow.py`)
   - `create_invoice_from_report` / `pay_in_full` path → paid in full with **no residual
     outstanding** (regression for finding #6: `rounded_total` vs `grand_total`).
   - `create_multi_invoice_return` with one failing invoice → result reports partial failure
     (regression for finding #4).

### Regression tests for each confirmed accounting finding

One focused test per confirmed finding so the fix is provable and stays fixed. Highest value:

- **#1 per-item tax** (`test_per_item_tax.py`): cart of a VAT item + a tax-exempt item →
  assert the exempt item is **not** taxed and `grand_total` is correct (would be 210, not 220,
  in the audit's live repro). Also the two-different-tax-accounts case (215, not 230). The
  audit repro scripts `scratchpad/test_peritem_tax*.py` promote directly into this test.
- **#3 multi-currency**: a non-company-currency customer → `conversion_rate != 1` and
  `base_grand_total != grand_total` (or an explicit block if multi-currency stays out of scope).

---

## Layer 2 — Frontend unit tests (Vitest)

**New infra** (none exists today): add Vitest — Vite 7 + the `@` alias are already configured;
add a `test` script and a `typecheck` script to `klik_spa/package.json`, and a frontend job to
`.github/workflows/ci.yaml` (currently backend-only).

**Start with the pure-logic money utils** (no mocking needed):
- `utils/currencyMath.ts` — `roundCurrency`, `addCurrency`/`subtractCurrency`,
  `calculateChange`, `calculateRemainingAmount`, `isPaymentComplete`. Pin change/rounding math.
- `utils/cartPricing.ts` — `getEffectiveItemRate`, `getExclusiveTaxRateForItem`,
  `getEffectiveDisplayRate`. Pin the client tax/discount back-out.
- `utils/currency.ts` — formatting.

These are the client formulas the backend trusts (the cashier-quoted rate/price come from
`getEffectiveItemRate`), so they are worth locking even though they are display-adjacent.

**Later, with a network mock** (MSW recommended — 40 of the 59 fetch sites live outside
`services/`, so mocking at the network layer covers them without refactoring): the checkout
`PaymentDialog` payload builders and the store hooks.

---

## Layer 3 — API-level e2e (accuracy backbone, owner's pick)

Drive each of the four flows end-to-end through the same `/api/method/...` endpoints the POS
UI calls, against a test site, asserting the final ERPNext state (invoice totals, GL balance,
POS Closing reconciliation). Full day-cycle script:

open shift → sell (with change) → sell on credit → partial return → full return →
store-credit grant → apply store credit → counter payment → close shift → assert the closing
reconciliation balances per payment mode.

This is the highest-fidelity guard against accounting regressions because it exercises the real
whitelisted endpoints, elevation paths, and hooks together. It can run as a `bench execute`
script in CI after the integration suite, or as a Playwright API-request spec.

**Browser e2e** (Playwright driving `klik_spa`) is deferred — higher maintenance; add a small
smoke suite for the critical checkout path only if UI regressions become a recurring problem.

---

## Housekeeping (do alongside the first test PR)

- Delete `test_checkout.py` at the repo root — broken scratch debris
  (`frappe.init(site="klik-pos.test") # wait, what is the site name?`).
- Migrate `klik_pos/tests/test_customer.py` and the 6 doctype stubs off the deprecated
  `FrappeTestCase` import to `from frappe.tests import IntegrationTestCase` / `UnitTestCase`.
- Add `test` + `typecheck` scripts to `klik_spa/package.json` and a frontend CI job.

## Sequencing

1. Fix the confirmed accounting findings (separate approved pass).
2. Land the Layer-1 regression tests **with** those fixes (red → green proves each fix).
3. Build out the Layer-1 flow suites and Layer-2 util tests.
4. Add the Layer-3 API e2e day-cycle as the release gate.
