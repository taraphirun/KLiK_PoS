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

export async function getBookletGaps(
  booklet: string
): Promise<{ success: boolean; data: number[]; message?: string }> {
  return getJson("klik_pos.api.booklet.get_booklet_gaps", { booklet });
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
