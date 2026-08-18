"""Regression tests for accounting findings from the 2026-08-18 audit (docs/audit/).

Each test pins the corrected behaviour of a confirmed money bug so a future edit that
reintroduces it fails CI. Fixtures are resolved find-or-create so the suite runs on a
fresh CI site (which provisions erpnext but no klik data) and on a populated site.
"""

import datetime
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import flt


def _company():
	name = frappe.defaults.get_global_default("company") or frappe.db.get_value("Company", {}, "name")
	return frappe.get_doc("Company", name)


def _make_item(code):
	if not frappe.db.exists("Item", code):
		frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": code,
				"item_name": code,
				"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name") or "All Item Groups",
				"is_stock_item": 0,
				"stock_uom": "Nos",
			}
		).insert(ignore_permissions=True)
	return code


def _tax_account(company):
	acc = frappe.db.get_value(
		"Account", {"company": company.name, "account_type": "Tax", "is_group": 0}, "name"
	)
	if acc:
		return acc
	parent = frappe.db.get_value(
		"Account", {"company": company.name, "root_type": "Liability", "is_group": 1}, "name"
	)
	doc = frappe.get_doc(
		{
			"doctype": "Account",
			"account_name": "KLIK Test VAT",
			"company": company.name,
			"parent_account": parent,
			"account_type": "Tax",
			"tax_rate": 10,
		}
	).insert(ignore_permissions=True)
	return doc.name


def _item_tax_template(company, account, rate, title):
	existing = frappe.db.get_value("Item Tax Template", {"company": company.name, "title": title}, "name")
	if existing:
		return existing
	doc = frappe.get_doc(
		{
			"doctype": "Item Tax Template",
			"title": title,
			"company": company.name,
			"taxes": [{"tax_type": account, "tax_rate": rate}],
		}
	).insert(ignore_permissions=True)
	return doc.name


class TestPerItemTaxRegression(IntegrationTestCase):
	"""Audit accounting finding #1: per-item tax rows must be emitted with
	set_by_item_tax_template=1 and rate=0, or ERPNext seeds every item (incl. tax-exempt
	items) with every tax account and over-charges tax."""

	def test_exempt_item_not_taxed_alongside_taxed_item(self):
		from klik_pos.api.sales_invoice import _populate_per_item_taxes

		company = _company()
		account = _tax_account(company)
		itt = _item_tax_template(company, account, 10, "KLIK Test VAT 10")
		taxed = _make_item("_KLIK_TAXED")
		exempt = _make_item("_KLIK_EXEMPT")
		customer = frappe.db.get_value("Customer", {}, "name") or frappe.get_doc(
			{"doctype": "Customer", "customer_name": "_KLIK Test Customer"}
		).insert(ignore_permissions=True).name
		profile = frappe.db.get_value("POS Profile", {}, "name")
		pos_profile = frappe.get_doc("POS Profile", profile) if profile else frappe._dict(taxes_and_charges=None)

		doc = frappe.new_doc("Sales Invoice")
		doc.customer = customer
		doc.company = company.name
		doc.update_stock = 0
		doc.taxes_and_charges = None
		doc.append("items", {"item_code": taxed, "qty": 1, "rate": 100, "item_tax_template": itt})
		doc.append("items", {"item_code": exempt, "qty": 1, "rate": 100})
		doc.set_missing_values()
		doc.set("taxes", [])
		_populate_per_item_taxes(doc, pos_profile)

		# Every appended per-item tax row must be flagged and zero-rated.
		for t in doc.taxes:
			self.assertEqual(flt(t.rate), 0, "per-item tax row must have rate 0")
			self.assertTrue(t.get("set_by_item_tax_template"), "per-item tax row must be flagged")

		doc.calculate_taxes_and_totals()
		# VAT applies to the taxed item only: 10% of 100 = 10, grand 210 (not 220).
		self.assertEqual(flt(doc.grand_total, 2), 210.00)
		total_tax = sum(flt(t.tax_amount) for t in doc.taxes)
		self.assertEqual(flt(total_tax, 2), 10.00)
		exempt_row = next(r for r in doc.items if r.item_code == exempt)
		self.assertIn(exempt_row.item_tax_rate or "{}", ("{}", "", None, "{}"))


class TestClosingReconCounterPayments(IntegrationTestCase):
	"""Audit accounting finding #2: the closing-shift 'expected' per mode must include
	standalone counter Payment Entry receipts scoped to the opening entry, matching the
	live drawer summary. Tested at the seam so it needs no submitted-PE fixtures."""

	def test_counter_payment_entry_included_in_expected(self):
		from klik_pos.api import pos_entry

		fake_ope = frappe._dict(name="_KLIK_FAKE_OPE", period_start_date=datetime.datetime(2026, 1, 1, 8, 0, 0))

		# No opening-detail rows and no Sales Invoice Payments exist for this fake name, so
		# the only contribution is the mocked counter Payment Entry. Patch where the name is
		# looked up (imported from payment inside the function under test).
		with patch(
			"klik_pos.api.payment._fetch_opening_payment_entry_data",
			return_value=[{"mode_of_payment": "Cash", "total_amount": 100, "transactions": 1}],
		):
			rec = pos_entry._calculate_payment_reconciliation(fake_ope, {"closing_balance": {"Cash": 100}})

		cash = next(r for r in rec if r["mode_of_payment"] == "Cash")
		# expected = opening(0) + SI payments(0) + counter PE(100); difference = closing(100) - 100 = 0
		self.assertEqual(flt(cash["expected_amount"], 2), 100.00)
		self.assertEqual(flt(cash["difference"], 2), 0.00)
