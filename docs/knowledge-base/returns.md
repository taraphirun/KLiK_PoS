# Returns: how each flow works

When a cashier processes a return in Klik POS, they choose **how the returned value is
settled**. There are two outcomes, both capped at what is currently **available** — and
any part of the return's value beyond that cap **always** reduces the original
invoice's own balance automatically. There is no way to end up with a return that both
leaves the original untouched and creates a floating credit; that used to be possible
(see "Why not three outcomes" below), and it was a real bug.

Every outcome creates a **credit note** in ERPNext (a Sales Invoice with "Is Return"
checked, linked to the original via "Return Against"). The outcome chosen is stamped on
the credit note in the "Return Outcome" field.

## The core rule: what "available" means (2026-08-15)

Cash or store credit is only ever given from money that is genuinely spare — not just
"money received on this invoice at some point," but money received **that isn't still
needed to cover what's left owing on the rest of the same invoice**.

```
outstanding_after_pure_reduction = max(outstanding_before − return_value, 0)
available                        = max(money_received − outstanding_after_pure_reduction, 0)
```

In plain terms: imagine this return did nothing but reduce the bill — work out what
would *still* be owed afterward. Only the slice of money received beyond that remaining
need is safe to hand out as cash or credit. Everything else pays down the bill instead.

- **A full return** (nothing is left on the invoice afterward) drives the "still owed"
  figure to zero, so the whole of what was received becomes available — this is why
  full returns behave exactly as before.
- **A partial return on a partly-paid invoice** is where this matters: returning one
  item out of ten on an invoice that's mostly unpaid should not hand back cash or
  credit for that one item while the other nine remain just as owed — the money
  already collected is still earmarked for those nine. The return instead reduces
  what's owed, keeping the money collected exactly where it was.
- **A partial return large enough to clear what's left** (e.g. returning 8 of 10 items
  when only 3 items' worth is still outstanding) frees up the genuine excess — that
  slice becomes available, same as a full return would.

This replaces an earlier version of the cap that only looked at "how much was ever
paid," independent of how much of the *same* invoice remained outstanding — which could
hand out cash/credit for a small return while the bulk of the invoice stayed untouched
and just as owed. (User rule, 2026-08-15.)

**A second, related bug found the same day:** "money received" itself has to account
for everything *already* given away by earlier returns on the same invoice — not just
earlier cash refunds, but earlier store credit too. Store credit books no payment row,
so it was invisible to the old calculation; a string of alternating refund/store-credit
returns on the same invoice kept reporting almost the full amount paid as still
available on every later return, letting the invoice's own balance go uncorrected even
after every item had been returned (user-reported, invoice 00215 — a fully-returned
$159 invoice with $100 paid was still showing $39.75 owed). Fixed by recording exactly
how much each return actually funded (`Return Funded Amount`, on the credit note) and
summing that across prior returns, instead of reconstructing it from payment rows alone.

## 1. Refund (money back)

**When available:** only when `available` (above) is greater than zero. Hidden/no
chooser at all when nothing is available (see "No chooser" below).

**The refund amount is not typed in.** It always equals the value of the items being
returned, capped at what's available. To hand back less money, return fewer items; to
leave value with the customer instead, choose Store Credit.

**What happens:** the credit note carries negative payment rows (Cash/Bank), meaning
money physically leaves the drawer or account. Whatever isn't funded (unpaid, or needed
for the rest of the invoice) is automatically reconciled against the original invoice,
clearing its outstanding instead of floating.

**What the system blocks (server-side, for every client including Desk):**
- Refunding anything when nothing is available.
- Refunding more than is available.

**Verify in Desk:** open the credit note → its Payments section shows the negative
rows; its outstanding is 0.

## 2. Store credit (use on other invoices)

**When available:** offered as a real choice whenever `available` > 0; automatic (no
chooser) at $0 otherwise.

**The credited amount is capped exactly like a refund** — at most what's available,
because store credit is money-equivalent (the customer can spend it on any other
invoice). Any part of the return beyond that cap settles the *original* invoice's own
outstanding automatically, the moment the return is submitted.

**What happens:** no money moves. The credit note keeps its own **negative
outstanding** up to the available cap — that negative amount *is* the customer's store
credit. It lives in Accounts Receivable like every other document; there is no
separate wallet or points balance to reconcile.

The balance shows up:
- on the customer's detail page ("Store credit: …" under Outstanding),
- in the Receive Payment window for any of that customer's invoices,
- in `/payments` → Reconciliation, alongside payment entries.

See `store-credit.md` for how it is redeemed.

**Verify in Desk:** Accounts Receivable report for the customer → the credit note
appears as a negative outstanding row for exactly the available amount, no more.

## 3. No chooser: automatic bill reduction

If nothing is available — either nothing was paid, or everything paid is still needed
to cover the rest of the invoice — Refund and Store Credit would both compute to **$0**.
There's nothing meaningful to choose, so the return screen shows neither button: just a
plain notice ("Nothing was paid…" or "The amount received is needed to cover its
remaining balance…") and one submit. Under the hood this runs the same Store Credit
mechanic with a $0 cap, so 100% of the return's value settles the original bill.

This is **reactive**, not a one-time decision: as the cashier changes which or how many
items are being returned, `available` is recomputed live. A small return might show no
chooser; increasing the return quantity enough to clear what's still owed can make the
chooser appear.

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
never needed to be its own mechanic. Store Credit, capped at what's available with the
remainder auto-settling the original, already produces the right answer at every
funding level. `"reduce_bill"` is still accepted as an input value from old
integrations/payloads — it's silently treated as `"store_credit"`.

## Over-return protection

The system tracks, per original invoice line, how much has already been returned across
*all* return invoices. Attempting to return more than was sold is blocked with "Cannot
return more than …" — from any client, POS or Desk, full or partial return.

## Which options the cashier sees

| Situation | Refund | Store credit |
|---|---|---|
| Nothing available (unpaid, or a small partial return on a mostly-unpaid invoice) | no chooser — automatic $0-funded bill reduction | same |
| Some available (partial return that clears what's left, or leaves genuine excess) | up to what's available; remainder settles the bill | up to what's available; remainder settles the bill |
| Full return of a paid/partly-paid invoice | **default**, up to the full amount received | available, up to the full amount received |
