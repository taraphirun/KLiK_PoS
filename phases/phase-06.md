# Phase 6: Customer-Specific Price List & Dynamic Pricing
**Module 7**

**Status:** ✅ Done

## Objective
Ensure that item prices dynamically update based on the selected customer's assigned price list priority.

## Scope note (2026-07-30)
Both halves are substantially already implemented under the hood: price-list priority resolution
already exists (`_get_priority_price_list()`), and customer-change dynamic pricing already works via
`setSelectedCustomer` → `initializePOS` → full product refetch. The real gap is an N+1 query in
`get_items()` (`_fetch_item_prices_sql` runs once per item in the loop instead of being batched).
See `implementation_plan.md` → Module 7 for details.

## Todos
- [x] [014.md](../todo/014.md): Batch the per-item price query in `get_items()` (fix N+1, no new endpoint)
- [x] [015.md](../todo/015.md): Verify existing customer-change refetch already delivers dynamic pricing (no new code expected)
