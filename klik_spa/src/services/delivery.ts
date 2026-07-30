import { extractErrorMessage } from "../utils/errorExtraction";

export type ReconciliationStatus = "Unmatched" | "Suggested" | "Confirmed" | "Rejected";
export type CompletionStatus = "Full" | "Partial";
export type PaymentStatus = "Paid" | "Unpaid" | "Partial";

export interface DeliveryReport {
  name: string;
  bot_delivery_id: string;
  reported_invoice_no?: string;
  completion_status: CompletionStatus;
  payment_status: PaymentStatus;
  delivery_driver?: string;
  driver_telegram_id?: string;
  delivery_timestamp?: string;
  gps_latitude?: number;
  gps_longitude?: number;
  photos?: string[] | null;
  voice_note?: string;
  matched_invoice?: string | null;
  amount_collected?: number;
  reconciliation_status: ReconciliationStatus;
  match_confidence?: number;
  match_notes?: string | null;
  payment_entry?: string | null;
  creation: string;
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

export async function rematchDeliveryReport(
  reportName: string,
  invoiceName: string
): Promise<{ success: boolean; matched_invoice?: string; reconciliation_status?: string }> {
  return postJson("klik_pos.api.delivery.rematch_delivery_report", {
    report_name: reportName,
    invoice_name: invoiceName,
  });
}
