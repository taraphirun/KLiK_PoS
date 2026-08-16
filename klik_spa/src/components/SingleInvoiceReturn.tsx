import { useEffect, useMemo, useState } from "react";
import {
  X,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
  Package,
  Minus,
  Plus
} from "lucide-react";
import { toast } from "react-toastify";
import { formatCurrencyWithSymbol, getCurrencySymbol } from "../utils/currency";
import { usePOSProfileStore } from "../stores/posProfileStore";
import { usePaymentModes } from "../hooks/usePaymentModes";
import {
  createPartialReturn,
  getReturnContext,
  getReturnedQty,
  type ReturnItem,
  type ReturnOutcome,
} from "../services/returnService";
import { getInvoiceDetails } from "../services/salesInvoice";

interface SingleInvoiceReturnProps {
  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoice: any;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (returnInvoice: string) => void;
}

export default function SingleInvoiceReturn({
  invoice,
  isOpen,
  onClose,
  onSuccess
}: SingleInvoiceReturnProps) {
  const [returnItems, setReturnItems] = useState<ReturnItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingReturnData, setLoadingReturnData] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [originalInvoiceGrandTotal, setOriginalInvoiceGrandTotal] = useState<number>(0);
  const [originalInvoicePaidAmount, setOriginalInvoicePaidAmount] = useState<number>(0);

  // Currency from invoice or POS profile
  const { posDetails } = usePOSProfileStore();
  const currency = (invoice && (invoice.currency || invoice.company_currency)) || posDetails?.currency || 'USD';
  const currencySymbol = getCurrencySymbol(currency);

  // Payment modes from POS profile
  const { modes: paymentModes, isLoading: paymentModesLoading } = usePaymentModes(typeof posDetails?.name === 'string' ? posDetails.name : '');

  // Payment method states
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<string>("");
  const [returnAmount, setReturnAmount] = useState<number>(0);

  // How the return is settled (phase-17 §2c, revised 2026-08-15, revised again
  // 2026-08-16). `outcome` is only the cashier's raw last click - what actually
  // happens is `effectiveOutcome` below, which is forced to store_credit whenever
  // nothing is `available`. refundable/outstanding are the invoice's own numbers
  // (server-computed, fixed per invoice); `available` is derived live from those plus
  // the currently-selected return quantities. Debt first, always (see hd/returns.py's
  // get_available_for_cash_or_credit): nothing is released while the invoice still
  // owes money after this return's value pays down as much of it as it can - only the
  // genuine excess, once the debt is fully cleared, is ever available, capped at
  // refundable.
  const [outcome, setOutcome] = useState<ReturnOutcome>("refund");
  const [refundable, setRefundable] = useState<number>(0);
  const [outstanding, setOutstanding] = useState<number>(0);

  useEffect(() => {
    if (isOpen && invoice) {
      initializeReturnItems();
    }
  }, [isOpen, invoice]);

  const totalReturnAmount = useMemo(
    () => returnItems.reduce((sum, item) => sum + (item.return_qty || 0) * item.rate, 0),
    [returnItems]
  );

  const available = useMemo(() => {
    // Rounded before comparing to 0: this crossover (return value exactly clearing the
    // outstanding balance) is one cashiers hit often, and float epsilon on live
    // reactive state could flap the refund/store-credit chooser right at the boundary.
    const excess = Math.max(Math.round((totalReturnAmount - outstanding) * 100) / 100, 0);
    return Math.max(Math.min(excess, refundable), 0);
  }, [refundable, outstanding, totalReturnAmount]);

  // Masks a stale/default `outcome` whenever nothing is available to give out - the
  // chooser itself is hidden in that case (below), but submission, labels and the
  // refund-vs-credit breakdown must all agree on what's actually going to happen.
  const effectiveOutcome: ReturnOutcome = available > 0 ? outcome : "store_credit";

  // The refund is not freely choosable: it always equals the value of the returned
  // items, capped at what's available (backend enforces the same rule). To refund
  // less, the cashier reduces the return quantities. This replaces the old editable
  // amount + write-off proration, which let refund and returned value silently
  // disagree - the difference became store credit nobody chose (invoice 00179 case).
  useEffect(() => {
    const rounded = Math.round(totalReturnAmount * 100) / 100;
    setReturnAmount(available > 0 ? Math.min(rounded, available) : rounded);
  }, [totalReturnAmount, available]);

  // Set default payment method when payment modes are loaded

  // Set default payment method when payment modes are loaded
  useEffect(() => {
    if (paymentModes.length > 0 && !selectedPaymentMethod) {
      // Find default payment method or use first one
      const defaultMode = paymentModes.find(mode => mode.default === 1);
      const firstMode = paymentModes[0];
      const resolved = defaultMode?.mode_of_payment || firstMode?.mode_of_payment || "";
      setSelectedPaymentMethod(resolved);
    }
  }, [paymentModes, selectedPaymentMethod]);

  const initializeReturnItems = async () => {
    setLoadingReturnData(true);
    try {

      // Refund/store-credit inputs from the server - `available` (above) derives from
      // these plus the live selected quantities, so nothing else needs setting here;
      // `outcome` keeps its default and is masked by `effectiveOutcome` if unavailable.
      const context = await getReturnContext(invoice.name || invoice.id);
      setRefundable(context?.refundable ?? 0);
      setOutstanding(context?.outstanding ?? 0);

      // Always fetch complete invoice details from backend to get accurate grand_total
      let invoiceWithItems = invoice;
      const invoiceDetails = await getInvoiceDetails(invoice.name || invoice.id);

      if (invoiceDetails.success && invoiceDetails.data) {
        invoiceWithItems = invoiceDetails.data.data || invoiceDetails.data;
        // Store the original invoice grand total and paid amount for return calculations
        setOriginalInvoiceGrandTotal(invoiceWithItems.grand_total || 0);
        setOriginalInvoicePaidAmount(invoiceWithItems.paid_amount || invoiceWithItems.grand_total || 0);
      } else {
        console.error('Failed to fetch invoice details:', invoiceDetails.error);
        throw new Error(invoiceDetails.error || 'Failed to fetch invoice details from backend');
      }

        const items: ReturnItem[] = [];

        // Handle different possible item structures
        const itemsArray = invoiceWithItems.items || invoiceWithItems.items_list || invoiceWithItems.sales_invoice_items || [];

        if (!Array.isArray(itemsArray)) {
          console.error('Items is not an array:', itemsArray);
          throw new Error('Invoice items not found in expected format');
        }

        for (const item of itemsArray) {

        // Get returned quantity for each item
        const returnedData = await getReturnedQty(
          invoiceWithItems.customer,
          invoiceWithItems.name || invoiceWithItems.id,
          item.item_code || item.id
        );

        const returnedQty = returnedData.success ?
          returnedData.data?.total_returned_qty || 0 : 0;

        // Handle different property names from different invoice sources
        const itemCode = item.item_code || item.id;
        const itemName = item.item_name || item.name;
        const qty = Number(item.qty ?? item.quantity ?? 0);
        const rate = Number(item.rate ?? item.unitPrice ?? 0);
        const amount = Number(item.amount ?? item.total ?? (qty * rate));


        items.push({
          item_code: itemCode,
          item_name: itemName,
          qty,
          rate,
          amount,
          returned_qty: returnedQty,
          available_qty: Math.round((qty - returnedQty) * 100) / 100,  // Round to 2 decimal places
          return_qty: Math.round((qty - returnedQty) * 100) / 100  // Round to 2 decimal places
        });
      }

      setReturnItems(items);
    } catch (error) {
      console.error('Error initializing return items:', error);
      toast.error('Failed to load return data');
    } finally {
      setLoadingReturnData(false);
    }
  };

  const handleReturnQtyChange = (itemCode: string, newQty: number) => {
    setReturnItems(prev => prev.map(item => {
      if (item.item_code === itemCode) {
        // Ensure return qty doesn't exceed available qty and round to 2 decimal places
        const validQty = Math.max(0, Math.min(Math.round(newQty * 100) / 100, item.available_qty));
        return { ...item, return_qty: validQty };
      }
      return item;
    }));
  };

  const handleReturnAllItems = () => {
    setReturnItems(prev => prev.map(item => ({
      ...item,
      return_qty: item.available_qty
    })));
  };

  const handleClearAll = () => {
    setReturnItems(prev => prev.map(item => ({
      ...item,
      return_qty: 0
    })));
  };

  const handleSubmitReturn = async () => {
    const itemsToReturn = returnItems.filter(item => item.return_qty && item.return_qty > 0);

    if (itemsToReturn.length === 0) {
      toast.error('Please select at least one item to return');
      return;
    }

    setIsLoading(true);
    const invoiceName = invoice.id || invoice.name
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const returnData = {
        items: itemsToReturn,
        paymentMethod: selectedPaymentMethod,
        returnAmount: returnAmount
      };


      // effectiveOutcome, not raw outcome: a stale "refund" click left selected while
      // quantities dropped `available` to 0 must not be sent as-is - the backend would
      // (correctly) reject it, since nothing is left available to refund.
      const result = await createPartialReturn(
        invoiceName,
        itemsToReturn,
        selectedPaymentMethod,
        returnAmount,
        effectiveOutcome
      );

      if (result.success) {
        const outcomeLabel =
          effectiveOutcome === "refund"
            ? `refunded via ${selectedPaymentMethod || "original payment method"}`
            : available <= 0
            ? "bill reduced"
            : "kept as store credit";
        toast.success(`Return created successfully (${outcomeLabel})`);
        // Any unpaid slice of the return settles the original bill automatically after
        // submit - if that step failed, the return itself still succeeded but the bill
        // wasn't reduced and the value is sitting as unresolved credit. Say so; don't
        // let it look like everything just worked.
        if (result.residualSettlement && !result.residualSettlement.success) {
          toast.warning(
            `Return recorded, but automatically reducing the original bill by ` +
              `${formatCurrencyWithSymbol(result.residualSettlement.amount, currency)} failed. ` +
              `Resolve manually in Payments > Reconciliation.`,
            { autoClose: false }
          );
        }
        onSuccess(result.returnInvoice!);
        onClose();
      } else {
        toast.error(result.error || 'Failed to create return');
      }
    } catch (error) {
      console.error('Error creating return:', error);
      toast.error('Failed to create return');
    } finally {
      setIsLoading(false);
    }
  };

  const hasItemsToReturn = returnItems.some(item => (item.return_qty || 0) > 0);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 bg-beveren-100 dark:bg-orange-900/20 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-orange-100 dark:bg-orange-900/40 rounded-lg">
                <RotateCcw className="w-6 h-6 text-orange-600 dark:text-orange-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                  Return Items
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Invoice: {invoice?.name || invoice?.id} • Customer: {invoice?.customer}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loadingReturnData ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-600 mx-auto mb-4"></div>
                <p className="text-gray-600 dark:text-gray-400">Loading return data...</p>
              </div>
            </div>
          ) : (
            <>
              {/* Action Buttons */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center space-x-3">
                  <button
                    onClick={handleReturnAllItems}
                    className="px-4 py-2 bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 rounded-lg hover:bg-orange-200 dark:hover:bg-orange-900/40 transition-colors text-sm font-medium"
                  >
                    Return All Available
                  </button>
                  <button
                    onClick={handleClearAll}
                    className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-sm font-medium"
                  >
                    Clear All
                  </button>
                </div>
                <div className="text-right">
                  {/* The refund-vs-return-value breakdown only means something for the
                      refund outcome - for store_credit the full returned value is
                      credited (funded slice as spendable credit, any unfunded slice
                      auto-settling the bill) and there's no "not refunded" remainder. */}
                  {effectiveOutcome === "refund" && originalInvoicePaidAmount > 0 && totalReturnAmount !== returnAmount ? (
                    <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                      <div className="flex justify-between items-center">
                        <span>Total Return Amount:</span>
                        <span>{formatCurrencyWithSymbol(totalReturnAmount, currency)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span>Refund Amount:</span>
                        <span>{formatCurrencyWithSymbol(returnAmount, currency)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        {/* Only reachable when the return's value exceeds what was paid
                            (partly-paid original) - that unpaid slice can't be refunded
                            as cash; it clears the original bill's balance instead. */}
                        <span className="text-orange-600 dark:text-red-400 font-semibold">Unpaid portion (clears this bill):</span>
                        <span className="text-orange-600 dark:text-red-400 font-semibold">
                          {formatCurrencyWithSymbol(totalReturnAmount - returnAmount, currency)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-lg font-bold text-black-600 dark:text-orange-400">
                      {formatCurrencyWithSymbol(totalReturnAmount, currency)}
                    </div>
                  )}
                  {effectiveOutcome === "refund" && originalInvoicePaidAmount > 0 && totalReturnAmount === returnAmount && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Customer Paid: {formatCurrencyWithSymbol(originalInvoicePaidAmount, currency)}
                    </div>
                  )}
                </div>
              </div>

              {/* Items Table */}
              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-100 dark:bg-gray-600">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Item
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Sold Qty
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Returned
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Available
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Return Qty
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Unit Price
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Return Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-600">
                      {returnItems.map((item) => (
                        <tr key={item.item_code} className="hover:bg-gray-50 dark:hover:bg-gray-600">
                          <td className="px-4 py-4">
                            <div className="flex items-center space-x-3">
                              <div className="p-2 bg-blue-100 dark:bg-blue-900/20 rounded-lg">
                                <Package className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                              </div>
                              <div>
                                <div className="text-sm font-medium text-gray-900 dark:text-white">
                                  {item.item_name}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                  Code: {item.item_code}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-center text-sm text-gray-900 dark:text-white">
                            {item.qty}
                          </td>
                          <td className="px-4 py-4 text-center">
                            <span className="text-sm text-red-600 dark:text-red-400">
                              {item.returned_qty}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-center">
                            <span className={`text-sm font-medium ${
                              item.available_qty > 0
                                ? 'text-green-600 dark:text-green-400'
                                : 'text-gray-500 dark:text-gray-400'
                            }`}>
                              {item.available_qty}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex items-center justify-center space-x-2">
                              <button
                                onClick={() => handleReturnQtyChange(
                                  item.item_code,
                                  Math.round(((item.return_qty || 0) - 1) * 100) / 100  // Round to 2 decimal places
                                )}
                                disabled={!item.return_qty || item.return_qty <= 0}
                                className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-600 rounded"
                              >
                                <Minus className="w-4 h-4" />
                              </button>
                              <input
                                type="number"
                                min="0"
                                max={item.available_qty}
                                value={item.return_qty || 0}
                                onChange={(e) => handleReturnQtyChange(
                                  item.item_code,
                                  Math.round((parseFloat(e.target.value) || 0) * 100) / 100  // Round to 2 decimal places
                                )}
                                className="w-16 px-2 py-1 text-center border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
                                disabled={item.available_qty === 0}
                              />
                              <button
                                onClick={() => handleReturnQtyChange(
                                  item.item_code,
                                  Math.round(((item.return_qty || 0) + 1) * 100) / 100  // Round to 2 decimal places
                                )}
                                disabled={item.available_qty === 0 || (item.return_qty || 0) >= item.available_qty}
                                className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-600 rounded"
                              >
                                <Plus className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-right text-sm text-gray-900 dark:text-white">
                            {formatCurrencyWithSymbol(item.rate, currency)}
                          </td>
                          <td className="px-4 py-4 text-right text-sm font-medium text-gray-900 dark:text-white">
                            {formatCurrencyWithSymbol((item.return_qty || 0) * item.rate, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Warning for no returnable items */}
              {returnItems.every(item => item.available_qty === 0) && (
                <div className="mt-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
                    <div>
                      <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                        No Items Available for Return
                      </h4>
                      <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                        All items from this invoice have already been returned.
                      </p>
                    </div>
                  </div>
                </div>
              )}

            </>
          )}
        </div>

        {/* Fixed Footer with Payment Methods and Return Button */}
        {hasItemsToReturn && (
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700 border-t border-gray-200 dark:border-gray-600 flex-shrink-0">
            {/* Return outcome (phase-17 §2c, revised 2026-08-15): where does the
                returned value go? Only offered when something is actually `available`
                - money received, minus whatever is still needed to cover the rest of
                this invoice (get_available_for_cash_or_credit in hd/returns.py). An
                unpaid original, or a partial return that doesn't clear more than the
                invoice's paid-for portion, has nothing safe to hand out (refund = $0,
                store credit = $0) - it just reduces the bill automatically, no chooser
                shown. This is reactive: increasing the return quantity can make cash/
                credit become available (a bigger return is more likely to fully cover
                what's still owed), so the chooser can appear as items are added. */}
            <div className="mb-4">
              {available > 0 ? (
                <>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                    Settle Return As
                  </h3>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <button
                      type="button"
                      onClick={() => setOutcome("refund")}
                      title={`Up to ${formatCurrencyWithSymbol(available, currency)} is available to refund`}
                      className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                        outcome === "refund"
                          ? "border-orange-500 bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
                          : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600"
                      }`}
                    >
                      Refund
                      <span className="block text-xs font-normal">cash / bank back</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutcome("store_credit")}
                      title={`Up to ${formatCurrencyWithSymbol(available, currency)} can become store credit`}
                      className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                        outcome === "store_credit"
                          ? "border-orange-500 bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
                          : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600"
                      }`}
                    >
                      Store Credit
                      <span className="block text-xs font-normal">use on other invoices</span>
                    </button>
                  </div>
                </>
              ) : (
                <div className="mb-3 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-4 py-3">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {refundable <= 0
                      ? "Nothing was paid on this invoice."
                      : "The amount received on this invoice is needed to cover its remaining balance."}
                  </p>
                  <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
                    This return reduces the invoice's outstanding by{" "}
                    {formatCurrencyWithSymbol(totalReturnAmount, currency)} - no refund, no store
                    credit{refundable <= 0 ? ", since no money ever changed hands." : "."}
                  </p>
                </div>
              )}

              {available > 0 && (effectiveOutcome === "refund" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Payment Method Selection */}
                  <div>
                    <select
                      value={selectedPaymentMethod}
                      onChange={(e) => setSelectedPaymentMethod(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-beveren-500 focus:border-beveren-500 transition-colors"
                      disabled={paymentModesLoading}
                    >
                      {paymentModesLoading ? (
                        <option>Loading payment methods...</option>
                      ) : (
                        <>
                          <option value="">{""}</option>
                          {paymentModes.map((mode) => {
                            const val = mode.mode_of_payment;
                            return (
                              <option key={val} value={val}>
                                {val}
                              </option>
                            );
                          })}
                        </>
                      )}
                    </select>
                  </div>

                  {/* Refund amount - read-only: always the value of the returned items,
                      capped at what's available. Change quantities to change it. */}
                  <div>
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 dark:text-gray-400 text-sm">
                        {currencySymbol}
                      </span>
                      <input
                        type="number"
                        value={returnAmount}
                        readOnly
                        className="w-full pl-8 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-white text-right text-lg font-semibold cursor-default"
                        placeholder="0.00"
                      />
                    </div>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 text-right">
                      Refund equals the returned items' value (max {formatCurrencyWithSymbol(available, currency)}).
                      Reduce return quantities to refund less.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {totalReturnAmount > available
                    ? // Partial return where the available slice is smaller than the
                      // return's full value - the rest settles this invoice's own
                      // balance instead of floating (server does this automatically
                      // after submit).
                      `No money moves. Only ${formatCurrencyWithSymbol(
                        available,
                        currency
                      )} becomes spendable store credit - the remaining ${formatCurrencyWithSymbol(
                        totalReturnAmount - available,
                        currency
                      )} settles this invoice's own balance instead.`
                    : "No money moves. The returned value stays as the customer's store credit and can be applied to their other invoices."}
                </p>
              ))}
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <div className="flex items-center space-x-2">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span>
                    {returnItems.filter(item => (item.return_qty || 0) > 0).length} item(s) selected for return
                  </span>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitReturn}
                  disabled={!hasItemsToReturn || isLoading || loadingReturnData}
                  className={`px-6 py-3 rounded-lg font-semibold text-base transition-colors shadow-lg ${
                    hasItemsToReturn && !isLoading && !loadingReturnData
                      ? 'bg-orange-600 text-white hover:bg-orange-700 hover:shadow-xl'
                      : 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                  }`}
                >
                  {isLoading ? 'Processing Return...' : 'Process Return'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
