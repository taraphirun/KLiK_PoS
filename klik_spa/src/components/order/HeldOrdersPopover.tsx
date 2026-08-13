"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, Trash2, RotateCcw, X } from "lucide-react";
import { toast } from "react-toastify";
import { deleteDraftInvoice } from "../../services/salesInvoice";
import { getOriginalDraftInvoiceId } from "../../utils/draftInvoiceCache";
import { extractErrorFromException } from "../../utils/errorExtraction";
import { formatCurrencyWithSymbol } from "../../utils/currency";

interface HeldOrderSummary {
  name: string;
  status?: string;
  customer_name?: string;
  base_grand_total?: number;
  base_rounded_total?: number;
  posting_date?: string;
  posting_time?: string;
  currency?: string;
  items?: unknown[];
}

interface HeldOrdersPopoverProps {
  // Whether the active cart currently has items - decides whether picking a held order can
  // resume directly or needs the current cart auto-held first.
  cartHasItems: boolean;
  // Direct resume: loads the held order straight into the (already empty, or already-held)
  // cart.
  onResume: (invoiceId: string) => Promise<void>;
  // Cart has unsaved items - caller runs the normal Hold flow (which already handles the
  // customer/salesperson-pin gate) and, once that finishes, resumes this invoice on its own.
  // Fired automatically, no cashier confirmation - see handlePick below.
  onHoldThenResume: (invoiceId: string) => void;
  currency_symbol?: string;
}

// Quick-access panel for held (Draft) sales invoices, opened straight from the cart
// footer so a cashier can resume one without leaving /pos (previously only possible
// via the Invoice History page). See draftInvoiceCache.ts / draftInvoiceToCart.ts for
// the actual resume mechanics this reuses.
export const HeldOrdersPopover = ({
  cartHasItems,
  onResume,
  onHoldThenResume,
  currency_symbol,
}: HeldOrdersPopoverProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [orders, setOrders] = useState<HeldOrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchHeldOrders = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        "/api/method/klik_pos.api.sales_invoice.get_sales_invoices?limit=100&start=0"
      );
      const result = await response.json();
      const invoices: HeldOrderSummary[] = result?.message?.data || [];
      setOrders(invoices.filter((inv) => inv.status === "Draft"));
    } catch (error) {
      console.error("Failed to load held orders:", error);
    } finally {
      setLoading(false);
    }
  };

  // Fetch once on mount so the badge count is right even before the panel is opened.
  useEffect(() => {
    fetchHeldOrders();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleOpen = () => {
    setIsOpen((prev) => !prev);
    if (!isOpen) fetchHeldOrders();
  };

  // The id of the held order currently loaded into the cart, if any - used only to disable/mark
  // that row below (resuming the invoice already in the cart is a no-op). NOT used to decide
  // whether to auto-hold: even a cart that started as a resumed held order can have unsaved
  // edits since (quantity bumped, item added...), so it must still be (re-)held - onto the same
  // draft, via draft_invoice_id - before switching away, or those edits are silently lost.
  const activeDraftId = getOriginalDraftInvoiceId();

  // Picking a held order while the cart has items auto-holds the current cart first (updating
  // its existing draft in place if it has one), then resumes the picked one - no prompt, no
  // "discard current cart" option. Fewer clicks, and no way to lose a cart by picking the wrong
  // button in a confirm dialog.
  const handlePick = (invoiceId: string) => {
    if (busyId) return;
    setIsOpen(false);
    if (cartHasItems) {
      onHoldThenResume(invoiceId);
      void fetchHeldOrders();
      return;
    }
    void resumeDirect(invoiceId);
  };

  const resumeDirect = async (invoiceId: string) => {
    setBusyId(invoiceId);
    try {
      await onResume(invoiceId);
      void fetchHeldOrders();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (invoiceId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (busyId) return;
    if (!window.confirm("Delete this held order? This cannot be undone.")) return;
    setBusyId(invoiceId);
    try {
      await deleteDraftInvoice(invoiceId);
      toast.success("Held order deleted");
      void fetchHeldOrders();
    } catch (error) {
      toast.error(extractErrorFromException(error, "Failed to delete held order"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleOpen}
        className="relative flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
      >
        <Clock className="h-4 w-4" />
        Held Orders
        {orders.length > 0 && (
          <span className="absolute -top-2 -right-2 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-beveren-600 px-1 text-xs font-semibold text-white">
            {orders.length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 z-[150] mb-2 w-80 max-h-96 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-2xl flex flex-col">
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-4 py-2">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">
              Held Orders {orders.length > 0 && `(${orders.length})`}
            </p>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {loading ? (
              <p className="p-3 text-center text-xs text-gray-500 dark:text-gray-400">Loading...</p>
            ) : orders.length === 0 ? (
              <p className="p-3 text-center text-xs text-gray-500 dark:text-gray-400">
                No held orders right now.
              </p>
            ) : (
              <div className="space-y-1.5">
                {orders.map((order) => {
                  const isActiveDraft = activeDraftId === order.name;
                  const total = order.base_rounded_total ?? order.base_grand_total ?? 0;
                  return (
                    <div
                      key={order.name}
                      onClick={() => !isActiveDraft && handlePick(order.name)}
                      className={`flex items-center justify-between gap-2 rounded-md border p-2.5 text-left transition-colors ${
                        isActiveDraft
                          ? "cursor-not-allowed border-gray-100 dark:border-gray-700 opacity-50"
                          : "cursor-pointer border-gray-200 dark:border-gray-700 hover:border-beveren-300 dark:hover:bg-gray-700/50"
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                          {order.customer_name || "Walk-in"}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {order.name} &middot; {(order.items?.length ?? 0)} item
                          {(order.items?.length ?? 0) === 1 ? "" : "s"}
                          {isActiveDraft && " · currently in cart"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-sm font-semibold text-beveren-600 dark:text-beveren-400">
                          {formatCurrencyWithSymbol(total, currency_symbol)}
                        </span>
                        {!isActiveDraft && (
                          <>
                            <RotateCcw className="h-4 w-4 text-gray-400" />
                            <button
                              type="button"
                              onClick={(e) => handleDelete(order.name, e)}
                              disabled={busyId === order.name}
                              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                              aria-label="Delete held order"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
