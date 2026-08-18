# klik_pos security audit — findings

**Date:** 2026-08-18
**Method:** static review by four bug-class reviewers (unauthenticated exposure, IDOR/ownership,
injection/webhook, secrets/auth), each required to *refute* candidates and account for Frappe's
framework-level permission enforcement; key items reproduced live against the running site
(`hd.phirun.me`) with unauthenticated `curl` and Guest-context console runs.
**Status:** report only. No code changed. Fixes are a later, separately-approved pass.

Severity reflects **real** exploitability on this deployment (a Cambodia retail POS reachable on
the public internet), not theoretical reachability.

---

## Top findings (ranked)

| # | Sev | Auth needed | Title |
|---|-----|-------------|-------|
| 1 | **High** | none | `get_invoice_details` returns any full Sales Invoice to an anonymous caller (enumerable) |
| 2 | **High** | none | WhatsApp invoice delivery writes the invoice PDF as a **public** File at a predictable URL |
| 3 | Medium | none | `get_customer_addresses` returns any customer's postal address to an anonymous caller |
| 4 | Medium | none | WhatsApp webhook POST accepts unauthenticated document forgery (no signature check) |
| 5 | Medium | any user | `send_invoice_email` emails any invoice's PDF to an attacker-chosen recipient, spoofable sender |
| 6 | Medium | any user | `fix_null_batch_sles` lets any authenticated user rewrite Stock Ledger Entries + force a repost |
| 7 | Medium | any user | `confirm_delivery_match` posts a Payment Entry against a caller-supplied invoice, bypassing PE create perm |
| 8 | Medium | none | `verify_pin` is an unthrottled sales-person PIN brute-force / enumeration oracle |
| 9 | Low | none | Anonymous info leaks: `get_global_totals`, `get_territories`, `get_sales_tax_categories`, `get_item_price_for_customer` |
| 10 | Low | any user | `mark_invoice_as_printed`, `set_manual_delivery_status`: raw writes on any invoice by name |
| 11 | Low | none | `upload_delivery_file` accepts any file type/size; webhook verify-token check is inert |
| 12 | Low | — | Plaintext Cloudflare + Maps creds in `.secrets/production-config.md` on disk |

---

### 1. `get_invoice_details` — unauthenticated full-invoice disclosure — **High** (live-proven)

**Location:** `klik_pos/api/sales_invoice.py:891`.

`@frappe.whitelist(allow_guest=True)` and the body is essentially
`frappe.get_doc("Sales Invoice", invoice_id).as_dict()`. `frappe.get_doc` does **not** check read
permission (that lives in the REST layer, which `allow_guest` opens up), and this endpoint —
unlike its sibling `get_sales_invoices` — never routes through `apply_sql_permissions`.

**Live proof:** unauthenticated (no cookie)
`GET /api/method/klik_pos.api.sales_invoice.get_invoice_details?invoice_id=00270` returned the
full document: `customer "Phirun"`, `company "Hong Dara"`, cashier `owner "pos@phirun.me"`,
amounts, items, addresses. Invoice names are bare sequential integers (`naming_series ".#####"`),
so an attacker loops `00001..` and scrapes the **entire sales history** — customer PII, itemised
purchases, totals, tax IDs, loyalty balances, cashier identity.

**Fix direction:** drop `allow_guest`; add `frappe.has_permission("Sales Invoice", "read",
doc=invoice_id, throw=True)` (or `.check_permission("read")`) before returning. The SPA is
authenticated, so guest access is unnecessary.

### 2. WhatsApp invoice delivery writes the invoice PDF as a public File — **High**

**Location:** invoice-delivery path in `klik_pos/api/whatsapp.py` / `whatsap/utils.py` — the PDF
File is saved with `is_private=0`.

A public File is served at a guessable `/files/<name>.pdf` URL with no auth. Every invoice sent
over WhatsApp becomes a publicly-fetchable PDF of a customer's receipt. Combined with finding #1
(which yields invoice names/customer names), the exposure compounds.

**Fix direction:** save invoice PDFs with `is_private=1` and deliver via an authenticated/signed
URL rather than a public path.

### 3. `get_customer_addresses` — unauthenticated address disclosure — **Medium**

**Location:** `klik_pos/api/customer.py:299`. `allow_guest=True`, reads via `frappe.get_all`
(`ignore_permissions=True` by default), and has no POS-profile gate (unlike `get_customers`).
Returns empty on the current site only because there are zero Address rows today; any address
entered later is exposed to anonymous callers who know a customer name (harvestable via #1).

**Fix direction:** remove `allow_guest`; use `frappe.get_list` or an explicit `has_permission`.

### 4. WhatsApp webhook POST — unauthenticated document forgery — **Medium**

**Location:** `klik_pos/api/whatsap/webhook.py:11`. The POST handler does **no** signature
verification (`X-Hub-Signature-256`) and inserts documents with `ignore_permissions=True`. Anyone
who can reach the endpoint can forge inbound-message/chat documents. The GET verify-token check
(finding #11) is also inert — it compares against a `WhatsApp Settings` doctype that does not
exist in this app (the app ships `WhatsApp Setup`), so the lookup returns `None` and the check
passes when the caller omits the token.

**Fix direction:** verify the Meta `X-Hub-Signature-256` HMAC against the app secret on every POST;
fix the verify-token lookup to read the real doctype/field.

### 5. `send_invoice_email` — arbitrary-invoice PDF exfil + sender spoof — **Medium**

**Location:** `klik_pos/api/email.py:11`. Takes a caller-supplied `invoice_no`, `email`
(recipient) **and** `sender`, fetches the invoice with no read-permission check, and sends its PDF
via company SMTP. An authenticated low-priv user can mail any invoice's PDF to any address, with a
spoofed sender on the company's mail infrastructure. The HTML body also interpolates client
`customer_name` (mail-injection surface). `send_invoice_sms` (`sms.py:11`) is the same pattern to
an attacker-chosen mobile — rated low (only number/amount).

**Fix direction:** permission-check the invoice; drop the caller-supplied `sender` (use the
configured account); escape templated fields.

### 6. `fix_null_batch_sles` — direct Stock Ledger rewrite by any user — **Medium**

**Location:** `klik_pos/overrides/company.py:4`. Whitelisted, no role check; issues
`db.set_value` on Stock Ledger Entry + Serial and Batch Entry with `update_modified=False`, then
triggers a stock repost and commits. Any authenticated user can corrupt stock valuation/quantities.

**Fix direction:** gate behind System Manager / Stock Manager; this is an admin repair tool.

### 7. `confirm_delivery_match` — PE against caller-supplied invoice — **Medium**

**Location:** `klik_pos/api/delivery.py:797`. Posts a Payment Entry (via `ignore_permissions`)
against a caller-supplied invoice and a caller-supplied `amount_collected`, with no Payment Entry
create-permission or ownership check. Bounded by the outstanding-amount cap, but it lets a user
without PE rights settle arbitrary invoices.

**Fix direction:** verify the caller's role and the invoice's delivery-report linkage before posting.

### 8. `verify_pin` — unthrottled PIN brute-force oracle — **Medium**

**Location:** `klik_pos/api/sales_person.py:85` (plaintext compare `str(stored_pin)==str(pin)`,
~line 118). Iterates all sales persons, no rate-limit or lockout, so PINs (typically 4 digits) are
brute-forceable; a success writes a 30-day redis "remembered salesperson" cache keyed on a
caller-supplied `device_id` not bound to the session user (finding overlaps PIN-CACHE).

**Fix direction:** hash PINs, add attempt throttling/lockout, bind the remember-cache to the
authenticated session.

### 9. Low-sensitivity anonymous leaks — **Low**

All `allow_guest=True` with no perm layer, confirmed live as Guest:
- `get_global_totals` (`customer.py:1004`) → `{total_customers:8, total_invoices:88}`.
- `get_territories` (`customer.py:757`) → territory list.
- `get_sales_tax_categories` (`tax.py:7`) → tax template names, rates, GL account heads
  (`Cambodia Tax - HD`, 10%, `VAT - HD`).
- `get_item_price_for_customer` (`item/item_price.py:10`) → per-item selling price.

No PII/financial records, but each is an unauthenticated read that should be closed. **Fix:**
remove `allow_guest` across these.

### 10-12. Other confirmed lows

- **`mark_invoice_as_printed`** (`sales_invoice.py:939`) raw `UPDATE tabSales Invoice ... WHERE
  name=%s` on any invoice; **`set_manual_delivery_status`** (`delivery.py:1533`) overrides delivery
  status on a caller-supplied invoice. Low individually; both are missing-ownership writes.
- **`upload_delivery_file`** (`delivery.py:1247`) deliberately bypasses `ALLOWED_MIMETYPES`, no
  extension/size validation, client filename verbatim. **`clear_backend_cache`** is guest-callable
  but effectively a no-op for other users (only clears the caller's own Guest-prefixed keys) — low.
- **`.secrets/production-config.md`** holds plaintext Cloudflare API token (account-wide Workers KV
  Edit) + Google Maps key on disk. Mitigated: `.gitignore` excludes `.secrets/`, and `git ls-files`
  / `git log` confirm it is **not committed**. Still, plaintext creds on the app server; the CF
  token is over-privileged. **Fix:** move to site config / a secret store; scope the CF token down.

---

## Refuted / checked-safe (recorded so they aren't re-chased)

- **`get_sales_invoices`, `get_customers`, `get_customer_info`, `get_customer_groups`** do **not**
  leak to Guest — the `(1=0)` permission fallback (the earlier hardening) and the POS-profile gate
  return empty/error. Verified live.
- **SQL injection via user input** — refuted. Raw SQL interpolates only `%s`-placeholder counts,
  static column lists, and metadata-derived field names; user values go through parameters.
- **`delete_draft_invoice` / `submit_draft_invoice`** — the mutating call (`.delete()` / `.submit()`)
  enforces permissions (no `ignore_permissions`), so they are not open IDOR.
- **`get_link_options`** — caller supplies a doctype but the query API enforces read perms.
- **`VITE_API_KEY/SECRET` baking** — no `.env` present; nothing is baked into the shipped bundle.
- **Cloudflare token storage** — stored correctly in a Frappe doctype (over-privileged scope noted
  under #12, but not itself a leak).

## What changed in the repo

Nothing. Report only. Live checks were unauthenticated GETs and rolled-back console runs.
