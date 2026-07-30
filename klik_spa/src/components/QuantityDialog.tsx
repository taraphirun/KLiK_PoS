"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { MenuItem } from "../../types";
import { formatCurrencyWithSymbol } from "../utils/currency";

interface QuantityDialogProps {
  item: MenuItem;
  onCancel: () => void;
  onConfirm: (quantity: number) => void | Promise<void>;
}

export default function QuantityDialog({ item, onCancel, onConfirm }: QuantityDialogProps) {
  const [quantity, setQuantity] = useState("1");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const parsedQuantity = parseFloat(quantity);
  const isValid = !isNaN(parsedQuantity) && parsedQuantity > 0;

  const handleConfirm = async () => {
    if (!isValid) return;
    setIsSubmitting(true);
    try {
      await onConfirm(parsedQuantity);
    } finally {
      setIsSubmitting(false);
    }
  };

  const price = Number(item.price_with_vat ?? item.price);

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg bg-white shadow-2xl dark:bg-gray-800">
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
              Add to cart
            </p>
            <h2 className="truncate text-lg font-bold text-gray-900 dark:text-white">
              {item.name}
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {formatCurrencyWithSymbol(price, item.currency_symbol)} each
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
            aria-label="Cancel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
            Quantity
          </label>
          <input
            ref={inputRef}
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleConfirm();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-center text-2xl text-gray-900 outline-none transition-colors focus:border-beveren-500 focus:ring-2 focus:ring-beveren-200 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-gray-200 bg-gray-50 px-5 py-4 dark:border-gray-700 dark:bg-gray-800/70">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isSubmitting || !isValid}
            className="rounded-md bg-beveren-600 px-4 py-2 text-sm font-semibold text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? "Adding..." : "Add to Cart"}
          </button>
        </div>
      </div>
    </div>
  );
}
