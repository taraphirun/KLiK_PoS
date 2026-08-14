# Claude rules for klik_pos

## Project

`klik_pos` is a vendored fork we own and edit in place at `apps/klik_pos/`.
Upstream remains at the `upstream` remote for cherry-picking fixes.
(Note: the `upstream` remote is not configured yet — only `origin` exists. Add it with
`git remote add upstream <beveren-repo-url>` before relying on `git diff upstream/main`.)

## Boundaries

Never edit `apps/erpnext/`, `apps/frappe/`, `apps/payments/`, or any other installed
app that isn't klik_pos (`hrms`, `print_designer`, `erpnext_telegram_integration`, ...).
All our code lives in `apps/klik_pos/`.

To change core behaviour, use klik_pos's `hooks.py`, in this order of preference:
1. `doc_events` (validate, before_submit, on_submit, on_cancel)
2. `override_doctype_class` to subclass a core controller
3. `override_whitelisted_methods` to replace an API endpoint
4. Custom Fields + Property Setters, exported as fixtures — never edit core .json
5. `doctype_js` / Client Script for Desk UI changes (the POS UI itself is `klik_spa/`, ours to edit)

## Follow ERPNext flow

Money and stock move only through submitting POS Invoice, Sales Invoice, or
Payment Entry — or through ERPNext's own reconciliation machinery
(`erpnext.accounts.utils.reconcile_against_document` / the Payment Reconciliation tool),
which is how credit notes and advances are allocated against invoices. Never:
- `frappe.db.sql` for writes — use the Document API so hooks and GL fire
- Direct inserts into GL Entry, Stock Ledger Entry, or Payment Ledger Entry
- Setting `docstatus` directly instead of calling `submit()` / `cancel()`
- Monkeypatching core functions at import time
- Recalculating totals or taxes by hand — call the core methods

If a requirement seems to need one of these, stop and ask rather than
working around it.

## Fork discipline

New functionality goes in new files under `klik_pos/hd/` where possible, not
threaded through upstream's existing modules. When upstream code must change,
keep the diff minimal and localized so `git diff upstream/main` stays readable.
Never reformat or refactor upstream files we aren't otherwise touching.

## After changes

- Python or doctype changes: `bench --site <site> migrate`
- Frontend changes: `bench build --app klik_pos`
  (delegates to `klik_spa`'s vite build via the root package.json `build` script)
- Custom Fields / Property Setters: export with `bench --site <site> export-fixtures`
  and commit the JSON
- Never commit `sites/` — site config and DB are not in this repo
- TypeScript check for klik_spa: `npx tsc -p tsconfig.app.json --noEmit`
  (plain `npx tsc --noEmit` checks nothing)
