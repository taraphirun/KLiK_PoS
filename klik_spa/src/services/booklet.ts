import { extractErrorMessage } from "../utils/errorExtraction";

export type BookletStatus = "Active" | "Stalled" | "Ready for Review" | "Closed";

export interface DeliveryBooklet {
  name: string;
  booklet_number: string;
  start_number: number;
  end_number: number;
  is_vip: 0 | 1;
  customer?: string | null;
  customer_name?: string | null;
  status: BookletStatus;
  closed_at?: string | null;
  closed_by?: string | null;
  creation: string;
  modified: string;
}

export interface BookletSettings {
  pages_per_booklet: number;
  normal_booklet_stall_days: number;
  vip_booklet_stall_days: number;
}

// Module 17: end-of-day paper-page reconciliation checklist + closing.
export type DailyPageStatus =
  | "Void"
  | "Delivered"
  | "Partially Delivered"
  | "Self Pickup"
  | "Scheduled"
  | "Pending Fulfillment"
  | "Reported, No Invoice"
  | "Unresolved";

export interface DailyPageRow {
  number: number;
  status: DailyPageStatus;
  invoice?: string | null;
  delivery_report?: string | null;
  void_reason?: string | null;
  /** Set once "Set Delivery Date" is used (status becomes "Scheduled") - 2026-08-03 follow-up. */
  requested_delivery_date?: string | null;
}

/** A submitted invoice whose requested_delivery_date lands on the date being viewed (2026-08-03
 * follow-up) - the paper page itself belongs to an earlier date's booklet group (already resolved
 * there as "Scheduled"), but the delivery commitment is due *today*, so it re-surfaces here,
 * actionable, and blocks this date's Close Day until Delivered/Self-Pickup is confirmed. status is
 * never "Scheduled" here - only Delivered/Partially Delivered/Self Pickup (closable) or Pending
 * Fulfillment (blocking). */
export interface ScheduledDeliveryRow {
  invoice: string;
  customer: string;
  page_number?: number | null;
  status: DailyPageStatus;
  requested_delivery_date: string;
}

/** One booklet's worth of the day's checklist (Module 17 follow-up, 2026-08-02) - touched numbers
 * are clustered by their real-or-implied booklet so a day spanning two far-apart invoice numbers
 * doesn't synthesize a huge fake gap between unrelated booklets. `start_number`/`end_number` is
 * the interior span actually touched within this booklet today; `bucket_start`/`bucket_end` is
 * the booklet's full range (registered, or implied from pages_per_booklet if not yet registered)
 * - used for the "Register this booklet" shortcut. */
export interface DailyGroup {
  booklet?: string | null;
  booklet_number: string;
  is_registered: boolean;
  start_number: number;
  end_number: number;
  bucket_start: number;
  bucket_end: number;
  rows: DailyPageRow[];
}

export type ClosingStatus = "Closed" | "Reopened" | "Needs Re-review";

export interface ClosingGroupSummary {
  booklet?: string | null;
  booklet_number: string;
  is_registered: boolean;
  start_number: number;
  end_number: number;
}

export interface DailyClosing {
  status: ClosingStatus;
  groups_summary: ClosingGroupSummary[];
  delivered_count: number;
  partially_delivered_count: number;
  self_pickup_count: number;
  void_count: number;
  scheduled_count: number;
  closed_by?: string | null;
  closed_at?: string | null;
  reopened_by?: string | null;
  reopened_at?: string | null;
  needs_review_reason?: string | null;
}

/** A submitted Sales Invoice for the day with no custom_invoice_ref at all - invisible to the
 * numbered checklist since there's no page number to place it at. Purely informational; never
 * affects Close Day, which stays scoped to the physical booklet's min-max range only. */
export interface UnreferencedInvoice {
  name: string;
  customer: string;
  customer_name?: string | null;
  grand_total: number;
  custom_delivery_status: string;
}

export interface DailyReconciliation {
  success: boolean;
  date: string;
  groups: DailyGroup[];
  summary: {
    delivered_count: number;
    partially_delivered_count: number;
    self_pickup_count: number;
    void_count: number;
    scheduled_count: number;
  };
  closing: DailyClosing | null;
  unreferenced_invoices: UnreferencedInvoice[];
  scheduled_deliveries: ScheduledDeliveryRow[];
  message?: string;
}

async function postJson(path: string, payload: Record<string, unknown>) {
  const csrfToken = window.csrf_token;

  const response = await fetch(`/api/method/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Frappe-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(extractErrorMessage(result, "Booklet request failed"));
  }

  return result.message;
}

/** Like postJson, but returns the response body even on a business-logic failure
 * (`result.message.success === false`) instead of throwing it away - only throws on a genuine
 * transport failure. Needed by closeDailyReconciliation: a blocked close still needs its
 * structured blocking_numbers/blocking_invoices, which plain postJson discards by throwing before
 * the caller ever sees them. */
async function postJsonExpectResult(path: string, payload: Record<string, unknown>) {
  const csrfToken = window.csrf_token;

  const response = await fetch(`/api/method/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Frappe-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok || !result.message) {
    throw new Error(extractErrorMessage(result, "Booklet request failed"));
  }

  return result.message;
}

async function getJson(path: string, params?: Record<string, string>) {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  const response = await fetch(`/api/method/${path}${query}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(extractErrorMessage(result, "Booklet request failed"));
  }

  return result.message;
}

export async function getBooklets(
  status?: string,
  search = ""
): Promise<{ success: boolean; data: DeliveryBooklet[]; message?: string }> {
  const params: Record<string, string> = {};
  if (status) params.status = status;
  if (search.trim()) params.search = search.trim();
  return getJson("klik_pos.api.booklet.list_booklets", params);
}

export async function upsertBooklet(booklet: {
  name?: string;
  booklet_number: string;
  start_number: number;
  end_number: number;
  is_vip?: boolean;
  customer?: string | null;
}): Promise<{ success: boolean; booklet?: string; message?: string }> {
  return postJson("klik_pos.api.booklet.upsert_booklet", { data: booklet });
}

export async function closeBooklet(
  booklet: string
): Promise<{ success: boolean; booklet?: string; status?: BookletStatus; message?: string }> {
  return postJson("klik_pos.api.booklet.close_booklet", { booklet });
}

export async function deleteBooklet(booklet: string): Promise<{ success: boolean; message?: string }> {
  return postJson("klik_pos.api.booklet.delete_booklet", { booklet });
}

/** Full-range readiness view for one booklet (Module 17 follow-up, 2026-08-02) - every page in
 * the booklet's whole start_number-end_number range, classified the same way as the daily
 * checklist. Replaces the old get_booklet_gaps (Delivery-Report-only, interior-span-only, and
 * with no bearing on whether the booklet could actually be closed). */
export async function getBookletStatus(
  booklet: string
): Promise<{
  success: boolean;
  data: DailyPageRow[];
  summary?: { delivered_count: number; partially_delivered_count: number; self_pickup_count: number; void_count: number };
  message?: string;
}> {
  return getJson("klik_pos.api.booklet.get_booklet_status", { booklet });
}

export async function getCandidateBooklets(
  invoiceNo: string
): Promise<{ success: boolean; data: DeliveryBooklet[]; message?: string }> {
  return getJson("klik_pos.api.booklet.get_candidate_booklets", { invoice_no: invoiceNo });
}

export async function resolveBooklet(
  reportName: string,
  booklet: string
): Promise<{ success: boolean; delivery_report?: string; booklet?: string; message?: string }> {
  return postJson("klik_pos.api.booklet.resolve_booklet", { report_name: reportName, booklet });
}

export async function getBookletSettings(): Promise<BookletSettings> {
  return getJson("klik_pos.api.booklet.get_booklet_settings");
}

export async function updateBookletSettings(
  settings: Partial<BookletSettings>
): Promise<BookletSettings & { success: boolean; message?: string }> {
  return postJson("klik_pos.api.booklet.update_booklet_settings", { data: settings });
}

export async function markPageVoid(
  pageNumber: number,
  reason?: string
): Promise<{ success: boolean; booklet?: string; page_number?: number; message?: string }> {
  return postJson("klik_pos.api.booklet.mark_page_void", { page_number: pageNumber, reason });
}

export async function unmarkPageVoid(
  pageNumber: number
): Promise<{ success: boolean; booklet?: string; page_number?: number; message?: string }> {
  return postJson("klik_pos.api.booklet.unmark_page_void", { page_number: pageNumber });
}

export async function getDailyReconciliation(date: string): Promise<DailyReconciliation> {
  return getJson("klik_pos.api.booklet.get_daily_reconciliation", { date });
}

export async function closeDailyReconciliation(
  date: string
): Promise<{
  success: boolean;
  date?: string;
  status?: ClosingStatus;
  message?: string;
  blocking_numbers?: number[];
  blocking_invoices?: string[];
}> {
  return postJsonExpectResult("klik_pos.api.booklet.close_daily_reconciliation", { date });
}

export async function reopenDailyReconciliation(
  date: string
): Promise<{ success: boolean; date?: string; status?: ClosingStatus; message?: string }> {
  return postJson("klik_pos.api.booklet.reopen_daily_reconciliation", { date });
}

export async function linkInvoiceToPage(
  invoiceName: string,
  pageNumber: number,
  date: string
): Promise<{ success: boolean; invoice_name?: string; page_number?: number; message?: string }> {
  return postJson("klik_pos.api.booklet.link_invoice_to_page", {
    invoice_name: invoiceName,
    page_number: pageNumber,
    date,
  });
}

export async function unlinkInvoicePage(
  invoiceName: string
): Promise<{ success: boolean; invoice_name?: string; message?: string }> {
  return postJson("klik_pos.api.booklet.unlink_invoice_page", { invoice_name: invoiceName });
}

/** Schedules a still-Pending booklet page for delivery on a later date (2026-08-03 follow-up) -
 * resolves the page on its own date (status "Scheduled") but the invoice re-surfaces, actionable,
 * on the target date's own checklist (see ScheduledDeliveryRow) until really delivered. */
export async function setRequestedDeliveryDate(
  invoiceName: string,
  date: string
): Promise<{ success: boolean; invoice_name?: string; requested_delivery_date?: string; message?: string }> {
  return postJson("klik_pos.api.booklet.set_requested_delivery_date", { invoice_name: invoiceName, date });
}

/** Undoes setRequestedDeliveryDate - reversible/reschedulable while still Pending. */
export async function clearRequestedDeliveryDate(
  invoiceName: string
): Promise<{ success: boolean; invoice_name?: string; message?: string }> {
  return postJson("klik_pos.api.booklet.clear_requested_delivery_date", { invoice_name: invoiceName });
}
