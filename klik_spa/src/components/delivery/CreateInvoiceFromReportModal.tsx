import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Link2, Loader2, Pencil, Plus, RotateCcw, RotateCw, Search, Trash2, X } from "lucide-react";
import { toast } from "react-toastify";
import Lightbox, { type SlideImage } from "yet-another-react-lightbox";
import Inline from "yet-another-react-lightbox/plugins/inline";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import type { Customer } from "../../types/customer";
import { CustomerSearchSection } from "../order/CustomerSearchSection";
import DeliveryPhotoStrip from "./DeliveryPhotoStrip";
import {
  confirmDeliveryMatch,
  correctReportedInvoiceNo,
  createInvoiceFromDeliveryReport,
  parseDeliveryPhotos,
  type DeliveryReport,
  type PaymentStatus,
} from "../../services/delivery";
import { getOutstandingSalesInvoices, type OutstandingSalesInvoice } from "../../services/paymentEntry";
import { getInvoiceDetails } from "../../services/salesInvoice";
import { formatCurrencyWithSymbol } from "../../utils/currency";

const PAYMENT_STATUS_OPTIONS: PaymentStatus[] = ["Paid", "Partial", "Unpaid"];

/** Matches klik_pos.api.item.item_listing.get_items's enriched_items shape - `id` is the actual
 * Item docname/item_code, `name` is the display name (item_name, falling back to item_code) -
 * NOT the other way around like a naive DB row. */
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

interface CreateInvoiceFromReportModalProps {
  report: DeliveryReport;
  onClose: () => void;
  onCreated: (invoiceName: string) => void;
}

/** Defaults the posting date input to the Delivery Report's delivery_timestamp (Todo 038 decision:
 * backfilled invoices should reflect when the paper delivery actually happened, not today) -
 * falls back to today if the report has no timestamp. */
function defaultPostingDate(report: DeliveryReport): string {
  const raw = report.delivery_timestamp || report.creation;
  if (raw) {
    const date = new Date(raw.replace(" ", "T"));
    if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/** 0 = no relation to the report's reported invoice number, 2 = exact match on Invoice Reference,
 * 1 = matches once both sides are reduced to digits only (tolerates a stray dash/space/typo'd
 * letter). Mirrors match_delivery_report's own tiering server-side, simplified for a client-side
 * sort - this never writes anything, it only decides *display order* and which rows get the
 * "Strong match" badge below. custom_invoice_ref-only, same as the backend (2026-08-06): a
 * Sales Invoice's own ERPNext docname is never considered a match signal here either. */
function invoiceMatchScore(invoice: OutstandingSalesInvoice, reportedInvoiceNo?: string): number {
  const reported = (reportedInvoiceNo || "").trim();
  if (!reported || !invoice.custom_invoice_ref) return 0;
  const ref = String(invoice.custom_invoice_ref);
  if (reported === ref) return 2;
  if (reported.replace(/\D/g, "") === ref.replace(/\D/g, "")) return 1;
  return 0;
}

interface InvoicePreviewItem {
  item_code: string;
  item_name: string;
  qty: number;
  rate: number;
  amount: number;
  uom?: string;
}

interface InvoicePreviewData {
  name: string;
  customer?: string;
  customer_name?: string;
  posting_date?: string;
  custom_invoice_ref?: number | null;
  currency?: string;
  grand_total?: number;
  outstanding_amount?: number;
  items?: InvoicePreviewItem[];
}

export default function CreateInvoiceFromReportModal({
  report,
  onClose,
  onCreated,
}: CreateInvoiceFromReportModalProps) {
  // "Link Invoice" (2026-08-06, user request) - this dialog used to be create-only, opened only
  // when a report had no matched_invoice at all. It's now the one place for both matching an
  // existing invoice and creating a new one, always available regardless of whether a match is
  // already suggested - staff can still back out and create a fresh invoice even with a match in
  // hand. Match defaults first since it's the cheaper/more common path; Create is one tap away.
  const [tab, setTab] = useState<"match" | "create">("match");

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [postingDate, setPostingDate] = useState(() => defaultPostingDate(report));
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>(
    report.payment_status === "Paid" || report.payment_status === "Partial"
      ? report.payment_status
      : "Unpaid"
  );
  const [amountCollected, setAmountCollected] = useState(String(report.amount_collected || ""));
  const [dueDate, setDueDate] = useState(() => defaultPostingDate(report));
  const [itemQuery, setItemQuery] = useState("");
  const [itemResults, setItemResults] = useState<ItemSearchResult[]>([]);
  const [isSearchingItems, setIsSearchingItems] = useState(false);
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── Reported invoice number correction (2026-08-06, user request: "sometime my driver would
  // just input the wrong invoice number") ────────────────────────────────────────────────────
  // Local override of what the bot reported, independent of matchSearch below - matchSearch is
  // just this dialog's search box and can be typed into freely without touching the underlying
  // report, whereas this is a real correction persisted server-side (and re-run through matching).
  const [reportedInvoiceNo, setReportedInvoiceNo] = useState(report.reported_invoice_no || "");
  const [isEditingInvoiceNo, setIsEditingInvoiceNo] = useState(false);
  const [invoiceNoDraft, setInvoiceNoDraft] = useState(reportedInvoiceNo);
  const [isSavingInvoiceNo, setIsSavingInvoiceNo] = useState(false);

  const handleSaveInvoiceNo = async () => {
    const value = invoiceNoDraft.trim();
    if (!value || value === reportedInvoiceNo) {
      setIsEditingInvoiceNo(false);
      setInvoiceNoDraft(reportedInvoiceNo);
      return;
    }
    setIsSavingInvoiceNo(true);
    try {
      const result = await correctReportedInvoiceNo(report.name, value);
      if (!result.success) throw new Error(result.message || "Failed to update invoice number");
      setReportedInvoiceNo(result.reported_invoice_no || value);
      setIsEditingInvoiceNo(false);
      // Re-run the match list against the corrected number, same as if staff had retyped the
      // search box themselves.
      setMatchSearch(result.reported_invoice_no || value);
      toast.success(
        result.matched_invoice
          ? `Invoice number updated - matched ${result.matched_invoice}`
          : "Invoice number updated - no match found yet"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update invoice number");
    } finally {
      setIsSavingInvoiceNo(false);
    }
  };

  // ── Match tab state ────────────────────────────────────────────────────────
  const [matchSearch, setMatchSearch] = useState(report.reported_invoice_no || "");
  const [matchInvoices, setMatchInvoices] = useState<OutstandingSalesInvoice[]>([]);
  const [isLoadingMatches, setIsLoadingMatches] = useState(true);
  // Pre-selected when a match is already suggested (Suggested status) - reopening this dialog to
  // confirm that match, or to swap it for a different one, both start from the same place.
  const [selectedMatchInvoice, setSelectedMatchInvoice] = useState<string | null>(report.matched_invoice || null);
  const [matchMarkPaid, setMatchMarkPaid] = useState(report.payment_status !== "Unpaid");
  const [matchAmountCollected, setMatchAmountCollected] = useState(String(report.amount_collected || ""));
  const [isLinkingMatch, setIsLinkingMatch] = useState(false);
  // Full detail for whichever invoice was last clicked in the match list, shown in the preview
  // panel to the right (2026-08-06, user request). Independent of selectedMatchInvoice in
  // principle, but in practice a click always sets both together - see handleSelectMatch.
  const [previewInvoice, setPreviewInvoice] = useState<InvoicePreviewData | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    const timer = window.setTimeout(async () => {
      setIsLoadingMatches(true);
      try {
        const response = await getOutstandingSalesInvoices(matchSearch, 0, 30, true, true);
        if (!isCurrent) return;
        setMatchInvoices(response.data || []);
      } catch {
        if (isCurrent) setMatchInvoices([]);
      } finally {
        if (isCurrent) setIsLoadingMatches(false);
      }
    }, matchSearch ? 300 : 0);

    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [matchSearch]);

  const sortedMatchInvoices = [...matchInvoices].sort(
    (a, b) => invoiceMatchScore(b, reportedInvoiceNo) - invoiceMatchScore(a, reportedInvoiceNo)
  );

  const handleSelectMatch = async (invoiceName: string) => {
    setSelectedMatchInvoice(invoiceName);
    setIsLoadingPreview(true);
    try {
      const result = await getInvoiceDetails(invoiceName);
      if (!result.success) throw new Error();
      // getInvoiceDetails wraps the backend's own {success, data} response as .data - double
      // nesting, not a mistake here, see services/salesInvoice.ts.
      setPreviewInvoice((result.data as { data: InvoicePreviewData }).data);
    } catch {
      setPreviewInvoice(null);
      toast.error("Failed to load invoice preview");
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleLinkMatch = async () => {
    if (!selectedMatchInvoice) return;
    if (report.payment_status === "Partial" && matchMarkPaid) {
      const amount = Number(matchAmountCollected);
      if (!amount || amount <= 0) {
        toast.error("Enter the amount collected before linking a partial payment.");
        return;
      }
    }
    setIsLinkingMatch(true);
    try {
      const amount = report.payment_status === "Partial" && matchMarkPaid ? Number(matchAmountCollected) : undefined;
      const result = await confirmDeliveryMatch(report.name, selectedMatchInvoice, matchMarkPaid, amount);
      if (!result.success) throw new Error(result.message || "Failed to link invoice");
      toast.success(
        result.payment_entry
          ? `Linked to ${selectedMatchInvoice} and posted payment ${result.payment_entry}`
          : `Linked to ${selectedMatchInvoice}`
      );
      onCreated(selectedMatchInvoice);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link invoice");
    } finally {
      setIsLinkingMatch(false);
    }
  };

  // Which delivery photo (full-resolution, by index into photoUrls) is open in the side panel to
  // the left of this dialog - null means the panel is closed. User request (2026-08-06): clicking
  // a thumbnail here should let staff keep referencing the photo while filling out the form below,
  // rather than covering the whole screen the way the shared lightbox does elsewhere.
  const [previewPhotoIndex, setPreviewPhotoIndex] = useState<number | null>(null);
  // Keyed by photo index, not just "the current one" - so flipping to another photo and back
  // remembers the correction you already made instead of losing it. Client-side only (not saved
  // anywhere); a fresh open of this modal always starts at 0. User request (2026-08-06): drivers
  // sometimes shoot a delivery photo sideways/upside-down.
  const [photoRotations, setPhotoRotations] = useState<Record<number, number>>({});
  const photoUrls = parseDeliveryPhotos(report.photos);
  const rotatePreview = (delta: number) => {
    if (previewPhotoIndex === null) return;
    setPhotoRotations((prev) => ({
      ...prev,
      [previewPhotoIndex]: ((prev[previewPhotoIndex] || 0) + delta + 360) % 360,
    }));
  };

  // Prefill from a VIP booklet match (Module 16) - a hint only, staff can still pick a different
  // customer below. Never overrides a customer the user already picked.
  useEffect(() => {
    if (!report.booklet_customer || customer) return;
    let isCurrent = true;
    fetch(
      `/api/method/klik_pos.api.customer.get_customers?search=${encodeURIComponent(report.booklet_customer)}&limit=5`,
      { credentials: "include" }
    )
      .then((response) => response.json())
      .then((result) => {
        if (!isCurrent) return;
        const rows = (result.message?.data || []) as { name: string; customer_name?: string }[];
        const match = rows.find((c) => c.name === report.booklet_customer);
        if (match) {
          setCustomer({ id: match.name, name: match.customer_name || match.name, customerName: match.customer_name } as Customer);
        }
      })
      .catch(() => {});
    return () => {
      isCurrent = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.booklet_customer]);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  // Independent local search against get_items - deliberately NOT the shared productStore, which
  // holds the live POS grid's product list/search query. Reusing it here would overwrite what a
  // cashier sees on the main POS screen if this modal is used while a shift is open elsewhere in
  // the app.
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
        const items = (result.message?.items || []) as ItemSearchResult[];
        setItemResults(items);
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
      const result = await createInvoiceFromDeliveryReport(
        report.name,
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
      toast.success(`Invoice ${result.invoice_name} created and linked to this delivery`);
      onCreated(result.invoice_name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create invoice");
    } finally {
      setIsSubmitting(false);
    }
  };

  const tabBtnClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${
      active
        ? "bg-white text-beveren-700 shadow-sm dark:bg-gray-900 dark:text-beveren-300"
        : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
    }`;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 overflow-y-auto bg-black/70 p-4 sm:flex-row">
      {/* Photo preview panel - deliberately placed before the dialog below in DOM order so it
          renders to its left in the row layout (stacks above it instead on narrow/mobile
          viewports, via the flex-col default above). Own panel, not the shared lightbox
          (DeliveryPhotoStrip's onPhotoClick override) - staying open side-by-side while the form
          is filled out is the whole point here.

          h-[80vh] below, not max-h - the Lightbox inside sizes itself to 100% of this container's
          height (Inline plugin), so it needs a genuine definite height to fill, not just a cap. A
          plain <img> never cared about this (it sizes off width + its own aspect ratio), which is
          why this only broke once the Lightbox replaced it. */}
      {previewPhotoIndex !== null && photoUrls[previewPhotoIndex] && (
        <div className="flex h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl dark:bg-gray-800">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Photo {previewPhotoIndex + 1} of {photoUrls.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => rotatePreview(-90)}
                  title="Rotate left"
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                >
                  <RotateCcw size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => rotatePreview(90)}
                  title="Rotate right"
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                >
                  <RotateCw size={15} />
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPreviewPhotoIndex(null)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <X size={16} />
            </button>
          </div>
          {/* min-h-0 - this is a flex-1 child of a flex-col parent; without it, Lightbox's own
              height:100% (set by the Inline plugin) has nothing definite to resolve against and
              the panel grows to fit content instead of respecting the container's own height. */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <Lightbox
              plugins={[Inline, Zoom]}
              slides={photoUrls.map((url) => ({ src: url }))}
              index={previewPhotoIndex}
              on={{ view: ({ index }) => setPreviewPhotoIndex(index) }}
              carousel={{ finite: true }}
              zoom={{ scrollToZoom: true, maxZoomPixelRatio: 4, doubleClickMaxStops: 3 }}
              render={{
                // Wraps Zoom's own pan/zoom transform (applied one level in, to the image itself)
                // rather than replacing it - the two transforms compose normally. Matched to the
                // slide being rendered by src, not "whichever index is current": the carousel can
                // render a neighboring slide (for swipe transitions) with this same function, and
                // each photo's rotation is independent.
                slideContainer: ({ slide, children }) => {
                  const index = photoUrls.indexOf((slide as SlideImage).src);
                  const degrees = index >= 0 ? photoRotations[index] || 0 : 0;
                  return (
                    <div
                      className="flex h-full w-full items-center justify-center"
                      style={{ transform: `rotate(${degrees}deg)`, transition: "transform 0.2s ease" }}
                    >
                      {children}
                    </div>
                  );
                },
              }}
            />
          </div>
        </div>
      )}

      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Link Invoice</h2>
            <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
              <span>
                Delivery report {report.name} · Invoice Reference{" "}
              </span>
              {isEditingInvoiceNo ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    type="text"
                    autoFocus
                    value={invoiceNoDraft}
                    onChange={(event) => setInvoiceNoDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") handleSaveInvoiceNo();
                      if (event.key === "Escape") {
                        setIsEditingInvoiceNo(false);
                        setInvoiceNoDraft(reportedInvoiceNo);
                      }
                    }}
                    disabled={isSavingInvoiceNo}
                    className="w-24 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={handleSaveInvoiceNo}
                    disabled={isSavingInvoiceNo}
                    title="Save"
                    className="rounded p-0.5 text-beveren-600 hover:bg-beveren-50 disabled:opacity-50 dark:hover:bg-beveren-900/20"
                  >
                    {isSavingInvoiceNo ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditingInvoiceNo(false);
                      setInvoiceNoDraft(reportedInvoiceNo);
                    }}
                    disabled={isSavingInvoiceNo}
                    title="Cancel"
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    <X size={13} />
                  </button>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <span className="font-medium text-gray-700 dark:text-gray-300">{reportedInvoiceNo || "—"}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setInvoiceNoDraft(reportedInvoiceNo);
                      setIsEditingInvoiceNo(true);
                    }}
                    title="Correct invoice number"
                    className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                  >
                    <Pencil size={12} />
                  </button>
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-800">
            <button type="button" onClick={() => setTab("match")} className={tabBtnClass(tab === "match")}>
              Match Existing
            </button>
            <button type="button" onClick={() => setTab("create")} className={tabBtnClass(tab === "create")}>
              Create New
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Delivery photos
            </label>
            <DeliveryPhotoStrip
              photos={report.photos}
              photoThumbnails={report.photo_thumbnails}
              voiceNote={report.voice_note}
              emptyLabel="No photos attached to this delivery."
              onPhotoClick={setPreviewPhotoIndex}
            />
          </div>

          {tab === "match" ? (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  Search invoice
                </label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                  <input
                    type="text"
                    value={matchSearch}
                    onChange={(event) => setMatchSearch(event.target.value)}
                    placeholder="Search by Invoice Reference, invoice number, or customer"
                    className="w-full rounded-md border border-gray-300 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
              </div>

              <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
                {isLoadingMatches ? (
                  <div className="flex items-center gap-2 p-3 text-sm text-gray-500 dark:text-gray-400">
                    <Loader2 size={14} className="animate-spin" /> Loading invoices...
                  </div>
                ) : sortedMatchInvoices.length === 0 ? (
                  <div className="p-3 text-sm text-gray-500 dark:text-gray-400">No outstanding invoices found.</div>
                ) : (
                  <div className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedMatchInvoices.map((invoice) => {
                      const score = invoiceMatchScore(invoice, reportedInvoiceNo);
                      const isSelected = selectedMatchInvoice === invoice.name;
                      return (
                        <button
                          key={invoice.name}
                          type="button"
                          onClick={() => handleSelectMatch(invoice.name)}
                          className={`block w-full px-3 py-2 text-left text-sm ${
                            isSelected
                              ? "bg-beveren-50 dark:bg-beveren-900/20"
                              : "hover:bg-gray-50 dark:hover:bg-gray-700"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-medium text-gray-900 dark:text-white">
                              {invoice.name}
                            </span>
                            {score > 0 && (
                              <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-300">
                                Strong match
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
                            <span className="min-w-0 truncate">{invoice.customer_name || invoice.customer}</span>
                            {invoice.custom_invoice_ref ? (
                              <span className="shrink-0">Invoice Reference: {invoice.custom_invoice_ref}</span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                            {formatCurrencyWithSymbol(invoice.outstanding_amount, invoice.currency)} outstanding
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {selectedMatchInvoice && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
                  <div className="mb-2 text-sm text-gray-700 dark:text-gray-300">
                    Selected: <span className="font-medium text-gray-900 dark:text-white">{selectedMatchInvoice}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    {report.payment_status === "Partial" && (
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                          Amount collected
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={matchAmountCollected}
                          onChange={(event) => setMatchAmountCollected(event.target.value)}
                          className="w-32 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                        />
                      </div>
                    )}
                    {report.payment_status !== "Unpaid" && (
                      <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                        <input
                          type="checkbox"
                          checked={matchMarkPaid}
                          onChange={(event) => setMatchMarkPaid(event.target.checked)}
                          className="h-4 w-4 rounded border-gray-300 text-beveren-600 focus:ring-beveren-500"
                        />
                        Mark as paid
                      </label>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting || isLinkingMatch}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          {tab === "match" ? (
            <button
              type="button"
              onClick={handleLinkMatch}
              disabled={!selectedMatchInvoice || isLinkingMatch}
              className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-4 py-2 text-sm font-medium text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isLinkingMatch ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
              Link Invoice
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-4 py-2 text-sm font-medium text-white hover:bg-beveren-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Invoice
            </button>
          )}
        </div>
      </div>

      {/* Invoice preview panel - to the right of the dialog (after it in DOM order), shown while
          on the Match tab with something selected (2026-08-06, user request). Read-only summary,
          not the full invoice view - just enough to confirm this is the right invoice before
          linking to it. */}
      {tab === "match" && (previewInvoice || isLoadingPreview) && (
        <div className="flex h-[80vh] w-full max-w-md flex-col rounded-xl bg-white shadow-xl dark:bg-gray-800">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {previewInvoice ? previewInvoice.name : "Loading invoice…"}
            </span>
            <button
              type="button"
              onClick={() => setPreviewInvoice(null)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {isLoadingPreview ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <Loader2 size={14} className="animate-spin" /> Loading invoice...
              </div>
            ) : previewInvoice ? (
              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Customer</div>
                    <div className="text-gray-900 dark:text-white">
                      {previewInvoice.customer_name || previewInvoice.customer || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Posting date</div>
                    <div className="text-gray-900 dark:text-white">{previewInvoice.posting_date || "—"}</div>
                  </div>
                  {previewInvoice.custom_invoice_ref ? (
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Invoice Reference</div>
                      <div className="text-gray-900 dark:text-white">{previewInvoice.custom_invoice_ref}</div>
                    </div>
                  ) : null}
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Outstanding</div>
                    <div className="text-gray-900 dark:text-white">
                      {formatCurrencyWithSymbol(previewInvoice.outstanding_amount || 0, previewInvoice.currency)}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="w-full text-xs">
                    <thead className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-700 dark:text-gray-400">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Item</th>
                        <th className="w-14 px-2 py-1.5 text-right font-medium">Qty</th>
                        <th className="w-16 px-2 py-1.5 text-right font-medium">Rate</th>
                        <th className="w-16 px-2 py-1.5 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {(previewInvoice.items || []).map((item, index) => (
                        <tr key={`${item.item_code}-${index}`}>
                          <td className="px-2 py-1.5 text-gray-900 dark:text-white">
                            {item.item_name}
                            <div className="text-[10px] text-gray-400">{item.item_code}</div>
                          </td>
                          <td className="px-2 py-1.5 text-right text-gray-700 dark:text-gray-300">{item.qty}</td>
                          <td className="px-2 py-1.5 text-right text-gray-700 dark:text-gray-300">{item.rate}</td>
                          <td className="px-2 py-1.5 text-right text-gray-700 dark:text-gray-300">{item.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <span className="text-gray-500 dark:text-gray-400">Grand total</span>
                  <span className="text-base font-semibold text-gray-900 dark:text-white">
                    {formatCurrencyWithSymbol(previewInvoice.grand_total || 0, previewInvoice.currency)}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
