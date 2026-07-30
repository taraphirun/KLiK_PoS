import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MapPin,
  RefreshCcw,
  Search,
  Truck,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "react-toastify";
import { useNavigate } from "react-router-dom";
import BottomNavigation from "../components/BottomNavigation";
import {
  confirmDeliveryMatch,
  getDeliveryReports,
  rejectDeliveryMatch,
  rematchDeliveryReport,
  type DeliveryReport,
} from "../services/delivery";
import { getOutstandingSalesInvoices, type OutstandingSalesInvoice } from "../services/paymentEntry";
import { formatCurrencyWithSymbol } from "../utils/currency";

type QueueTab = "pending" | "history";

const PENDING_STATUSES = "Unmatched,Suggested";
const HISTORY_STATUSES = "Confirmed,Rejected";

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  const date = new Date(value.replace(" ", "T"));
  if (isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function confidenceBadgeClass(confidence?: number): string {
  const value = confidence || 0;
  if (value >= 0.9) return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
  if (value >= 0.7) return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "Confirmed":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "Rejected":
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    case "Suggested":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300";
  }
}

interface RematchPickerProps {
  reportName: string;
  onCancel: () => void;
  onMatched: (invoiceName: string) => void;
}

function RematchPicker({ reportName, onCancel, onMatched }: RematchPickerProps) {
  const [search, setSearch] = useState("");
  const [invoices, setInvoices] = useState<OutstandingSalesInvoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      try {
        const response = await getOutstandingSalesInvoices(search, 0, 20);
        if (!isCurrent) return;
        setInvoices(response.data || []);
      } catch {
        if (isCurrent) setInvoices([]);
      } finally {
        if (isCurrent) setIsLoading(false);
      }
    }, search ? 300 : 0);

    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  const handlePick = async (invoiceName: string) => {
    setIsSubmitting(true);
    try {
      const result = await rematchDeliveryReport(reportName, invoiceName);
      if (!result.success) throw new Error("Re-match failed");
      toast.success(`Re-matched to ${invoiceName}`);
      onMatched(invoiceName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to re-match");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Pick an invoice</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          <X size={16} />
        </button>
      </div>
      <div className="relative mb-2">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search invoice or customer"
          className="w-full rounded-md border border-gray-300 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
      </div>
      <div className="max-h-56 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700">
        {isLoading ? (
          <div className="flex items-center gap-2 p-3 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading invoices...
          </div>
        ) : invoices.length === 0 ? (
          <div className="p-3 text-sm text-gray-500 dark:text-gray-400">No outstanding invoices found.</div>
        ) : (
          invoices.map((invoice) => (
            <button
              key={invoice.name}
              type="button"
              disabled={isSubmitting}
              onClick={() => handlePick(invoice.name)}
              className="flex w-full items-center justify-between px-2 py-2 text-left text-sm hover:bg-white disabled:opacity-50 dark:hover:bg-gray-800"
            >
              <span className="min-w-0 truncate text-gray-900 dark:text-white">
                {invoice.name}
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {invoice.customer_name || invoice.customer}
                </span>
              </span>
              <span className="ml-2 shrink-0 font-medium text-gray-700 dark:text-gray-300">
                {formatCurrencyWithSymbol(invoice.outstanding_amount, invoice.currency)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

interface ReportCardProps {
  report: DeliveryReport;
  onChanged: () => void;
}

function ReportCard({ report, onChanged }: ReportCardProps) {
  const navigate = useNavigate();
  const [showRematch, setShowRematch] = useState(false);
  const [amountCollected, setAmountCollected] = useState(String(report.amount_collected || ""));
  const [markPaid, setMarkPaid] = useState(report.payment_status !== "Unpaid");
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  const isResolved = report.reconciliation_status === "Confirmed" || report.reconciliation_status === "Rejected";
  const canConfirm = Boolean(report.matched_invoice) && !isResolved;

  const handleConfirm = async () => {
    if (report.payment_status === "Partial" && markPaid) {
      const amount = Number(amountCollected);
      if (!amount || amount <= 0) {
        toast.error("Enter the amount collected before confirming a partial payment.");
        return;
      }
    }

    setIsConfirming(true);
    try {
      const amount = report.payment_status === "Partial" && markPaid ? Number(amountCollected) : undefined;
      const result = await confirmDeliveryMatch(report.name, undefined, markPaid, amount);
      if (!result.success) throw new Error(result.message || "Confirm failed");
      toast.success(
        result.payment_entry
          ? `Confirmed and posted payment ${result.payment_entry}`
          : "Delivery confirmed"
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to confirm delivery");
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReject = async () => {
    setIsRejecting(true);
    try {
      const result = await rejectDeliveryMatch(report.name, "Rejected from reconciliation queue");
      if (!result.success) throw new Error("Reject failed");
      toast.success("Delivery report rejected");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reject delivery report");
    } finally {
      setIsRejecting(false);
    }
  };

  const mapsUrl =
    report.gps_latitude && report.gps_longitude
      ? `https://www.google.com/maps?q=${report.gps_latitude},${report.gps_longitude}`
      : null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-white">
              {report.delivery_driver || "Unknown driver"}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(report.reconciliation_status)}`}>
              {report.reconciliation_status}
            </span>
          </div>
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {formatTimestamp(report.delivery_timestamp || report.creation)}
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 inline-flex items-center gap-1 text-beveren-600 hover:underline dark:text-beveren-400"
              >
                <MapPin size={12} /> Map
              </a>
            )}
          </div>
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Reported invoice: <span className="font-medium text-gray-700 dark:text-gray-300">{report.reported_invoice_no || "—"}</span>
            {" · "}
            {report.completion_status} delivery, {report.payment_status} payment
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-md bg-gray-50 p-3 dark:bg-gray-900">
        {report.matched_invoice ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => navigate(`/invoice/${report.matched_invoice}`)}
                className="font-medium text-beveren-600 hover:underline dark:text-beveren-400"
              >
                {report.matched_invoice}
              </button>
              {report.match_notes && (
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{report.match_notes}</div>
              )}
            </div>
            {typeof report.match_confidence === "number" && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${confidenceBadgeClass(report.match_confidence)}`}>
                {Math.round((report.match_confidence || 0) * 100)}% confidence
              </span>
            )}
          </div>
        ) : (
          <div className="text-sm text-gray-500 dark:text-gray-400">No matching invoice found.</div>
        )}

        {showRematch && !isResolved && (
          <RematchPicker
            reportName={report.name}
            onCancel={() => setShowRematch(false)}
            onMatched={() => {
              setShowRematch(false);
              onChanged();
            }}
          />
        )}
      </div>

      {!isResolved && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {report.payment_status === "Partial" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 dark:text-gray-400">Amount collected</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amountCollected}
                onChange={(event) => setAmountCollected(event.target.value)}
                className="w-28 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
          )}

          {report.payment_status !== "Unpaid" && (
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={markPaid}
                onChange={(event) => setMarkPaid(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-beveren-600 focus:ring-beveren-500"
              />
              Mark as paid
            </label>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowRematch((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              <RefreshCcw size={14} />
              Re-match
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={isRejecting}
              className="inline-flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              {isRejecting ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
              Reject
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm || isConfirming}
              className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isConfirming ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DeliveryReconciliationPage() {
  const [activeTab, setActiveTab] = useState<QueueTab>("pending");
  const [search, setSearch] = useState("");
  const [reports, setReports] = useState<DeliveryReport[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const status = activeTab === "pending" ? PENDING_STATUSES : HISTORY_STATUSES;
      const response = await getDeliveryReports(status, search);
      setReports(response.data || []);
      setTotalCount(response.total_count || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch delivery reports");
      setReports([]);
      setTotalCount(0);
    } finally {
      setIsLoading(false);
    }
  }, [activeTab, search]);

  useEffect(() => {
    const timer = window.setTimeout(fetchReports, search ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [fetchReports, search]);

  return (
    <div className="min-h-screen bg-gray-50 pb-20 dark:bg-gray-900 lg:ml-20 lg:pb-12">
      <div className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Truck className="text-beveren-600 dark:text-beveren-400" size={24} />
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Delivery Reconciliation</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {totalCount} {activeTab === "pending" ? "pending" : "resolved"} report
                  {totalCount === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-800">
              <button
                type="button"
                onClick={() => setActiveTab("pending")}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  activeTab === "pending"
                    ? "bg-white text-beveren-700 shadow-sm dark:bg-gray-900 dark:text-beveren-300"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                }`}
              >
                Pending Queue
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("history")}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  activeTab === "history"
                    ? "bg-white text-beveren-700 shadow-sm dark:bg-gray-900 dark:text-beveren-300"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                }`}
              >
                History
              </button>
            </div>
          </div>
        </div>
      </div>

      <main className="space-y-4 px-4 py-6 sm:px-6">
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search driver, invoice, or delivery ID"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-6 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            <Loader2 size={18} className="animate-spin" /> Loading delivery reports...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        ) : reports.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            {activeTab === "pending" ? "No pending delivery reports." : "No resolved delivery reports yet."}
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map((report) => (
              <ReportCard key={report.name} report={report} onChanged={fetchReports} />
            ))}
          </div>
        )}
      </main>

      <div className="lg:hidden">
        <BottomNavigation />
      </div>
    </div>
  );
}
