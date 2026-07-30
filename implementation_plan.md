# Comprehensive Implementation Plan - Porting Custom Features to `upstream/version-16`

This document details the exact technical changes (functions, state variables, API endpoints, and UI elements) required to port all custom features from `main` to a fresh `upstream/version-16` branch.

---

## Preparation

- Check out a new branch `version-16.1` from `upstream/version-16` before applying the following modules.

---

## Progress Tracker

Legend: ✅ Done · 🔷 In progress · ⬜ Not started. Per-todo status lives in each `todo/NNN.md`; per-phase status in each `phases/phase-NN.md`.

| Module | Phase | Todos | Status |
|---|---|---|---|
| 9 — AZ Coil Sheet Order [TOP CORE 1] | (pre-plan) | — | ✅ Done |
| 6 — Transaction-Based Invoice & Closing Reconciliation [TOP CORE 2] | 1 | 001–004 | ✅ Done (runtime-verified by user; partial/unpaid fix applied) |
| 2 — Telegram Contact Search & Customer Link | 2 | 005–007 | ✅ Done (backend wrappers in customer.py, service routed through them, TelegramLinkSection subcomponent) |
| 3 — Telegram Invoice Sharing | 3 | 008–009 | ✅ Done |
| 4 — Customer Credit Limit Validation | 4 | 010–011, 037 | ✅ Done (pre-submit check wraps erpnext core; credit visibility added to /customers list) |
| 5 — Additional Discount & Tax Round-Off | 5 | 012–013 | ✅ Done (round-off was already fixed pre-session; discount wraps erpnext native fields) |
| 7 — Customer-Specific Price List | 6 | 014–015 | ✅ Done (fixed N+1 price query in get_items; dynamic pricing on customer change already existed) |
| 8 — Keyboard Navigation & UI Usability | 7 | 016–017 | ✅ Done (Cmd/Ctrl+F, Escape, custom_invoice_ref, grid arrow-nav + Shift+Enter quantity dialog) |
| 1 — Custom Print Format & Status Indicators | 8 | 018 | ✅ Done (existing DB-only print format exported to repo; custom_description + credit info added) |
| 10 — Delivery Tracking & Payment Reconciliation | 9 | 019–024 | 🔷 In progress (019–023 done: staging DocType, reconciled Sales Invoice fields, bot ingestion endpoint, invoice-number auto-match, confirm/reject/re-match + mark-as-paid) |
| 11 — Driver Management & Free-Text→Link | 10 | 025–028 | ⬜ Not started |
| 12 — Deliveries & Conflicts UI | 11 | 029–030 | ⬜ Not started |
| 13 — Live Delivery Map | 12 | 031–032 | ⬜ Not started |
| 14 — Offline-First Bot Repoint & Legacy Retirement | 13 | 033–036 | ⬜ Not started |

**Next up:** Module 10 / Todo 024 (frontend reconciliation page, `klik_spa`) is the next step in
the delivery-consolidation track (Phases 9-13) — the last todo in Phase 9. (Phase 6 completed
2026-07-30; Phase 7 completed 2026-07-30; Phase 8 completed 2026-07-30; Phase 9 Todos 019–023
completed 2026-07-30.)

---

## Top Priority Core Features Summary

1. **Module 9 [TOP CORE 1]**: AZ Coil Sheet Order Custom Input inside `CartItemRow.tsx` (Option B formula, disabled quantity, Khmer text).
2. **Module 6 [TOP CORE 2]**: Transaction-Based Invoice Payment Processing (Unpaid, Partial Paid with `allow_partial_payment`, Fully Paid) & POS Closing Shift Reconciliation.

---

## Detailed Module Specifications

### Module 9 [TOP CORE 1]: AZ Coil Sheet Order Custom Input

#### 1. Backend Custom Fields Fixtures
- **[MODIFY] [klik_pos/klik_pos/custom/pos_profile.json](file:///home/phirun/dev/KLiK_PoS/klik_pos/klik_pos/custom/pos_profile.json)**:
  - Add `custom_az_coil_item_groups` field (`Small Text` / `Data`) to configure item groups that trigger AZ Coil sheet inputs (e.g. `zn`).
- **[MODIFY] [klik_pos/klik_pos/custom/sales_invoice.json](file:///home/phirun/dev/KLiK_PoS/klik_pos/klik_pos/custom/sales_invoice.json)**:
  - Add `custom_ds_roofing_spec` (`JSON`) and `custom_description` (`Text`) fields to `Sales Invoice Item` doctype.
- **[MODIFY] [klik_pos/install.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/install.py)**:
  - Ensure `after_install()` registers `custom_ds_roofing_spec` and `custom_description` custom fields.

#### 2. Backend Sales Invoice API
- **[MODIFY] [klik_pos/api/sales_invoice.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/sales_invoice.py)**:
  - Implement `_add_roofing_spec_to_item(item_data, item)`: JSON serializes `custom_ds_roofing_spec` when writing invoice items.
  - Implement `_add_description_to_item(item_data, item)`: Sets line item `description` and `custom_description`.
  - Update `_get_invoice_items_with_returns()`: Selects and parses `custom_ds_roofing_spec` and `custom_description`.

#### 3. Frontend Types & Cart Item Specs
- **[MODIFY] [klik_spa/types/index.ts](file:///home/phirun/dev/KLiK_PoS/klik_spa/types/index.ts)**:
  - Add `custom_az_coil_item_groups?: string` to `POSProfile` interface.
  - Add `custom_ds_roofing_spec?: Array<{ straight: number; curve: number; end: number; quantity: number }>` to `CartItem` & `MenuItem` interfaces.
  - Add `custom_description?: string` to `CartItem` interface.

#### 4. Cart Item Row Input & Quantity Control
- **[MODIFY] [klik_spa/src/components/order/CartItemRow.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/order/CartItemRow.tsx)**:
  - **Item Group Detection**: Check if `item.item_group` or `item.category` is in `posDetails?.custom_az_coil_item_groups` (or fallback `"zn"`).
  - **Quantity Control**: Set standard `QuantityInput` to **disabled / read-only**.
  - **Roofing Spec Inputs**: Render `RoofingSpecTable` directly **below Quantity input**:
    - Input fields: `straight` (req), `quantity` (req), `curve` (opt), `end` (opt).
    - **Formula (Option B)**:
      $$\text{sum} = (\text{straight} + \text{curve} + \text{end}) / 100$$
      $$\text{Total Qty (Meters)} = \text{sum} \times \text{quantity}$$
  - **Khmer Line Note Formatting**:
    - Straight Sheet: `ត្រង់ 3.50m x 10 = 35.00m`
    - Curved Sheet: `កោង (3.50m + 0.50m + 0.20m) x 10 = 42.00m`

---

### Module 6 [TOP CORE 2]: Transaction-Based Invoice Processing & POS Closing Shift Reconciliation

#### 1. Transaction-Based Payment Determination & Partial Payment Handling
- **[MODIFY] [klik_pos/api/sales_invoice.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/sales_invoice.py)**:
  - **Transaction-Based `is_pos` Determination (`_determine_is_pos(customer, business_type, amount_paid)`)**:
    - If `amount_paid > 0` (cash/card collected at POS) $\rightarrow$ Set `doc.is_pos = 1`, `doc.pos_profile = pos_profile.name`, and populate `Sales Invoice Payment` child table.
    - If `amount_paid == 0` (Unpaid / Pay Later / Credit Sale) $\rightarrow$ Set `doc.is_pos = 0`, `doc.pos_profile = None`, creating a regular Accounts Receivable invoice without payment entries.
  - **Shift Tagging**: Tag `doc.custom_pos_opening_entry = opening_entry_name` on ALL invoices (both paid and credit/unpaid) so every invoice generated during a shift is tracked in closing totals.
  - **Partial Payment Safeguard**:
    - For partial payments (`0 < amount_paid < grand_total`), set `doc.allow_partial_payment = 1` or explicitly record `paid_amount = amount_paid` and `outstanding_amount = grand_total - amount_paid`.
  - **Case-Insensitive Customer Type Check**: Normalize `customer_type` handling in `_check_customer_type_for_pos`.
  - **Invoice Ref Field Mapping**: Map `custom_invoice_ref` from payload into Sales Invoice document.

#### 2. POS Closing Shift Reconciliation API (`pos_entry.py`)
- **[MODIFY] [klik_pos/api/pos_entry.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/pos_entry.py)**:
  - **Fix SQL Join Duplication in `_calculate_closing_entry_totals()`**:
    - Query 1 (Invoice Totals): `SELECT SUM(net_total), SUM(grand_total) FROM tabSales Invoice WHERE custom_pos_opening_entry = %s AND docstatus = 1`.
    - Query 2 (Quantity Totals): `SELECT SUM(sii.qty) FROM tabSales Invoice Item sii INNER JOIN tabSales Invoice si ON si.name = sii.parent WHERE si.custom_pos_opening_entry = %s AND si.docstatus = 1`.
  - **Strict Shift Payment Reconciliation in `_calculate_payment_reconciliation()`**:
    - Filter payments strictly by `si.custom_pos_opening_entry = %s`.
  - **Credit / Unpaid Sales Summary**:
    - Aggregate `total_credit_sales = SUM(outstanding_amount)` for invoices in the shift.

#### 3. Payment Dialog & Closing Shift UI
- **[MODIFY] [klik_spa/src/components/dialog/PaymentDialog.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/dialog/PaymentDialog.tsx)**
- **[MODIFY] [klik_spa/src/pages/ClosingShiftPage.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/pages/ClosingShiftPage.tsx)**

---

### Module 2: Telegram Contact Search & Customer Link

#### 1. Backend Telegram API Wrapper
- **[MODIFY] [klik_pos/api/customer.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/customer.py)**:
  - `@frappe.whitelist() def search_telegram_contact(search_query, search_type="all")`: Calls `erpnext_telegram_integration.telegram_api.search_telegram_contact`.
  - `@frappe.whitelist() def link_telegram_to_customer(customer_name, telegram_user_id, ...)`: Calls `erpnext_telegram_integration.telegram_api.link_telegram_to_customer`.
  - `@frappe.whitelist() def get_customer_telegram_link(customer_name)`: Returns linked Telegram user details for a customer.

#### 2. Frontend Customer Service Layer
- **[MODIFY] [klik_spa/src/services/customerService.ts](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/services/customerService.ts)**:
  - Add TypeScript interfaces: `TelegramContact`, `TelegramLinkResult`, `CustomerTelegramLink`.
  - Add functions `searchTelegramContact`, `linkTelegramToCustomer`, `getCustomerTelegramLink`.

#### 3. Add Customer Modal UI
- **[MODIFY] [klik_spa/src/components/customer/AddCustomerModal.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/customer/AddCustomerModal.tsx)**:
  - Add Telegram contact search field with live autocomplete dropdown.
  - Add "Quick Link Telegram" action button.
  - Display green badge when customer has a linked Telegram account (`@username` or `ID`).

---

### Module 3: Telegram Invoice Sharing

#### 1. Backend Invoice Sending Endpoint
- **[MODIFY] [klik_pos/api/sales_invoice.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/sales_invoice.py)**:
  - `@frappe.whitelist() def send_telegram_invoice(customer_name, invoice_name, attach_file=True)`:
    - Generates invoice PDF via `frappe.get_print("Sales Invoice", invoice_name, print_format="DS POS Invoice KLiK")`.
    - Dispatches message & PDF attachment to customer's linked Telegram chat via `erpnext_telegram_integration`.

#### 2. Sharing Service & Dialog UI
- **[NEW] [klik_spa/src/services/useSharing.ts](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/services/useSharing.ts)**:
  - Implement `sendInvoiceTelegram({ customer_name, invoice_name, attach_file })`.
- **[MODIFY] [klik_spa/src/components/dialog/PaymentHeader.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/dialog/PaymentHeader.tsx)**:
  - Add Telegram button (using `Send` icon from `lucide-react`) to completion header buttons.
- **[MODIFY] [klik_spa/src/components/dialog/SharingInterface.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/dialog/SharingInterface.tsx)**:
  - Add `sharingMode === "telegram"` tab containing message preview box, customer name field, and "Send Telegram" action button.

---

### Module 4: Customer Credit Limit Validation

> **Note (2026-07-30):** ERPNext core already implements credit limit enforcement —
> `erpnext.selling.doctype.customer.customer.get_credit_limit()` / `get_customer_outstanding()` /
> `check_credit_limit()`, invoked automatically from `Sales Invoice.on_submit()`
> (`sales_invoice.py:519,745`). klik_pos does not bypass it, so `doc.submit()` in
> `submit_draft_invoice()` already blocks over-limit invoices today. This module does **not**
> reimplement that math — it wraps the existing core functions in a pre-submit check so the
> Payment Dialog can warn the cashier *before* the draft invoice is even inserted, instead of only
> finding out after `doc.submit()` throws (which currently leaves an orphaned draft Sales Invoice
> behind).

#### 1. Backend Credit Limit Verification
- **[MODIFY] [klik_pos/api/sales_invoice.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/sales_invoice.py)**:
  - Implement `check_customer_credit_limit(customer, new_invoice_amount, company)` as a thin wrapper:
    - Reuses `erpnext.selling.doctype.customer.customer.get_credit_limit(customer, company)` and
      `get_customer_outstanding(customer, company)` — do not re-derive the credit limit or
      outstanding balance with new SQL.
    - If `credit_limit > 0` and `current_outstanding + new_invoice_amount > credit_limit`, returns
      exceeded details (`credit_limit`, `current_outstanding`, `new_invoice_amount`, `excess`).
  - `@frappe.whitelist() def validate_before_submit(data)`: Pre-submission endpoint called by POS UI
    before `submit_draft_invoice`; calls `check_customer_credit_limit` using the draft's customer
    and grand total. Purely advisory — the core `on_submit` check remains the actual enforcement
    point, so this can't be bypassed by skipping the pre-check.

#### 2. Service Layer & Payment Dialog UI
- **[MODIFY] [klik_spa/src/services/salesInvoice.ts](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/services/salesInvoice.ts)**:
  - Add `validateBeforeSubmit(data)` function and `CreditLimitValidation` interface.
- **[MODIFY] [klik_spa/src/components/dialog/PaymentDialog.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/dialog/PaymentDialog.tsx)**:
  - Call `validateBeforeSubmit()` before order submission.
  - If credit limit is exceeded, display prominent red alert banner with exceeded amount details and block submit button.

#### 3. Customer List Visibility (added 2026-07-30, requested alongside this phase)
- **[MODIFY] [klik_pos/api/customer.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/customer.py)**:
  - `get_customers()` batch-attaches `credit_limit` (via `get_credit_limit`, falling back to the
    Company default) and `credit_used` (outstanding, via a single grouped GL Entry query across the
    current page's customers — not one core `get_customer_outstanding()` call per row) to each
    returned customer row.
- **[MODIFY] [klik_spa/src/hooks/useCustomers.ts](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/hooks/useCustomers.ts)**:
  - Map `credit_limit`/`credit_used` onto `Customer.creditLimit`/`creditUsed`.
- **[MODIFY] [klik_spa/src/components/CustomersPage.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/CustomersPage.tsx)**:
  - Add a "Credit" column (desktop + mobile tables) showing credit used vs. total allowed credit
    (or "No Limit" when `credit_limit` is 0).

---

### Module 5: Additional Discount & Tax Round-Off Fixes

> **Note (2026-07-30):** The round-off half of this module is already fixed — commit `cf59278`
> ("fix: remove klik's custom roundoff from the sales invoice flow", 2026-07-07) removed klik's
> buggy custom round-off monkey-patch/GL path. `_set_roundoff_fields()` in `sales_invoice.py` is now
> an intentional no-op ("ERPNext handles invoice rounding natively"). Nothing to do there.
>
> The additional-discount half is genuinely missing, but the math already exists in ERPNext core:
> Sales Invoice already has native `apply_discount_on` (Grand Total/Net Total), `discount_amount`,
> and `additional_discount_percentage` fields, and `calculate_taxes_and_totals()` (already called in
> `build_sales_invoice_doc`) already fully applies them. klik_pos currently never touches these
> fields. This module is glue only — parse a discount value from the POS payload and set it on the
> doc before totals are calculated — not new discount math.
>
> Bonus: the existing `validate_checkout_invoice` tax-preview endpoint already rebuilds the doc via
> `build_sales_invoice_doc` and returns `grand_total`/`net_total`, and the Payment Dialog already
> polls it live. Once the backend sets the discount field, that same endpoint reflects it
> automatically — the "recalculate in real time" requirement below is mostly already wired.

#### 1. Backend Discount Logic
- **[MODIFY] [klik_pos/api/sales_invoice.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/sales_invoice.py)**:
  - `parse_invoice_data`: read `additionalDiscountAmount`/`additionalDiscountPercentage` and
    `discountType`/`apply_discount_on` from the payload.
  - Implement `_set_additional_discount_fields(doc, discount_amount, discount_percentage, apply_discount_on)`:
    sets `doc.discount_amount` / `doc.additional_discount_percentage` / `doc.apply_discount_on`
    directly — no new discount math, `calculate_taxes_and_totals()` (core) does the rest.
  - Call this from both `build_sales_invoice_doc` (real submit) and `validate_checkout_invoice`'s
    preview path so the live tax preview and the actual submitted invoice always agree.

#### 2. Payment Dialog UI
- **[MODIFY] [klik_spa/src/components/dialog/PaymentDialog.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/dialog/PaymentDialog.tsx)**:
  - Add Additional Discount input fields (Amount & Percentage, mutually exclusive via `apply_discount_on`/discount type toggle) in the payment summary section.
  - Include the discount fields in the existing `validateCheckoutInvoice` preview payload so
    `grandTotal` and change given recalculate in real time off the backend-computed total (not a
    reimplemented client-side formula).

---

### Module 7: Customer-Specific Price List & Dynamic Pricing

> **Note (2026-07-30):** Both halves of this module are substantially already implemented, just via
> a different architecture than originally planned:
>
> - Price-list priority (Customer → Customer Group → POS Profile → Selling Settings) is already
>   resolved once per request by `_get_priority_price_list()` in `item_listing.py`'s `get_items()`.
> - Dynamic pricing on customer change already works: `setSelectedCustomer()` in `productStore.ts`
>   triggers `initializePOS()` → a full product refetch with the new customer id, and the cache
>   explicitly bypasses itself whenever a customer is set (`isCacheValid && !effectiveCustomerId`).
>   The product grid already gets fully re-priced items on customer selection — no new listener
>   needed in `ProductProvider.tsx`.
>
> The real remaining gap: `get_items()` calls `_fetch_item_prices_sql(item_code, price_list,
> current_date)` **once per item inside the product loop** — a genuine N+1 query (up to 2000 items =
> up to 2000 queries), unlike stock/bundle/variant counts in the same function which are already
> correctly batched before the loop. The fix is batching that one query in `item_listing.py`
> (mirroring `_fetch_batch_stock`/`_fetch_product_bundle_map`), not building a new endpoint in
> `item_price.py` that nothing would call. (`_get_conversion_factor_sql` has the same N+1 shape but
> is UOM conversion, not customer pricing — out of scope for this module.)

#### 1. Backend Batch Pricing Fix
- **[MODIFY] [klik_pos/api/item/item_listing.py](file:///home/phirun/dev/KLiK_PoS/klik_pos/api/item/item_listing.py)**:
  - Add `_fetch_item_prices_batch_sql(item_codes, price_list, current_date)`: one query for all item
    codes in the page (`item_code IN (...)`), returning a `{item_code: [price_rows]}` map.
  - Call it once before the `for item in items:` loop; replace the per-item
    `_fetch_item_prices_sql(item_code, ...)` call with a map lookup.
  - No changes to price-list priority resolution — `_get_priority_price_list()` is already correct.

#### 2. Product Provider
- No code change needed — `setSelectedCustomer` → `initializePOS` already refetches
  fully-repriced products on customer change.

---

### Module 8: Keyboard Navigation & UI Usability

#### 1. Layout Global Shortcuts & Navigation
- **[MODIFY] [klik_spa/src/components/RetailPOSLayout.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/RetailPOSLayout.tsx)**:
  - Register `Cmd/Ctrl + F`: Focuses search bar.
  - Register `Escape`: Clears search bar / deselects search result.
  - Register `ArrowUp / ArrowDown`: Navigates search results grid.
  - Register `Shift+Enter`: Opens quantity dialog for highlighted product.

#### 2. Search Bar & Order Summary Refinements
- **[MODIFY] [klik_spa/src/components/SearchBar.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/SearchBar.tsx)**:
  - Forward `onKeyDown` prop to search `<input>` element.
- **[MODIFY] [klik_spa/src/components/order/OrderSummary.tsx](file:///home/phirun/dev/KLiK_PoS/klik_spa/src/components/order/OrderSummary.tsx)**:
  - Add `custom_invoice_ref` input field for entering physical receipt/invoice numbers.

---

### Module 1: Custom Print Format & Status Indicators

- **[NEW] [klik_pos/klik_pos/print_format/ds_pos_invoice_klik/ds_pos_invoice_klik.json](file:///home/phirun/dev/KLiK_PoS/klik_pos/klik_pos/print_format/ds_pos_invoice_klik/ds_pos_invoice_klik.json)**:
  - Print format JSON definition for `DS POS Invoice KLiK`.
  - Displays Khmer sheet order descriptions (`custom_description`), payment breakdown, customer credit info, and status indicators (`PAID`, `UNPAID`, `PARTIAL`).

---

### Module 10: Delivery Tracking & Payment Reconciliation (Telegram Delivery Bot)

Detailed specification lives in [phases/phase-09.md](file:///home/phirun/dev/KLiK_PoS/phases/phase-09.md) (Todos 019–024). Builds on Module 6 (unpaid/partial invoices go out for delivery, driver collects, reconciliation posts the payment). Does **not** use Sales Orders or Delivery Notes.

**Boundary (decided): bot collects, KlikPOS confirms.** The bot collects delivery data via a structured Telegram (aiogram FSM) flow — invoice no, completion status, payment status, GPS, optional photos/voice — with **no OCR/AI** (the old Document AI/GenAI/ocr-service code is legacy/unused). Data is structured but driver-entered, so KlikPOS does the **invoice matching + human confirm + mark-paid**. KlikPOS runs no OCR/AI (structured-to-structured match). Data flows one-way (bot → KlikPOS); the Payment Entry posts locally in Frappe. Because the collection is a thin structured flow, full consolidation of the bot's data layer into Frappe is now viable — see Module 11 note.

#### 1. Delivery Report Staging DocType
- **[NEW] `klik_pos/klik_pos/doctype/delivery_report/`**: Stores untrusted bot data (GPS, driver, timestamp, delivery status, paid-at-location, amount collected) plus reconciliation state (`Unmatched` / `Suggested` / `Confirmed` / `Rejected`) and `match_confidence`.

#### 2. Sales Invoice Reconciled Delivery Fields
- **[MODIFY] `klik_pos/klik_pos/custom/sales_invoice.json`**: Add `custom_delivery_status`, `custom_delivery_driver`, `custom_delivered_at`, `custom_delivery_gps_latitude/longitude`, `custom_delivery_report` — written only after a confirmed match.

#### 3. Delivery API
- **[NEW] `klik_pos/api/delivery.py`**:
  - `submit_delivery_report(data)`: idempotent bot ingestion; creates a Delivery Report and runs auto-match.
  - `match_delivery_report(report)`: exact invoice-no → fuzzy → attribute matching with confidence scoring; suggestion only, never mutates the invoice.
  - `confirm_delivery_match(report_name, invoice_name, mark_paid)`: stamps delivery data onto the invoice and, if paid-at-location, posts a Payment Entry via the existing `create_payment_entry`.
  - `reject_delivery_match` / `rematch_delivery_report`: manual resolution.

#### 4. Reconciliation UI
- **[NEW] `klik_spa/src/pages/DeliveryReconciliationPage.tsx`** + `klik_spa/src/services/delivery.ts`: queue of pending reports, suggested-match card with confidence, confirm / reject / re-match / mark-as-paid actions.

---

### Module 11: Driver Management & Free-Text → Link Migration

Detailed specification lives in [phases/phase-10.md](file:///home/phirun/dev/KLiK_PoS/phases/phase-10.md) (Todos 025–028). Introduces a `Driver` master in KlikPOS and migrates the Phase 9 free-text driver fields to `Link`. Integrates with the existing delivery bot project (`/home/phirun/dev/hd-delivery-telegram`), which already owns driver identity (Telegram id / chat id) in its own PostgreSQL `Driver` table.

#### 1. Driver DocType
- **[NEW] `klik_pos/klik_pos/doctype/driver/`**: `driver_name`, `phone_number`, `telegram_user_id`, `telegram_username`, `chat_id`, `status` (Active/Pending/Rejected), `bot_driver_id` (cross-system sync key).

#### 2. Driver API + Bot Sync Bridge
- **[NEW] `klik_pos/api/driver.py`**: `list_drivers`, `upsert_driver`, `set_driver_status`, and `sync_driver_from_bot` (bot attaches Telegram identity). Source-of-truth default: **Frappe is master**, bot syncs from it (see phase-10 for the alternative mirror mode).

#### 3. Driver Management UI
- **[NEW] `klik_spa/src/pages/DriverManagementPage.tsx`** + `klik_spa/src/services/driver.ts`: side-menu page to list/create/approve/reject/suspend drivers — a native port of the bot's `/drivers` screen.

#### 4. Field Migration
- **[MODIFY]** `delivery_report.json` and `sales_invoice.json`: convert `delivery_driver` / `custom_delivery_driver` from `Data` to `Link(Driver)` with a backfill patch.

> **Broader UI-integration note** (updated): The delivery bot's collection path is now a thin structured Telegram (aiogram FSM) flow with **no OCR/AI** — the Document AI/GenAI/ocr-service code is legacy. This removes the main obstacle to consolidation, so **full consolidation into Frappe is now viable** and is the recommended direction for a single system-of-record. The one piece that cannot become a KlikPOS web screen is the **Telegram bot process itself** — it stays as a Python service but repoints from Postgres/MinIO to KlikPOS whitelisted APIs + Frappe File, becoming a thin data-entry client.
>
> Recommended migration is **strangler-fig, not big-bang**: (1) model the bot's entities as Frappe doctypes (Delivery Report = Module 10, Driver = Module 11); (2) natively port UI screens into `klik_spa` (reconciliation, drivers first; then deliveries list, live map via Google Maps + Frappe realtime); (3) repoint the aiogram bot to write to KlikPOS APIs; (4) retire NestJS + Postgres + Redis/BullMQ + MinIO + ocr-service. Modules 10–14 implement this path in order.
>
> **Out of scope (decided)**: The bot's `Customer` and `Address` entities are **not** ported — ERPNext already owns Customer and Address natively; a Delivery Report derives its customer/address from the **matched Sales Invoice**. The bot's `Booklet` feature is a **legacy transition-only aid and is dropped** — no Booklet doctype, field, or UI in KlikPOS. Only **Delivery** and **Driver** entities move.

---

### Module 12: Deliveries & Conflicts UI in KlikPOS

Detailed spec: [phases/phase-11.md](file:///home/phirun/dev/KLiK_PoS/phases/phase-11.md) (Todos 029–030). Native port of the bot's deliveries list + conflicts/duplicates + low-confidence screens, operating over the Frappe `Delivery Report` doctype and reusing the Module 10 reconciliation endpoints.

### Module 13: Live Delivery Map

Detailed spec: [phases/phase-12.md](file:///home/phirun/dev/KLiK_PoS/phases/phase-12.md) (Todos 031–032). Port of the bot's `/live` map: Google Maps (`@vis.gl/react-google-maps`) plotting delivery GPS, driven by Frappe `publish_realtime` instead of NestJS/socket.io.

### Module 14: Offline-First Bot Repoint & Legacy Retirement

Detailed spec: [phases/phase-13.md](file:///home/phirun/dev/KLiK_PoS/phases/phase-13.md) (Todos 033–036). The bot becomes **offline-first**: every delivery is written to a **local SQLite** outbox immediately (so drivers keep working when ERPNext is down), then a **sync worker** forwards `Not Synced` rows to the KlikPOS ingestion API (idempotent on `bot_delivery_id`) and uploads photos/voice to Frappe File. The bot UI is reduced to a per-delivery **Synced / Not Synced** status. Final step retires NestJS + Postgres + Redis/BullMQ + MinIO + ocr-service. These todos live in the bot repo (`hd-delivery-telegram`); the KlikPOS-side contract is the Module 10 APIs.

> **Offline-first invariant**: the bot never blocks a driver. Local SQLite is the durable capture store; KlikPOS is authoritative once synced. Idempotency on `bot_delivery_id` (Module 10, Todo 021) is what makes retry-after-downtime safe.

---

## Verification Plan

### Automated Tests & Builds
- Run `cd klik_spa && npm run build` to verify TypeScript compilation and asset bundling.
- Run `python3 -m py_compile klik_pos/api/*.py` to verify Python syntax.

### Manual Verification
- **AZ Coil Sheet Orders**: Verify in `CartItemRow.tsx` (Option B formula, disabled quantity, Khmer text).
- **Invoice Payment Types**: Test Unpaid, Partial Payment (`allow_partial_payment`), and Full Payment order submissions.
- **Closing Shift Reconciliation**: Verify shift closing summary table shows Total Sales, Collected Cash/Card, Credit/Unpaid Sales, and Expected Cash in Drawer with zero duplicate calculations.
- **Telegram & Credit Limit**: Test Telegram linking/sharing and credit limit warning popups.
