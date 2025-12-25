import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def after_install():
	"""Create custom fields after app installation"""
	create_custom_fields({
		"POS Invoice Item": [
			{
				"fieldname": "custom_ds_roofing_spec",
				"label": "Roofing Spec",
				"fieldtype": "JSON",
				"default": "[]",
				"read_only": 0,
				"insert_after": "item_group",
			},
		],
		"Sales Invoice Item": [
			{
				"fieldname": "custom_ds_roofing_spec",
				"label": "Roofing Spec",
				"fieldtype": "JSON",
				"default": "[]",
				"read_only": 0,
				"insert_after": "item_group",
			},
			{
				"fieldname": "custom_description",
				"label": "Custom Description",
				"fieldtype": "Text",
				"default": "[]",
				"read_only": 0,
				"insert_after": "item_group",
			},
		]
	})
	frappe.db.commit()
