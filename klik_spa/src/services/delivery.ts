import { extractErrorMessage } from "../utils/errorExtraction";
import { getRealtimeSocket } from "../utils/realtime";

export type ReconciliationStatus = "Unmatched" | "Suggested" | "Confirmed" | "Rejected";
export type CompletionStatus = "Full" | "Partial";
export type PaymentStatus = "Paid" | "Unpaid" | "Partial";

export interface DeliveryReport {
  name: string;
  bot_delivery_id: string;
  reported_invoice_no?: string;
  completion_status: CompletionStatus;
  payment_status: PaymentStatus;
  /** Verbatim driver name/handle as reported by the bot, before matching (Todo 028). */
  reported_driver_name?: string;
  /** Resolved Delivery Driver docname (Link), or blank if unmatched. */
  delivery_driver?: string | null;
  /** Fetched display name for delivery_driver - use this for UI, not the raw docname. */
  delivery_driver_name?: string | null;
  driver_telegram_id?: string;
  delivery_timestamp?: string;
  gps_latitude?: number;
  gps_longitude?: number;
  /** Raw JSON-encoded array of Frappe private-file URLs (e.g. '["/private/files/x.jpg"]'), NOT a
   * parsed array - frappe.get_all() returns JSON fieldtype columns as their raw string value.
   * Use parseDeliveryPhotos() rather than reading this directly. */
  photos?: string | null;
  voice_note?: string;
  matched_invoice?: string | null;
  amount_collected?: number;
  reconciliation_status: ReconciliationStatus;
  match_confidence?: number;
  match_notes?: string | null;
  payment_entry?: string | null;
  /** Delivery Booklet docname this report's invoice number was matched to at ingestion, or blank
   * (see is_booklet_out_of_range) - Module 16. */
  booklet?: string | null;
  booklet_number?: string | null;
  booklet_status?: string | null;
  /** Set when reported_invoice_no is numeric but matched no known booklet range - needs manual
   * resolution (see ResolveBookletButton). */
  is_booklet_out_of_range?: 0 | 1;
  /** Suggested customer (docname) when this report matched a VIP booklet - a hint the Create
   * Invoice modal prefills but staff can still override, not an authoritative assignment. */
  booklet_customer?: string | null;
  creation: string;
  /** Same-invoice grouping key: matched_invoice, else reported_invoice_no (2026-07-31). */
  group_key: string;
  /** Count of Delivery Reports sharing group_key, across ALL reconciliation statuses - may be
   * higher than how many of that group appear in the current filtered list. */
  group_total_count: number;
  /** True if group_total_count > 1 or any report in the group is a Partial delivery - these
   * groups sort to the top of the list (server-side) and should be visually clustered. */
  group_flagged: boolean;
}

export interface DeliveryReportsResponse {
  success: boolean;
  data: DeliveryReport[];
  total_count: number;
  start: number;
  limit: number;
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
    throw new Error(extractErrorMessage(result, "Delivery reconciliation request failed"));
  }

  return result.message;
}

export async function getDeliveryReports(
  status?: string,
  search = "",
  start = 0,
  limit = 100
): Promise<DeliveryReportsResponse> {
  const params = new URLSearchParams({
    start: String(start),
    limit: String(limit),
  });
  if (status) params.set("status", status);
  if (search.trim()) params.set("search", search.trim());

  const response = await fetch(`/api/method/klik_pos.api.delivery.get_delivery_reports?${params.toString()}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(extractErrorMessage(result, "Failed to fetch delivery reports"));
  }

  return result.message;
}

export async function confirmDeliveryMatch(
  reportName: string,
  invoiceName?: string,
  markPaid?: boolean,
  amountCollected?: number
): Promise<{ success: boolean; matched_invoice?: string; payment_entry?: string | null; message?: string }> {
  return postJson("klik_pos.api.delivery.confirm_delivery_match", {
    report_name: reportName,
    invoice_name: invoiceName,
    mark_paid: markPaid,
    amount_collected: amountCollected,
  });
}

export async function rejectDeliveryMatch(
  reportName: string,
  reason?: string
): Promise<{ success: boolean; reconciliation_status?: string }> {
  return postJson("klik_pos.api.delivery.reject_delivery_match", {
    report_name: reportName,
    reason,
  });
}

/** Parses DeliveryReport.photos (a raw JSON string, or already an array if a caller constructed
 * one in memory - e.g. realtime updates) into a plain string[]. Never throws. */
export function parseDeliveryPhotos(photos?: string | string[] | null): string[] {
  if (!photos) return [];
  if (Array.isArray(photos)) return photos;
  try {
    const parsed = JSON.parse(photos);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function rematchDeliveryReport(
  reportName: string,
  invoiceName: string
): Promise<{ success: boolean; matched_invoice?: string; reconciliation_status?: string }> {
  return postJson("klik_pos.api.delivery.rematch_delivery_report", {
    report_name: reportName,
    invoice_name: invoiceName,
  });
}

export interface BackfillInvoiceItem {
  item_code: string;
  quantity: number;
  price: number;
}

/** Payload for create_invoice_from_delivery_report (Todo 038) - a paper-transition backfill, so
 * only what a fast table entry needs: customer, items, and an optional posting_date override
 * (defaults server-side to today if omitted). Not the full POS checkout payload shape. */
export interface BackfillInvoiceData {
  customer: { id: string };
  items: BackfillInvoiceItem[];
  posting_date?: string;
}

export async function createInvoiceFromDeliveryReport(
  reportName: string,
  invoiceData: BackfillInvoiceData,
  paymentStatus: PaymentStatus,
  amountCollected?: number,
  dueDate?: string
): Promise<{
  success: boolean;
  invoice_name?: string;
  reconciliation_status?: string;
  payment_entry?: string | null;
  message?: string;
}> {
  return postJson("klik_pos.api.delivery.create_invoice_from_delivery_report", {
    report_name: reportName,
    invoice_data: invoiceData,
    payment_status: paymentStatus,
    amount_collected: amountCollected,
    due_date: dueDate,
  });
}

/** Matches the payload published by Delivery Report's on_update hook (Todo 031) - a minimal,
 * map-oriented projection, not the full DeliveryReport shape. */
export interface DeliveryRealtimeUpdate {
  name: string;
  gps_latitude: number;
  gps_longitude: number;
  delivery_driver_name: string | null;
  completion_status: CompletionStatus;
  payment_status: PaymentStatus;
  reconciliation_status: ReconciliationStatus;
  matched_invoice: string | null;
  reported_invoice_no: string | null;
  delivery_timestamp: string | null;
}

const DELIVERY_REALTIME_EVENT = "delivery_report_update";

/** Subscribes to live Delivery Report updates (Todo 031/032). Returns an unsubscribe function -
 * call it on unmount, the socket connection itself is shared/reused (see getRealtimeSocket). */
export function subscribeToDeliveryUpdates(callback: (update: DeliveryRealtimeUpdate) => void): () => void {
  const socket = getRealtimeSocket();
  socket.on(DELIVERY_REALTIME_EVENT, callback);
  return () => {
    socket.off(DELIVERY_REALTIME_EVENT, callback);
  };
}
