# Fresh Site Deployment Checklist

Written 2026-08-03 after a real fresh-install portability audit (Todo 055 addendum) - verified
by actually installing `erpnext` → `klik_pos` → `erpnext_telegram_integration` from scratch on a
throwaway site (`klik-portability-test.local`) and confirming what does/doesn't come back
automatically. Use this when you actually drop and recreate `hd.phirun.me`.

## Fully automatic now (bench install-app klik_pos handles all of this)
No action needed - confirmed via the fresh install test:
- Every custom field: Sales Invoice (delivery status incl. Self Pickup, delivery driver/GPS/
  report fields, requested delivery date, **Invoice Ref** - see note below), POS Profile (Google
  Maps API key + Map ID, print format, AZ coil item groups, etc.), Warehouse (shop lat/lng)
- Every new doctype: Delivery Booklet, Delivery Booklet Settings, Delivery Booklet Void Entry,
  Delivery Booklet Daily Closing (incl. `scheduled_count`/`scheduled_summary`), Delivery Driver,
  Delivery Personnel, Delivery Report
- The **Delivery Bot** role and its exact permissions (read/write/create/export on Delivery
  Report, Delivery Booklet, Delivery Booklet Settings)
- Scheduler event (`check_booklet_lifecycle`, hourly)
- Workspace sidebar/desktop icons, print format JS includes

**Note on Invoice Ref**: `custom_invoice_ref` (the booklet page-number field almost everything in
Modules 15-17 depends on) and the `Delivery Bot` role/permissions were BOTH found missing from the
app's own code during this audit - they'd been created directly on `hd.phirun.me` via Desk at some
point, invisible to any fixture. Both are now fixed in `klik_pos/setup/install.py`
(`ensure_sales_invoice_invoice_ref_field`, `ensure_delivery_bot_role`) and verified idempotent
against the live site (no data disruption) and correct on a fresh install.

## Manual steps required after a fresh install (data entry / external config, not code)
1. **ERPNext Setup Wizard** - Company, default Warehouse, Fiscal Year, Chart of Accounts, Cost
   Center tree, Customer Groups, Territories, currency, UOM. Standard ERPNext onboarding, nothing
   to do with klik_pos, required on every fresh site regardless of any app installed. Go through
   the real wizard rather than scripting it by hand - hand-scripting it during this audit hit
   several ERPNext-standard mandatory-field quirks (Warehouse Type, Cost Center parent, Fiscal
   Year) that the wizard's own code path handles correctly in one pass.
2. **POS Profile(s)** - create real profile(s) linked to the correct Warehouse(s), then set:
   - Google Maps API Key (`custom_google_maps_api_key`)
   - Google Maps Map ID (`custom_google_maps_map_id`) - optional, enables smooth vector-rendered
     zoom on the Live Delivery Map; leave blank to keep classic raster tiles (still fully
     functional, just without smooth zoom transitions)
3. **Warehouse shop location** - set Shop Latitude/Shop Longitude (Stock → Warehouse) on whichever
   warehouse(s) your POS Profiles use, if you want shop pin(s) on the Live Delivery Map
4. **Booklet Settings** - confirm/set `pages_per_booklet` (defaults to 50 if left blank),
   stall-day thresholds (default 1 normal / 3 VIP)
5. **Register your real Delivery Booklets** - booklet_number/start_number/end_number matching your
   actual physical paper booklets
6. **Delivery Bot service account** - the role now auto-creates, but you still need to:
   - Create a User for the bot (e.g. `delivery-bot@...`), assign it the `Delivery Bot` role
   - Generate a fresh API key/secret for that user - the old one is meaningless on a new site
     regardless of any automation
   - Update the bot repo's (`hd-delivery-telegram`) `.env` with the new site's URL and the new
     API key/secret

## Only relevant if setting up on a genuinely new machine (not a same-bench site reset)
Your stated plan - drop the site, recreate it, same VM - does NOT need these, since the bench's
`apps/` checkout (and its already-built frontend assets) stays untouched:
- `bench build --app klik_pos` - `klik_pos/public/klik_spa/assets/` is gitignored, not committed,
  so a fresh git clone on a different machine needs one build. Not needed here.
- `yarn install` in `klik_spa/` if `node_modules` isn't present.
- nginx site config / SSL - `hd.phirun.me` is already configured in nginx and pointed to by
  aaPanel on the separate VM; recreating the *site* (database) doesn't touch either.

## Not deployment-blocking, tracked separately (see `bugs.md` / `NEXT_STEPS.md`)
- BUG-001, BUG-002 - pre-existing, unrelated to this audit
- Delivery Report permission gap (regular staff can't see the reconciliation queue) - deliberately
  deferred, no decision made yet
- Todo 036 (retire the bot repo's legacy NestJS/Postgres/Redis/MinIO/OCR stack) - separate,
  deliberately not started (needs a monitored parallel-run window)
