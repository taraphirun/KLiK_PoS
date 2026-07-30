# Phase 5: Additional Discount & Tax Round-Off Fixes
**Module 5**

**Status:** ✅ Done

## Objective
Support additional discounts (amount and percentage) in the POS checkout flow.

## Scope note (2026-07-30)
The round-off half of this phase is already fixed (commit `cf59278`, 2026-07-07) — ERPNext's
native rounding is used and klik's custom roundoff path was removed. Only the additional-discount
half remains, and it wraps ERPNext core's existing `discount_amount`/`additional_discount_percentage`/
`apply_discount_on` fields + `calculate_taxes_and_totals()` rather than reimplementing discount math.
See `implementation_plan.md` → Module 5 for details.

## Todos
- [x] [012.md](../todo/012.md): Backend additional-discount field wiring (native erpnext fields)
- [x] [013.md](../todo/013.md): Frontend Payment Dialog discount inputs and calculation
