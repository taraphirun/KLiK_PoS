"""Return-outcome rules for Sales Invoice returns (phase-17 17-pre, §2c).

A klik-created return goes through one of two cashier-chosen outcomes, both capped at
`get_refundable_amount()` - money actually received against the original invoice:

- "refund"       - money actually goes back to the customer (cash/bank rows in the
                   return's payments table). Only allowed up to the amount received.
- "store_credit" - no money moves; the credit note keeps its own negative outstanding
                   (update_outstanding_for_self = 1), which *is* the customer's store
                   credit balance, living in Accounts Receivable like everything else.
                   Redemption against other invoices happens via ERPNext's own
                   Payment Reconciliation machinery (see hd/store_credit.py).

Either way, any UNFUNDED slice of the return - value beyond what was actually paid -
never floats. `settle_unfunded_residual()` (below) reconciles it against the original
invoice's own outstanding right after submit, via the same Payment Reconciliation
engine. For a fully unpaid original this collapses cleanly: the funded slice is 0 (no
refund, no credit), and 100% of the return's value reduces the original bill - exactly
what a cashier expects from returning items nobody ever paid for.

The funding cap is not simply "money received" (`get_refundable_amount`) though - it is
`get_available_for_cash_or_credit()` (2026-08-15, revised 2026-08-16, user rule):
nothing is released while the original invoice still owes money after this return's
value is applied to it - every dollar of the return goes to paying down the bill first.
Only once a return's value fully clears what's currently owed does the leftover become
available, capped at what was truly paid (`refundable`). Handing out cash/credit while
the SAME invoice still has debt outstanding is never done, regardless of how much has
been paid in total or how much this specific return happens to be worth.

There used to be a third outcome, "reduce_bill" - book the credit directly against the
original via `update_outstanding_for_self = 0` and stop there. Retired (2026-08-15):
ERPNext's own accounts_controller auto-flips that flag back to 1 whenever the return's
value exceeds the original's *remaining* outstanding, and when it flips, the *entire*
credit floats as self-outstanding while GL books nothing against the original -
producing a return that both left the original's balance untouched AND created a
same-size floating credit (double-booked, user-reported on 00186-family invoices: paid
9.5 of 79.5, full "reduce bill" return left 70 still owed on the original *and* 79.5
floating as credit). The store_credit mechanic above doesn't have this landmine - it
was already designed to fund only what was paid and settle the rest - so it fully
subsumes reduce_bill's job. `"reduce_bill"` is still accepted as an outcome value (old
callers, e.g. multi-return payloads built before this change) and is mapped straight to
the store_credit mechanic in `apply_return_outcome()`; the custom field's Select options
still list "Reduce Bill" for existing historical documents, but new returns never write
it.

The refund cap is also enforced globally through a Sales Invoice `validate` hook
(validate_return_payout, wired in hooks.py), so Desk-created returns obey the same
rule - the creator helpers here are convenience wiring, the hook is the guarantee.
"""

import frappe
from frappe import _
from frappe.utils import flt

RETURN_OUTCOMES = ("refund", "reduce_bill", "store_credit")

# Value stored on the custom_return_outcome field (created in setup/install.py).
# "reduce_bill" is never written by new code (see module docstring) - kept only so old
# documents that already carry it stay meaningful to read.
OUTCOME_LABELS = {
	"refund": "Refund",
	"reduce_bill": "Reduce Bill",
	"store_credit": "Store Credit",
}


def get_refundable_amount(invoice_name, company=None):
	"""Money actually received against this invoice so far, net of everything already
	given away via prior returns against it - cash refunds AND store credit alike.

	This is deliberately NOT grand_total - outstanding_amount: a return settled against
	the original lowers outstanding without any money having been received, which would
	overstate what is refundable. Sources counted instead:

	- the invoice's own paid_amount (POS payments table + advances applied at submit)
	- Payment Entry allocations against it (Receive adds, Pay subtracts)
	- every prior return's `custom_return_funded_amount` - how much of THAT return was
	  actually funded as cash or spendable store credit at creation time, fixed and
	  immune to later events (the unfunded remainder settling against the original, or
	  the customer later redeeming that credit against some OTHER invoice - neither
	  changes how much was originally taken out of THIS invoice's paid pool).

	Store credit was previously invisible here (no payment row is booked for it), so a
	string of alternating cash-refund and store-credit returns against the same invoice
	kept reporting nearly the full amount paid as still available on every subsequent
	return, letting later returns over-claim funds that earlier store-credit grants had
	already spent (user-reported, invoice 00215, 2026-08-15). custom_return_funded_amount
	closes that gap; for returns created before the field existed (fallback: their own
	payment-row sum, cash-only - the same undercount the old formula always had for
	legacy data, not a new regression).

	Journal-entry payments are not counted (not used by klik flows); a JE-paid invoice
	simply shows a smaller refundable amount, which errs on the safe side.
	"""
	original = frappe.db.get_value(
		"Sales Invoice",
		invoice_name,
		["paid_amount", "docstatus"],
		as_dict=True,
	)
	if not original or original.docstatus != 1:
		return 0.0

	pe_net = frappe.db.sql(
		"""
		SELECT COALESCE(SUM(CASE WHEN pe.payment_type = 'Receive' THEN per.allocated_amount
		                         WHEN pe.payment_type = 'Pay' THEN -per.allocated_amount
		                         ELSE 0 END), 0)
		FROM `tabPayment Entry Reference` per
		JOIN `tabPayment Entry` pe ON pe.name = per.parent
		WHERE pe.docstatus = 1
		  AND per.reference_doctype = 'Sales Invoice'
		  AND per.reference_name = %s
		""",
		(invoice_name,),
	)[0][0]

	cash_fallback_expr = """COALESCE(
		(SELECT -SUM(sip.amount) FROM `tabSales Invoice Payment` sip WHERE sip.parent = si.name),
		0
	)"""
	has_funded_field = frappe.get_meta("Sales Invoice").has_field("custom_return_funded_amount")
	committed_expr = (
		f"COALESCE(si.custom_return_funded_amount, {cash_fallback_expr})"
		if has_funded_field
		else cash_fallback_expr
	)
	prior_committed = frappe.db.sql(
		f"""
		SELECT COALESCE(SUM({committed_expr}), 0)
		FROM `tabSales Invoice` si
		WHERE si.docstatus = 1
		  AND si.is_return = 1
		  AND si.return_against = %s
		""",
		(invoice_name,),
	)[0][0]

	return flt(original.paid_amount) + flt(pe_net) - flt(prior_committed)


def get_available_for_cash_or_credit(refundable, outstanding_before, return_total):
	"""How much of a return's value may become cash or spendable store credit.

	Debt first, always: nothing is released while the original invoice still owes
	money after this return's value pays down as much of it as it can. Only the
	genuine EXCESS - the part of the return's value left over once the debt is fully
	cleared - is ever available, and even that is capped at `refundable` (money truly
	received). A return smaller than what's still owed contributes 0 (100% reduces the
	bill); a return that clears the debt and then some releases exactly the leftover;
	a full return against an already-settled invoice releases up to the full
	`refundable` figure, same as before this rule existed (2026-08-15, revised
	2026-08-16, user rule: "we don't give out cash or credit unless we have more money
	than the customer owes us" - compared against the debt as a whole, not just
	whatever this one return happens to be worth).
	"""
	excess = max(flt(return_total) - flt(outstanding_before), 0.0)
	return max(min(excess, flt(refundable)), 0.0)


@frappe.whitelist()
def get_return_context(invoice):
	"""What the return UI needs to offer the right outcomes: how much money was actually
	received (refund cap) and what is still outstanding (reduce-bill relevance)."""
	si = frappe.db.get_value(
		"Sales Invoice",
		invoice,
		["grand_total", "rounded_total", "outstanding_amount", "docstatus", "is_return"],
		as_dict=True,
	)
	if not si:
		frappe.throw(_("Invoice {0} not found.").format(invoice))

	return {
		"refundable": flt(get_refundable_amount(invoice), 2),
		"outstanding": flt(si.outstanding_amount, 2),
		"grand_total": flt(si.rounded_total or si.grand_total, 2),
	}


def resolve_outcome(outcome, available):
	"""Default when the caller didn't choose: refund if there's anything available to
	refund, otherwise store credit - which, at 0 available, collapses to a pure bill
	reduction (see module docstring). Never defaults to the retired "reduce_bill"
	mechanic. `available` is `get_available_for_cash_or_credit()`, not raw
	`get_refundable_amount()` - a partly-paid partial return with nothing spare still
	defaults to store_credit (i.e. bill reduction), not a doomed refund attempt."""
	if outcome:
		if outcome not in RETURN_OUTCOMES:
			frappe.throw(_("Invalid return outcome {0}. Use one of: {1}").format(
				outcome, ", ".join(RETURN_OUTCOMES)
			))
		return outcome
	return "refund" if available > 0 else "store_credit"


def apply_return_outcome(return_doc, original_invoice, outcome=None, payment_method=None, refund_amount=None):
	"""Wire payments rows and update_outstanding_for_self on an unsaved return doc.

	Must be called after items/qty are set and before save. Totals are computed here
	(core method) so the refund amount can default to the return's own total.

	Returns (outcome, unfunded_amount): unfunded_amount is the part of the return's
	value this call did NOT fund as cash or credit (0 if fully funded) - the caller
	must pass it to settle_unfunded_residual() right after submit so it reconciles
	against the original's own outstanding instead of floating.
	"""
	_set_return_discount_and_write_off(return_doc, original_invoice)
	return_doc.run_method("calculate_taxes_and_totals")
	return_total = abs(flt(return_doc.rounded_total) or flt(return_doc.grand_total))

	refundable = get_refundable_amount(original_invoice.name)
	outstanding_before = flt(original_invoice.outstanding_amount)
	available = get_available_for_cash_or_credit(refundable, outstanding_before, return_total)
	outcome = resolve_outcome(outcome, available)

	# Legacy alias: "reduce_bill" as its own booking mechanic (flag=0, stop) is retired
	# - see module docstring for why. Old callers that still pass it get the store_credit
	# mechanic instead, which does exactly what they wanted (bill reduced) and does it
	# safely at every funding level. The label written on the doc, and the outcome
	# returned to the caller, reflect what actually happened - "store_credit" - not the
	# alias that was passed in.
	if outcome == "reduce_bill":
		outcome = "store_credit"

	return_doc.payments = []
	_set_outcome_field(return_doc, outcome)

	if outcome == "refund":
		if available <= 0:
			if refundable <= 0:
				frappe.throw(
					_("Original invoice {0} is unpaid - a cash/bank refund is not allowed. "
					  "Choose 'store credit' instead.").format(original_invoice.name)
				)
			frappe.throw(
				_("This return's value doesn't yet clear the {0} still owed on invoice "
				  "{1} - nothing is available to refund until it does. It will reduce "
				  "the bill instead.").format(
					flt(outstanding_before, 2), original_invoice.name
				)
			)

		# The refund is NOT freely choosable: it always equals the value of the returned
		# items, capped at what's available (the genuine excess once this return has
		# cleared what's owed - get_available_for_cash_or_credit). A cashier who wants
		# to hand back less money must return fewer items -
		# otherwise the difference silently became floating store credit the cashier
		# never chose (user-reported, invoice 00179: all items returned at 13.6 but
		# refund typed as 3.6 -> 10.0 orphaned credit).
		amount = min(return_total, available)
		if refund_amount is not None and abs(flt(refund_amount) - amount) > 0.01:
			frappe.throw(
				_("Refund must equal the value of the returned items ({0}, capped at the {1} "
				  "available) - got {2}. To refund less, reduce the return quantities; "
				  "to keep value with the customer instead, use 'store credit'.").format(
					flt(amount, 2), flt(available, 2), flt(refund_amount, 2)
				)
			)
		if amount <= 0:
			frappe.throw(_("Refund amount must be greater than zero."))

		if payment_method:
			return_doc.append("payments", {"mode_of_payment": payment_method, "amount": -abs(amount)})
		elif original_invoice.get("payments"):
			# No explicit mode: hand back through the modes the customer paid with,
			# clamped so the refund never exceeds the requested amount.
			remaining = amount
			for p in original_invoice.payments:
				if remaining <= 0:
					break
				row_amount = min(abs(flt(p.amount)), remaining)
				if row_amount <= 0:
					continue
				return_doc.append(
					"payments",
					{"mode_of_payment": p.mode_of_payment, "amount": -row_amount, "account": p.account},
				)
				remaining -= row_amount
		else:
			# Original was paid via Payment Entry (credit sale paid later) - refund needs an
			# explicit mode since there are no POS payment rows to mirror.
			frappe.throw(
				_("Original invoice {0} was paid by Payment Entry - pass a payment method "
				  "for the refund.").format(original_invoice.name)
			)

		# Refund rows only book when the return is a POS invoice.
		return_doc.is_pos = 1
		if not return_doc.get("pos_profile") and original_invoice.get("pos_profile"):
			return_doc.pos_profile = original_invoice.pos_profile

		unfunded = return_total - amount
		_set_funded_amount_field(return_doc, amount)

	else:  # store_credit (covers the retired reduce_bill alias too - see above)
		# Store credit is money-equivalent: the customer can spend it on any invoice, so
		# only the funded slice (up to `available`, same cap a refund would use) becomes
		# spendable credit. An unpaid original, or a partial return with nothing spare,
		# funds nothing - no throw for that; the credit note just carries no spendable
		# balance. Either way, whatever isn't funded is settled against the original
		# bill right after submit (see settle_unfunded_residual) - so a fully unpaid
		# return still does exactly what a cashier expects: the bill goes down by the
		# full returned value, nothing floats.
		#
		# The doc's own outstanding after submit will mechanically be -return_total
		# (flag=1 books the whole thing against itself) - the caller's post-submit
		# settle_unfunded_residual call is what actually trims it down to -funded.
		return_doc.update_outstanding_for_self = 1
		_make_non_pos(return_doc)
		funded = min(return_total, available)
		unfunded = return_total - funded
		_set_funded_amount_field(return_doc, funded)

	return outcome, unfunded


def _set_return_discount_and_write_off(return_doc, original_invoice):
	"""get_mapped_doc copies the original's fixed discount_amount (and write_off_amount)
	verbatim (+X) onto the return. On a return the item total is negative, and both are
	SUBTRACTED from it, so a positive copied value INCREASES the credit's magnitude -
	a 7.95 partial return of an invoice with a 1.00 invoice-level discount credited
	8.95 (user-reported 2026-08-13, invoice 00168/00169), and a full return would
	over-credit by 2x the discount. ERPNext's own return mapper has the same blind spot
	(it negates 'Actual' tax rows but not the invoice-level discount).

	Rules (mirroring the refund-amount logic the return UI already applies):
	- full return: mirror the discount, negated - the credit equals what the invoice
	  actually totalled after discount (-79.5 - (-1.0) = -78.5).
	- partial return: prorate the discount by the returned fraction, negated; or zero
	  it entirely when the POS profile's "ignore write-off on partial returns" flag is
	  set (credit the full item value).
	- percentage-based discounts are left alone: the percentage recomputes off the
	  negative total, which prorates and signs itself correctly.
	- write_off_amount: negate on full returns, zero on partial. (Real write-off GL
	  rows are not tagged against_voucher, so prorated partial write-offs make the
	  original's recomputed outstanding drift - zeroing avoids that entirely.)
	"""
	frac = 0.0
	orig_items_total = sum(abs(flt(i.qty)) * flt(i.rate) for i in original_invoice.items)
	returned_total = sum(abs(flt(i.qty)) * flt(i.rate) for i in return_doc.items)
	if orig_items_total:
		frac = returned_total / orig_items_total
	is_full_return = frac >= 0.9999

	ignore_on_partial = False
	try:
		from klik_pos.klik_pos.utils import get_current_pos_profile

		profile = get_current_pos_profile()
		ignore_on_partial = bool(
			profile and profile.get("custom_ignore_write_off_on_partial_returns")
		)
	except Exception:
		pass

	# Invoice-level fixed discount ("$1 off" style). Skip when percentage-driven.
	orig_discount = flt(original_invoice.get("discount_amount"))
	if orig_discount and not flt(return_doc.get("additional_discount_percentage")):
		if is_full_return:
			return_doc.discount_amount = -orig_discount
		elif ignore_on_partial:
			return_doc.discount_amount = 0
		else:
			return_doc.discount_amount = flt(-orig_discount * frac, 2)
		return_doc.base_discount_amount = flt(
			flt(return_doc.discount_amount) * flt(return_doc.get("conversion_rate") or 1), 2
		)

	orig_write_off = flt(original_invoice.get("write_off_amount"))
	if orig_write_off:
		write_off = -orig_write_off if is_full_return else 0
		return_doc.write_off_amount = write_off
		return_doc.base_write_off_amount = flt(
			write_off * flt(return_doc.get("conversion_rate") or 1), 2
		)


def settle_unfunded_residual(return_name, original_name, unfunded_amount):
	"""Reconcile `unfunded_amount` - the part of a return's value apply_return_outcome
	did NOT fund as cash or store credit (see get_available_for_cash_or_credit) - off
	the return's own outstanding, against the original invoice's own balance, instead of
	leaving it floating.

	Without this, a full return of a partly-paid credit sale left the unpaid slice
	floating as store credit while the original still showed the same amount owed
	(user-reported, 00186/00187: paid 29.5 of 79.5, full refund return -> refund 29.5
	but 50 floated as credit AND 50 stayed due; and again for store_credit outcome,
	00198: paid 9.5 of 79.5, full store-credit return -> customer expected exactly 9.5
	of spendable credit, not a blocked return). Net zero, wrong shape - the unfunded
	part is the unpaid part of the very bill being returned, so it clears that bill,
	leaving only the truly-paid amount as the customer's spendable balance.

	`unfunded_amount` is passed in explicitly rather than re-derived from the return
	doc's post-submit outstanding_amount: that number is correct-by-construction for
	refund (payment rows mechanically encode the split) but NOT for store_credit, whose
	doc always ends up at -return_total regardless of what was actually "available" -
	re-deriving it from raw outstanding/return_total (as an earlier version of this
	function did) silently ignored `refundable`/prior-refund history on invoices with
	more than one prior return. The caller already did that arithmetic correctly.

	Load-bearing for fully-unpaid and no-headroom-left returns too (2026-08-15): those
	now go through this same path with 0 funded, so this call is the *only* thing that
	reduces the original's outstanding at all - not just a cleanup step. Callers must
	surface a failure to the cashier rather than swallow it.

	Uses the same Payment Reconciliation machinery as store-credit redemption. Returns
	None if there was nothing to settle, else {"success": bool, "amount": flt} - on
	failure the (accounting-consistent) floating-credit state is left for the /payments
	reconciliation panel to resolve manually, and the caller must say so.
	"""
	unfunded_amount = flt(unfunded_amount)
	if unfunded_amount <= 0.005:
		return None

	# Defensive re-read, fresh post-submit: never reconcile more than what's actually
	# still outstanding on either document, regardless of what the caller computed.
	return_outstanding = -flt(frappe.db.get_value("Sales Invoice", return_name, "outstanding_amount"))
	orig = frappe.db.get_value(
		"Sales Invoice", original_name, ["customer", "outstanding_amount"], as_dict=True
	)
	if not orig:
		return None

	amount = flt(min(unfunded_amount, return_outstanding, flt(orig.outstanding_amount)), 2)
	if amount <= 0.005:
		return None

	from klik_pos.hd.store_credit import apply_store_credit

	try:
		apply_store_credit(orig.customer, original_name, amount=amount, credit_note=return_name)
		return {"success": True, "amount": amount}
	except Exception:
		frappe.log_error(
			frappe.get_traceback(), f"Return residual reconcile failed: {return_name} vs {original_name}"
		)
		return {"success": False, "amount": amount}


def _make_non_pos(return_doc):
	"""Non-refund returns move no drawer money - keep them out of POS shift/closing math."""
	return_doc.is_pos = 0
	# A mapped copy of an old invoice can carry a past due date; a non-POS credit note
	# must not have due_date before posting_date.
	return_doc.due_date = return_doc.posting_date


def _set_outcome_field(return_doc, outcome):
	if frappe.get_meta("Sales Invoice").has_field("custom_return_outcome"):
		return_doc.custom_return_outcome = OUTCOME_LABELS[outcome]


def _set_funded_amount_field(return_doc, funded_amount):
	"""Persist how much of this return was actually funded (cash or spendable credit) -
	fixed at creation, read back by get_refundable_amount() for every later return
	against the same original invoice. See that function's docstring for why this can't
	just be reconstructed from payment rows alone (misses store credit entirely)."""
	if frappe.get_meta("Sales Invoice").has_field("custom_return_funded_amount"):
		return_doc.custom_return_funded_amount = flt(funded_amount, 2)


def validate_return_payout(doc, method=None):
	"""Sales Invoice `validate` hook (hooks.py): no return may hand back more money than
	is actually available - the genuine excess once this return has cleared what's
	still owed on the original invoice (get_available_for_cash_or_credit) - regardless
	of which client created it (klik SPA, Desk, API)."""
	if not doc.get("is_return") or not doc.get("return_against"):
		return

	refund_total = -flt(sum(flt(p.amount) for p in (doc.get("payments") or [])))
	if refund_total <= 0:
		# No payout (or a nonsensical positive sum, which core validation rejects) - the
		# payout rule has nothing to say. Standalone credit notes are ERPNext's business.
		return

	refundable = get_refundable_amount(doc.return_against)
	outstanding_before = flt(
		frappe.db.get_value("Sales Invoice", doc.return_against, "outstanding_amount")
	)
	return_total = abs(flt(doc.rounded_total) or flt(doc.grand_total))
	available = get_available_for_cash_or_credit(refundable, outstanding_before, return_total)

	if refund_total > available + 0.005:
		frappe.throw(
			_("Return {0}: refund of {1} exceeds the {2} available against {3} - this return's "
			  "value doesn't yet clear the {4} still owed on it. Reduce the refund, or return "
			  "as store credit / let it reduce the bill instead.").format(
				doc.name or _("(new)"),
				flt(refund_total, 2),
				flt(available, 2),
				doc.return_against,
				flt(outstanding_before, 2),
			),
			title=_("Refund exceeds amount available"),
		)
