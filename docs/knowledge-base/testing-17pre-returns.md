# Test checklist: return-flow rework + store credit (phase-17 17-pre)

Browser tests, ~10 min. Run against a site with an open POS shift. Pick a real test
customer (not walk-in). Written 2026-08-13; backend already verified by 32 console
checks — this list verifies the same flows through the real UI.

## Prep

- [x] POS open, shift open, test customer selected.

## 1. Unpaid credit sale → return options

1. Make a credit sale (unpaid), e.g. $20.
2. Invoice History → that invoice → Return (single-return modal).
3. **Expect:** "Settle Return As" row with 3 buttons. **Refund grayed out** (hover
   tooltip: "Nothing was paid on this invoice"). **Reduce Bill preselected.** No
   payment method / amount fields visible.
4. Return 1 item as **Reduce Bill** → submit.
5. **Check:** original invoice's outstanding dropped by the returned amount.
   Desk cross-check: Accounts Receivable report shows the same lower number.

- [x] pass (2026-08-14)

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

## 3b. Store credit blocked on unpaid invoice

1. Unpaid credit sale → open Return.
2. **Expect:** both Refund AND Store Credit grayed out; only Reduce Bill available.
3. (Backend double-check: forcing store_credit via API fails with "store credit is not
   allowed because no money was ever received".)

- [x] pass (2026-08-14)

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

- [x] pass (2026-08-14)

## 7. Desk-side hook (optional)

1. Desk → open an unpaid submitted invoice → Create > Return / Credit Note.
2. Set is_pos + add a refund payment row → save.
3. **Expect block:** "refund of X exceeds the 0.0 actually received".

- [ ] pass

## 8. Multi-invoice return spot-check

1. Returns screen → multi-invoice flow → select an invoice.
2. **Expect:** per-invoice "Settle Return As" select next to Mode of Payment; payment
   fields disappear for Reduce Bill / Store Credit.
3. Submit one and verify the same rules as above.

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
