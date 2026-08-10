import { toast } from "react-toastify";
import { markInvoiceAsPrinted } from "../services/salesInvoice";

interface Invoice {
  name?: string;
  id?: string;
  pos_profile: string;
  custom_is_printed?: boolean | number;
  [key: string]: unknown;
}

interface PrintOptions {
  preventReprint?: boolean;
  onAfterMark?: () => void;
  posDetails?: {
    print_format?: string;
    letter_head?: string | null;
    custom_network_printer?: string;
    [key: string]: unknown;
  } | null;
}

/** Existing behaviour: hidden iframe -> browser's own print dialog. Used whenever no Network
 * Printer is configured on the POS Profile, and as the fallback if a configured one fails
 * (offline, misconfigured, pycups missing on the server, etc.) - printing should always give the
 * cashier *something* to act on rather than silently doing nothing. */
function printViaBrowserDialog(invoiceName: string, options: PrintOptions) {
  const printFormat = options.posDetails?.print_format || "";
  const letterHead = options.posDetails?.letter_head || 0;

  const baseUrl = window.location.origin;
  const url =
    baseUrl +
    "/printview?doctype=Sales%20Invoice" +
    "&name=" + encodeURIComponent(invoiceName) +
    "&format=" + encodeURIComponent(printFormat) +
    "&no_letterhead=" + (letterHead ? 0 : 1);

  // Remove any previous print iframe
  const existingFrame = document.getElementById("klik-print-frame");
  if (existingFrame) existingFrame.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "klik-print-frame";
  iframe.src = url;
  iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none;";
  document.body.appendChild(iframe);

  iframe.addEventListener("load", () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      toast.error("Unable to print. Try allowing pop-ups or use the print button in the preview.");
    } finally {
      // Clean up after print dialog closes
      setTimeout(() => iframe.remove(), 60000);
    }
  });
}

/** POS Profile.custom_network_printer set -> print straight to it server-side (Frappe core's
 * print_by_server via CUPS), no browser dialog at all. Returns whether it actually succeeded so
 * the caller can fall back to the browser dialog on failure instead of leaving the cashier with
 * nothing printed. */
async function printViaNetworkPrinter(invoiceName: string): Promise<boolean> {
  try {
    const csrfToken = window.csrf_token;
    const response = await fetch("/api/method/klik_pos.api.sales_invoice.print_invoice_via_network_printer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ invoice_name: invoiceName }),
      credentials: "include",
    });

    const result = await response.json();
    if (!response.ok || result.message?.success !== true) {
      console.warn("Network printer print failed, falling back to browser dialog:", result.message?.error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("Network printer request failed, falling back to browser dialog:", err);
    return false;
  }
}

export function handlePrintInvoice(invoiceData: Invoice | null, options: PrintOptions = {}) {
  if (!invoiceData) {
    toast.error("No invoice data available for printing");
    return;
  }

  const isAlreadyPrinted = Boolean(invoiceData.custom_is_printed);
  if (isAlreadyPrinted && options.preventReprint) {
    toast.error("Reprinting is not allowed for this invoice");
    return;
  }

  const invoiceName = invoiceData.name || invoiceData.id;
  if (!invoiceName) {
    toast.error("Invoice name is missing");
    return;
  }

  const networkPrinter = options.posDetails?.custom_network_printer;

  const afterTrigger = () => {
    // Mark invoice as printed
    markInvoiceAsPrinted(invoiceName)
      .then(() => options.onAfterMark?.())
      .catch((err) => {
        console.error("Error marking invoice as printed:", err);
        toast.error("Failed to mark invoice as printed");
      });
  };

  if (networkPrinter) {
    printViaNetworkPrinter(invoiceName).then((succeeded) => {
      if (succeeded) {
        afterTrigger();
      } else {
        toast.warning(`Could not reach printer "${networkPrinter}" - opening print preview instead.`);
        printViaBrowserDialog(invoiceName, options);
        afterTrigger();
      }
    });
    return;
  }

  printViaBrowserDialog(invoiceName, options);
  afterTrigger();
}
