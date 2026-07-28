import frappe
from klik_pos.api.sales_invoice import build_sales_invoice_doc

frappe.init(site="klik-pos.test") # wait, what is the site name? 
