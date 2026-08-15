export interface ReturnItem {
  item_code: string;
  item_name: string;
  qty: number;
  rate: number;
  amount: number;
  returned_qty: number;
  available_qty: number;
  return_qty?: number;
}

export interface InvoiceForReturn {
  name: string;
  posting_date: string;
  posting_time: string;
  customer: string;
  grand_total: number;
  paid_amount?: number;
  status: string;
  items: ReturnItem[];
}

export interface ReturnData {
  customer: string;
  invoice_returns: {
    invoice_name: string;
    return_items: ReturnItem[];
    payment_method?: string;
    return_amount?: number;
    // 'refund' | 'reduce_bill' | 'store_credit' - see klik_pos/hd/returns.py
    outcome?: string;
  }[];
}

export async function getReturnedQty(customer: string, salesInvoice: string, item: string) {
  const csrfToken = window.csrf_token
  try {
    const response = await fetch(`/api/method/klik_pos.api.sales_invoice.returned_qty`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Frappe-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        customer,
        sales_invoice: salesInvoice,
        item
      }),
       credentials: 'include'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to get returned quantity');
    }

    return {
      success: true,
      data: data.message
    };
          //eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Error getting returned quantity:', error);
    return {
      success: false,
      error: error.message || 'Failed to get returned quantity'
    };
  }
}

export async function getCustomerInvoicesForReturn(
  customer: string,
  startDate?: string,
  endDate?: string,
  shippingAddress?: string
): Promise<{success: boolean; data?: InvoiceForReturn[]; error?: string}> {
  try {
    const params = new URLSearchParams({
      customer,
      ...(startDate && { start_date: startDate }),
      ...(endDate && { end_date: endDate }),
      ...(shippingAddress && { shipping_address: shippingAddress })
    });

    const response = await fetch(`/api/method/klik_pos.api.sales_invoice.get_customer_invoices_for_return?${params}`);
    const data = await response.json();

    if (!response.ok || !data.message.success) {
      throw new Error(data.message.error || 'Failed to fetch customer invoices');
    }

    return {
      success: true,
      data: data.message.data
    };
          //eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Error fetching customer invoices for return:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch customer invoices'
    };
  }
}

// How a return is settled - see klik_pos/hd/returns.py (phase-17 §2c).
// 'reduce_bill' is a retired outcome (2026-08-15) still accepted server-side as a
// legacy alias for 'store_credit' - new code should never send it.
export type ReturnOutcome = 'refund' | 'reduce_bill' | 'store_credit';

// What happened to any part of the return's value beyond what was actually paid - it
// always settles the original invoice's own balance rather than floating. Present
// whenever there was something to settle (unpaid or partly-paid original); absent when
// the original was fully paid.
export interface ResidualSettlement {
  success: boolean;
  amount: number;
}

// Refund cap / outstanding context the return UI needs to offer the right outcomes.
export async function getReturnContext(
  invoiceName: string
): Promise<{refundable: number; outstanding: number; grand_total: number} | null> {
  try {
    const response = await fetch(
      `/api/method/klik_pos.hd.returns.get_return_context?invoice=${encodeURIComponent(invoiceName)}`,
      { credentials: 'include' }
    );
    const data = await response.json();
    return data.message || null;
  } catch (error) {
    console.error('Error fetching return context:', error);
    return null;
  }
}

export async function createPartialReturn(
  invoiceName: string,
  returnItems: ReturnItem[],
  paymentMethod?: string,
  returnAmount?: number,
  outcome?: ReturnOutcome
): Promise<{success: boolean; returnInvoice?: string; message?: string; error?: string; residualSettlement?: ResidualSettlement | null}> {

  const csrfToken = window.csrf_token;
  try {
    const response = await fetch(`/api/method/klik_pos.api.sales_invoice.create_partial_return`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Frappe-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        invoice_name: invoiceName,
        return_items: returnItems,
        // Payment method / amount only make sense for a refund; store_credit rejects
        // payout rows outright.
        payment_method: outcome === 'refund' ? paymentMethod || undefined : undefined,
        return_amount: outcome === 'refund' ? returnAmount || 0 : undefined,
        outcome: outcome
      }),
       credentials: 'include'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to create partial return');
    }

    // Handle both response formats
    const result = data.message || data;

    if (!result.success) {
      throw new Error(result.message || 'Failed to create partial return');
    }

    return {
      success: true,
      returnInvoice: result.return_invoice,
      message: result.message,
      residualSettlement: result.residual_settlement
    };
        //eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Error creating partial return:', error);
    return {
      success: false,
      error: error.message || 'Failed to create partial return'
    };
  }
}

export async function createMultiInvoiceReturn(
  returnData: ReturnData
): Promise<{success: boolean; createdReturns?: string[]; message?: string; error?: string}> {
  const csrfToken = window.csrf_token;
  try {
    const response = await fetch(`/api/method/klik_pos.api.sales_invoice.create_multi_invoice_return`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
         'X-Frappe-CSRF-Token': csrfToken
      },
      body: new URLSearchParams({
        return_data: JSON.stringify(returnData)
      }).toString(),
       credentials: 'include'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to create multi-invoice return');
    }

    // Handle both response formats
    const result = data.message || data;

    if (!result.success) {
      throw new Error(result.message || 'Failed to create multi-invoice return');
    }

    return {
      success: true,
      createdReturns: result.created_returns,
      message: result.message
    };

          //eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Error creating multi-invoice return:', error);
    return {
      success: false,
      error: error.message || 'Failed to create multi-invoice return'
    };
  }
}

export async function getValidSalesInvoices(
  customer: string,
  itemCode: string,
  startDate: string,
  shippingAddress?: string,
  searchText?: string
) {
  try {
    const filters = {
      customer,
      item_code: itemCode,
      start_date: startDate,
      ...(shippingAddress && { shipping_address: shippingAddress })
    };

    const params = new URLSearchParams({
      doctype: 'Sales Invoice',
      txt: searchText || '',
      searchfield: 'name',
      start: '0',
      page_len: '20',
      filters: JSON.stringify(filters)
    });

    const response = await fetch(`/api/method/klik_pos.api.sales_invoice.get_valid_sales_invoices?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to fetch valid sales invoices');
    }

    return {
      success: true,
      data: data.message
    };

          //eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Error fetching valid sales invoices:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch valid sales invoices'
    };
  }
}
