import { useEffect, useState } from "react";
import { X, MailPlus, MessageCirclePlus, MessageSquarePlus, Send } from "lucide-react";
import SharingInterface from "./SharingInterface";
import { getCurrencySymbol } from "../../utils/currency";

interface ShareInvoiceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  invoiceData: any;
  posDetails?: any;
  initialMode?: string | null;
}

const isFlagEnabled = (value: unknown) => value === 1 || value === "1" || value === true;

/**
 * Lightweight "share this invoice" modal - just the channel picker + SharingInterface,
 * with none of PaymentDialog's checkout/hold/submit UI. Used wherever an already-submitted
 * invoice needs to be shared outside of an active checkout (e.g. the invoice view page).
 */
export default function ShareInvoiceDialog({
  isOpen,
  onClose,
  invoiceData,
  posDetails,
  initialMode = null,
}: ShareInvoiceDialogProps) {
  const [mode, setMode] = useState<string | null>(initialMode);

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
    }
  }, [isOpen, initialMode]);

  if (!isOpen) return null;

  const grandTotal = Number(invoiceData?.grand_total) || 0;
  const currencySymbol =
    invoiceData?.currency_symbol || (invoiceData?.currency ? getCurrencySymbol(invoiceData.currency) : "");

  const whatsappEnabled = isFlagEnabled(posDetails?.custom_enable_whatsapp);
  const smsEnabled = isFlagEnabled(posDetails?.custom_enable_sms);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[150]">
      <div className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            Share Invoice {invoiceData?.name || ""}
          </h2>
          <div className="flex items-center space-x-1">
            <button
              className={`p-2 rounded-lg ${mode === "email" ? "bg-blue-100 text-blue-700" : "text-blue-600 hover:bg-blue-100"} dark:text-blue-400 dark:hover:bg-blue-900`}
              title="Email"
              onClick={() => setMode("email")}
            >
              <MailPlus size={18} />
            </button>
            {whatsappEnabled && (
              <button
                className={`p-2 rounded-lg ${mode === "whatsapp" ? "bg-green-100 text-green-700" : "text-green-600 hover:bg-green-100"} dark:text-green-400 dark:hover:bg-green-900`}
                title="WhatsApp"
                onClick={() => setMode("whatsapp")}
              >
                <MessageCirclePlus size={18} />
              </button>
            )}
            {smsEnabled && (
              <button
                className={`p-2 rounded-lg ${mode === "sms" ? "bg-blue-100 text-blue-700" : "text-blue-600 hover:bg-blue-100"} dark:text-blue-400 dark:hover:bg-blue-900`}
                title="SMS"
                onClick={() => setMode("sms")}
              >
                <MessageSquarePlus size={18} />
              </button>
            )}
            <button
              className={`p-2 rounded-lg ${mode === "telegram" ? "bg-sky-100 text-sky-700" : "text-sky-600 hover:bg-sky-100"} dark:text-sky-400 dark:hover:bg-sky-900`}
              title="Telegram"
              onClick={() => setMode("telegram")}
            >
              <Send size={18} />
            </button>
            <div className="w-px h-6 bg-gray-300 dark:bg-gray-600 mx-1" />
            <button
              className="p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700 rounded-lg"
              title="Close"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto custom-scrollbar">
          <SharingInterface
            mode={mode}
            onModeChange={(nextMode) => {
              setMode(nextMode);
              if (nextMode === null) onClose();
            }}
            invoiceData={invoiceData}
            grandTotal={grandTotal}
            currencySymbol={currencySymbol}
          />
        </div>
      </div>
    </div>
  );
}
