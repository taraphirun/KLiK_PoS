# Phase 2: Telegram Contact Search & Customer Link
**Module 2**

**Status:** ✅ Done

## Objective
Integrate Telegram contact search and customer linking to allow seamless customer management via Telegram.

## Todos
- [x] [005.md](../todo/005.md): Backend Telegram API wrappers
- [x] [006.md](../todo/006.md): Frontend customer service layer updates
- [x] [007.md](../todo/007.md): Frontend Add Customer Modal UI enhancements

## Implementation notes
- Backend wrappers (`search_telegram_contact`, `link_telegram_to_customer`, `get_customer_telegram_link`) live in `klik_pos/api/customer.py` and lazily import `erpnext_telegram_integration` so a missing/broken Telegram app can't break the rest of the module.
- Frontend `customerService.ts` calls the new `klik_pos.api.customer.*` wrappers (not the Telegram app directly).
- UI is a scoped `TelegramLinkSection.tsx` subcomponent: search + type filter, autocomplete dropdown, select/link, green "Linked" badge. Edit mode links immediately and loads any existing link; new-customer mode defers linking until the customer is created.
- Out of scope (not in acceptance criteria): main's phone-number auto-match. Can be added later if wanted.
