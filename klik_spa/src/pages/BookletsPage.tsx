import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  BookOpen,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "react-toastify";
import BottomNavigation from "../components/BottomNavigation";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { CustomerSearchSection } from "../components/order/CustomerSearchSection";
import type { Customer } from "../types/customer";
import {
  closeBooklet,
  deleteBooklet,
  getBookletSettings,
  getBookletStatus,
  getBooklets,
  updateBookletSettings,
  upsertBooklet,
  type BookletSettings,
  type BookletStatus,
  type DailyPageRow,
  type DailyPageStatus,
  type DeliveryBooklet,
} from "../services/booklet";

type StatusFilter = "all" | BookletStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "Active", label: "Active" },
  { value: "Stalled", label: "Stalled" },
  { value: "Ready for Review", label: "Ready for Review" },
  { value: "Closed", label: "Closed" },
];

function statusBadgeClass(status: BookletStatus): string {
  switch (status) {
    case "Active":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "Stalled":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 animate-pulse";
    case "Ready for Review":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-400";
  }
}

/** Same palette as DailyReconciliationPage's statusBadgeClass, for a DailyPageStatus row instead
 * of a BookletStatus - kept as a small local duplicate rather than a shared import since the two
 * pages otherwise have no coupling. */
function pageStatusBadgeClass(status: DailyPageStatus): string {
  switch (status) {
    case "Delivered":
    case "Self Pickup":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "Partially Delivered":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "Void":
      return "bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-400";
    case "Pending Fulfillment":
    case "Reported, No Invoice":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
    default:
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
  }
}

interface BookletFormState {
  name?: string;
  booklet_number: string;
  start_number: string;
  end_number: string;
  is_vip: boolean;
  customer: Customer | null;
}

const EMPTY_FORM: BookletFormState = {
  booklet_number: "",
  start_number: "",
  end_number: "",
  is_vip: false,
  customer: null,
};

function pagesFromNumber(bookletNumber: string, pagesPerBooklet: number): { start: string; end: string } | null {
  const num = Number(bookletNumber);
  if (!Number.isInteger(num) || num <= 0) return null;
  return { start: String((num - 1) * pagesPerBooklet + 1), end: String(num * pagesPerBooklet) };
}

function BookletFormDialog({
  initial,
  pagesPerBooklet,
  onCancel,
  onSaved,
}: {
  initial: BookletFormState;
  pagesPerBooklet: number;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<BookletFormState>(initial);
  const [rangeTouched, setRangeTouched] = useState(Boolean(initial.name));
  const [isSaving, setIsSaving] = useState(false);
  const isEdit = Boolean(initial.name);

  const handleNumberChange = (value: string) => {
    setForm((f) => ({ ...f, booklet_number: value }));
    if (!rangeTouched) {
      const suggested = pagesFromNumber(value, pagesPerBooklet);
      if (suggested) setForm((f) => ({ ...f, booklet_number: value, start_number: suggested.start, end_number: suggested.end }));
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.booklet_number.trim()) {
      toast.error("Booklet number is required.");
      return;
    }
    if (!form.start_number || !form.end_number) {
      toast.error("Start and end number are required.");
      return;
    }
    if (form.is_vip && !form.customer) {
      toast.error("A VIP booklet needs a customer.");
      return;
    }

    setIsSaving(true);
    try {
      const result = await upsertBooklet({
        name: form.name,
        booklet_number: form.booklet_number.trim(),
        start_number: Number(form.start_number),
        end_number: Number(form.end_number),
        is_vip: form.is_vip,
        customer: form.is_vip ? form.customer?.id : null,
      });
      if (!result.success) throw new Error(result.message || "Failed to save booklet");
      toast.success(isEdit ? "Booklet updated" : "Booklet created");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save booklet");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEdit ? "Edit Booklet" : "New Booklet"}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Booklet Number
            </label>
            <input
              type="text"
              value={form.booklet_number}
              onChange={(event) => handleNumberChange(event.target.value)}
              placeholder="e.g. 25 or VIP-1"
              autoFocus
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Start Number
              </label>
              <input
                type="number"
                value={form.start_number}
                onChange={(event) => {
                  setRangeTouched(true);
                  setForm((f) => ({ ...f, start_number: event.target.value }));
                }}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                End Number
              </label>
              <input
                type="number"
                value={form.end_number}
                onChange={(event) => {
                  setRangeTouched(true);
                  setForm((f) => ({ ...f, end_number: event.target.value }));
                }}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={form.is_vip}
              onChange={(event) => setForm((f) => ({ ...f, is_vip: event.target.checked }))}
              className="rounded border-gray-300 text-beveren-600 focus:ring-beveren-500"
            />
            VIP Booklet (dedicated to one customer)
          </label>
          {form.is_vip && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Customer
              </label>
              <CustomerSearchSection
                selectedCustomer={form.customer}
                onCustomerSelect={(customer) => setForm((f) => ({ ...f, customer }))}
                onCustomerClear={() => setForm((f) => ({ ...f, customer: null }))}
              />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-beveren-700 disabled:opacity-50"
            >
              {isSaving && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SettingsDialog({
  initial,
  onCancel,
  onSaved,
}: {
  initial: BookletSettings;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      const result = await updateBookletSettings(form);
      if (!result.success) throw new Error(result.message || "Failed to save settings");
      toast.success("Booklet settings updated");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Booklet Settings</h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Pages Per Booklet
            </label>
            <input
              type="number"
              value={form.pages_per_booklet}
              onChange={(event) => setForm((f) => ({ ...f, pages_per_booklet: Number(event.target.value) }))}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Normal Booklet Stall Days
            </label>
            <input
              type="number"
              value={form.normal_booklet_stall_days}
              onChange={(event) =>
                setForm((f) => ({ ...f, normal_booklet_stall_days: Number(event.target.value) }))
              }
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              VIP Booklet Stall Days
            </label>
            <input
              type="number"
              value={form.vip_booklet_stall_days}
              onChange={(event) => setForm((f) => ({ ...f, vip_booklet_stall_days: Number(event.target.value) }))}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-beveren-700 disabled:opacity-50"
            >
              {isSaving && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function BookletRow({ booklet, onChanged }: { booklet: DeliveryBooklet; onChanged: () => void }) {
  const [pageStatus, setPageStatus] = useState<DailyPageRow[] | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const toggleStatus = async () => {
    if (pageStatus !== null) {
      setPageStatus(null);
      return;
    }
    setIsLoadingStatus(true);
    try {
      const result = await getBookletStatus(booklet.name);
      if (!result.success) throw new Error(result.message || "Failed to load booklet status");
      setPageStatus(result.data || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load booklet status");
    } finally {
      setIsLoadingStatus(false);
    }
  };

  const handleClose = async () => {
    setIsBusy(true);
    try {
      const result = await closeBooklet(booklet.name);
      if (!result.success) throw new Error(result.message || "Failed to close booklet");
      toast.success(`Booklet #${booklet.booklet_number} closed`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close booklet");
    } finally {
      setIsBusy(false);
      setConfirmClose(false);
    }
  };

  const handleDelete = async () => {
    setIsBusy(true);
    try {
      const result = await deleteBooklet(booklet.name);
      if (!result.success) throw new Error(result.message || "Failed to delete booklet");
      toast.success(`Booklet #${booklet.booklet_number} deleted`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete booklet");
    } finally {
      setIsBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-white">#{booklet.booklet_number}</span>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              ({booklet.start_number}-{booklet.end_number})
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(booklet.status)}`}>
              {booklet.status}
            </span>
            {Boolean(booklet.is_vip) && (
              <span className="rounded-full bg-beveren-100 px-2 py-0.5 text-xs font-bold uppercase text-beveren-700 dark:bg-beveren-900/30 dark:text-beveren-300">
                VIP
              </span>
            )}
          </div>
          {Boolean(booklet.is_vip) && booklet.customer_name && (
            <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{booklet.customer_name}</div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleStatus}
            disabled={isLoadingStatus}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {isLoadingStatus && <Loader2 size={14} className="animate-spin" />}
            {pageStatus === null ? "Check Status" : "Hide Status"}
          </button>
          <button
            type="button"
            onClick={() => setShowEdit(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <Pencil size={14} />
          </button>
          {booklet.status !== "Closed" && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setConfirmClose(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <CheckCircle2 size={14} />
              Close
            </button>
          )}
          <button
            type="button"
            disabled={isBusy}
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-red-300 px-2 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {pageStatus !== null && (
        <div className="mt-3 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
              <tr>
                <th className="px-3 py-1.5 font-medium">#</th>
                <th className="px-3 py-1.5 font-medium">Status</th>
                <th className="px-3 py-1.5 font-medium">Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-800">
              {pageStatus.map((row) => (
                <tr key={row.number}>
                  <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white">{row.number}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pageStatusBadgeClass(row.status)}`}>
                      {row.status}
                    </span>
                    {row.status === "Void" && row.void_reason && (
                      <span className="ml-1 text-xs text-gray-400">({row.void_reason})</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">
                    {row.invoice || row.delivery_report || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showEdit && (
        <BookletFormDialog
          initial={{
            name: booklet.name,
            booklet_number: booklet.booklet_number,
            start_number: String(booklet.start_number),
            end_number: String(booklet.end_number),
            is_vip: Boolean(booklet.is_vip),
            customer:
              booklet.is_vip && booklet.customer
                ? ({ id: booklet.customer, name: booklet.customer_name || booklet.customer, customerName: booklet.customer_name } as Customer)
                : null,
          }}
          pagesPerBooklet={50}
          onCancel={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={handleClose}
        title="Close booklet?"
        message={`This marks booklet #${booklet.booklet_number} as fully reconciled and removes it from the stall/ready-for-review checks.`}
        confirmText="Close Booklet"
        confirmButtonClass="bg-blue-600 hover:bg-blue-700 text-white"
      />
      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete booklet?"
        message={`This permanently removes booklet #${booklet.booklet_number}. Only possible if no Delivery Report is linked to it yet.`}
        confirmText="Delete"
        confirmButtonClass="bg-red-600 hover:bg-red-700 text-white"
      />
    </div>
  );
}

interface BookletPrefillState {
  bookletNumber?: string;
  startNumber?: number;
  endNumber?: number;
}

export default function BookletsPage() {
  const location = useLocation();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [booklets, setBooklets] = useState<DeliveryBooklet[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formInitial, setFormInitial] = useState<BookletFormState>(EMPTY_FORM);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<BookletSettings | null>(null);

  // Arrived via the Daily Reconciliation page's "Register this booklet" shortcut (Module 17
  // follow-up, 2026-08-02) - prefills the New Booklet form with the computed range rather than
  // making staff retype it. Only reads location.state once on mount.
  useEffect(() => {
    const prefill = location.state as BookletPrefillState | undefined;
    if (prefill?.bookletNumber) {
      setFormInitial({
        booklet_number: prefill.bookletNumber,
        start_number: String(prefill.startNumber ?? ""),
        end_number: String(prefill.endNumber ?? ""),
        is_vip: false,
        customer: null,
      });
      setShowForm(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchBooklets = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const status = statusFilter === "all" ? undefined : statusFilter;
      const response = await getBooklets(status, search);
      setBooklets(response.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch booklets");
      setBooklets([]);
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    const timer = window.setTimeout(fetchBooklets, search ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [fetchBooklets, search]);

  useEffect(() => {
    getBookletSettings().then(setSettings).catch(() => setSettings(null));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 pb-20 dark:bg-gray-900 lg:ml-20 lg:pb-12">
      <div className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="text-beveren-600 dark:text-beveren-400" size={24} />
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Delivery Booklets</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {booklets.length} booklet{booklets.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <SettingsIcon size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setFormInitial(EMPTY_FORM);
                  setShowForm(true);
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-2 text-sm font-medium text-white hover:bg-beveren-700"
              >
                <Plus size={16} />
                New Booklet
              </button>
            </div>
          </div>
        </div>
      </div>

      <main className="space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative max-w-xl flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search booklet number"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>
          <div className="inline-flex flex-wrap rounded-lg border border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-800">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setStatusFilter(filter.value)}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  statusFilter === filter.value
                    ? "bg-white text-beveren-700 shadow-sm dark:bg-gray-900 dark:text-beveren-300"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-6 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            <Loader2 size={18} className="animate-spin" /> Loading booklets...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        ) : booklets.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            No booklets registered.
          </div>
        ) : (
          <div className="space-y-3">
            {booklets.map((booklet) => (
              <BookletRow key={booklet.name} booklet={booklet} onChanged={fetchBooklets} />
            ))}
          </div>
        )}
      </main>

      {showForm && (
        <BookletFormDialog
          initial={formInitial}
          pagesPerBooklet={settings?.pages_per_booklet || 50}
          onCancel={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            fetchBooklets();
          }}
        />
      )}

      {showSettings && settings && (
        <SettingsDialog
          initial={settings}
          onCancel={() => setShowSettings(false)}
          onSaved={() => {
            setShowSettings(false);
            getBookletSettings().then(setSettings).catch(() => {});
          }}
        />
      )}

      <div className="lg:hidden">
        <BottomNavigation />
      </div>
    </div>
  );
}
