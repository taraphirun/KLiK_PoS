# Phase 17: Customer Statement (and later Supplier Statement)
**Module 18**

**Status:** 🚧 In progress. **17-pre (return-flow rework) implemented and live-tested 2026-08-13** —
26/26 console checks green against `hd.phirun.me` (all scenarios rolled back): item-link fix +
over-return guard restored, payout caps (klik + Desk via validate hook), outcome→flag wiring,
store-credit creation and redemption via Payment Reconciliation, three-outcome return UI
(Single + Multi), store-credit banner in Receive Payment, balance on customer page,
`docs/knowledge-base/{returns,store-credit}.md`. `custom_return_outcome` field created on
`hd.phirun.me` (before_migrate handles other sites). 17a-17d (statement itself) not started.
Design decided (user, 2026-08-13); central claims smoke-tested (see "Proof").

## Objective
ERPNext already ships a customer statement capability, but it is spread across a report (General
Ledger), a summary report (Accounts Receivable + ageing), and a batch emailer DocType (Process
Statement Of Accounts) with ~30 filters. The ask (user, 2026-08-13):

> I understand ERPNext already have its own customer statement feature, but I find it to be
> complicated. So I want a feature to simplify that. But I do not want anything to break.
> ERPNext data has to be accurate.

So: a simplified, manager-facing statement view — pick a customer, pick a period, see opening
balance, the transactions, the closing balance, plus what is currently outstanding and how overdue it
is. Shareable as PDF or image. Later, the same thing for suppliers.

Refined after review (user, 2026-08-13): the end goal is *"generate a customer statement that shows
me their unpaid bills / amounts still owed"* — i.e. the primary content is the **open-bills list**
(per-invoice outstanding), with the dated GL activity as supporting detail, not the other way
around. And returns must not distort it: *"only the invoices that the customer actually owed me
show up"* — see §2b, which turned up a real defect in the return flow.

## Verdict
**Feasible, and low risk.** The feature is read-only: it writes nothing, so "don't break ERPNext
data" is satisfied by construction, not by care. Accuracy is satisfied by *not* computing anything
ourselves — the implementation calls ERPNext's own report functions and renders their output.

## Decisions (user, 2026-08-13)

| # | Question | Decision |
|---|---|---|
| 1 | Statement contents | GL rows **+** outstanding **+** ageing buckets *(refined by review: open-bills list is the primary block, GL is secondary — §2, §2b)* |
| 2 | Currency | Company currency only |
| 3 | Who may view | **Managers only** — reuse this app's existing admin role set |
| 4 | Entry point | Customer detail tab first; standalone page later ("both") |
| 5 | Transaction scope | **All GL entries** for the party (not POS-only) |
| 6 | Sharing | PDF **and** image share, in scope |

## Decisions, round 2 (user, 2026-08-13 — after the returns review)

| # | Point | Decision / clarification |
|---|---|---|
| 7 | The `update_outstanding_for_self=0` rows on the site | Were the user's own manual Desk edits while experimenting — klik code has never set the flag. Diagnosis stands. |
| 8 | Site data | `hd.phirun.me` is a test site; all data wiped before production. So no data cleanup needed for prod (§2b's Payment Reconciliation cleanup is optional, test-site-only). **New deliverable instead: a knowledge-base doc describing how each money flow works** (§8b). |
| 9 | Return payout rules | Must be fixed properly, server-enforced: original unpaid → **no payout at all**; original partly/fully paid → payout allowed **up to the amount actually paid**, cash/bank. |
| 10 | Store credit | **Required, high priority**: a return option "return as store credit" whose amount can be applied toward the customer's other invoices (§2c). |
| 11 | Double return | Reproduced by the user from Desk. Root cause found — a klik bug, not an ERPNext gap (§2d). Fix properly. |

---

## 1. The mechanism

Two ERPNext reports drive the statement: the Accounts Receivable detail report drives the
open-bills block (§2 Block A), and the General Ledger report drives the account-activity block
described here. Same reuse pattern for both.

ERPNext's General Ledger report is the activity engine. Its `execute(filters)` returns
`(columns, rows)` where the rows already include an `'Opening'` row, the transaction rows, a
`'Total'` row and a `'Closing (Opening + Total)'` row — i.e. exactly the shape of a statement.

This is not a hack or a private back door: ERPNext's own Process Statement Of Accounts DocType does
precisely this. See
`erpnext/accounts/doctype/process_statement_of_accounts/process_statement_of_accounts.py:22`:

```python
from erpnext.accounts.report.general_ledger.general_ledger import execute as get_soa
```

So the backend is a thin whitelisted wrapper in `klik_pos/api/statement.py`:

```python
from erpnext.accounts.report.general_ledger.general_ledger import execute as get_soa

filters = frappe._dict({
    "company": company,             # derived server-side, never trusted from client
    "from_date": from_date,
    "to_date": to_date,
    "party_type": party_type,       # "Customer" | "Supplier"
    "party": [party],               # note: list, not string
    "group_by": "Group by Voucher (Consolidated)",
})
columns, rows = get_soa(filters)
```

…then reshape `rows` into a small, stable JSON payload for the SPA (date, voucher type, voucher no,
debit, credit, running balance, plus opening/closing figures pulled off the marker rows).

### Why reuse the report instead of writing SQL

The app already hand-rolls one GL query — `_get_customer_credit_info` in `klik_pos/api/customer.py:58`
(`SUM(debit) - SUM(credit)` over `tabGL Entry`). That is fine for a single *current* total. A dated
statement is a different problem, and the parts that are easy to get subtly wrong are exactly the
parts the report already handles:

- **Opening balance** as of `from_date` (a separate accumulation, not a filter).
- Cancelled/reversed entries (`is_cancelled`), and the finance-book / period-closing edge cases.
- Party account currency vs company currency, and presentation-currency conversion.
- Accounting-dimension and cost-center scoping, if this ever matters.

Getting any of those wrong produces a statement that disagrees with ERPNext's own report — which is
the specific failure the user asked to avoid. Calling `execute()` makes disagreement structurally
impossible: it *is* the same code path.

### Proof (run live, 2026-08-13, site `hd.phirun.me`)

Called `get_soa()` directly with the filters above for the customer with the most GL entries:

```
cols: gl_entry, posting_date, account, debit, credit, balance, voucher_type,
      voucher_subtype, voucher_no, against, party_type, party,
      against_voucher_type, against_voucher, bill_no
rows: 42
{'account': "'Opening'",                      'debit': 0.0,     'credit': 0.0,     'balance': 0.0}
{'posting_date': 2026-07-15, 'voucher_type': 'Sales Invoice', 'voucher_no': 'ACC-SINV-2026-00031',
 'debit': 3.9, 'credit': 0.0, 'balance': 3.9, 'account': '1310 - Debtors - HD'}
{'account': "'Total'",                        'debit': 2193.68, 'credit': 1230.49, 'balance': 963.19}
{'account': "'Closing (Opening + Total)'",    'debit': 2193.68, 'credit': 1230.49, 'balance': 963.19}
```

Confirms: works on this ERPNext v16 install, no Desk context needed, opening/closing rows present,
running balance already computed. Nothing else about the statement body is technically uncertain.

## 2. Statement contents (decision 1: GL + outstanding + ageing; reordered per review)

Three ERPNext calls, one endpoint, three display blocks — ordered by what the user actually reads
this statement for:

**Block A (primary) — Open Bills.** The Accounts Receivable *detail* report
(`erpnext.accounts.report.accounts_receivable.accounts_receivable.execute`, imported by Process SOA
as `get_ar_soa` at `process_statement_of_accounts.py:18`) with `report_date = to_date`,
`party_type`, `party`, `ageing_based_on`, `range1..4`. Returns one row per open voucher: invoice,
posting date, due date, invoiced amount, paid, credit-note amount, **outstanding**, and per-row
ageing ranges. Filter/display rows with nonzero outstanding. This *is* "unpaid bills / amounts
still owed" — per-invoice, netted against payments, with credit notes as negative rows so the total
is always the true amount owed.

Smoke-tested live (2026-08-13, same site/customer as the GL proof). Gotchas confirmed:

- `execute()` returns a **6-tuple**, not `(columns, rows)` — unpack `result[0], result[1]`.
- Row fields: `voucher_type, voucher_no, posting_date, due_date, invoiced, paid, credit_note,
  outstanding, age, range1..range5`.
- The floating credit note `00161` appears as a real row with `outstanding: -108.94` while its
  original `00146` shows `+108.94` — the display-netting in §2b is grounded in this.
- An invoice whose return was booked with `update_outstanding_for_self=0` (`00152`) already comes
  back netted: `invoiced: 1522.80, credit_note: 761.40, outstanding: 700.00`. Both worlds visible
  in one dataset.
- Payment Entry rows appear too (advances/refunds/unallocated payments). Keep them — they are part
  of the true amount owed — but render them under a small "Unallocated / advances" label rather
  than mixed in with bills.

**Block B — outstanding + ageing header** via Accounts Receivable Summary, exactly the way Process
SOA's `set_ageing()` does it (`process_statement_of_accounts.py:228`):

```python
from erpnext.accounts.report.accounts_receivable_summary.accounts_receivable_summary import (
    execute as get_ageing,
)

ageing_filters = frappe._dict({
    "company": company,
    "report_date": to_date,
    "ageing_based_on": "Due Date",   # or "Posting Date"; fix one, don't expose as a filter
    "range1": 30, "range2": 60, "range3": 90, "range4": 120,
    "party_type": party_type,
    "party": [party],
})
_cols, ageing = get_ageing(ageing_filters)
```

Returns one summary row per party with the 0-30 / 31-60 / 61-90 / 91-120 / 120+ buckets and the
total outstanding. Header shows: **Total Outstanding** (big) + the five buckets as a compact strip.
(Alternative: skip this call and sum Block A's per-row ageing ranges server-side — one call fewer,
same numbers. Either is fine; do not compute buckets in the SPA.)

**Block C (secondary) — Account activity.** The dated GL rows from §1 (opening / transactions /
closing), shown below the open bills or behind a toggle. This is the audit trail that reconciles
with accounting; it is not the headline.

Ageing "as of" date = the statement's `to_date`, so the header and body always describe the same
moment. Do not let them drift apart.

**Note on the two numbers.** GL closing balance and AR outstanding will not always match, and that is
correct, not a bug: closing balance is the party account balance as of `to_date` including advances
and unallocated payments; AR outstanding sums per-invoice unpaid amounts. Label them distinctly
("Closing Balance" vs "Total Outstanding") so nobody reads a discrepancy as an error. If they should
be reconciled visually, show closing balance in the body's footer and outstanding in the header — do
not put them side by side in one box.

## 2b. Returns / credit notes — why "invoices the customer no longer owes" still show up

User-reported symptom (2026-08-13): a return is made against an unpaid invoice, the original invoice
still shows as unpaid, and the return floats as a separate negative invoice. Confirmed live on
`hd.phirun.me` — both behaviors exist side by side:

```
00161  return -108.94  against 00146  update_outstanding_for_self=1
       → 00146 still Overdue, outstanding 108.94; return has outstanding -108.94
00165  return  -11.70  against 00148  update_outstanding_for_self=0
       → 00148 status "Credit Note Issued", outstanding 0        ← the desired behavior
```

**Root cause.** ERPNext's Sales Invoice field `update_outstanding_for_self` (default **"1"** in
`sales_invoice.json`). When 1, the credit note books its GL against *itself* — it keeps its own
negative outstanding and the original invoice is untouched. When 0, the GL `against_voucher` is the
`return_against` invoice (`sales_invoice.py:1669`), so the original invoice's outstanding drops.
klik_pos's return creators (`return_sales_invoice` at `api/sales_invoice.py:3294`,
`create_partial_return` at `:3841`, `create_multi_invoice_return`) never set the field, so the
default (1) applies. For POS returns with an actual cash refund the point is moot — the negative
payments row settles the credit note either way. For **credit-sale returns (no refund)** the default
produces exactly the floating-credit-note symptom.

**The flag is not a bug to hide — it is the lever the return flow should drive deliberately.**
`update_outstanding_for_self = 0` means "this credit reduces the original bill";
`= 1` means "this credit floats as party credit" — which is exactly what a store credit is (§2c).
So the fix is not "always set 0"; it is: the cashier's chosen return outcome decides the flag.
Rules in §2c. Guard rail for free: if a flag-0 return exceeds the original's remaining outstanding,
ERPNext flips the flag back to 1 itself (`accounts_controller.py:220`), so over-reduction of the
original is impossible.

**Bug found while diagnosing** — `create_partial_return` appends a refund payment row (default mode
"Cash") whenever `final_return_amount > 0`, even when the original invoice is an unpaid credit sale
where no money ever changed hands. On an `is_pos=0` return that payments row is inert in GL (the
floating 00159–00163 rows are exactly this shape), but it is wrong data on the document and would
become an actual phantom cash refund if such a return were ever `is_pos=1`. Superseded by the §2c
payout rules: refund rows only ever up to the amount actually paid, and none when nothing was paid.

**Existing floating credit notes** (already submitted with the flag at 1): test-site data, wiped
before production (decision 8), so no cleanup obligation. If wanted on the test site anyway,
ERPNext's remedy is Payment Reconciliation in Desk. Statement display rule, split by intent:
credit notes carrying the §2c store-credit marker are *not* grouped under their original — the
customer chose credit instead of reducing that bill (often the original is fully paid and there is
nothing to net against); they feed the "Store credit" header line and their own section. Unmarked
floating credit notes (legacy/manual ones like these) are grouped under their `return_against`
original with the netted remainder.

## 2c. Return outcomes and store credit (decisions 9 + 10)

Server-enforced rules, computed from the original invoice at return time
(`paid_so_far = grand_total − outstanding_amount`, both read fresh from the original):

| Original state | Refund (cash/bank) | Reduce this bill | Store credit |
|---|---|---|---|
| Unpaid | **Forbidden** — no payout rows accepted at all | Default | Allowed |
| Partly paid | Allowed, **capped at `paid_so_far`** | Allowed for the unpaid remainder | Allowed |
| Fully paid | Allowed, capped at `paid_so_far` (= grand total) | n/a (nothing outstanding) | Allowed |

Backend enforces the cap and the unpaid-means-no-payout rule regardless of what the UI sends — the
UI merely hides/limits the choices. A mixed return on a partly-paid invoice splits naturally: refund
up to `paid_so_far`, remainder goes to "reduce bill" or "store credit" per the cashier's choice.

**How each outcome books (all through ERPNext's own controller — nothing hand-written):**

- **Refund** — negative rows in the return's `payments` table (cash/bank mode), as the full-return
  flow already does. The credit note settles itself; original untouched (correct: it was paid).
- **Reduce this bill** — no payment rows, `update_outstanding_for_self = 0`. GL books the credit
  against `return_against`; the original's outstanding drops (may become "Credit Note Issued").
- **Store credit** — no payment rows, `update_outstanding_for_self = 1` (ERPNext's default). The
  credit note keeps its own **negative outstanding** — that *is* the store credit balance, sitting
  in Accounts Receivable, denominated and audited like everything else. **No new doctype, no
  parallel balance ledger** — inventing one would be exactly the "second opinion about accounting"
  failure mode §9 warns about. Mark the doc (e.g. `custom_return_outcome = "Store Credit"` or a
  remark) purely so the UI/statement can label it; the amount lives in AR only.

**Redeeming store credit against other invoices.** ERPNext's native allocation engine:
`erpnext.accounts.utils.reconcile_against_document` (`accounts/utils.py:508`) — the same machinery
Payment Reconciliation uses to knock a credit note off against an invoice. klik flow:

1. Payment screen (and customer header) shows "Store credit available: X" = sum of the party's
   credit notes with negative outstanding.
2. Cashier taps "apply store credit" → backend allocates the credit note(s) against the target
   invoice via the reconciliation utility, oldest first, capped at the invoice's outstanding.
3. Statement thereafter shows both sides netted automatically — AR already reflects allocations.

(Exact call signature of `reconcile_against_document` to be pinned down at implementation — it is
internal API like the report imports, same §9 discipline: smoke-test after ERPNext upgrades.)

**Implementation check — `is_pos` on non-refund returns.** Both klik creators inherit `is_pos`
from the original via `get_mapped_doc`. A store-credit or reduce-bill return of a POS-paid sale
would then be `is_pos=1` with an empty payments table — untested whether ERPNext's POS validation
accepts that. Likely these returns should set `is_pos = 0`: no drawer movement is involved, which
also keeps them out of shift/closing cash math. Verify at implementation time.

## 2d. Over-return: root cause (decision 11) — a klik bug, and it also blinds Desk

The user reproduced returning the same unpaid invoice twice. Cause found, proven live:

Both klik return creators map the original item link as

```python
"Sales Invoice Item": {"doctype": "Sales Invoice Item", "field_map": {"name": "prevdoc_detail_docname"}}
```

`prevdoc_detail_docname` **is not a column on Sales Invoice Item** (a query against it errors with
"Unknown column"). The mapped value is silently discarded, so klik-created return items carry **no
`sales_invoice_item` link** — the field ERPNext's own return mapper sets
(`sales_and_purchase_return.py:620`). Two consequences:

1. ERPNext's over-return guard (`validate_returned_documents` → `validate_quantity`) keys valid
   items by `(item_code, sales_invoice_item)`. With the link missing, the row falls into the
   "does not exist in the original" branch with `raise_exception=False` — a **non-blocking
   msgprint** — and `StockOverReturnError` never fires for klik-made returns.
2. `get_already_returned_items` finds prior returns *by* `sales_invoice_item`. Unlinked klik returns
   are invisible to it — so even a later **Desk** return sails past the guard, because the earlier
   klik return doesn't count. Verified: returns `00159/00160/00161` have `sales_invoice_item NULL`
   (klik-made), `00162/00163` have it set (Desk-made) — which is precisely how `00153` got fully
   returned twice.

**Fix:** change the field_map to `"name": "sales_invoice_item"` in `return_sales_invoice`
(`api/sales_invoice.py:3319`) and `create_partial_return` (`:3874`)
(`create_multi_invoice_return` delegates to the latter). ERPNext's cumulative
returned-qty validation then works, across both klik and Desk, full and partial returns. No
compensating klik-side qty check needed — restoring the link restores the core guard.

## 3. Currency (decision 2: company currency)

Pass no `presentation_currency` and no `currency` filter — the GL report then returns company
currency, which is what `_get_customer_credit_info` and the rest of this app already use. `debit`
/ `credit` / `balance` (not the `*_in_account_currency` variants) are the fields to read.

Format with the app's existing `formatCurrencyWithSymbol` using the company currency symbol from
`get_user_company_and_currency()` (`klik_pos/api/customer.py:285`). Do **not** use the POS profile's
transaction currency — for a multi-currency setup those differ, and the statement is an accounting
document.

## 4. Permissions (decision 3: managers only)

This is the one place the feature can go wrong. The report's `execute()` runs raw SQL and enforces
no document permissions — the wrapper endpoint is the only thing between a logged-in POS user and
the full financial history of any customer.

Rules:

- `@frappe.whitelist()` — **never** `allow_guest=True`. (Six endpoints in `klik_pos/api/customer.py`
  and two in `sales_invoice.py` do use it; do not copy that here.)
- Gate on this app's existing admin role set, so there is one definition of "manager" and not two.
  `_check_admin_privileges()` in `klik_pos/api/payment.py:574` already encodes it:
  `{"Administrator", "Sales Manager", "System Manager"}` (same set as `api/user.py`'s
  `is_admin_user`). Promote that helper to a shared util rather than re-declaring the set a third
  time, and `frappe.throw(_("Not permitted"), frappe.PermissionError)` when it fails.
- `company` derived server-side from the session's POS profile / `get_user_company_and_currency()`.
  Never accept a company from the client.
- Frontend mirrors the same gate for affordance only (hide the tab when
  `is_admin_user` is false, from the already-fetched `get_current_user_info`). The server check is
  the real one; the UI check just avoids showing a button that will fail.

## 5. Transaction scope (decision 5: all GL entries)

No `custom_pos_opening_entry` filtering, unlike `get_customer_statistics`
(`klik_pos/api/customer.py:913`), which counts POS-created invoices only. This statement shows
everything: POS sales, Desk-created invoices, payment entries, journal entries, credit notes.

That is the point — this is the number that reconciles with accounting. Worth a one-line note in the
UI ("Includes all accounting entries, not only POS sales") so the difference from the customer
detail page's "total spent" statistic is visible rather than confusing.

## 6. UI (decision 4: customer detail tab first, standalone page later)

**Phase 17a — tab in `CustomerPageDetails.tsx`** (`/customers/:id`). No new route, no new nav entry.

Layout, top to bottom:

1. **Period selector** — presets (This Month / Last Month / This Quarter / This Year / Custom), not
   ERPNext's ~30 filter fields. Default: This Month. Applies to the GL activity section; the
   open-bills block is always "as of `to_date`".
2. **Header block** — Total Outstanding + the five ageing buckets (§2 Block B), plus a
   **"Store credit: X"** line when the party has unallocated credit notes (§2c) so the net position
   is readable at a glance.
3. **Open Bills table (primary)** — one row per invoice still owed: Invoice (linking to
   `/invoice/:id`), Date, Due Date, Invoiced, Paid/Credited, **Outstanding**, Age. Credit notes not
   yet reconciled shown grouped under their `return_against` original with the netted remainder
   (§2b).
4. **Account activity (secondary, collapsible)** — the GL table, 5 columns: Date, Reference, Debit,
   Credit, Balance. Opening row pinned first, Closing row pinned last.
5. **Actions** — Download PDF, Share Image (§7).

Build the whole thing as a self-contained `<CustomerStatement customer={id} />` component with the
customer as a prop, so 17c can mount it unchanged.

**Phase 17c — standalone `/statements` route**, structured like `PaymentEntriesPage.tsx` (party
picker + date range + the same component). This is where the supplier tab lands. Manager-only route
gate via `ProtectedRoute`.

## 7. Sharing (decision 6: PDF + image)

Server-side for both, which keeps the shared file identical to what the screen shows and adds no SPA
dependency.

**PDF** — render a Jinja HTML template (header + ageing, then the open-bills table as the main
body, then the GL activity table — same order as the screen, §6) and pipe it through the
same path the app already uses for invoices, `frappe.get_print(...)` / `frappe.utils.pdf.get_pdf`
(see `klik_pos/api/email.py:31`). Process SOA's `get_report_pdf()` / `download_statements()` are the
reference implementation if a print-format-driven approach is preferred later.

**Image** — convert page 1 of that same PDF to PNG. `pdftoppm` (poppler-utils) is already installed
at `/usr/bin/pdftoppm`, and Pillow 12.2.0 is already in the bench venv, so this needs **no new
dependency** — a `subprocess` call to `pdftoppm -png -r 150 -f 1 -l 1` plus an optional Pillow
downscale. Avoid adding `pdf2image` (not installed) or a client-side `html2canvas` (not in
`package.json`) unless one of those turns out to be materially simpler.

**Delivery** — reuse the existing send infrastructure (WhatsApp / Telegram / email / SMS in
`klik_pos/api/`), but note the current endpoints are invoice-shaped
(`send_invoice_email`, `deliver_invoice_via_whatsapp`), so this needs either a generic
"send this file to this contact" endpoint or statement-specific siblings. Prefer the generic one —
supplier statements and any future document will want it too.

## 8. Supplier Statement (Phase 17d)

Backend is nearly free: same `general_ledger.execute()` with `party_type: "Supplier"`; ageing
equivalent is `accounts_payable_summary` (and `supplier_ledger_summary` for a future all-parties
overview). **Write the wrapper party-type-generic from day one** — it costs nothing now and avoids a
fork later. Same for the React component: take `partyType` as a prop.

Frontend is **greenfield**, and this is the honest scope caveat: there is currently *zero* Supplier
or Purchase Invoice code anywhere in `klik_pos/` or `klik_spa/src/` (verified by grep). No supplier
list page, no supplier detail page, no supplier picker. The statement table is reusable; the way you
get to it is not. Budget it as "new small page", not "flip a flag". This is also why supplier lands
on the standalone `/statements` page (17c) rather than a customer-detail tab.

## 8b. Knowledge-base doc (decision 8)

A user-facing doc set describing how each money flow works in this system — written for the shop,
not for developers, because the site data will be wiped and the *processes* are what carry over to
production. One markdown file per flow under `docs/knowledge-base/`:

- Cash/QR sale (paid POS invoice) — what gets booked, where it shows.
- Credit sale (unpaid invoice) — outstanding, due date, where it appears on the statement.
- Partial payment — allocation, remaining outstanding.
- Return of a **paid** sale → refund path (§2c) — caps, what the customer walks away with.
- Return of an **unpaid** sale → reduce-bill path — original invoice's status change.
- Return → **store credit** path — where the balance lives, how to see it, how it is redeemed.
- Applying store credit at checkout — what reconciliation does to both documents.
- Reading the customer statement — open bills vs activity vs closing balance vs store credit.

Each doc: the flow as steps, which documents ERPNext creates, and where to verify the numbers in
Desk (so trust in the simplified UI can always be re-anchored to ERPNext itself). Write them as the
features land (17-pre → 17b), not as an afterthought at the end.

## 9. Is "Klik POS as a UI layer over ERPNext" sustainable?

Answered directly, because it changes how this and every later feature should be built.

**Yes — conditionally.** The condition is the pattern this codebase already mostly follows:

- **Reads** reuse ERPNext's report/utility functions rather than re-deriving numbers. (This feature;
  `get_credit_limit` in `customer.py:67`.)
- **Writes** go through ERPNext DocType controllers and its own helpers rather than touching tables.
  (Payment allocation calls `update_voucher_outstanding` in `payment.py:449`; draft invoices go
  through the Sales Invoice doc.)

As long as that holds, "UI layer" is genuinely sustainable, because the accounting truth stays in
exactly one place and this app never becomes a second opinion about it. ERPNext upgrades then affect
presentation, not correctness.

**The failure mode to avoid** is copying business logic instead of calling it — a hand-written
statement SQL, a hand-written credit-limit rule, a hand-written outstanding recalculation. Each one
is a fork of ERPNext's accounting that silently drifts and only shows up as "the POS says one number,
the Desk report says another." That is the thing that would make this unsustainable, and it is a
choice made per-feature, not an inevitability.

**Two real costs to accept, not deny:**

1. **Internal-API coupling.** `report.general_ledger.execute` and
   `accounts_receivable_summary.execute` are not documented public APIs; they are internal imports.
   Mitigation is that ERPNext imports them the same way in Process SOA, so they cannot change
   casually — but the correct discipline is a smoke test (a `bench console` call like the one in
   "Proof") run after each ERPNext upgrade, for every such import this app depends on. The list is
   short today; keep it short and keep it written down (see the checklist task below).
2. **Surface growth.** `sales_invoice.py` is 4270 lines; the SPA has 18 pages. The maintenance cost
   of this direction is not correctness — it's breadth. Every "just add X too" adds an endpoint, a
   page, and a permission decision. That is the thing to ration, and it is a product decision, not a
   technical limit.

---

## Implementation plan

**17-pre — Return-flow rework (do this first; the statement is only as truthful as the returns)**
0a. **Restore the item link** (§2d): field_map `"name": "sales_invoice_item"` in
    `return_sales_invoice` (`api/sales_invoice.py:3319`) and `create_partial_return` (`:3874`).
    Re-test the double-return scenario — must now raise `StockOverReturnError`.
0b. **Payout rules server-side** (§2c): read the original fresh, compute
    `paid_so_far = grand_total − outstanding_amount`; reject payment rows when unpaid; cap refunds
    at `paid_so_far`; kill the phantom default-"Cash" append in `create_partial_return`.
0c. **Outcome → flag wiring** (§2c): refund → payment rows, flag untouched; reduce-bill →
    `update_outstanding_for_self = 0`; store credit → flag 1 + outcome marker on the doc.
0d. **Return UI**: three-outcome choice on the return screen, options hidden/capped by the
    original's paid state (refund hidden when nothing paid, etc.).
0e. **Store credit redemption** (§2c): available-credit fetch (sum of party's negative-outstanding
    credit notes) + "apply store credit" on the payment screen via
    `reconcile_against_document`, oldest-first, capped at the target invoice's outstanding. Show
    the balance on the customer header too.
0f. **Knowledge-base docs** (§8b) for the return and store-credit flows, written as they land.

**17a — Backend + customer detail tab (core)**
1. `klik_pos/hd/statement.py` (new-module location per CLAUDE.md fork discipline):
   `get_party_statement(party_type, party, from_date, to_date)` —
   manager-gated, company derived server-side, calls `get_ar_soa` (open bills) + `get_ageing` +
   `get_soa` (GL activity), returns
   `{outstanding, ageing{}, store_credit, open_bills[], opening, activity_rows[], total, closing,
   currency}`.
2. Promote `_check_admin_privileges()` (`payment.py:574`) to a shared util; use it here.
3. `klik_spa/src/services/statement.ts` + `CustomerStatement.tsx` (period presets, ageing header,
   open-bills table with credit-note grouping, collapsible GL activity, both parties supported by
   prop).
4. Mount as a tab in `CustomerPageDetails.tsx`, hidden when `is_admin_user` is false.
5. Verify: `npx tsc -p tsconfig.app.json --noEmit` (baseline 184 errors — must not increase),
   `npx eslint` on touched files, and a `bench console` cross-check of one customer's open-bills
   total and closing balance against the Desk Accounts Receivable and General Ledger reports.

**17b — PDF + image share**
6. Jinja template + `get_statement_pdf()` endpoint (same gate).
7. `get_statement_image()` via `pdftoppm` subprocess; no new dependency.
8. Generic "send file to contact" endpoint, or statement-specific WhatsApp/Telegram/email siblings.

**17c — Standalone `/statements` page**
9. Party picker + date range, mounting the same `CustomerStatement` component; manager-gated route.

**17d — Supplier statement**
10. Supplier picker + `party_type="Supplier"` + `accounts_payable_summary` ageing. Backend should
    already work unchanged if step 1 was written party-type-generic.

**Cross-cutting**
11. Add an "ERPNext upgrade smoke checks" note listing the internal report imports this app depends
    on, so a version bump has a defined verification step.
