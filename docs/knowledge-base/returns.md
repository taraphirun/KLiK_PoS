# Returns: how each flow works

When a cashier processes a return in Klik POS, they choose **how the returned value is
settled**. As of 2026-08-15 there are two outcomes, both capped at what was actually
paid on the original invoice — and any part of the return's value beyond that cap
**always** reduces the original invoice's own balance automatically. There is no way to
end up with a return that both leaves the original untouched and creates a floating
credit; the two used to be able to disagree (see "Why not three outcomes" below), and
that disagreement was a real bug.

Every outcome creates a **credit note** in ERPNext (a Sales Invoice with "Is Return"
checked, linked to the original via "Return Against"). The outcome chosen is stamped on
the credit note in the "Return Outcome" field.

## 1. Refund (money back)

**When available:** only if money was actually received against the original invoice —
POS payment at sale time, or a Payment Entry received later. Hidden/no chooser at all
when nothing was paid (see §3 below).

**The refund amount is not typed in.** It always equals the value of the items being
returned, capped at what was actually received (minus refunds already given). To hand
back less money, return fewer items; to leave value with the customer instead, choose
Store Credit. This prevents the trap where all items were returned but a smaller
amount was typed — the difference silently became store credit nobody chose.

**What happens:** the credit note carries negative payment rows (Cash/Bank), meaning
money physically leaves the drawer or account. A fully-paid original is untouched —
correct, because it was paid. On a **partly-paid** original, the refund covers only the
paid slice; the unpaid remainder of the returned value is automatically reconciled
against the original invoice, clearing its outstanding (it does not float as store
credit — the customer never paid that part).

**What the system blocks (server-side, for every client including Desk):**
- Refunding anything on an invoice where nothing was paid.
- Refunding more than was actually received.

**Verify in Desk:** open the credit note → its Payments section shows the negative
rows; its outstanding is 0.

## 2. Store credit (use on other invoices)

**When available:** always offered as a choice when something was paid; automatic
(no chooser) at $0 when nothing was paid — see §3.

**The credited amount is capped the same way a refund is** — at most what was actually
paid, because store credit is money-equivalent (the customer can spend it on any other
invoice). Any part of the return beyond that cap doesn't vanish and doesn't float: it
settles the *original* invoice's own outstanding automatically, the moment the return
is submitted.

**What happens:** no money moves. The credit note keeps its own **negative
outstanding** up to the paid cap — that negative amount *is* the customer's store
credit. It lives in Accounts Receivable like every other document; there is no
separate wallet or points balance to reconcile.

The balance shows up:
- on the customer's detail page ("Store credit: …" under Outstanding),
- in the Receive Payment window for any of that customer's invoices,
- in `/payments` → Reconciliation, alongside payment entries.

See `store-credit.md` for how it is redeemed.

**Verify in Desk:** Accounts Receivable report for the customer → the credit note
appears as a negative outstanding row for exactly the paid amount, no more.

## 3. Unpaid invoice: no choice, automatic bill reduction

If nothing was paid on the original, Refund and Store Credit would both compute to
**$0** — there's nothing meaningful to choose. So the return screen shows neither
button: just a plain notice ("Nothing was paid on this invoice — this return reduces
the invoice's outstanding by $X") and one submit. Under the hood this runs the same
Store Credit mechanic with a $0 cap, so 100% of the return's value settles the original
bill. Net effect: the customer no longer owes for the returned items, no refund, no
credit — exactly what "returning something you never paid for" should do.

**Verify in Desk:** the original invoice's outstanding drops by the returned value; the
credit note's own outstanding is 0 (nothing left floating).

## Why not three outcomes (history)

Earlier this had a third button, "Reduce Bill" — book the credit directly against the
original and stop. Retired 2026-08-15: ERPNext's own core (`accounts_controller.py`)
silently flips that booking flag back whenever a return's value exceeds the original's
*remaining* outstanding — and when it flips, GL books the *entire* credit against
itself, not the original, and the original's balance is left untouched. Result:
customer still owed the full original amount *and* had a same-size credit sitting
unused (user-reported: paid $9.50 of $79.50, a full "reduce bill" return left $70 still
owed on the original **and** $79.50 floating as unfunded credit — a genuine
double-booking, not just a display bug).

The fix isn't a workaround for that ERPNext behavior — it's recognizing "Reduce Bill"
never needed to be its own mechanic. Store Credit, capped at what was paid with the
remainder auto-settling the original, already produces the right answer at every
funding level (fully paid, partly paid, or unpaid) without ever touching that flag.
`"reduce_bill"` is still accepted as an input value from old integrations/payloads —
it's silently treated as `"store_credit"`, which does what the caller wanted.

## Over-return protection

The system tracks, per original invoice line, how much has already been returned across
*all* return invoices. Attempting to return more than was sold is blocked with "Cannot
return more than …" — from any client, POS or Desk, full or partial return.

## Which options the cashier sees

| Original invoice state | Refund | Store credit |
|---|---|---|
| Unpaid | no chooser — automatic $0-funded bill reduction | same |
| Partly paid | up to the paid amount; remainder settles the bill | up to the paid amount; remainder settles the bill |
| Fully paid | **default**, up to full amount | available, up to full amount |
