import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "react-toastify";
import type { Customer } from "../../types/customer";
import { CustomerSearchSection } from "../order/CustomerSearchSection";
import { createInvoiceForUnreportedPage, type PaymentStatus } from "../../services/delivery";

const PAYMENT_STATUS_OPTIONS: PaymentStatus[] = ["Paid", "Partial", "Unpaid"];

/** Matches klik_pos.api.item.item_listing.get_items's enriched_items shape - `id` is the actual
 * Item docname/item_code, `name` is the display name (item_name, falling back to item_code). */
interface ItemSearchResult {
  id: string;
  name: string;
  price: number;
  uom?: string;
}

interface InvoiceLine {
  item_code: string;
  item_name: string;
  quantity: number;
  price: number;
}

interface CreateInvoiceForPageModalProps {
  pageNumber: number;
  defaultDate: string;
  onClose: () => void;
  onCreated: (invoiceName: string) => void;
}

/** Backfills a Sales Invoice for a booklet page number with neither an invoice nor a Delivery
 * Report at all (Module 17's daily reconciliation "Unresolved" bucket) - a stripped-down sibling
 * of CreateInvoiceFromReportModal (no photos/report defaults, since there's no report here at all)
 * that calls create_invoice_for_unreported_page instead. */
export default function CreateInvoiceForPageModal({
  pageNumber,
  defaultDate,
  onClose,
  onCreated,
}: CreateInvoiceForPageModalProps) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [postingDate, setPostingDate] = useState(defaultDate);
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("Unpaid");
  const [amountCollected, setAmountCollected] = useState("");
  const [dueDate, setDueDate] = useState(defaultDate);
  const [itemQuery, setItemQuery] = useState("");
  const [itemResults, setItemResults] = useState<ItemSearchResult[]>([]);
  const [isSearchingItems, setIsSearchingItems] = useState(false);
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  // Independent local search against get_items - deliberately NOT the shared productStore (see
  // CreateInvoiceFromReportModal's identical note - avoids clobbering the live POS grid's state).
  useEffect(() => {
    const query = itemQuery.trim();
    if (!query) {
      setItemResults([]);
      return;
    }
    let isCurrent = true;
    setIsSearchingItems(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ search: query, limit: "20" });
        if (customer) params.set("customer", customer.id);
        const response = await fetch(
          `/api/method/klik_pos.api.item.item_listing.get_items?${params.toString()}`,
          { credentials: "include" }
        );
        const result = await response.json();
        if (!isCurrent) return;
        setItemResults((result.message?.items || []) as ItemSearchResult[]);
      } catch {
        if (isCurrent) setItemResults([]);
      } finally {
        if (isCurrent) setIsSearchingItems(false);
      }
    }, 300);

    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [itemQuery, customer]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) {
        setShowItemDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handlePickItem = (item: ItemSearchResult) => {
    setLines((prev) => {
      const existing = prev.find((line) => line.item_code === item.id);
      if (existing) {
        return prev.map((line) =>
          line.item_code === item.id ? { ...line, quantity: line.quantity + 1 } : line
        );
      }
      return [...prev, { item_code: item.id, item_name: item.name, quantity: 1, price: item.price || 0 }];
    });
    setItemQuery("");
    setItemResults([]);
    setShowItemDropdown(false);
  };

  const updateLine = (itemCode: string, field: "quantity" | "price", value: number) => {
    setLines((prev) =>
      prev.map((line) => (line.item_code === itemCode ? { ...line, [field]: value } : line))
    );
  };

  const removeLine = (itemCode: string) => {
    setLines((prev) => prev.filter((line) => line.item_code !== itemCode));
  };

  const total = lines.reduce((sum, line) => sum + line.quantity * line.price, 0);

  const hasValidLines =
    lines.length > 0 && lines.every((line) => line.quantity > 0 && line.price >= 0);
  const needsDueDate = paymentStatus !== "Paid";
  const hasValidPayment =
    paymentStatus !== "Partial" || (Number(amountCollected) > 0 && Number(amountCollected) < total);
  const canSubmit =
    Boolean(customer) &&
    hasValidLines &&
    hasValidPayment &&
    (!needsDueDate || Boolean(dueDate)) &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!customer) {
      toast.error("Select a customer first.");
      return;
    }
    if (!hasValidLines) {
      toast.error("Add at least one item with a quantity greater than 0.");
      return;
    }
    if (paymentStatus === "Partial" && !(Number(amountCollected) > 0)) {
      toast.error("Enter the amount collected for a partial payment.");
      return;
    }
    if (needsDueDate && !dueDate) {
      toast.error("Select a due date.");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createInvoiceForUnreportedPage(
        pageNumber,
        {
          customer: { id: customer.id },
          items: lines.map((line) => ({
            item_code: line.item_code,
            quantity: line.quantity,
            price: line.price,
          })),
          posting_date: postingDate,
        },
        paymentStatus,
        paymentStatus === "Partial" ? Number(amountCollected) : undefined,
        needsDueDate ? dueDate : undefined
      );
      if (!result.success || !result.invoice_name) {
        throw new Error(result.message || "Failed to create invoice");
      }
      toast.success(`Invoice ${result.invoice_name} created for page ${pageNumber}`);
      onCreated(result.invoice_name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create invoice");
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Create Invoice</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Backfill the missing invoice for paper page #{pageNumber}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Customer
            </label>
            <CustomerSearchSection
              selectedCustomer={customer}
              onCustomerSelect={setCustomer}
              onCustomerClear={() => setCustomer(null)}
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Posting date
              </label>
              <input
                type="date"
                value={postingDate}
                onChange={(event) => setPostingDate(event.target.value)}
                className="w-48 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Payment status
              </label>
              <select
                value={paymentStatus}
                onChange={(event) => setPaymentStatus(event.target.value as PaymentStatus)}
                className="w-40 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              >
                {PAYMENT_STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            {paymentStatus === "Partial" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  Amount collected
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amountCollected}
                  onChange={(event) => setAmountCollected(event.target.value)}
                  placeholder={total ? total.toFixed(2) : "0.00"}
                  className="w-32 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                />
              </div>
            )}

            {needsDueDate && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  Due date
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                  className="w-48 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                />
              </div>
            )}
          </div>

          <div ref={searchBoxRef} className="relative">
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Add item
            </label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input
                type="text"
                value={itemQuery}
                onChange={(event) => {
                  setItemQuery(event.target.value);
                  setShowItemDropdown(true);
                }}
                onFocus={() => setShowItemDropdown(true)}
                placeholder="Search item name or code"
                className="w-full rounded-md border border-gray-300 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            {showItemDropdown && itemQuery.trim() && (
              <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
                {isSearchingItems ? (
                  <div className="flex items-center gap-2 p-3 text-sm text-gray-500 dark:text-gray-400">
                    <Loader2 size={14} className="animate-spin" /> Searching...
                  </div>
                ) : itemResults.length === 0 ? (
                  <div className="p-3 text-sm text-gray-500 dark:text-gray-400">No items found.</div>
                ) : (
                  itemResults.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handlePickItem(item)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      <span className="min-w-0 truncate text-gray-900 dark:text-white">
                        {item.name}
                        <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">{item.id}</span>
                      </span>
                      <span className="ml-2 shrink-0 text-gray-600 dark:text-gray-300">{item.price}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-gray-200 dark:border-gray-700">
            {lines.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
                No items added yet — search above to add what was on the paper slip.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 text-left text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="w-20 px-3 py-2 font-medium">Qty</th>
                    <th className="w-24 px-3 py-2 font-medium">Rate</th>
                    <th className="w-24 px-3 py-2 text-right font-medium">Amount</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {lines.map((line) => (
                    <tr key={line.item_code}>
                      <td className="px-3 py-2 text-gray-900 dark:text-white">
                        {line.item_name}
                        <div className="text-xs text-gray-400">{line.item_code}</div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={line.quantity}
                          onChange={(event) =>
                            updateLine(line.item_code, "quantity", Number(event.target.value))
                          }
                          className="w-16 rounded border border-gray-300 bg-white px-1.5 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.price}
                          onChange={(event) =>
                            updateLine(line.item_code, "price", Number(event.target.value))
                          }
                          className="w-20 rounded border border-gray-300 bg-white px-1.5 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                        />
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">
                        {(line.quantity * line.price).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => removeLine(line.item_code)}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {lines.length > 0 && (
            <div className="flex items-center justify-end gap-2 text-sm">
              <span className="text-gray-500 dark:text-gray-400">Total</span>
              <span className="text-base font-semibold text-gray-900 dark:text-white">{total.toFixed(2)}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-4 py-2 text-sm font-medium text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create Invoice
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
