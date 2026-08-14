// Store credit = the customer's credit notes still carrying their own negative
// outstanding (created by "return as store credit"). Backend: klik_pos/hd/store_credit.py,
// which reads and redeems them purely through ERPNext's own AR / Payment Reconciliation
// machinery - no parallel balance is kept anywhere.

export interface StoreCreditNote {
  name: string;
  posting_date: string;
  return_against?: string;
  custom_return_outcome?: string;
  available: number;
}

export interface StoreCreditBalance {
  customer: string;
  total: number;
  credit_notes: StoreCreditNote[];
}

export async function getStoreCredit(customer: string): Promise<StoreCreditBalance | null> {
  try {
    const response = await fetch(
      `/api/method/klik_pos.hd.store_credit.get_store_credit?customer=${encodeURIComponent(customer)}`,
      { credentials: "include" }
    );
    const data = await response.json();
    return data.message || null;
  } catch (error) {
    console.error("Error fetching store credit:", error);
    return null;
  }
}

export interface ApplyStoreCreditResult {
  success: boolean;
  applied?: number;
  invoice_outstanding?: number;
  remaining_store_credit?: number;
  error?: string;
}

export async function applyStoreCredit(
  customer: string,
  invoice: string,
  amount?: number,
  creditNote?: string
): Promise<ApplyStoreCreditResult> {
  const csrfToken = window.csrf_token;
  try {
    const response = await fetch(`/api/method/klik_pos.hd.store_credit.apply_store_credit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ customer, invoice, amount, credit_note: creditNote }),
      credentials: "include",
    });
    const data = await response.json();
    if (!response.ok) {
      // Frappe packs the throw message into _server_messages / exception
      const serverMsg = data._server_messages
        ? JSON.parse(JSON.parse(data._server_messages)[0]).message
        : data.exception || "Failed to apply store credit";
      return { success: false, error: serverMsg };
    }
    const result = data.message || data;
    return {
      success: Boolean(result.success),
      applied: result.applied,
      invoice_outstanding: result.invoice_outstanding,
      remaining_store_credit: result.remaining_store_credit,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error("Error applying store credit:", error);
    return { success: false, error: error.message || "Failed to apply store credit" };
  }
}
