// utils/stock.ts
import { usePOSProfileStore } from '../stores/posProfileStore';

/**
 * Single source of truth for "is this item out of stock" across the POS UI (product cards, grid,
 * line view, variant picker, restaurant layout) and the cart (cartStore's hasFiniteAvailableStock).
 *
 * Stock Settings > Allow Negative Stock is a global backend setting - once it's on, the backend
 * itself will let a Sales Invoice push a bin below zero, so nothing client-side should be blocking
 * or graying out an item just because `available` reads 0 or negative. Every call site that used to
 * inline `item.is_stock_item !== false && item.available <= 0` must route through here instead, or
 * it silently disagrees with the setting - which is exactly the bug this function fixes (the "Add"
 * button was disabled at the UI layer before cartStore's own guard ever ran).
 */
export function isItemOutOfStock(item: { available?: number; is_stock_item?: boolean }): boolean {
  if (item.is_stock_item === false) return false;
  if (usePOSProfileStore.getState().allowNegativeStock) return false;
  return (item.available ?? 0) <= 0;
}
