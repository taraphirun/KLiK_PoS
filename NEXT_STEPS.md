# Next Steps

Outstanding items as of 2026-08-03, after Module 17 (Daily Booklet Page Reconciliation follow-up:
Todos 053-054), Todo 055 (Live Delivery Map: shop location pins, numbered cluster pins, Live Feed
teleport-on-click, smooth vector-map zoom), and a portability audit (`custom_invoice_ref` +
`Delivery Bot` role fixed - see `DEPLOYMENT_CHECKLIST.md`). Not a phased todo list — a snapshot of
what's left to verify, act on, or pick up. Update or delete items as they're resolved; this file
isn't meant to accumulate stale entries the way `bugs.md` sometimes does.

## Needs an action from you (ops/deployment, not code)
- [ ] Delete leftover $1 test invoices against "Delivery Reconciliation Demo (seed)" customer -
      stuck uncancellable because AZT stock is too tight on this site; not touched since it'd
      require a Stock Settings change
- [ ] `klik-portability-test.local` (the throwaway fresh-install test site) is still sitting on
      this bench, half-configured (a scaffolded "Portability Test Co" company with no proper Chart
      of Accounts). Decide whether to keep developing it (finish the real Setup Wizard first) or
      drop it once you're done with it - not urgent either way.
- [ ] Todo 036 Phase A is done (bot code decoupled from Postgres/Redis-as-DB/MinIO, see
      `todo/036.md`) - restart both `bench restart` and `sudo systemctl restart
      delivery-bot.service` to pick it up, then verify `/syncstatus` and a real register→approve→
      delivery flow. Phase B (stopping Postgres/MinIO/ocr-service/NestJS/frontend on
      `192.168.2.235`) is yours to do whenever ready, in whatever order.

## Known, deliberately deferred (not urgent)
- [x] Delivery Report permission gap - fixed 2026-08-03: added a new POS Profile checkbox,
      "Allow Delivery Management Access" (`custom_allow_delivery_management`, unchecked by
      default), same pattern as "Allow to Create and Edit Customers" etc. It now controls
      Deliveries/Delivery Report, Drivers, Live Map, Booklets, and Daily Close together - replaces
      the old hardcoded Administrator/Sales Manager/System Manager-only gate for these 5 pages
      specifically (Dashboard's own admin-only gate is untouched). Enforced in the nav
      (`RetailSidebar.tsx`, `BottomNavigation.tsx`) and at the route level (`ProtectedRoute.tsx`
      redirects to `/pos` if the flag is off) - **frontend only, by design** (confirmed with the
      user): matches how every other POS Profile checkbox in this app works, no backend API
      enforcement was added since these endpoints are shared with the Telegram bot's own API-key
      calls and scoping a server-side check to exclude those safely was judged not worth the risk
      for this round. Turn it on per-profile at POS Profile → Delivery & Alerts section. Requires
      `bench restart` + reload to pick up (already built).
- [ ] WhatsApp integration (`klik_pos/api/whatsap*`, `WhatsApp *` doctypes) - pre-existing code from
      a different contributor (Sept 2025), confirmed unused ("i don't use it"). Not touched, no
      action taken - flagged here only as a future cleanup candidate if ever wanted.
- Module 12 (Deliveries & Conflicts UI) — dropped, not being built, listed here only for context

## Bugs (see `bugs.md` for full detail)
- [x] BUG-001: `custom_delivery_date` was written on Sales Invoice but wasn't a real field - dead
      code, all four assignments removed 2026-08-03. Requires `bench restart` to pick up.
- [x] BUG-002: `custom_invoice_ref` type/`allow_on_submit` design issue fixed 2026-08-03 - kept as
      `Int` (user's call, Module 17's booklet math depends on it), `allow_on_submit` now `1`, and
      the checkout input (`OrderSummary.tsx`) now strips non-digits as you type instead of silently
      saving garbage as `0`. Requires `bench restart` (field property) - frontend already rebuilt.
