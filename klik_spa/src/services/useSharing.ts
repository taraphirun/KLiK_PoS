
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendEmails(data: any) {
  const csrfToken = window.csrf_token;

  const response = await fetch('/api/method/klik_pos.api.email.send_invoice_email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(data),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : 'Failed to send email';
    throw new Error(serverMsg);
  }

  return result.message;
}

export async function getAvailableOutgoingAccounts() {
  const csrfToken = window.csrf_token;

  const response = await fetch(
    "/api/method/klik_pos.api.email.get_available_outgoing_accounts",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrfToken,
      },
      credentials: "include",
    }
  );

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : "Failed to get available outgoing accounts";
    throw new Error(serverMsg);
  }

  return result.message;
}

// Extend Window interface to include csrf_token
declare global {
  interface Window {
    csrf_token: string;
  }
}

interface WhatsAppData {
  mobile_no?: string;
  message?: string;
  customer_name?: string;
  invoice_data?: string;
  template_name?: string;
  template_parameters?: string[];
}

export async function getWhatsAppSetup() {
  const csrfToken = window.csrf_token;

  const response = await fetch(
    "/api/method/klik_pos.api.whatsapp.get_whatsapp_setup",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrfToken,
      },
      credentials: "include",
    }
  );

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : "Failed to get WhatsApp setup";
    throw new Error(serverMsg);
  }

  return result.message;
}

// New function specifically for simple text messages
export async function sendWhatsAppMessage(data: WhatsAppData) {
  const csrfToken = window.csrf_token;


  const response = await fetch('/api/method/klik_pos.api.whatsapp.deliver_invoice_via_whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(data),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : 'Failed to send WhatsApp message';
    throw new Error(serverMsg);
  }

  return result.message;
}

// Function for sending template messages
export async function sendTemplateWhatsApp(mobile: string, templateName: string, parameters?: string[]) {
  const csrfToken = window.csrf_token;

  const response = await fetch('/api/method/klik_pos.api.whatsapp.send_template_whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      mobile_no: mobile,
      template_name: templateName,
      template_parameters: parameters || []
    }),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : 'Failed to send WhatsApp message';
    throw new Error(serverMsg);
  }

  return result.message;
}

// Check if SMS gateway is configured
export async function getSMSGateway() {
  const csrfToken = window.csrf_token;

  const response = await fetch(
    "/api/method/klik_pos.api.sms.get_sms_gateway_settings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrfToken,
      },
      credentials: "include",
    }
  );

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : "Failed to get SMS gateway settings";
    throw new Error(serverMsg);
  }

  return result.message;
}

// Function for sending SMS message
export async function sendSMSMessage(data: { mobile_no: string; message: string; customer_name?: string }) {
  const csrfToken = window.csrf_token;


  const response = await fetch('/api/method/klik_pos.api.sms.send_sms_message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(data),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : 'Failed to send SMS message';
    throw new Error(serverMsg);
  }

  return result.message;
}

// Function for sending invoice SMS
export async function sendInvoiceSMS(data: { mobile_no: string; customer_name: string; invoice_data: string; message?: string }) {
  const csrfToken = window.csrf_token;


  const response = await fetch('/api/method/klik_pos.api.sms.send_invoice_sms', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(data),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : 'Failed to send invoice SMS message';
    throw new Error(serverMsg);
  }

  return result.message;
}

// Function for sending invoice with PDF attachment
export async function sendInvoiceWithPDF(mobile: string, invoiceNo: string, message?: string) {
  const csrfToken = window.csrf_token;

  const response = await fetch('/api/method/klik_pos.api.whatsapp.send_invoice_whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      mobile_no: mobile,
      invoice_data: invoiceNo,
      message: message || 'Your invoice is ready!'
    }),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : 'Failed to send invoice WhatsApp message';
    throw new Error(serverMsg);
  }

  return result.message;
}

// Function for sending invoice with customer data (from frontend)
export async function sendInvoiceWhatsApp(data: {
  mobile_no: string;
  customer_name: string;
  invoice_data: string;
  message?: string;
}) {
  const csrfToken = window.csrf_token;


  const response = await fetch('/api/method/klik_pos.api.whatsapp.send_invoice_whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      mobile_no: data.mobile_no,
      customer_name: data.customer_name,
      invoice_data: data.invoice_data,
      message: data.message || 'Your invoice is ready! Please find the PDF attached.'
    }),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result._server_messages
      ? JSON.parse(result._server_messages)[0]
      : 'Failed to send invoice WhatsApp message';
    throw new Error(serverMsg);
  }

  return result.message;
}

// ============ TELEGRAM FUNCTIONS ============

interface TelegramContactInfo {
  telegram_contact_id: string;
  telegram_display_name: string;
}

interface TelegramEnabledStatus {
  enabled: boolean;
  has_settings: boolean;
  has_authenticated_user: boolean;
  authenticated_user?: string;
  error?: string;
}

// Check if Telegram integration is enabled
export async function checkTelegramEnabled(): Promise<TelegramEnabledStatus> {
  const csrfToken = window.csrf_token;

  try {
    const response = await fetch('/api/method/erpnext_telegram_integration.erpnext_telegram_integration.api.check_telegram_enabled', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Frappe-CSRF-Token': csrfToken,
      },
      credentials: 'include',
    });

    const result = await response.json();
    return result.message || { enabled: false, has_settings: false, has_authenticated_user: false };
  } catch (error) {
    console.error("Error checking Telegram enabled:", error);
    return { enabled: false, has_settings: false, has_authenticated_user: false };
  }
}

// Get Telegram contact info for a customer
export async function getTelegramContactInfo(customerName: string): Promise<TelegramContactInfo | null> {
  const csrfToken = window.csrf_token;

  try {
    const response = await fetch(`/api/method/erpnext_telegram_integration.erpnext_telegram_integration.api.get_telegram_contact_info?customer_name=${encodeURIComponent(customerName)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Frappe-CSRF-Token': csrfToken,
      },
      credentials: 'include',
    });

    const result = await response.json();

    if (result.message && result.message.telegram_contact_id) {
      return result.message;
    }
    return null;
  } catch (error) {
    console.error("Error getting Telegram contact info:", error);
    return null;
  }
}

// Send invoice via Telegram
export async function sendInvoiceTelegram(data: {
  customer_name: string;
  invoice_name: string;
  message?: string;
  attach_file?: boolean;
  attachment_format?: 'PDF' | 'Image' | null;  // null = use user's setting
}): Promise<{ status: string; message: string }> {
  const csrfToken = window.csrf_token;

  const response = await fetch('/api/method/erpnext_telegram_integration.erpnext_telegram_integration.api.send_invoice_telegram', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Frappe-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      customer_name: data.customer_name,
      invoice_name: data.invoice_name,
      message: data.message,
      attach_file: data.attach_file !== false ? 1 : 0,
      attachment_format: data.attachment_format || null  // null = use user's setting
    }),
    credentials: 'include',
  });

  const result = await response.json();

  if (!response.ok || !result.message || result.message.status !== "success") {
    const serverMsg = result.message?.message ||
      (result._server_messages ? JSON.parse(result._server_messages)[0] : 'Failed to send invoice via Telegram');
    throw new Error(serverMsg);
  }

  return result.message;
}

