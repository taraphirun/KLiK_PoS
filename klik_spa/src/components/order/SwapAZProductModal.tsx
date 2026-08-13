"use client";

import { useMemo, useState } from "react";
import { X, Search } from "lucide-react";
import type { CartItem, MenuItem } from "../../../types";
import { useProductStore } from "../../stores/productStore";
import { formatCurrencyWithSymbol } from "../../utils/currency";
import { isAZCoilItem } from "../../utils/azCoil";
import { hasFiniteAvailableStock } from "../../stores/cartStore";

interface SwapAZProductModalProps {
  currentItem: CartItem;
  // Untyped to match CartItemRow's own posDetails prop - see azCoil.ts's AZCoilItemGroupsSource
  // comment on the codebase's two separate POSProfile types.
  posDetails: any;
  onClose: () => void;
  onSelect: (item: MenuItem) => Promise<void> | void;
}

// Lets a cashier change the product on an already-specced AZ Coil cart row without losing the
// roofing spec table (see changeCartItemProduct in cartStore.ts, which is what actually performs
// the swap - this component is just the picker). AZ-only by design: the button that opens this
// only renders for AZ Coil rows (CartItemRow.tsx), and the list below is filtered to the same
// AZ item groups, so there's no path from here into a cross-category swap.
export const SwapAZProductModal: React.FC<SwapAZProductModalProps> = ({
  currentItem,
  posDetails,
  onClose,
  onSelect,
}) => {
  const products = useProductStore((state) => state.products);
  const [search, setSearch] = useState("");
  const [isSwapping, setIsSwapping] = useState(false);

  const currentCode = currentItem.item_code || currentItem.id;

  const azProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter((product) => {
      if (!isAZCoilItem(product, posDetails)) return false;
      if ((product.item_code || product.id) === currentCode) return false;
      if (!query) return true;
      return (
        product.name?.toLowerCase().includes(query) ||
        (product.item_code || product.id)?.toLowerCase().includes(query)
      );
    });
  }, [products, posDetails, currentCode, search]);

  const handlePick = async (product: MenuItem) => {
    if (isSwapping) return;
    setIsSwapping(true);
    try {
      await onSelect(product);
    } finally {
      setIsSwapping(false);
    }
  };

  // Same rule the store's changeCartItemProduct actually enforces (see cartStore.ts) - mirrored
  // here so a blocked pick is disabled and labeled before the cashier ever taps it, not just
  // rejected by toast afterward. Respects Stock Settings > Allow Negative Stock via
  // hasFiniteAvailableStock: once that's on, nothing here blocks or labels anything.
  const stockIssue = (product: MenuItem): "out" | "insufficient" | null => {
    if (!hasFiniteAvailableStock(product)) return null;
    const available = product.available ?? 0;
    if (available <= 0) return "out";
    if (available < currentItem.quantity) return "insufficient";
    return null;
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-gray-800">
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
              Change Product
            </p>
            <h2 className="truncate text-lg font-bold text-gray-900 dark:text-white">
              {currentItem.name}
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Pick a different AZ product. Roofing spec and quantity are kept.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
            aria-label="Close product picker"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search AZ products..."
              autoFocus
              className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 focus:border-transparent focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {azProducts.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
              No other AZ products found.
            </div>
          ) : (
            <div className="grid gap-2">
              {azProducts.map((product) => {
                const issue = stockIssue(product);
                const disabled = isSwapping || issue !== null;
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => handlePick(product)}
                    disabled={disabled}
                    title={
                      issue === "out"
                        ? "Out of stock"
                        : issue === "insufficient"
                        ? `Only ${product.available} ${product.uom || "units"} available - needs ${currentItem.quantity}`
                        : undefined
                    }
                    className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-3 text-left transition-colors hover:border-beveren-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                        {product.name}
                      </p>
                      <p className="font-mono text-xs text-gray-500 dark:text-gray-400">
                        {product.item_code || product.id}
                      </p>
                      {issue && (
                        <p className="mt-0.5 text-xs font-medium text-red-500 dark:text-red-400">
                          {issue === "out"
                            ? "Out of stock"
                            : `Only ${product.available} ${product.uom || "units"} available`}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-beveren-600 dark:text-beveren-400">
                        {formatCurrencyWithSymbol(product.price, product.currency_symbol)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
