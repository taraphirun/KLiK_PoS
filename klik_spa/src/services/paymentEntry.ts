import { extractErrorMessage } from "../utils/errorExtraction";

export interface CustomerPaymentEntryRequest {
  customer: string;
  amount: number;
  mode_of_payment: string;
  sales_invoice?: string;
  allocated_amount?: number;
  reference_no?: string;
  reference_date?: string;
  remarks?: string;
}

export interface CustomerPaymentEntryResponse {
  success: boolean;
  name: string;
  customer: string;
  amount: number;
  mode_of_payment: string;
  sales_invoice?: string | null;
  allocated_amount?: number | null;
  opening_entry: string;
  posting_date: string;
}

export interface OutstandingSalesInvoice {
  name: string;
  /** "Invoice Reference" - the paper/booklet reference number staff actually write down, distinct
   * from this invoice's own ERPNext docname (2026-08-06: this is now the *only* thing delivery
   * matching considers - see match_delivery_report). Absent if the site has no such field
   * installed at all (get_outstanding_sales_invoices omits the column entirely in that case,
   * rather than sending a misleading 0/null). */
  custom_invoice_ref?: number | null;
  posting_date: string;
  due_date?: string;
  customer: string;
  customer_name: string;
  company: string;
  currency: string;
  grand_total: number;
  rounded_total?: number;
  paid_amount: number;
  outstanding_amount: number;
  status: string;
}

export interface OutstandingSalesInvoicesResponse {
  success: boolean;
  data: OutstandingSalesInvoice[];
  total_count: number;
  start: number;
  limit: number;
}

export interface UnallocatedCustomerPaymentEntry {
  name: string;
  posting_date: string;
  customer: string;
  customer_name?: string;
  company: string;
  mode_of_payment?: string;
  paid_amount: number;
  unallocated_amount: number;
  currency: string;
  reference_no?: string;
  remarks?: string;
  // "credit_note" rows are store-credit notes (klik_pos/hd/store_credit.py) listed
  // alongside payment entries in the reconciliation panel; absent for real PEs.
  entry_type?: "credit_note";
  return_against?: string;
}

// Store-credit notes shaped like unallocated payment entries, for the same panel.
export async function getStoreCreditNotes(
  search = "",
  limit = 50
): Promise<UnallocatedCustomerPaymentEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search.trim()) params.set("search", search.trim());
  const response = await fetch(
    `/api/method/klik_pos.hd.store_credit.list_store_credit_notes?${params.toString()}`,
    { credentials: "include" }
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(extractErrorMessage(result, "Failed to fetch store credit notes"));
  }
  return result.message?.data || [];
}

export interface UnallocatedCustomerPaymentEntriesResponse {
  success: boolean;
  data: UnallocatedCustomerPaymentEntry[];
  total_count: number;
  start: number;
  limit: number;
}

export async function createCustomerPaymentEntry(
  payload: CustomerPaymentEntryRequest
): Promise<CustomerPaymentEntryResponse> {
  const csrfToken = window.csrf_token;

  const response = await fetch("/api/method/klik_pos.api.payment.create_customer_payment_entry", {
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
    throw new Error(extractErrorMessage(result, "Failed to receive customer payment"));
  }

  return result.message;
}

export async function getOutstandingSalesInvoices(
  search = "",
  start = 0,
  limit = 100,
  /** Default false, matching the endpoint's own default - most callers (payment collection
   * flows) genuinely only want unpaid invoices. The Link Invoice match picker passes true, since
   * a delivery can legitimately match an invoice that's already been paid in full elsewhere. */
  includePaid = false,
  /** Default false. The Link Invoice match picker passes true to hide invoices whose
   * custom_delivery_status is already "Delivered" - re-matching a finished delivery is pointless.
   * Deliberately independent of includePaid (delivery completion and payment are separate axes
   * throughout this app) and of "Partially Delivered", which stays visible for a follow-up
   * delivery against the remainder. */
  excludeDelivered = false
): Promise<OutstandingSalesInvoicesResponse> {
  const params = new URLSearchParams({
    start: String(start),
    limit: String(limit),
  });
  if (search.trim()) params.set("search", search.trim());
  if (includePaid) params.set("include_paid", "1");
  if (excludeDelivered) params.set("exclude_delivered", "1");

  const response = await fetch(
    `/api/method/klik_pos.api.payment.get_outstanding_sales_invoices?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
    }
  );

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(extractErrorMessage(result, "Failed to fetch outstanding invoices"));
  }

  return result.message;
}

export async function getUnallocatedCustomerPaymentEntries(
  search = "",
  start = 0,
  limit = 100
): Promise<UnallocatedCustomerPaymentEntriesResponse> {
  const params = new URLSearchParams({
    start: String(start),
    limit: String(limit),
  });
  if (search.trim()) params.set("search", search.trim());

  const response = await fetch(
    `/api/method/klik_pos.api.payment.get_unallocated_customer_payment_entries?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
    }
  );

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(extractErrorMessage(result, "Failed to fetch payment entries"));
  }

  return result.message;
}

export async function reconcilePaymentEntryWithInvoice(
  paymentEntry: string,
  salesInvoice: string,
  allocatedAmount: number
) {
  const csrfToken = window.csrf_token;

  const response = await fetch(
    "/api/method/klik_pos.api.payment.reconcile_payment_entry_with_invoice",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        payment_entry: paymentEntry,
        sales_invoice: salesInvoice,
        allocated_amount: allocatedAmount,
      }),
      credentials: "include",
    }
  );

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(extractErrorMessage(result, "Failed to reconcile payment"));
  }

  return result.message;
}
