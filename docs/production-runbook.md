# klik_pos production runbook — drop current site → ready to sell

A step-by-step to rebuild `hd.phirun.me` from scratch and go live with real data.
Assumes a working bench at `/home/frappe/frappe-bench` with apps: frappe, erpnext, hrms,
print_designer, erpnext_telegram_integration, klik_pos.

> Convention: `<site>` = your production site (e.g. `hd.phirun.me`). Run bench commands from
> `/home/frappe/frappe-bench`. Steps that touch supervisor/redis (`k_reset`, restarts) are
> yours to run.

---

## 0. Before you drop the old site (capture what won't regenerate)

The current `.secrets/production-config.md` already holds the Cloudflare + Maps values. Also
capture, from the old site (or write down now):

- **Company**: legal name, default currency, chart-of-accounts template, tax IDs.
- **POS Profile(s)**: name, warehouse, payment methods + their accounts, price list,
  cost/income/write-off accounts, applicable users, any `custom_*` flags
  (delivery management, hide expected amount, autofetch batch/serial, delivery charge item).
- **Mode of Payment → Account** mapping per company (Cash/Bank/… default accounts).
- **Users + roles** (cashiers, managers) and which POS Profile each belongs to.
- **Tax setup** (if any): Item Tax Templates / Sales Taxes and Charges Templates and whether
  tax is **inclusive** (`included_in_print_rate`) — see §5.
- **Integrations**: Telegram bot token, Cloudflare account id + API token, Google Maps key +
  map id, delivery-bot API key/secret, KV namespace ids, reporting chat/topic ids.
- **Optional**: export master data you want to keep (Items, Customers, Price Lists) — see §7.

**Back up the old DB first** (safety net): `bench --site <site> backup --with-files`, and copy
the resulting files off the server.

---

## 1. Drop and recreate the site

```
bench --site <site> backup --with-files          # one last backup
bench drop-site <site> --db-root-password <root> --force
bench new-site <site> --db-root-password <root> --admin-password <admin-pass>
```

## 2. Install apps (order matters) and migrate

```
bench --site <site> install-app erpnext
bench --site <site> install-app hrms                       # if used
bench --site <site> install-app print_designer             # if used
bench --site <site> install-app erpnext_telegram_integration
bench --site <site> install-app klik_pos
bench --site <site> migrate
```

Installing + migrating klik_pos automatically restores (no manual step):
- **Custom Fields + Property Setters** (created by `klik_pos/setup/install.py`, run on
  after-install / after-migrate).
- **Cashier permissions** — the Custom DocPerm fixtures for the `Sales User` role
  (`klik_pos/fixtures/custom_docperm.json`): Sales Invoice create/submit, Item Price / Batch /
  Serial No / Payment Entry read.
- **Print formats** — Invoice Khmer A5, Thermal Printer PF, DS POS Invoice KLiK (standard
  print formats shipped in the app; now with the conditional Tax row + tax-inclusive
  Unit Price/Amount).

## 3. Restore business config (manual — not in fixtures)

Run the ERPNext setup wizard (or scripted) to create the **Company** (currency, CoA, fiscal
year), then create:

1. **Warehouse(s)** for the company.
2. **Mode of Payment → Account**: for each mode (Cash, Bank, …) add an account row for the
   company (needed before a POS Profile can use it, and before checkout can post).
3. **POS Profile(s)**: company, warehouse, price list, cost/income/write-off accounts, the
   payment methods, mark the default mode, add cashiers to **Applicable Users**, and set any
   `custom_*` flags you captured in §0. Mark only **one** profile default per user.
4. **Price List(s)** and any Pricing Rules.

## 4. Restore users, roles, and confirm cashier access

1. Create the **users** (cashiers, managers). Give cashiers **Sales User** + **Sales Manager**
   (Sales Manager is the only non-admin role that can open/close POS entries on this setup and
   unlocks the klik admin screens). Do **not** grant Accounts roles or Journal Entry to
   cashiers — store-credit redemption elevates internally. Full matrix:
   `docs/knowledge-base/cashier-permissions.md`.
2. Add each cashier to their POS Profile's **Applicable Users**.
3. Set **Allow Modules** on each user (at least KLiK PoS, Selling).
4. **Verify** with the audit snippet at the end of `cashier-permissions.md`
   (run in `bench --site <site> console`) — no `MISSING` output means the cashier path is
   covered.

## 5. Tax setup (decide before selling)

The POS currently books **no VAT** unless you configure it. Decide:

- **No VAT** (prices are final): nothing to do.
- **VAT, tax-inclusive** (price already includes tax — recommended for retail here): create an
  **Item Tax Template** per rate with `included_in_print_rate` behaviour, and either assign it
  on the Item (Item Tax table) or set a taxes template on the POS Profile. The per-item tax fix
  and the inclusive print formats are already in place, so:
  - a cart mixing taxed + tax-exempt items taxes only the taxed lines (no over-taxation);
  - the Khmer A5 / Thermal / DS POS prints show a **Tax (incl.)** line (hidden when 0) and
    tax-inclusive Unit Price / Amount.
- After configuring, ring a test sale of a taxed item **plus** a tax-exempt item and confirm
  the totals and the printed invoice are correct.

## 6. Secrets & integrations — **rotate, then set**

The values in `.secrets/production-config.md` have sat in plaintext — **rotate them first**,
then enter the new values on the new site:

1. **Cloudflare**: rotate the API token, **scope it down** to only the KV namespace it needs
   (not account-wide Workers KV Edit). Enter account id + new token on **Telegram Bot
   Settings**.
2. **Google Maps**: rotate the key (keep it referrer-restricted); set key + map id on the POS
   Profile(s) that use the live map.
3. **Telegram bot token / delivery-bot key/secret / KV namespace ids / chat ids**: set per the
   companion bot repo (`/home/frappe/prod/hd-delivery-telegram`, Module 14). Delivery-bot
   API key/secret regenerate fresh on the new site.
4. **WhatsApp** (only if you enable inbound webhook — you don't use WhatsApp today): set
   `whatsapp_app_secret` in the site config; the webhook fails closed without it.
5. Store all rotated values in a **password manager**, not a server file; delete
   `.secrets/production-config.md` once the rebuild no longer needs it.

## 7. Load master + opening data

- **Items** (with item groups, UOM, is_stock_item, and Item Tax if using VAT), **Customers**,
  **Customer Groups**, **Territories**. Import via Data Import or restore from your export.
- **Opening stock**: Stock Reconciliation or opening Stock Entries per warehouse.
- **Opening accounting balances** (if migrating balances): Journal Entry / Opening Invoice
  Creation Tool as appropriate.

## 8. Build, restart, verify

```
bench --site <site> migrate          # ensure fixtures/customizations applied
bench build --app klik_pos           # frontend assets
```
Then **`k_reset`** (yours) so workers serve the latest Python + clear caches.

**Smoke-test a full day-cycle on the UI as a real cashier** (the go-live gate):
1. Open a POS shift.
2. Sell an item, take cash, confirm **change** and a correct printed invoice.
3. Sell a **tax-exempt + taxed** cart (if VAT configured) → totals correct, print correct.
4. **Return** an item → refund path; **store-credit** return → apply the credit to another
   invoice → outstanding clears.
5. Take a **counter payment** (Reconcile tab) → it shows in the closing "expected".
6. **Close the shift** → per-mode expected vs counted reconciles.
7. As a manager, open **Dashboard → Sales by Seller** → each seller's # sales / total sale /
   total paid / variance shows.

**CI**: push the branch and confirm the CI run is green — the backend regression tests
(per-item tax, closing reconciliation, multi-currency) run there on a fresh site, and the
frontend Vitest suite runs too.

## 9. Go-live checklist (all must be ✅)

- [ ] Company, CoA, fiscal year, currency correct
- [ ] POS Profile(s) complete; payment modes have accounts; cashiers in Applicable Users
- [ ] Cashiers have Sales User + Sales Manager; permission audit clean
- [ ] Tax decision made and test sale verified (or confirmed no-VAT)
- [ ] Secrets **rotated**, scoped, entered on new site; `.secrets` file removed
- [ ] Items / customers / opening stock loaded
- [ ] `bench migrate` + `bench build` done, `k_reset` run
- [ ] Full day-cycle smoke-test passed on the UI
- [ ] CI green (backend + frontend tests)
- [ ] A fresh backup taken of the ready-to-sell site

---

## Related docs
- `docs/knowledge-base/cashier-permissions.md` — role/permission matrix + audit snippet
- `docs/audit/README.md` — audit findings + what was fixed
- `CLAUDE.md` — fork discipline (never edit core; money moves only through submitting
  Sales Invoice / Payment Entry / POS entries)
