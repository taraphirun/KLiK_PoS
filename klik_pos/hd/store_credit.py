"""Store credit = credit notes with their own negative outstanding (phase-17 §2c).

A "store credit" return (hd/returns.py) submits a credit note with
update_outstanding_for_self = 1 and no refund rows, so it keeps a negative
outstanding_amount in Accounts Receivable. That negative outstanding IS the
customer's store credit balance - no separate doctype, no parallel ledger.

Redemption reuses ERPNext's own Payment Reconciliation machinery end to end:
get_unreconciled_entries -> allocate_entries -> reconcile(), which books a
system-generated "Credit Note" Journal Entry knocking the credit note off
against the target invoice. Nothing here writes GL or outstanding by hand.
"""

import frappe
from frappe import _
from frappe.utils import flt, getdate


@frappe.whitelist()
def get_store_credit(customer):
	"""The customer's available store credit: submitted credit notes that still carry a
	negative outstanding (their own, i.e. not yet allocated to any invoice)."""
	if not customer or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found.").format(customer))

	fields = ["name", "posting_date", "return_against", "outstanding_amount"]
	if frappe.get_meta("Sales Invoice").has_field("custom_return_outcome"):
		fields.append("custom_return_outcome")

	notes = frappe.get_all(
		"Sales Invoice",
		filters={
			"customer": customer,
			"docstatus": 1,
			"is_return": 1,
			"outstanding_amount": ["<", -0.005],
		},
		fields=fields,
		order_by="posting_date asc, name asc",
	)

	for n in notes:
		n["available"] = abs(flt(n.pop("outstanding_amount")))

	return {
		"customer": customer,
		"total": sum(n["available"] for n in notes),
		"credit_notes": notes,
	}


@frappe.whitelist()
def list_store_credit_notes(search=None, limit=50):
	"""All customers' unallocated store-credit notes, shaped like the unallocated
	payment entries the /payments reconciliation panel lists - so credit notes can sit
	in the same 'Credit / Payment Entries' column and be allocated the same way."""
	conditions = ["si.docstatus = 1", "si.is_return = 1", "si.outstanding_amount < -0.005"]
	values = {"limit": int(limit)}
	if search:
		conditions.append("(si.name LIKE %(search)s OR si.customer LIKE %(search)s OR si.customer_name LIKE %(search)s)")
		values["search"] = f"%{search}%"

	rows = frappe.db.sql(
		f"""
		SELECT si.name, si.customer, si.customer_name, si.posting_date, si.currency,
		       si.return_against, si.custom_return_outcome,
		       ABS(si.outstanding_amount) AS unallocated_amount
		FROM `tabSales Invoice` si
		WHERE {" AND ".join(conditions)}
		ORDER BY si.posting_date ASC, si.name ASC
		LIMIT %(limit)s
		""",
		values,
		as_dict=True,
	)
	for r in rows:
		r["entry_type"] = "credit_note"
	return {"data": rows}


@frappe.whitelist()
def apply_store_credit(customer, invoice, amount=None, credit_note=None):
	"""Allocate the customer's store credit against one outstanding invoice, oldest
	credit note first, capped at the invoice's outstanding (and at `amount` if given).
	Pass `credit_note` to spend one specific note instead of oldest-first (used by the
	/payments reconciliation panel, where the cashier picked an exact row).

	Runs ERPNext's Payment Reconciliation programmatically - the same engine the Desk
	tool uses - so the allocation JE, outstanding updates and payment ledger are all
	ERPNext's own doing.
	"""
	target = frappe.db.get_value(
		"Sales Invoice",
		invoice,
		["name", "customer", "company", "docstatus", "is_return", "outstanding_amount", "posting_date"],
		as_dict=True,
	)
	if not target or target.docstatus != 1:
		frappe.throw(_("Invoice {0} is not submitted.").format(invoice))
	if target.is_return:
		frappe.throw(_("{0} is a return - store credit can only be applied to a sale.").format(invoice))
	if target.customer != customer:
		frappe.throw(_("Invoice {0} does not belong to customer {1}.").format(invoice, customer))

	invoice_outstanding = flt(target.outstanding_amount)
	if invoice_outstanding <= 0:
		frappe.throw(_("Invoice {0} has no outstanding amount.").format(invoice))

	credit = get_store_credit(customer)
	if credit_note:
		credit["credit_notes"] = [n for n in credit["credit_notes"] if n["name"] == credit_note]
		credit["total"] = sum(n["available"] for n in credit["credit_notes"])
		if not credit["credit_notes"]:
			frappe.throw(
				_("Credit note {0} has no unallocated store credit for customer {1}.").format(
					credit_note, customer
				)
			)
	if not credit["credit_notes"]:
		frappe.throw(_("Customer {0} has no store credit available.").format(customer))

	to_apply = invoice_outstanding
	if amount is not None:
		amount = flt(amount)
		if amount <= 0:
			frappe.throw(_("Amount to apply must be greater than zero."))
		to_apply = min(to_apply, amount)
	to_apply = min(to_apply, credit["total"])

	pr = frappe.new_doc("Payment Reconciliation")
	pr.company = target.company
	pr.party_type = "Customer"
	pr.party = customer
	pr.receivable_payable_account = frappe.db.get_value("Sales Invoice", invoice, "debit_to")
	# Window must span both the credit notes and the target invoice.
	dates = [getdate(target.posting_date)] + [getdate(n["posting_date"]) for n in credit["credit_notes"]]
	pr.from_invoice_date = pr.from_payment_date = min(dates)
	pr.to_invoice_date = pr.to_payment_date = max(dates)
	pr.get_unreconciled_entries()

	target_invoices = [row.as_dict() for row in pr.invoices if row.invoice_number == invoice]
	if not target_invoices:
		frappe.throw(_("Invoice {0} was not found among unreconciled invoices.").format(invoice))

	credit_note_names = [n["name"] for n in credit["credit_notes"]]
	# pr.payments lists PEs, JEs and dr/cr notes; keep only this customer's store credit
	# notes, oldest first (get_store_credit already sorts ascending).
	credit_rows = [
		row.as_dict()
		for name in credit_note_names
		for row in pr.payments
		if row.reference_type == "Sales Invoice" and row.reference_name == name
	]
	if not credit_rows:
		frappe.throw(_("No unreconciled store credit found for customer {0}.").format(customer))

	# Trim the credit rows to exactly the amount being applied - allocate_entries splits
	# the last row itself via its allocation logic, so just cap each row's amount.
	remaining = to_apply
	selected = []
	for row in credit_rows:
		if remaining <= 0.005:
			break
		row_available = min(flt(row.get("amount")), remaining)
		row["amount"] = row_available
		selected.append(row)
		remaining -= row_available

	# One call - allocate_entries resets pr.allocation on every invocation, so all selected
	# credit rows must go in together. It walks payments x invoices greedily, which with a
	# single target invoice gives exactly the oldest-first allocation wanted here.
	pr.allocate_entries(frappe._dict({"invoices": target_invoices, "payments": selected}))
	allocations = [
		{"credit_note": row.reference_name, "allocated": flt(row.allocated_amount)}
		for row in pr.get("allocation")
	]

	# reconcile() submits a system-generated Journal Entry; a cashier role has no JE
	# permission, so run the final step elevated. Everything the elevated block does was
	# validated above (same customer, submitted docs, capped amounts) and executes only
	# ERPNext's own reconciliation code.
	#
	# Deliberately NOT frappe.set_user() - that call also overwrites local.session.sid
	# and wipes local.session.data (user-reported logout bug, 2026-08-16: set_user()
	# corrupts the live request's session, and once Session.update() persists it back to
	# Redis under the real sid, the next request resumes with no user and gets treated as
	# Guest). Permission/role checks only ever read frappe.session.user
	# (frappe.get_roles(), has_permission() both default to it) - so only that, plus the
	# two permission caches set_user() also resets, needs touching here. sid and
	# session.data are never involved.
	original_user = frappe.session.user
	original_role_permissions = getattr(frappe.local, "role_permissions", {})
	original_user_perms = getattr(frappe.local, "user_perms", None)
	try:
		frappe.local.session.user = "Administrator"
		frappe.local.role_permissions = {}
		frappe.local.user_perms = None
		pr.reconcile()
	finally:
		frappe.local.session.user = original_user
		frappe.local.role_permissions = original_role_permissions
		frappe.local.user_perms = original_user_perms

	return {
		"success": True,
		"customer": customer,
		"invoice": invoice,
		"applied": flt(to_apply, 2),
		"allocations": allocations,
		"invoice_outstanding": flt(
			frappe.db.get_value("Sales Invoice", invoice, "outstanding_amount")
		),
		"remaining_store_credit": get_store_credit(customer)["total"],
	}
