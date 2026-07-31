import { extractErrorMessage } from "../utils/errorExtraction";

export type DriverStatus = "Pending" | "Active" | "Rejected";

export interface DeliveryDriver {
  name: string;
  driver_name: string;
  phone_number?: string | null;
  status: DriverStatus;
  telegram_user_id?: string | null;
  telegram_username?: string | null;
  chat_id?: string | null;
  bot_driver_id?: string | null;
  creation: string;
  modified: string;
}

export interface DriverListResponse {
  success: boolean;
  data: DeliveryDriver[];
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
    throw new Error(extractErrorMessage(result, "Driver request failed"));
  }

  return result.message;
}

export async function getDrivers(status?: string, search = "", start = 0, limit = 100): Promise<DriverListResponse> {
  const params = new URLSearchParams({
    start: String(start),
    limit: String(limit),
  });
  if (status) params.set("status", status);
  if (search.trim()) params.set("search", search.trim());

  const response = await fetch(`/api/method/klik_pos.api.driver.list_drivers?${params.toString()}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(extractErrorMessage(result, "Failed to fetch drivers"));
  }

  return result.message;
}

export async function upsertDriver(driver: {
  name?: string;
  driver_name: string;
  phone_number?: string;
  status?: DriverStatus;
}): Promise<{ success: boolean; driver?: string; status?: DriverStatus; message?: string }> {
  return postJson("klik_pos.api.driver.upsert_driver", { data: driver });
}

export async function setDriverStatus(
  driver: string,
  status: DriverStatus
): Promise<{ success: boolean; driver?: string; status?: DriverStatus; message?: string }> {
  return postJson("klik_pos.api.driver.set_driver_status", { driver, status });
}
