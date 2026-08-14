# Returns: how each flow works

When a cashier processes a return in Klik POS, they choose **how the returned value is
settled**. There are exactly three outcomes, and the system enforces which ones are
available based on what actually happened with the original invoice's money.

Every outcome creates a **credit note** in ERPNext (a Sales Invoice with "Is Return"
checked, linked to the original via "Return Against"). The difference between the
outcomes is only where the value goes. The outcome chosen is stamped on the credit note
in the "Return Outcome" field.

## 1. Refund (money back)

**When available:** only if money was actually received against the original invoice —
POS payment at sale time, or a Payment Entry received later.

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
- Refunding more than was actually received. ("Bill reduced" credits do not count as
  money received.)

**Verify in Desk:** open the credit note → its Payments section shows the negative
rows; its outstanding is 0.

## 2. Reduce bill (lower what's owed)

**When available:** when the original invoice still has an outstanding amount.

**What happens:** no money moves. The credit note is booked directly against the
original invoice ("Update Outstanding for Self" is unchecked), so the original's
outstanding drops by the returned value. If everything is returned, the original's
status becomes "Credit Note Issued".

Safety: ERPNext itself refuses to reduce the original below zero — if the return is
larger than what is still outstanding, the remainder automatically stays on the credit
note (effectively becoming store credit).

**Verify in Desk:** open the original invoice → outstanding is lower; Accounts
Receivable report shows the reduced amount.

## 3. Store credit (use on other invoices)

**When available:** only if money was actually received against the original invoice —
same rule as a refund, because store credit is money-equivalent (the customer can spend
it anywhere). An unpaid invoice grants no store credit: the customer never gave the
store anything, so that case is "reduce bill". On a partly-paid invoice, at most the
paid amount can become store credit.

**What happens:** no money moves. The credit note keeps its own **negative
outstanding** — that negative amount *is* the customer's store credit. It lives in
Accounts Receivable like every other document; there is no separate wallet or points
balance to reconcile.

The balance shows up:
- on the customer's detail page ("Store credit: …" under Outstanding),
- in the Receive Payment window for any of that customer's invoices.

See `store-credit.md` for how it is redeemed.

**Verify in Desk:** Accounts Receivable report for the customer → the credit note
appears as a negative outstanding row.

## Over-return protection

The system tracks, per original invoice line, how much has already been returned across
*all* return invoices. Attempting to return more than was sold is blocked with "Cannot
return more than …" — from any client, POS or Desk, full or partial return.

## Which options the cashier sees

| Original invoice state | Refund | Reduce bill | Store credit |
|---|---|---|---|
| Unpaid | disabled | **default** | disabled |
| Partly paid | up to the paid amount | available | up to the paid amount |
| Fully paid | **default**, up to full amount | disabled (nothing owed) | available |
