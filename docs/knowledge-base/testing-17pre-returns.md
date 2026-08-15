# Test checklist: return-flow rework + store credit (phase-17 17-pre)

Browser tests, ~10 min. Run against a site with an open POS shift. Pick a real test
customer (not walk-in). Written 2026-08-13; backend already verified by console checks
(39 across 5 suites as of 2026-08-15) — this list verifies the same flows through the
real UI.

**2026-08-15 redesign:** the third "Reduce Bill" outcome button is retired. ERPNext's
own core silently auto-flipped its booking flag whenever a return exceeded the
original's remaining outstanding, producing a return that left the original's balance
untouched *and* created a same-size floating credit (user-reported, double-booked). The
chooser now offers only **Refund** and **Store Credit** — both capped at what was
actually paid, with any unpaid remainder always auto-settling the original bill right
after submit. For a fully unpaid invoice this collapses cleanly: no chooser is shown at
all, since refund and store credit would both be $0 — the return just reduces the bill.
Cases 1 and 3b below (written for the retired 3-button design) are superseded by the
new case 3c.

## Prep

- [x] POS open, shift open, test customer selected.

## 1. Unpaid credit sale → return options (superseded by 3c, 2026-08-15)

~~1. Make a credit sale (unpaid), e.g. $20.~~
~~2. Invoice History → that invoice → Return (single-return modal).~~
~~3. Expect: "Settle Return As" row with 3 buttons. Refund grayed out. Reduce Bill~~
   ~~preselected. No payment method / amount fields visible.~~
~~4. Return 1 item as Reduce Bill → submit.~~
~~5. Check: original invoice's outstanding dropped by the returned amount.~~

Passed under the retired 3-button design (2026-08-14). The "Reduce Bill" button no
longer exists — see case 3c for its replacement (the info-panel collapse on unpaid
invoices) and the new bug it was covering for.

- [x] superseded — see 3c

## 2. Over-return guard (the big one)

1. Same invoice → Return again → try to return the same items beyond remaining qty.
2. **Expect:** UI caps the qty at what's still available; forcing a second full return
   fails with backend error **"Cannot return more than …"**.
   (Before the fix this went through silently — double returns were possible.)

- [x] pass (2026-08-14)

## 3. Store credit creation

1. New **paid** sale, e.g. $15 cash. (Unpaid sales cannot grant store credit — the
   customer never gave the store money. On an unpaid invoice the Store Credit button
   must be grayed out, same as Refund.)
2. Return it, pick **Store Credit** → submit.
3. Customer detail page → under the Outstanding metric, green
   **"Store credit: $15"** line.
4. Desk cross-check: the credit note has outstanding **-15** and
   field "Return Outcome" = Store Credit.
   (Look in the **Sales Invoice list** filtered by "Is Return", or the **Accounts
   Receivable report** - NOT Customer > Connections, which only shows dashboard stats.)

- [x] pass (2026-08-14)

## 3b. Store credit blocked on unpaid invoice (superseded by 3c, 2026-08-15)

~~1. Unpaid credit sale → open Return.~~
~~2. Expect: both Refund AND Store Credit grayed out; only Reduce Bill available.~~
~~3. Backend double-check: forcing store_credit via API fails with "no money was ever~~
   ~~received".~~

Passed under the retired design (2026-08-14). **The hard block is gone** — see 3c: an
unpaid invoice no longer *blocks* store credit, it just skips the choice entirely
(there's nothing to choose between two $0 outcomes) and reduces the bill.

- [x] superseded — see 3c

## 3c. Unpaid invoice: no chooser, automatic bill reduction (2026-08-15)

This replaces 1 and 3b. It also directly covers a real bug: choosing the old "Reduce
Bill" on a *partly-paid* invoice's full return created a same-size floating credit
**and** left the original's balance unchanged (ERPNext's own core auto-flip silently
doubled the value) — see phase-17 / hd/returns.py for the mechanism.

1. Make a credit sale (unpaid), e.g. $20.
2. Invoice History → that invoice → Return (single-return modal).
3. **Expect:** no 3-button chooser. Instead a gray info panel: "Nothing was paid on
   this invoice. This return reduces the invoice's outstanding by $X - no refund, no
   store credit, since no money ever changed hands." Refund amount fields absent.
4. Return 1 item (e.g. $2) → submit.
5. **Check:** original invoice's outstanding dropped by exactly that amount (e.g.
   20 → 18). The return invoice's own outstanding is **0** — nothing floats as credit.
   Desk: Accounts Receivable report shows the original's lower balance; the invoice's
   linked documents include a system Journal Entry of type "Credit Note".
6. **Regression check (the actual bug):** repeat on a **partly-paid** invoice with a
   **full** return (e.g. paid $9.50 of $79.50, return all items). **Expect:** original
   settles to **0**, and store credit ends at exactly the paid amount (**$9.50**) — not
   $79.50, and not blocked. Customer page should show Store credit: $9.50, not
   Outstanding: $70 + Store credit: $79.50.

- [ ] pass

## 4. Store credit redemption (the important one)

1. Make another unpaid sale, e.g. $10.
2. Open that invoice → **Receive Payment**.
3. **Expect:** green banner "Store credit available: $15" with an
   **Apply store credit** button.
4. Tap it. **Expect toast:** "Store credit applied: $10 — invoice settled".
5. **Check:** invoice outstanding 0; customer page store credit now $5.
6. Desk cross-check: the invoice's linked documents include a system-generated
   Journal Entry of type "Credit Note" referencing both the invoice and the credit
   note.

- [x] pass (2026-08-14)

## 5. Refund locked to returned value

1. Make a **paid** POS sale (cash), e.g. $8 (2 items).
2. Return it. **Expect:** Refund preselected, payment mode visible, refund amount
   **read-only** = value of returned items, hint "Reduce return quantities to refund
   less."
3. Lower one item's return qty. **Expect:** refund amount follows automatically.
4. Submit. **Check:** credit note total = returned items' value, negative Cash payment
   row for exactly the same amount; shift/drawer math includes the refund.
   (This replaces the 00179 trap: refund and credit note can no longer disagree.)

- [x] pass (2026-08-14)

## 6. Partly-paid original: refund capped at what was paid

1. Credit sale $20, then Receive Payment $12 cash.
2. Return all items with **Refund**. **Expect:** refund amount shows 12 (capped at
   paid), breakdown shows "Unpaid portion (clears this bill): $8". Backend enforces
   the same rule if the UI is bypassed.
3. **Check after submit:** the original invoice's outstanding drops to **0** (the $8
   unpaid remainder auto-reconciles against it), and the return invoice's outstanding
   is 0 too — no floating credit, nothing still due. Desk: a system Journal Entry of
   type "Credit Note" links the two.

- [x] pass (2026-08-15)

## 7. Desk-side hook (optional)

1. Desk → open an unpaid submitted invoice → Create > Return / Credit Note.
2. Set is_pos + add a refund payment row → save.
3. **Expect block:** "refund of X exceeds the 0.0 actually received".

- [ ] pass

## 8. Multi-invoice return spot-check

1. Returns screen → multi-invoice flow → select a **paid or partly-paid** invoice.
2. **Expect:** per-invoice "Settle Return As" select with two options (Refund / Store
   credit); payment fields disappear for Store Credit.
3. Select an **unpaid** invoice instead. **Expect:** no select — same gray info panel
   as case 3c ("Nothing was paid on this invoice...").
4. Submit one of each and verify the same rules as cases 5/3c above.

- [ ] pass

## 9. Partial return doesn't drain money still owed on the rest of the invoice (2026-08-15)

The rule: cash/credit is only given from money that's genuinely spare - not needed to
cover what's left owing on the SAME invoice. A small partial return on a mostly-unpaid
invoice must not hand back cash/credit while the rest of that invoice stays just as
owed.

1. Credit sale, 10 items @ $10 (grand total $100), then Receive Payment **$30** cash
   (outstanding $70).
2. Return just **1 item** ($10). **Expect:** no chooser - gray panel: "The amount
   received on this invoice is needed to cover its remaining balance." Submit reduces
   the bill by $10 (outstanding 70 → 60), no cash, no credit.
3. Same setup, fresh invoice. Return **8 of 10 items** ($80 - big enough to clear the
   $70 still owed and then some). **Expect:** chooser appears (both Refund and Store
   Credit enabled), capped at $30 (the full amount paid - nothing left to protect once
   the return covers what's owed). Submit as Store Credit: credit note ends at exactly
   -$30 spendable; original settles to $20 (2 unreturned items × $10, correct).
4. Same setup, fresh invoice, return **all 10 items** (full return). **Expect:**
   unaffected by this rule - refund/credit available up to the full $30 paid, same as
   before this change.

- [ ] pass

## Known test-site quirks (not bugs)

- Old returns created before the fix (00159–00163 era) have phantom "Cash" rows; those
  count as "refund already given", so **refundable on those original invoices reads
  low**. Irrelevant for production (data will be wiped).
- Legacy floating credit notes count as store credit and will appear in the balance —
  that is correct AR math; redeem or ignore them.

## If something fails

Note the exact toast/error text and which step number — the backend error messages are
specific (cap amounts, invoice names) and identify the failing rule directly.
