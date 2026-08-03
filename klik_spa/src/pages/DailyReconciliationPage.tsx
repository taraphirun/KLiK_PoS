import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  BookOpen,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  FilePlus2,
  Info,
  Link2,
  Loader2,
  Lock,
  RotateCcw,
  Truck,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "react-toastify";
import { useNavigate } from "react-router-dom";
import BottomNavigation from "../components/BottomNavigation";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { useUserInfo } from "../hooks/useUserInfo";
import CreateInvoiceFromReportModal from "../components/delivery/CreateInvoiceFromReportModal";
import CreateInvoiceForPageModal from "../components/delivery/CreateInvoiceForPageModal";
import type { DeliveryReport } from "../services/delivery";
import { setManualDeliveryStatus } from "../services/delivery";
import {
  clearRequestedDeliveryDate,
  closeDailyReconciliation,
  getDailyReconciliation,
  linkInvoiceToPage,
  markPageVoid,
  reopenDailyReconciliation,
  setRequestedDeliveryDate,
  unlinkInvoicePage,
  unmarkPageVoid,
  type DailyGroup,
  type DailyPageRow,
  type DailyPageStatus,
  type DailyReconciliation,
  type ScheduledDeliveryRow,
  type UnreferencedInvoice,
} from "../services/booklet";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function statusBadgeClass(status: DailyPageStatus): string {
  switch (status) {
    case "Delivered":
    case "Self Pickup":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "Partially Delivered":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "Scheduled":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300";
    case "Void":
      return "bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-400";
    case "Pending Fulfillment":
    case "Reported, No Invoice":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
    default:
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
  }
}

function nextDayIso(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface SetDeliveryDateDialogProps {
  invoiceName: string;
  label: string;
  minDate: string;
  initialValue?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Date-picker modal for the "Set/Change Delivery Date" action (2026-08-03 follow-up) - a plain
 * ConfirmDialog can't collect a date, so this mirrors LinkPagePicker's own portal-modal shape
 * instead (the date input doubles as the only thing to review before confirming). */
function SetDeliveryDateDialog({ invoiceName, label, minDate, initialValue, onClose, onSaved }: SetDeliveryDateDialogProps) {
  const [value, setValue] = useState(initialValue || minDate);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSave = async () => {
    if (!value) return;
    setIsSubmitting(true);
    try {
      const result = await setRequestedDeliveryDate(invoiceName, value);
      if (!result.success) throw new Error(result.message || "Failed to set delivery date");
      toast.success(`${label} scheduled for delivery on ${value}`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set delivery date");
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Set Delivery Date</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          {label} was purchased today but asked to be delivered later - pick the date it's actually due.
        </p>
        <input
          type="date"
          value={value}
          min={minDate}
          onChange={(event) => setValue(event.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSubmitting || !value}
            onClick={handleSave}
            className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface RowActionsProps {
  row: DailyPageRow;
  date: string;
  readOnly: boolean;
  onChanged: () => void;
  onCreateInvoiceForPage: (row: DailyPageRow) => void;
  onCreateInvoiceFromReport: (row: DailyPageRow) => void;
}

type ConfirmKind = "self-pickup" | "delivered" | "unlink" | "void" | "unvoid" | "clear-date";

function RowActions({ row, date, readOnly, onChanged, onCreateInvoiceForPage, onCreateInvoiceFromReport }: RowActionsProps) {
  const [isBusy, setIsBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);
  const [showDateDialog, setShowDateDialog] = useState(false);

  const runManual = async (status: "Delivered" | "Self Pickup") => {
    if (!row.invoice) return;
    setIsBusy(true);
    try {
      const result = await setManualDeliveryStatus(row.invoice, status);
      if (!result.success) throw new Error(result.message || "Failed to update");
      toast.success(`Page ${row.number} marked ${status}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setIsBusy(false);
      setConfirmKind(null);
    }
  };

  const runUnlink = async () => {
    if (!row.invoice) return;
    setIsBusy(true);
    try {
      const result = await unlinkInvoicePage(row.invoice);
      if (!result.success) throw new Error(result.message || "Failed to unlink");
      toast.success(`Page ${row.number} unlinked`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to unlink");
    } finally {
      setIsBusy(false);
      setConfirmKind(null);
    }
  };

  const runToggleVoid = async () => {
    setIsBusy(true);
    try {
      const result =
        row.status === "Void" ? await unmarkPageVoid(row.number) : await markPageVoid(row.number);
      if (!result.success) throw new Error(result.message || "Failed to update");
      toast.success(row.status === "Void" ? `Page ${row.number} unvoided` : `Page ${row.number} marked void`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setIsBusy(false);
      setConfirmKind(null);
    }
  };

  const runClearDate = async () => {
    if (!row.invoice) return;
    setIsBusy(true);
    try {
      const result = await clearRequestedDeliveryDate(row.invoice);
      if (!result.success) throw new Error(result.message || "Failed to clear delivery date");
      toast.success(`Page ${row.number}'s scheduled delivery date cleared`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear delivery date");
    } finally {
      setIsBusy(false);
      setConfirmKind(null);
    }
  };

  const confirmProps: Record<
    ConfirmKind,
    { title: string; message: string; confirmText: string; confirmButtonClass: string; onConfirm: () => void }
  > = {
    "self-pickup": {
      title: "Confirm self-pickup?",
      message: `Mark page ${row.number} (${row.invoice}) as picked up by the customer.`,
      confirmText: "Confirm Self-Pickup",
      confirmButtonClass: "bg-beveren-600 hover:bg-beveren-700 text-white",
      onConfirm: () => runManual("Self Pickup"),
    },
    delivered: {
      title: "Confirm delivered?",
      message: `Mark page ${row.number} (${row.invoice}) as delivered. No bot report exists for this - this is a manual override.`,
      confirmText: "Confirm Delivered",
      confirmButtonClass: "bg-beveren-600 hover:bg-beveren-700 text-white",
      onConfirm: () => runManual("Delivered"),
    },
    unlink: {
      title: "Unlink page reference?",
      message: `Remove page ${row.number} from ${row.invoice} - the page goes back to Unresolved and the invoice back to the unreferenced list.`,
      confirmText: "Unlink",
      confirmButtonClass: "bg-red-600 hover:bg-red-700 text-white",
      onConfirm: runUnlink,
    },
    void: {
      title: "Mark page void?",
      message: `Mark page ${row.number} void - confirming this paper page never resulted in a real sale.`,
      confirmText: "Mark Void",
      confirmButtonClass: "bg-amber-600 hover:bg-amber-700 text-white",
      onConfirm: runToggleVoid,
    },
    unvoid: {
      title: "Unvoid page?",
      message: `Undo the void mark on page ${row.number}.`,
      confirmText: "Unvoid",
      confirmButtonClass: "bg-beveren-600 hover:bg-beveren-700 text-white",
      onConfirm: runToggleVoid,
    },
    "clear-date": {
      title: "Clear scheduled delivery date?",
      message: `Page ${row.number} (${row.invoice}) goes back to Pending Fulfillment on ${date}, un-scheduled.`,
      confirmText: "Clear Date",
      confirmButtonClass: "bg-red-600 hover:bg-red-700 text-white",
      onConfirm: runClearDate,
    },
  };

  const activeConfirm = confirmKind ? confirmProps[confirmKind] : null;

  const confirmDialog = activeConfirm && (
    <ConfirmDialog
      isOpen
      onClose={() => setConfirmKind(null)}
      onConfirm={activeConfirm.onConfirm}
      title={activeConfirm.title}
      message={activeConfirm.message}
      confirmText={activeConfirm.confirmText}
      confirmButtonClass={activeConfirm.confirmButtonClass}
    />
  );

  const dateDialog = showDateDialog && row.invoice && (
    <SetDeliveryDateDialog
      invoiceName={row.invoice}
      label={`Page ${row.number} (${row.invoice})`}
      minDate={nextDayIso(date)}
      initialValue={row.requested_delivery_date}
      onClose={() => setShowDateDialog(false)}
      onSaved={() => {
        setShowDateDialog(false);
        onChanged();
      }}
    />
  );

  if (readOnly) return null;

  if (row.status === "Scheduled") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setShowDateDialog(true)}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <CalendarClock size={12} />
          Change Date
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setConfirmKind("clear-date")}
          className="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          Clear Date
        </button>
        {confirmDialog}
        {dateDialog}
      </div>
    );
  }

  if (row.status === "Pending Fulfillment") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setConfirmKind("self-pickup")}
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          Confirm Self-Pickup
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setConfirmKind("delivered")}
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          Confirm Delivered
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setShowDateDialog(true)}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <CalendarClock size={12} />
          Set Delivery Date
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setConfirmKind("unlink")}
          className="rounded-lg border border-red-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          Unlink
        </button>
        {confirmDialog}
        {dateDialog}
      </div>
    );
  }

  if (row.status === "Reported, No Invoice") {
    return (
      <button
        type="button"
        onClick={() => onCreateInvoiceFromReport(row)}
        className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        <FilePlus2 size={12} />
        Create Invoice
      </button>
    );
  }

  if (row.status === "Unresolved") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onCreateInvoiceForPage(row)}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <FilePlus2 size={12} />
          Create Invoice
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setConfirmKind("void")}
          className="rounded-lg border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
        >
          Mark Void
        </button>
        {confirmDialog}
      </div>
    );
  }

  if (row.status === "Void") {
    return (
      <>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => setConfirmKind("unvoid")}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <Undo2 size={12} />
          Unvoid
        </button>
        {confirmDialog}
      </>
    );
  }

  return null;
}

interface LinkPagePickerProps {
  invoice: UnreferencedInvoice;
  date: string;
  unresolvedNumbers: number[];
  onClose: () => void;
  onLinked: () => void;
}

/** Attaches an unreferenced invoice to an Unresolved page number - the picker itself doubles as
 * the confirmation step (an explicit "Link to Page N" click after reviewing the choice), rather
 * than a separate picker-then-ConfirmDialog pair. */
function LinkPagePicker({ invoice, date, unresolvedNumbers, onClose, onLinked }: LinkPagePickerProps) {
  const [selected, setSelected] = useState<number | "">(unresolvedNumbers[0] ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleLink = async () => {
    if (selected === "") return;
    setIsSubmitting(true);
    try {
      const result = await linkInvoiceToPage(invoice.name, Number(selected), date);
      if (!result.success) throw new Error(result.message || "Failed to link");
      toast.success(`${invoice.name} linked to page ${selected}`);
      onLinked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link");
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Link to Booklet Page</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Attach <span className="font-medium text-gray-700 dark:text-gray-300">{invoice.name}</span> to
          an Unresolved page number for {date}.
        </p>
        {unresolvedNumbers.length === 0 ? (
          <p className="text-sm italic text-gray-500 dark:text-gray-400">No Unresolved pages for this date.</p>
        ) : (
          <select
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
          >
            {unresolvedNumbers.map((n) => (
              <option key={n} value={n}>
                Page {n}
              </option>
            ))}
          </select>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSubmitting || selected === ""}
            onClick={handleLink}
            className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting && <Loader2 size={14} className="animate-spin" />}
            {selected === "" ? "Link" : `Link to Page ${selected}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface UnreferencedInvoiceRowActionsProps {
  invoice: UnreferencedInvoice;
  unresolvedNumbers: number[];
  date: string;
  readOnly: boolean;
  onChanged: () => void;
}

function UnreferencedInvoiceRowActions({ invoice, unresolvedNumbers, date, readOnly, onChanged }: UnreferencedInvoiceRowActionsProps) {
  const [isBusy, setIsBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState<"self-pickup" | "delivered" | null>(null);
  const [showLinkPicker, setShowLinkPicker] = useState(false);

  if (readOnly) return null;

  const isPending = invoice.custom_delivery_status === "Pending" || invoice.custom_delivery_status === "Not Delivered";

  const runManual = async (status: "Delivered" | "Self Pickup") => {
    setIsBusy(true);
    try {
      const result = await setManualDeliveryStatus(invoice.name, status);
      if (!result.success) throw new Error(result.message || "Failed to update");
      toast.success(`${invoice.name} marked ${status}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setIsBusy(false);
      setConfirmKind(null);
    }
  };

  const activeConfirm =
    confirmKind === "self-pickup"
      ? {
          title: "Confirm self-pickup?",
          message: `Mark ${invoice.name} as picked up by the customer.`,
          confirmText: "Confirm Self-Pickup",
          onConfirm: () => runManual("Self Pickup"),
        }
      : confirmKind === "delivered"
      ? {
          title: "Confirm delivered?",
          message: `Mark ${invoice.name} as delivered. No bot report exists for this - this is a manual override.`,
          confirmText: "Confirm Delivered",
          onConfirm: () => runManual("Delivered"),
        }
      : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {isPending && (
        <>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => setConfirmKind("self-pickup")}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Confirm Self-Pickup
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => setConfirmKind("delivered")}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Confirm Delivered
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => setShowLinkPicker(true)}
        className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        <Link2 size={12} />
        Link to Page
      </button>

      {activeConfirm && (
        <ConfirmDialog
          isOpen
          onClose={() => setConfirmKind(null)}
          onConfirm={activeConfirm.onConfirm}
          title={activeConfirm.title}
          message={activeConfirm.message}
          confirmText={activeConfirm.confirmText}
          confirmButtonClass="bg-beveren-600 hover:bg-beveren-700 text-white"
        />
      )}

      {showLinkPicker && (
        <LinkPagePicker
          invoice={invoice}
          date={date}
          unresolvedNumbers={unresolvedNumbers}
          onClose={() => setShowLinkPicker(false)}
          onLinked={() => {
            setShowLinkPicker(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

interface BookletGroupCardProps {
  group: DailyGroup;
  date: string;
  readOnly: boolean;
  onChanged: () => void;
  onCreateInvoiceForPage: (row: DailyPageRow) => void;
  onCreateInvoiceFromReport: (row: DailyPageRow) => void;
}

/** One booklet's worth of the checklist (Module 17 follow-up, 2026-08-02) - the whole page used to
 * show one flat table spanning min-to-max across the entire day, which synthesized a huge fake gap
 * whenever two unrelated invoice numbers landed far apart (e.g. 1222 and 2222 on the same day).
 * Now grouped by booklet, each with its own interior span. */
function BookletGroupCard({ group, date, readOnly, onChanged, onCreateInvoiceForPage, onCreateInvoiceFromReport }: BookletGroupCardProps) {
  const navigate = useNavigate();

  const handleRegister = () => {
    navigate("/deliveries/booklets", {
      state: {
        bookletNumber: group.booklet_number,
        startNumber: group.bucket_start,
        endNumber: group.bucket_end,
      },
    });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-gray-900/50">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <BookOpen size={14} className="text-gray-400" />
          Booklet #{group.booklet_number}
          <span className="font-normal text-gray-400">
            (pages {group.start_number}-{group.end_number}
            {(group.start_number !== group.bucket_start || group.end_number !== group.bucket_end) &&
              ` of booklet range ${group.bucket_start}-${group.bucket_end}`}
            )
          </span>
          {!group.is_registered && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              not yet registered
            </span>
          )}
        </div>
        {!group.is_registered && (
          <button
            type="button"
            onClick={handleRegister}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <BookOpen size={12} />
            Register this booklet
          </button>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
          <tr>
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Reference</th>
            <th className="px-4 py-2 font-medium">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-800">
          {group.rows.map((row) => (
            <tr key={row.number}>
              <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{row.number}</td>
              <td className="px-4 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(row.status)}`}>
                  {row.status}
                </span>
                {row.status === "Void" && row.void_reason && (
                  <div className="mt-0.5 text-xs text-gray-400">{row.void_reason}</div>
                )}
                {row.status === "Scheduled" && row.requested_delivery_date && (
                  <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-gray-400">
                    <CalendarClock size={11} /> Delivery on {row.requested_delivery_date}
                  </div>
                )}
              </td>
              <td className="px-4 py-2">
                {row.invoice ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/invoice/${row.invoice}`)}
                    className="text-beveren-600 hover:underline dark:text-beveren-400"
                  >
                    {row.invoice}
                  </button>
                ) : row.delivery_report ? (
                  <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
                    <Truck size={12} /> {row.delivery_report}
                  </span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </td>
              <td className="px-4 py-2">
                <RowActions
                  row={row}
                  date={date}
                  readOnly={readOnly}
                  onChanged={onChanged}
                  onCreateInvoiceForPage={onCreateInvoiceForPage}
                  onCreateInvoiceFromReport={onCreateInvoiceFromReport}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ScheduledDeliveryRowActionsProps {
  row: ScheduledDeliveryRow;
  readOnly: boolean;
  onChanged: () => void;
}

function ScheduledDeliveryRowActions({ row, readOnly, onChanged }: ScheduledDeliveryRowActionsProps) {
  const [isBusy, setIsBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState<"self-pickup" | "delivered" | null>(null);

  if (readOnly) return null;
  if (row.status !== "Pending Fulfillment") return null;

  const runManual = async (status: "Delivered" | "Self Pickup") => {
    setIsBusy(true);
    try {
      const result = await setManualDeliveryStatus(row.invoice, status);
      if (!result.success) throw new Error(result.message || "Failed to update");
      toast.success(`${row.invoice} marked ${status}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setIsBusy(false);
      setConfirmKind(null);
    }
  };

  const activeConfirm =
    confirmKind === "self-pickup"
      ? {
          title: "Confirm self-pickup?",
          message: `Mark ${row.invoice} as picked up by the customer.`,
          confirmText: "Confirm Self-Pickup",
          onConfirm: () => runManual("Self Pickup"),
        }
      : confirmKind === "delivered"
      ? {
          title: "Confirm delivered?",
          message: `Mark ${row.invoice} as delivered. No bot report exists for this - this is a manual override.`,
          confirmText: "Confirm Delivered",
          onConfirm: () => runManual("Delivered"),
        }
      : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={isBusy}
        onClick={() => setConfirmKind("self-pickup")}
        className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        Confirm Self-Pickup
      </button>
      <button
        type="button"
        disabled={isBusy}
        onClick={() => setConfirmKind("delivered")}
        className="rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        Confirm Delivered
      </button>
      {activeConfirm && (
        <ConfirmDialog
          isOpen
          onClose={() => setConfirmKind(null)}
          onConfirm={activeConfirm.onConfirm}
          title={activeConfirm.title}
          message={activeConfirm.message}
          confirmText={activeConfirm.confirmText}
          confirmButtonClass="bg-beveren-600 hover:bg-beveren-700 text-white"
        />
      )}
    </div>
  );
}

interface ScheduledDeliveriesCardProps {
  rows: ScheduledDeliveryRow[];
  readOnly: boolean;
  onChanged: () => void;
}

/** Invoices whose requested delivery date is *this* date (2026-08-03 follow-up) - the paper page
 * itself lives in an earlier date's booklet group (already resolved there as "Scheduled"), but the
 * actual delivery commitment is due today, so it surfaces here too, at the top of the checklist,
 * actionable, and blocks this date's Close Day until really confirmed. Same card chrome as
 * BookletGroupCard, per the user's ask to reuse that grouping UI. */
function ScheduledDeliveriesCard({ rows, readOnly, onChanged }: ScheduledDeliveriesCardProps) {
  const navigate = useNavigate();

  return (
    <div className="overflow-hidden rounded-lg border border-purple-200 dark:border-purple-900">
      <div className="flex items-center gap-2 border-b border-purple-200 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-800 dark:border-purple-900 dark:bg-purple-950/20 dark:text-purple-300">
        <CalendarClock size={14} />
        Scheduled for delivery today ({rows.length})
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
          <tr>
            <th className="px-4 py-2 font-medium">Invoice</th>
            <th className="px-4 py-2 font-medium">Customer</th>
            <th className="px-4 py-2 font-medium">Page</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-800">
          {rows.map((row) => (
            <tr key={row.invoice}>
              <td className="px-4 py-2">
                <button
                  type="button"
                  onClick={() => navigate(`/invoice/${row.invoice}`)}
                  className="text-beveren-600 hover:underline dark:text-beveren-400"
                >
                  {row.invoice}
                </button>
              </td>
              <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{row.customer}</td>
              <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{row.page_number ?? "—"}</td>
              <td className="px-4 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(row.status)}`}>
                  {row.status}
                </span>
              </td>
              <td className="px-4 py-2">
                <ScheduledDeliveryRowActions row={row} readOnly={readOnly} onChanged={onChanged} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DailyReconciliationPage() {
  const navigate = useNavigate();
  const { userInfo } = useUserInfo();
  const isSystemManager = userInfo?.roles?.includes("System Manager") ?? false;

  const [date, setDate] = useState(todayIso());
  const [result, setResult] = useState<DailyReconciliation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isReopening, setIsReopening] = useState(false);
  const [blockingNumbers, setBlockingNumbers] = useState<number[] | null>(null);
  const [blockingInvoices, setBlockingInvoices] = useState<string[] | null>(null);
  const [pageModalRow, setPageModalRow] = useState<DailyPageRow | null>(null);
  const [reportModalRow, setReportModalRow] = useState<DailyPageRow | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setBlockingNumbers(null);
    setBlockingInvoices(null);
    try {
      const response = await getDailyReconciliation(date);
      if (!response.success) throw new Error(response.message || "Failed to load");
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load daily reconciliation");
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const groups = result?.groups || [];
  const allRows = groups.flatMap((g) => g.rows);
  const unresolvedNumbers = allRows.filter((r) => r.status === "Unresolved").map((r) => r.number);
  const scheduledDeliveries = result?.scheduled_deliveries || [];
  const closing = result?.closing;
  const isClosed = closing?.status === "Closed";
  const needsReview = closing?.status === "Needs Re-review";
  // Hides/disables every manual action on the checklist once the day is Closed (user request,
  // 2026-08-03) - re-enabled the moment it's Reopened. "Needs Re-review" deliberately stays
  // actionable: that status exists specifically so staff can address the drift that triggered it,
  // and hiding the actions would make that impossible without a System-Manager-only Reopen first.
  const isReadOnly = isClosed;

  const handleClose = async () => {
    setIsClosing(true);
    setBlockingNumbers(null);
    setBlockingInvoices(null);
    try {
      const res = await closeDailyReconciliation(date);
      if (!res.success) {
        setBlockingNumbers(res.blocking_numbers?.length ? res.blocking_numbers : null);
        setBlockingInvoices(res.blocking_invoices?.length ? res.blocking_invoices : null);
        throw new Error(res.message || "Failed to close");
      }
      toast.success(`${date} closed`);
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close day");
    } finally {
      setIsClosing(false);
    }
  };

  const handleReopen = async () => {
    setIsReopening(true);
    try {
      const res = await reopenDailyReconciliation(date);
      if (!res.success) throw new Error(res.message || "Failed to reopen");
      toast.success(`${date} reopened`);
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reopen day");
    } finally {
      setIsReopening(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-20 dark:bg-gray-900 lg:ml-20 lg:pb-12">
      <div className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <CalendarCheck className="text-beveren-600 dark:text-beveren-400" size={24} />
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Daily Reconciliation</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {groups.length > 0
                    ? `${groups.length} booklet group${groups.length === 1 ? "" : "s"}: ${groups
                        .map((g) => `#${g.booklet_number} (${g.start_number}-${g.end_number})`)
                        .join(", ")}`
                    : "Nothing touched on this date yet"}
                  {scheduledDeliveries.length > 0 &&
                    ` + ${scheduledDeliveries.length} scheduled for delivery today`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
              {isClosed ? (
                <span className="inline-flex items-center gap-1 rounded-lg bg-green-100 px-3 py-2 text-sm font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300">
                  <Lock size={14} /> Closed
                </span>
              ) : (
                <button
                  type="button"
                  disabled={isClosing || (groups.length === 0 && scheduledDeliveries.length === 0)}
                  onClick={handleClose}
                  className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-2 text-sm font-medium text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  {isClosing ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                  Close Day
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <main className="space-y-4 px-4 py-6 sm:px-6">
        {closing && (
          <div
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm ${
              needsReview
                ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300"
                : "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-300"
            }`}
          >
            <div className="flex items-center gap-2">
              {needsReview ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
              <span>
                {needsReview
                  ? `Needs re-review: ${closing.needs_review_reason}`
                  : `Closed by ${closing.closed_by} on ${closing.closed_at}`}
                {closing.status === "Reopened" && ` (reopened by ${closing.reopened_by} on ${closing.reopened_at})`}
              </span>
            </div>
            {isSystemManager && closing.status !== "Reopened" && (
              <button
                type="button"
                disabled={isReopening}
                onClick={handleReopen}
                className="inline-flex items-center gap-1 rounded-lg border border-current px-3 py-1.5 text-xs font-medium hover:bg-white/50 disabled:opacity-50"
              >
                {isReopening ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                Reopen
              </button>
            )}
          </div>
        )}

        {((blockingNumbers && blockingNumbers.length > 0) || (blockingInvoices && blockingInvoices.length > 0)) && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {blockingNumbers && blockingNumbers.length > 0 && <div>Pages still need action: {blockingNumbers.join(", ")}</div>}
            {blockingInvoices && blockingInvoices.length > 0 && (
              <div>Scheduled deliveries still need action: {blockingInvoices.join(", ")}</div>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-6 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            <Loader2 size={18} className="animate-spin" /> Loading...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        ) : (
          <>
            {scheduledDeliveries.length > 0 && (
              <ScheduledDeliveriesCard rows={scheduledDeliveries} readOnly={isReadOnly} onChanged={fetchData} />
            )}
            {groups.length === 0 ? (
              scheduledDeliveries.length === 0 && (
                <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                  No invoices or delivery reports touched {date}.
                </div>
              )
            ) : (
              groups.map((group) => (
                <BookletGroupCard
                  key={group.booklet || group.booklet_number}
                  group={group}
                  date={date}
                  readOnly={isReadOnly}
                  onChanged={fetchData}
                  onCreateInvoiceForPage={setPageModalRow}
                  onCreateInvoiceFromReport={setReportModalRow}
                />
              ))
            )}
          </>
        )}

        {Boolean(result?.unreferenced_invoices?.length) && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300">
              <Info size={14} className="text-gray-400" />
              Invoices without a physical reference ({result!.unreferenced_invoices.length})
              <span className="font-normal text-gray-400">— informational only, doesn't block closing</span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-800">
                {result!.unreferenced_invoices.map((inv) => (
                  <tr key={inv.name}>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => navigate(`/invoice/${inv.name}`)}
                        className="text-beveren-600 hover:underline dark:text-beveren-400"
                      >
                        {inv.name}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-gray-700 dark:text-gray-300">
                      {inv.customer_name || inv.customer}
                    </td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{inv.custom_delivery_status}</td>
                    <td className="px-4 py-2 text-right text-gray-700 dark:text-gray-300">
                      {inv.grand_total.toFixed(2)}
                    </td>
                    <td className="px-4 py-2">
                      <UnreferencedInvoiceRowActions
                        invoice={inv}
                        unresolvedNumbers={unresolvedNumbers}
                        date={date}
                        readOnly={isReadOnly}
                        onChanged={fetchData}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {pageModalRow && (
        <CreateInvoiceForPageModal
          pageNumber={pageModalRow.number}
          defaultDate={date}
          onClose={() => setPageModalRow(null)}
          onCreated={() => {
            setPageModalRow(null);
            fetchData();
          }}
        />
      )}

      {reportModalRow?.delivery_report && (
        <CreateInvoiceFromReportModal
          report={
            {
              name: reportModalRow.delivery_report,
              reported_invoice_no: String(reportModalRow.number),
              reconciliation_status: "Unmatched",
              completion_status: "Full",
              payment_status: "Unpaid",
              creation: date,
            } as DeliveryReport
          }
          onClose={() => setReportModalRow(null)}
          onCreated={() => {
            setReportModalRow(null);
            fetchData();
          }}
        />
      )}

      <div className="lg:hidden">
        <BottomNavigation />
      </div>
    </div>
  );
}
