frappe.ui.form.on("Telegram Bot Settings", {
	refresh(frm) {
		// Frappe's Password control fires a live strength-check AJAX call
		// (frappe.core.doctype.user.user.test_password_strength) on every keyup/paste. For a long,
		// high-entropy value like a Cloudflare API token or a Telegram bot token (not a human-chosen
		// password), zxcvbn's crack-time estimate overflows 64-bit int on the way back through
		// orjson ("TypeError: Integer exceeds 64-bit range") - which interrupts the field before the
		// value is even staged for save. Found 2026-08-04 pasting a real Cloudflare token in. Disable
		// the check for both password fields on this form.
		["bot_token", "cloudflare_api_token"].forEach((fieldname) => {
			const field = frm.get_field(fieldname);
			if (field && field.disable_password_checks) {
				field.disable_password_checks();
			}
		});
	},
});
