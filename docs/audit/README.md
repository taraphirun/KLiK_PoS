# klik_pos audit — 2026-08-18

A four-part audit of the klik_pos fork, focused (in priority order) on accounting accuracy,
security, and performance, plus a plan for a permanent test suite. Multi-agent review with an
adversarial refutation pass; the decisive items were reproduced live on `hd.phirun.me` inside
`frappe.db.rollback()` or via unauthenticated `curl`. **No code was changed** — this is a report
for triage.

## Documents

- **[accounting-findings.md](accounting-findings.md)** — money math. 12 confirmed, several
  refuted-as-safe.
- **[security-findings.md](security-findings.md)** — 12 confirmed (2 High), several refuted.
- **[performance-findings.md](performance-findings.md)** — nothing urgent at 176 invoices;
  forward-looking.
- **[test-plan.md](test-plan.md)** — backend integration + frontend Vitest + API-level e2e for the
  four flows; built after fixes are approved.

## The short list — fix these first

1. **Accounting #1 — per-item tax over-taxation (High, live-proven).** A cart mixing a taxed item
   with a VAT-exempt item over-charges VAT (grand total came out 220 vs correct 210). Fires as soon
   as an exempt item is sold alongside a taxed one. `_populate_per_item_taxes` emits tax rows without
   `set_by_item_tax_template`.
2. **Security #1 — `get_invoice_details` unauthenticated (High, live-proven).** Any anonymous caller
   reads any full invoice; names are sequential, so the whole sales history is scrapeable.
3. **Security #2 — invoice PDFs written as public Files (High).** WhatsApp-delivered receipts are
   fetchable at guessable URLs with no auth.
4. **Accounting #2 — closing reconciliation excludes counter Payment Entries (High).** The closing
   screen's expected-cash omits money taken at the counter → false variance.

## Method note

Findings are labelled **confirmed** (survived refutation, often with a live repro) vs **refuted**
(checked and safe — recorded so they aren't re-investigated). Reproduction scripts live in the
session scratchpad and are named per finding; they promote directly into the Phase-4 regression
suite once fixes land.

## Current site posture

Two of the High findings are latent-to-live depending on data: the tax bug needs an exempt/second
tax template (VAT-exempt goods are common), and the multi-currency 1:1 GL bug needs a non-USD
customer (none today). The two security High findings are live right now on the public site.
