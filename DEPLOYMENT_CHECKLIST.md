# Fresh Site Deployment Checklist

Written 2026-08-03 after a real fresh-install portability audit (Todo 055 addendum) - verified
by actually installing `erpnext` → `klik_pos` → `erpnext_telegram_integration` from scratch on a
throwaway site (`klik-portability-test.local`) and confirming what does/doesn't come back
automatically. Use this when you actually drop and recreate `hd.phirun.me`.

**2026-08-06 addendum**: added the Telegram Bot Settings / telegram-bot-worker / Hookdeck sections
below - config for the Cloudflare Worker rewrite (`telegram-bot-worker`, a separate repo) that
didn't exist when this doc was first written. None of it is required just to get klik_pos itself
working again after a site drop (the current production bot, `hd-delivery-telegram`, doesn't use
any of it) - it's here so a site recreation doesn't quietly leave the Worker pointed at
credentials that no longer exist, ahead of `PHASES.md`'s own Phase 10 cutover.

## Fully automatic now (bench install-app klik_pos handles all of this)
No action needed - confirmed via the fresh install test:
- Every custom field: Sales Invoice (delivery status incl. Self Pickup, delivery driver/GPS/
  report fields, requested delivery date, **Invoice Ref** - see note below), POS Profile (Google
  Maps API key + Map ID, **Live Map Auto-Focus on New Delivery** - Check, defaults on, added
  2026-08-06 - print format, AZ coil item groups, etc.), Warehouse (shop lat/lng)
- The **Telegram Bot Settings** doctype itself (a Single) - the fields exist automatically; the
  *values* in it are 100% manual, see the new section below.
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
   - The same key/secret pair also goes into the **Telegram Bot Settings** doctype and the
     **telegram-bot-worker** secrets below and into Hookdeck's destination auth - one dedicated
     user is enough for all of them, since every caller only needs *a* valid Delivery Bot session,
     not different permissions from each other (see "Cross-cutting values" table below)
7. **Telegram Bot Settings** (Desk, System Manager only) - a Single doctype, added for the
   telegram-bot-worker rewrite (Cloudflare KV driver cache + the delivery review-chat forward).
   Every *field* comes back automatically; every *value* in it is wiped by a site drop and must be
   re-entered:

   | Field | What goes in it |
   |---|---|
   | Enabled | Check, once the rest of this section is filled in |
   | Bot Token | The delivery bot's Telegram token - **must be the same value** as the Worker's `BOT_TOKEN` secret (see below); klik_pos uses it for direct outbound sends (driver-approved DM, booklet-stalled alert) and Telegram media downloads |
   | Cloudflare Account ID | From the Cloudflare dashboard |
   | Cloudflare API Token | A scoped API Token (not a Global API Key) with "Workers KV Storage: Edit" - this is account-wide, not per-namespace |
   | Cloudflare KV Namespace ID (DRIVERS) | The Worker's `DRIVERS` KV namespace id (`wrangler.toml`, or the Cloudflare dashboard) - **this namespace itself is separate infrastructure that survives a site drop**; only this field (the reference to it) needs re-entering |
   | Cloudflare KV Namespace ID (ACKS) | Same idea, for the `ACKS` namespace (Phase 7's durability ledger) |
   | Reporting Chat ID | Telegram chat id completed deliveries are forwarded to for human review (negative id for a supergroup). Blank disables forwarding |
   | Reporting Topic ID | Optional - only if that group has Topics enabled |
   | Admin Telegram IDs | Comma-separated Telegram user ids DMed on things needing attention (permanent ingestion failures, driver approvals, stalled booklets) - same list as the bot repo's `ADMIN_TELEGRAM_IDS`, kept in two places by hand |

8. **telegram-bot-worker secrets** (Cloudflare, not Frappe - `cd telegram-bot-worker && wrangler
   secret put <NAME>` for each) - only relevant once you're pointing the Worker at this site at
   all (it isn't live in production yet - see `PHASES.md` Phase 10, a separate, user-run cutover
   from this site-recreation checklist). The two KV namespaces and the cron trigger are already
   declared in the repo's `wrangler.toml` and don't need recreating; these six are the ones that
   are deliberately *never* committed:

   | Secret | Purpose |
   |---|---|
   | `BOT_TOKEN` | Telegram bot token - same value as Telegram Bot Settings' Bot Token above. Currently the disposable test bot from `PHASES.md`'s prerequisites, **not** the production token - swapping this to the real token is the Phase 10 cutover step itself, not part of recreating this site |
   | `SECRET_TOKEN` | An arbitrary value you choose, passed to Telegram's `setWebhook` and checked against every incoming request's header. Unaffected by a site recreation - no need to rotate it just for this |
   | `KLIKPOS_BASE_URL` | This site's URL (`https://hd.phirun.me`) |
   | `KLIKPOS_API_KEY` / `KLIKPOS_API_SECRET` | The Delivery Bot service account's key/secret from step 6 - **will go stale the moment you drop the site** (the user/key it points to no longer exists), even if you never touch the Worker otherwise. Re-run `wrangler secret put` for both after step 6 |
   | `HOOKDECK_API_KEY` | Hookdeck's Publish API key - the write path (delivery reports, driver registrations) is skipped (logged, not an error) if unset, so this only matters once you're actually routing writes through Hookdeck |

9. **Hookdeck** (external dashboard, hookdeck.com - only relevant alongside step 8) - two
   connections, per `PHASES.md`'s prerequisites: one for delivery reports, one for driver
   registration. Each connection's destination is one of these two klik_pos endpoints, authenticated
   with the same Delivery Bot API key/secret from step 6:
   - `POST https://hd.phirun.me/api/method/klik_pos.api.delivery.submit_delivery_report_webhook`
   - `POST https://hd.phirun.me/api/method/klik_pos.api.driver.sync_driver_from_bot_webhook`

   Both endpoints already return a status-code-mapped response (422 permanent / 500 transient) so
   Hookdeck's own retry logic works correctly out of the box - no special Hookdeck-side retry
   config needed beyond pointing it at the right URL with the right auth header.

## Cross-cutting values (same secret, multiple places - easy to update one and forget the rest)

| Value | Lives in |
|---|---|
| Delivery Bot API key/secret | `hd-delivery-telegram/.env` (`KLIKPOS_API_KEY`/`KLIKPOS_API_SECRET`), telegram-bot-worker secrets (same names), Hookdeck's two destination auth headers |
| Telegram bot token | Telegram Bot Settings' `bot_token`, telegram-bot-worker's `BOT_TOKEN` secret. **Not** shared with `hd-delivery-telegram`'s `DELIVERY_BOT_TOKEN` - the old bot and the new Worker/klik_pos direct-send path are deliberately different bot tokens (the old bot still owns the live webhook/long-polling until Phase 10's cutover) |
| Admin Telegram IDs | Telegram Bot Settings' `admin_telegram_ids`, `hd-delivery-telegram/.env`'s `ADMIN_TELEGRAM_IDS` |
| Reporting chat/topic id | Telegram Bot Settings' `reporting_chat_id`/`reporting_topic_id`, `hd-delivery-telegram/.env`'s `REPORTING_CHAT_ID`/`REPORTING_TOPIC_ID` |

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
