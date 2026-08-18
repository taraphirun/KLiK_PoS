# Cashier user setup: roles and permissions

## What a cashier account needs

A cashier logs into the klik POS frontend (`klik_spa`), opens a POS session, sells,
takes payments, and handles returns. They should NOT be able to create or submit
Journal Entries from Desk — store-credit redemption submits its system-generated
Journal Entry through a scoped in-code elevation (`klik_pos/hd/store_credit.py`,
`apply_store_credit`), precisely so this permission never has to be granted to the
cashier role.

Verified working setup (site `hd.phirun.me`, user `pos@phirun.me`, 2026-08-18):

### Roles

| Role | Why |
|---|---|
| Sales User | Baseline selling access (Customer, Item, Selling module) |
| Sales Manager | The only non-admin role with create+submit on POS Opening Entry and POS Closing Entry on this site. Note: klik_pos treats Sales Manager as admin-tier in its own UI (`klik_pos/api/user.py` `admin_roles`), so this also unlocks the POS admin screens. |

### Extra role permissions (Role Permission Manager, added to Sales User)

These are shipped as fixtures (`klik_pos/fixtures/custom_docperm.json`, exported for
`role = Sales User`) and restored automatically by `bench --site <site> migrate` — no
manual re-adding on a fresh site. Each was confirmed missing by a live
`frappe.has_permission` audit and each breaks a real POS flow without it:

| Doctype | Perm | Breaks without it |
|---|---|---|
| Sales Invoice | read, write, create, submit (+cancel if voiding from POS is allowed) | Checkout — no role grants Sales Invoice at all in a stock ERPNext install except Accounts User/Manager |
| Item Price | read | Item pricing and barcode search show nothing |
| Batch | read | Batch-tracked item selection |
| Serial No | read | Serialised item selection |

### Module access (User form → Allow Modules)

At minimum: KLiK PoS, Selling. (ERPNext Integrations / Telegram only if that cashier
touches delivery flows.)

### POS Profile

Add the user to the POS Profile's **Applicable Users** child table. If any
**User Permission** record with `Allow = POS Profile` exists for the user, it takes
precedence and the user must ALSO be in that profile's Applicable Users — a stray
User Permission pointing elsewhere silently yields an empty profile list
(`klik_pos/api/pos_profile.py`, `get_pos_profiles_for_user`).

Only mark the user as **Default** in one profile — being default in two logs
"Already set default in pos profile ..., kindly disabled default" errors.

## What NOT to grant

- **Journal Entry** (any perm) — store-credit redemption elevates internally; a direct
  grant would let the cashier create/submit arbitrary JEs from Desk.
- **Payment Entry** create/submit — `klik_pos/api/payment.py` creates them with
  doc-scoped `ignore_permissions`; only `read` is needed (covered by the roles above)
  for the /payments panel listings.
- **System Manager** — full backend access.

## How missing permissions fail (and why it's now graceful)

Every raw-SQL read endpoint routes through
`klik_pos/api/sql_builder.py::apply_sql_permissions()`, which injects Frappe's
permission conditions for the query's primary doctype. If the user has **no read
permission at all** on that doctype, the injected condition is `(1=0)` — the query
runs normally and returns zero rows, so the UI shows an empty list.

Historical note: before 2026-08-18 that fallback replaced the whole query with
`SELECT 1 WHERE 1=0`, which dropped the `%s` placeholders while callers still passed
their params — every such request died with
`MySQLdb.ProgrammingError: not all arguments converted during bytes formatting`
(a 500, surfacing in the POS as spinning/empty screens and Error Log bursts). If a
cashier sees consistently empty item/price lists, suspect a missing `read` grant
first, then check Error Log.

## Auditing a new cashier user

Run in `bench --site <site> console` (adjust the user):

```python
import frappe
user = "cashier@example.com"
for dt, ptypes in [
    ("Sales Invoice", ["read","write","create","submit"]),
    ("POS Opening Entry", ["read","write","create","submit"]),
    ("POS Closing Entry", ["read","write","create","submit"]),
    ("Payment Entry", ["read"]),
    ("Item", ["read"]), ("Item Price", ["read"]), ("Item Group", ["read"]),
    ("Batch", ["read"]), ("Serial No", ["read"]), ("Bin", ["read"]),
    ("Product Bundle", ["read"]),
    ("Customer", ["read","write","create"]), ("Customer Group", ["read"]),
    ("Address", ["read","write","create"]), ("Contact", ["read","write","create"]),
    ("POS Profile", ["read"]), ("Mode of Payment", ["read"]),
    ("Price List", ["read"]), ("Warehouse", ["read"]), ("UOM", ["read"]),
    ("Sales Person", ["read"]), ("Sales Taxes and Charges Template", ["read"]),
    ("Stock Reservation Entry", ["read","write","create","submit"]),
    ("GL Entry", ["read"]), ("Stock Ledger Entry", ["read"]),
]:
    missing = [p for p in ptypes if not frappe.has_permission(dt, p, user=user)]
    if missing:
        print("MISSING", dt, missing)
```

No output = the cashier path is fully covered.
