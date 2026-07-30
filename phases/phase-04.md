# Phase 4: Customer Credit Limit Validation
**Module 4**

**Status:** ⬜ Not started

## Objective
Enforce customer credit limits during the POS checkout process, preventing submission if limits are exceeded.

## Scope note (2026-07-30)
ERPNext core already enforces credit limits on `Sales Invoice.on_submit()` via
`erpnext.selling.doctype.customer.customer.check_credit_limit()`, and klik_pos doesn't bypass it —
so over-limit invoices already fail today. This phase wraps the existing core functions
(`get_credit_limit`, `get_customer_outstanding`) in a **pre-submit** check so the Payment Dialog can
warn the cashier before the draft invoice is created, instead of only after `doc.submit()` throws.
No credit-limit math is being reimplemented. See `implementation_plan.md` → Module 4 for details.

## Todos
- [ ] [010.md](../todo/010.md): Backend credit limit verification API (wraps core, pre-submit only)
- [ ] [011.md](../todo/011.md): Frontend Payment Dialog credit limit validation integration
- [ ] [037.md](../todo/037.md): Show customer credit used / credit limit on the Customers list page
