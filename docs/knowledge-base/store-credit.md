# Store credit: where it lives and how it is redeemed

## What it is

Store credit is created by a return settled as "Store credit" (see `returns.md`) — only
possible when money was actually received against the original invoice, and capped at
that amount, since store credit is money-equivalent. It is
**not** a separate wallet: it is the credit note itself, sitting in Accounts Receivable
with a negative outstanding amount. The customer's total store credit = the sum of
their credit notes that still have negative outstanding.

Because it lives in AR, it can never disagree with accounting — the customer statement,
the Desk Accounts Receivable report, and the POS all read the same number from the same
place.

## Where to see it

- **Customer detail page** — "Store credit: …" shown under the Outstanding metric.
- **Receive Payment window** — when a customer with credit has an unpaid invoice, a
  green "Store credit available" banner appears with an **Apply store credit** button.
- **Desk** — Accounts Receivable report: the credit notes are the negative rows.

## How redemption works

Pressing **Apply store credit** on an unpaid invoice:

1. Collects the customer's open credit notes, **oldest first**.
2. Allocates them against the invoice, up to the invoice's outstanding (never more).
3. ERPNext's own Payment Reconciliation machinery books the allocation — it creates a
   small system-generated Journal Entry (type "Credit Note") linking the two documents
   and updates both outstandings.

After applying:
- the invoice's outstanding drops (to zero if credit covered it),
- the used credit notes' negative outstanding shrinks toward zero,
- the remaining store credit is shown in the confirmation message.

No cash is involved at any point; nothing appears in the POS shift/closing figures.

## Verify in Desk

Open the invoice after applying → its Payment Ledger / linked documents show a Journal
Entry of type "Credit Note" referencing both the invoice and the credit note. The
Accounts Receivable report reflects both sides immediately.

## Rules

- Store credit can only be applied to **submitted, unpaid sales invoices of the same
  customer**.
- Partial application is automatic: a 30 credit against a 12 invoice applies 12 and
  keeps 18 available.
- Redemption order is always oldest credit note first.
