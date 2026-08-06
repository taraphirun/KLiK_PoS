import { useCallback, useEffect, useState } from "react";
import { BookOpen, ChevronDown, Link2, Loader2, MapPin, Search, Truck, Undo2, X, XCircle } from "lucide-react";
import { toast } from "react-toastify";
import { useNavigate } from "react-router-dom";
import BottomNavigation from "../components/BottomNavigation";
import {
  getDeliveryReports,
  rejectDeliveryMatch,
  unrejectDeliveryMatch,
  type DeliveryReport,
} from "../services/delivery";
import { getCandidateBooklets, resolveBooklet, type DeliveryBooklet } from "../services/booklet";
import CreateInvoiceFromReportModal from "../components/delivery/CreateInvoiceFromReportModal";
import DeliveryPhotoStrip from "../components/delivery/DeliveryPhotoStrip";

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

interface ResolveBookletPickerProps {
  reportName: string;
  reportedInvoiceNo?: string;
  onCancel: () => void;
  onResolved: () => void;
}

/** Manual link for a Delivery Report whose reported invoice number matched no registered booklet
 * range at ingestion (Module 16) - mirrors the NestJS dashboard's ResolveBookletModal. */
function ResolveBookletPicker({ reportName, reportedInvoiceNo, onCancel, onResolved }: ResolveBookletPickerProps) {
  const [candidates, setCandidates] = useState<DeliveryBooklet[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    getCandidateBooklets(reportedInvoiceNo || "")
      .then((response) => {
        if (isCurrent) setCandidates(response.data || []);
      })
      .catch(() => {
        if (isCurrent) setCandidates([]);
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [reportedInvoiceNo]);

  const handlePick = async (bookletName: string) => {
    setIsSubmitting(true);
    try {
      const result = await resolveBooklet(reportName, bookletName);
      if (!result.success) throw new Error(result.message || "Failed to link booklet");
      toast.success(`Linked to booklet #${bookletName}`);
      onResolved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link booklet");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Link invoice #{reportedInvoiceNo} to a booklet
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          <X size={16} />
        </button>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 p-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading candidate booklets...
        </div>
      ) : candidates.length === 0 ? (
        <div className="p-2 text-sm italic text-gray-500 dark:text-gray-400">
          No registered booklet covers this invoice number - register one on the Booklets page first.
        </div>
      ) : (
        <div className="space-y-1">
          {candidates.map((booklet) => (
            <button
              key={booklet.name}
              type="button"
              disabled={isSubmitting}
              onClick={() => handlePick(booklet.name)}
              className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-white disabled:opacity-50 dark:hover:bg-gray-800"
            >
              <span className="text-gray-900 dark:text-white">
                Booklet #{booklet.booklet_number} ({booklet.start_number}-{booklet.end_number})
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{booklet.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ReportCardProps {
  report: DeliveryReport;
  onChanged: () => void;
}

/** All the state and API calls a single report's actions need - reject/un-reject and the two
 * toggleable panels (Resolve Booklet, Link Invoice). Extracted (2026-08-06) so the desktop table
 * view (ReportTableRow) and the mobile card view (ReportCard) share one implementation of this
 * logic instead of two copies that could drift - only how it's laid out on screen differs between
 * them.
 *
 * Revised same day: Confirm, mark-as-paid, and the amount-collected input are gone from here -
 * per the user's decision, *linking* an invoice (via the Link Invoice dialog, whether matching an
 * existing one or creating a new one) now confirms the report itself; there's no separate confirm
 * step left to expose in the row/table. Amount-collected/mark-paid moved into that dialog instead,
 * since they only ever mattered at the moment of linking. Re-match is gone too - folded into the
 * same dialog rather than being its own button/picker.
 */
function useReportRow(report: DeliveryReport, onChanged: () => void) {
  const navigate = useNavigate();
  const [showLinkInvoice, setShowLinkInvoice] = useState(false);
  const [showResolveBooklet, setShowResolveBooklet] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isUnrejecting, setIsUnrejecting] = useState(false);

  const isRejected = report.reconciliation_status === "Rejected";
  const isResolved = report.reconciliation_status === "Confirmed" || isRejected;

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

  const handleUnreject = async () => {
    setIsUnrejecting(true);
    try {
      const result = await unrejectDeliveryMatch(report.name);
      if (!result.success) throw new Error(result.message || "Un-reject failed");
      toast.success(
        result.matched_invoice
          ? `Un-rejected - re-matched to ${result.matched_invoice}`
          : "Un-rejected - back to Unmatched"
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to un-reject delivery report");
    } finally {
      setIsUnrejecting(false);
    }
  };

  const mapsUrl =
    report.gps_latitude && report.gps_longitude
      ? `https://www.google.com/maps?q=${report.gps_latitude},${report.gps_longitude}`
      : null;

  return {
    navigate,
    showLinkInvoice,
    setShowLinkInvoice,
    showResolveBooklet,
    setShowResolveBooklet,
    isRejecting,
    isUnrejecting,
    isRejected,
    isResolved,
    handleReject,
    handleUnreject,
    mapsUrl,
  };
}

function ReportCard({ report, onChanged }: ReportCardProps) {
  const {
    navigate,
    showLinkInvoice,
    setShowLinkInvoice,
    showResolveBooklet,
    setShowResolveBooklet,
    isRejecting,
    isUnrejecting,
    isRejected,
    isResolved,
    handleReject,
    handleUnreject,
    mapsUrl,
  } = useReportRow(report, onChanged);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-white">
              {report.delivery_driver_name || report.reported_driver_name || "Unknown driver"}
            </span>
            {report.reported_driver_name && !report.delivery_driver_name && (
              <span
                title="Reported by the bot but not linked to a Delivery Driver record yet"
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              >
                unlinked
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(report.reconciliation_status)}`}>
              {report.reconciliation_status}
            </span>
            {report.booklet_number && (
              <span
                title={`Booklet #${report.booklet_number} - ${report.booklet_status}`}
                className="inline-flex items-center gap-1 rounded-full bg-beveren-100 px-2 py-0.5 text-xs font-medium text-beveren-700 dark:bg-beveren-900/30 dark:text-beveren-300"
              >
                <BookOpen size={11} /> #{report.booklet_number}
              </span>
            )}
            {Boolean(report.is_booklet_out_of_range) && (
              <span
                title="Reported invoice number matches no registered booklet"
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              >
                booklet out of range
              </span>
            )}
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
          {(report.photos || report.voice_note) && (
            <div className="mt-2">
              <DeliveryPhotoStrip photos={report.photos} photoThumbnails={report.photo_thumbnails} voiceNote={report.voice_note} />
            </div>
          )}
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
      </div>

      {isRejected ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={handleUnreject}
            disabled={isUnrejecting}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {isUnrejecting ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
            Un-reject
          </button>
        </div>
      ) : !isResolved ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {Boolean(report.is_booklet_out_of_range) && (
            <button
              type="button"
              onClick={() => setShowResolveBooklet((v) => !v)}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
            >
              <BookOpen size={14} />
              Resolve Booklet
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowLinkInvoice(true)}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <Link2 size={14} />
            Link Invoice
          </button>
          <button
            type="button"
            onClick={handleReject}
            disabled={isRejecting}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            {isRejecting ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
            Reject
          </button>
        </div>
      ) : null}

      {showResolveBooklet && !isResolved && (
        <ResolveBookletPicker
          reportName={report.name}
          reportedInvoiceNo={report.reported_invoice_no}
          onCancel={() => setShowResolveBooklet(false)}
          onResolved={() => {
            setShowResolveBooklet(false);
            onChanged();
          }}
        />
      )}

      {showLinkInvoice && (
        <CreateInvoiceFromReportModal
          report={report}
          onClose={() => setShowLinkInvoice(false)}
          onCreated={() => {
            setShowLinkInvoice(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

interface ReportGroup {
  key: string;
  reports: DeliveryReport[];
  totalCount: number;
  flagged: boolean;
}

/** Chunks the (already server-sorted, same-key-adjacent) list into groups. Reports.tsx renders
 * these instead of a flat list so multi-delivery invoices - partial now, remainder later - are
 * visually clustered instead of scattered (2026-07-31 addendum). */
function groupReports(reports: DeliveryReport[]): ReportGroup[] {
  const groups: ReportGroup[] = [];
  for (const report of reports) {
    const last = groups[groups.length - 1];
    if (last && last.key === report.group_key) {
      last.reports.push(report);
    } else {
      groups.push({
        key: report.group_key,
        reports: [report],
        totalCount: report.group_total_count,
        flagged: report.group_flagged,
      });
    }
  }
  return groups;
}

const ALL_STATUSES = "Unmatched,Suggested,Confirmed,Rejected";

interface GroupClusterProps {
  group: ReportGroup;
  onChanged: () => void;
}

/** The "N more (other status) — show" expansion, shared (2026-08-06) between the mobile card
 * cluster and the desktop table's group rows for the same reason useReportRow is shared - one
 * implementation of the fetch/filter logic, two different layouts on top of it. */
function useGroupExpansion(group: ReportGroup) {
  const [extraReports, setExtraReports] = useState<DeliveryReport[] | null>(null);
  const [isLoadingExtra, setIsLoadingExtra] = useState(false);

  const visibleNames = new Set(group.reports.map((r) => r.name));
  const hiddenCount = group.totalCount - group.reports.length;
  const others = (extraReports || []).filter((r) => !visibleNames.has(r.name));

  const handleShowMore = async () => {
    setIsLoadingExtra(true);
    try {
      const response = await getDeliveryReports(ALL_STATUSES, group.key, 0, 50);
      setExtraReports((response.data || []).filter((r) => !visibleNames.has(r.name)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load other deliveries for this invoice");
    } finally {
      setIsLoadingExtra(false);
    }
  };

  return { others, hiddenCount, extraReports, isLoadingExtra, handleShowMore };
}

function GroupCluster({ group, onChanged }: GroupClusterProps) {
  const { others, hiddenCount, extraReports, isLoadingExtra, handleShowMore } = useGroupExpansion(group);

  // Plain, unwrapped card for the ordinary case: one report, no siblings anywhere, not itself a
  // Partial delivery worth flagging.
  if (group.reports.length === 1 && !group.flagged) {
    return <ReportCard report={group.reports[0]} onChanged={onChanged} />;
  }

  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50/40 p-3 dark:border-amber-700 dark:bg-amber-950/10">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
          Invoice {group.key} · {group.totalCount} delivery report{group.totalCount === 1 ? "" : "s"}
        </span>
        {hiddenCount > 0 && !extraReports && (
          <button
            type="button"
            onClick={handleShowMore}
            disabled={isLoadingExtra}
            className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-300"
          >
            {isLoadingExtra ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} />}
            {hiddenCount} more (other status) — show
          </button>
        )}
      </div>
      <div className="space-y-3">
        {group.reports.map((report) => (
          <ReportCard key={report.name} report={report} onChanged={onChanged} />
        ))}
        {others.map((report) => (
          <ReportCard key={report.name} report={report} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

// ─── Desktop table view (2026-08-06, user request) ──────────────────────────
//
// Same data, same actions, same useReportRow/useGroupExpansion logic as the card view above - this
// is purely a denser layout for wide screens. Rendered instead of (not alongside) the card list at
// the lg: breakpoint; see DeliveryReconciliationPage's return for the split.
const TABLE_COLUMNS = ["Driver", "Invoice", "Matched", "Status", "Time", "Photos", "Action"];
const TABLE_COLUMN_COUNT = TABLE_COLUMNS.length;

function ReportTableRow({ report, onChanged }: ReportCardProps) {
  const {
    navigate,
    showLinkInvoice,
    setShowLinkInvoice,
    showResolveBooklet,
    setShowResolveBooklet,
    isRejecting,
    isUnrejecting,
    isRejected,
    isResolved,
    handleReject,
    handleUnreject,
    mapsUrl,
  } = useReportRow(report, onChanged);

  const actionBtnClass =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium";

  return (
    <>
      <tr className="border-b border-gray-100 align-top last:border-b-0 dark:border-gray-700">
        <td className="px-3 py-3">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-gray-900 dark:text-white">
              {report.delivery_driver_name || report.reported_driver_name || "Unknown driver"}
            </span>
            {report.reported_driver_name && !report.delivery_driver_name && (
              <span
                title="Reported by the bot but not linked to a Delivery Driver record yet"
                className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              >
                unlinked
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-3 text-sm">
          <div className="font-medium text-gray-900 dark:text-white">{report.reported_invoice_no || "—"}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {report.completion_status} · {report.payment_status}
          </div>
        </td>
        <td className="px-3 py-3 text-sm">
          {report.matched_invoice ? (
            <div>
              <button
                type="button"
                onClick={() => navigate(`/invoice/${report.matched_invoice}`)}
                className="font-medium text-beveren-600 hover:underline dark:text-beveren-400"
              >
                {report.matched_invoice}
              </button>
              {typeof report.match_confidence === "number" && (
                <div
                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${confidenceBadgeClass(
                    report.match_confidence
                  )}`}
                >
                  {Math.round((report.match_confidence || 0) * 100)}% confidence
                </div>
              )}
              {report.match_notes && (
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{report.match_notes}</div>
              )}
            </div>
          ) : (
            <span className="text-gray-400 dark:text-gray-500">No match</span>
          )}
        </td>
        <td className="px-3 py-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(report.reconciliation_status)}`}>
              {report.reconciliation_status}
            </span>
            {report.booklet_number && (
              <span
                title={`Booklet #${report.booklet_number} - ${report.booklet_status}`}
                className="inline-flex items-center gap-1 rounded-full bg-beveren-100 px-2 py-0.5 text-xs font-medium text-beveren-700 dark:bg-beveren-900/30 dark:text-beveren-300"
              >
                <BookOpen size={11} /> #{report.booklet_number}
              </span>
            )}
            {Boolean(report.is_booklet_out_of_range) && (
              <span
                title="Reported invoice number matches no registered booklet"
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              >
                out of range
              </span>
            )}
          </div>
        </td>
        <td className="whitespace-nowrap px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
          {formatTimestamp(report.delivery_timestamp || report.creation)}
          {mapsUrl && (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-beveren-600 hover:underline dark:text-beveren-400"
            >
              <MapPin size={12} /> Map
            </a>
          )}
        </td>
        <td className="px-3 py-3">
          <DeliveryPhotoStrip photos={report.photos} photoThumbnails={report.photo_thumbnails} voiceNote={report.voice_note} />
        </td>
        <td className="px-3 py-3">
          {isRejected ? (
            <button
              type="button"
              onClick={handleUnreject}
              disabled={isUnrejecting}
              className={`${actionBtnClass} border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700`}
            >
              {isUnrejecting ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
              Un-reject
            </button>
          ) : isResolved ? (
            <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {Boolean(report.is_booklet_out_of_range) && (
                <button
                  type="button"
                  onClick={() => setShowResolveBooklet((v) => !v)}
                  className={`${actionBtnClass} border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30`}
                >
                  <BookOpen size={12} />
                  Resolve Booklet
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowLinkInvoice(true)}
                className={`${actionBtnClass} border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700`}
              >
                <Link2 size={12} />
                Link Invoice
              </button>
              <button
                type="button"
                onClick={handleReject}
                disabled={isRejecting}
                className={`${actionBtnClass} border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30`}
              >
                {isRejecting ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                Reject
              </button>
            </div>
          )}
        </td>
      </tr>

      {!isResolved && showResolveBooklet && (
        <tr className="border-b border-gray-100 dark:border-gray-700">
          <td colSpan={TABLE_COLUMN_COUNT} className="bg-gray-50 px-3 py-3 dark:bg-gray-900">
            <ResolveBookletPicker
              reportName={report.name}
              reportedInvoiceNo={report.reported_invoice_no}
              onCancel={() => setShowResolveBooklet(false)}
              onResolved={() => {
                setShowResolveBooklet(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}

      {showLinkInvoice && (
        <CreateInvoiceFromReportModal
          report={report}
          onClose={() => setShowLinkInvoice(false)}
          onCreated={() => {
            setShowLinkInvoice(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function GroupClusterRows({ group, onChanged }: GroupClusterProps) {
  const { others, hiddenCount, extraReports, isLoadingExtra, handleShowMore } = useGroupExpansion(group);

  if (group.reports.length === 1 && !group.flagged) {
    return <ReportTableRow report={group.reports[0]} onChanged={onChanged} />;
  }

  return (
    <>
      <tr className="bg-amber-50/60 dark:bg-amber-950/20">
        <td colSpan={TABLE_COLUMN_COUNT} className="px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Invoice {group.key} · {group.totalCount} delivery report{group.totalCount === 1 ? "" : "s"}
            </span>
            {hiddenCount > 0 && !extraReports && (
              <button
                type="button"
                onClick={handleShowMore}
                disabled={isLoadingExtra}
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-300"
              >
                {isLoadingExtra ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} />}
                {hiddenCount} more (other status) — show
              </button>
            )}
          </div>
        </td>
      </tr>
      {group.reports.map((report) => (
        <ReportTableRow key={report.name} report={report} onChanged={onChanged} />
      ))}
      {others.map((report) => (
        <ReportTableRow key={report.name} report={report} onChanged={onChanged} />
      ))}
    </>
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
      {/* will-change/translateZ (2026-08-06): promotes the sticky header onto its own compositing
          layer. Without it, the much heavier table below (added this session) apparently gives
          some desktop browsers a full-page repaint/blank flash on every scroll tick - isolating
          the header's layer stops its repaint from being tangled up with the table's. */}
      <div className="sticky top-0 z-40 border-b border-gray-200 bg-white [transform:translateZ(0)] [will-change:transform] dark:border-gray-700 dark:bg-gray-900">
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
          <>
            {/* Mobile: card list (unchanged). Desktop: table - denser, and gives the action
                buttons their own column per the user's request, instead of wrapping inside each
                card. */}
            <div className="space-y-3 lg:hidden">
              {groupReports(reports).map((group) => (
                <GroupCluster key={group.key} group={group} onChanged={fetchReports} />
              ))}
            </div>
            {/* [contain:paint] pairs with the sticky header's own layer promotion above - tells
                the browser this subtree's paint is self-contained, so scrolling this much heavier
                table doesn't force a repaint of everything else on the page. Paint-only (not
                `content`, which also contains layout) - rows can still resize as their photos
                load in without fighting a layout containment boundary. */}
            <div className="hidden overflow-x-auto rounded-lg border border-gray-200 bg-white [contain:paint] dark:border-gray-700 dark:bg-gray-800 lg:block">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    {TABLE_COLUMNS.map((column) => (
                      <th
                        key={column}
                        className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {groupReports(reports).map((group) => (
                    <GroupClusterRows key={group.key} group={group} onChanged={fetchReports} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>

      <div className="lg:hidden">
        <BottomNavigation />
      </div>
    </div>
  );
}
