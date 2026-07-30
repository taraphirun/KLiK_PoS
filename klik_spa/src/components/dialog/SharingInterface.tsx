import { X, Loader2, Pencil, Check } from "lucide-react";
import { formatCurrencyWithSymbol } from "../../utils/currency";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { useCustomerActions } from "../../services/customerService";
import { fetchWhatsAppTemplates, getDefaultWhatsAppTemplate, processTemplate, getDefaultMessageTemplate } from "../../services/whatsappTemplateService";
import { fetchEmailTemplates, getDefaultEmailTemplate, processEmailTemplate, getDefaultEmailMessageTemplate } from "../../services/emailTemplateService";

interface SharingInterfaceProps {
  mode: string | null;
  onModeChange: (mode: string | null) => void;
  invoiceData: any;
  grandTotal: number;
  currencySymbol: string;
}

/**
 * Self-contained "share this invoice" panel: owns its own sharing-channel state
 * (recipient details, templates, send-in-flight flags) so it can be mounted
 * anywhere an invoice needs to be shared - the post-checkout PaymentDialog
 * screen and the standalone ShareInvoiceDialog both use this same component.
 */
export default function SharingInterface({
  mode,
  onModeChange,
  invoiceData,
  grandTotal,
  currencySymbol,
}: SharingInterfaceProps) {
  const [sharingData, setSharingData] = useState({ email: "", phone: "", name: "" });
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [isSendingWhatsapp, setIsSendingWhatsapp] = useState(false);
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [whatsappTemplates, setWhatsappTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<any>(null);
  const [customMessage, setCustomMessage] = useState("");
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [isEditingWhatsapp, setIsEditingWhatsapp] = useState(false);
  const [emailTemplates, setEmailTemplates] = useState<any[]>([]);
  const [selectedEmailTemplate, setSelectedEmailTemplate] = useState<any>(null);
  const [emailMessage, setEmailMessage] = useState("");
  const [isLoadingEmailTemplates, setIsLoadingEmailTemplates] = useState(false);
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [modeEnabled, setModeEnabled] = useState(false);
  const [outgoingAccounts, setOutgoingAccounts] = useState<any[]>([]);
  const [selectedSender, setSelectedSender] = useState<string>("");
  const [telegramDisplayName, setTelegramDisplayName] = useState<string>("");
  const { getCustomerTelegramLink } = useCustomerActions();

  const fetchCustomerDetails = async (customerId: string, existingEmail: string, existingPhone: string, existingName: string) => {
    try {
      const response = await fetch(`/api/method/klik_pos.api.customer.get_customer_info?customer_name=${customerId}`);
      const data = await response.json();
      if (data.message) {
        const customerData = data.message;
        setSharingData({
          email: existingEmail || customerData.email_id || "",
          phone: existingPhone || customerData.mobile_no || "",
          name: existingName || customerData.customer_name || customerData.name || "",
        });
      } else {
        setSharingData({ email: existingEmail, phone: existingPhone, name: existingName });
      }
    } catch (error) {
      console.error("Error fetching customer details:", error);
      setSharingData({ email: existingEmail, phone: existingPhone, name: existingName });
    }
  };

  useEffect(() => {
    if (!mode || !invoiceData) return;

    const email = invoiceData.customer_address_doc?.email_id || invoiceData.customer_email || invoiceData.email_id || "";
    const phone = invoiceData.mobile_no || invoiceData.customer_address_doc?.mobile_no || invoiceData.customer_address_doc?.phone || invoiceData.customer_phone || "";
    const name = invoiceData.customer_name || invoiceData.customer || "";

    if ((!email || !phone) && invoiceData.customer) {
      fetchCustomerDetails(invoiceData.customer, email, phone, name);
    } else {
      setSharingData({ email, phone, name });
    }
  }, [invoiceData, mode]);

  useEffect(() => {
    if (mode === "email") {
      const getEmailOutgoingAccounts = async () => {
        const { getAvailableOutgoingAccounts } =
          await import("../../services/useSharing");
        try {
          await getAvailableOutgoingAccounts().then((result: any) => {
            const accounts = result?.accounts ?? [];
            if (!accounts || accounts.length === 0) {
              toast.error(
                "No available outgoing email accounts found. Please configure email accounts in ERPNext to use this feature."
              );
              setModeEnabled(false);
            } else {
              setOutgoingAccounts(accounts);
              const defaultAccount =
                accounts.find((a: any) => a.source === "default_outgoing") ??
                accounts[0];
              setSelectedSender(defaultAccount?.name ?? "");
              setModeEnabled(true);
            }
          });
        } catch (error) {
          toast.error("Failed to load email accounts. Please try again.");
          onModeChange(null);
        }
      };

      getEmailOutgoingAccounts();
    } else if (mode === "sms") {
      const getSmsSettings = async () => {
        const { getSMSGateway } = await import("../../services/useSharing");
        try {
          await getSMSGateway().then((settings: any) => {
            if (!settings || !settings.enabled) {
              toast.error(
                "SMS gateway is not configured. Please set up SMS gateway in ERPNext to use this feature."
              );
              setModeEnabled(false);
            } else {
              setModeEnabled(true);
            }
          });
        } catch (error) {
          toast.error("Failed to load SMS settings. Please try again.");
          onModeChange(null);
        }
      };

      getSmsSettings();
    } else if (mode === "whatsapp") {
      const checkWhatsAppSetup = async () => {
        const { getWhatsAppSetup } = await import("../../services/useSharing");
        try {
          const setup = await getWhatsAppSetup();
          if (!setup?.is_configured) {
            toast.error(
              "WhatsApp is not configured. Please set up WhatsApp Business API in ERPNext to use this feature."
            );
            setModeEnabled(false);
          } else {
            setModeEnabled(true);
          }
        } catch (error) {
          toast.error("Failed to load WhatsApp setup. Please try again.");
          onModeChange(null);
        }
      };

      checkWhatsAppSetup();
    } else if (mode === "telegram") {
      const checkTelegramLink = async () => {
        const customerId = invoiceData?.customer;
        if (!customerId) {
          toast.error("No customer linked to this invoice.");
          setModeEnabled(false);
          return;
        }
        try {
          const link = await getCustomerTelegramLink(customerId);
          if (!link.linked) {
            toast.error(link.message || "This customer has no linked Telegram account.");
            setModeEnabled(false);
          } else {
            setTelegramDisplayName(link.telegram_display_name || "");
            setModeEnabled(true);
          }
        } catch (error) {
          toast.error("Failed to check Telegram link. Please try again.");
          onModeChange(null);
        }
      };

      checkTelegramLink();
    }
  }, [mode]);

  useEffect(() => {
    const loadWhatsAppTemplates = async () => {
      if (mode === "whatsapp" && whatsappTemplates.length === 0) {
        setIsLoadingTemplates(true);
        try {
          const [templates, defaultTemplateName] = await Promise.all([fetchWhatsAppTemplates(), getDefaultWhatsAppTemplate()]);
          setWhatsappTemplates(templates);
          if (defaultTemplateName) {
            const defaultTemplate = templates.find((t) => t.name === defaultTemplateName);
            if (defaultTemplate) {
              setSelectedTemplate(defaultTemplate);
              setCustomMessage(defaultTemplate.template);
            }
          } else {
            setCustomMessage(getDefaultMessageTemplate());
          }
        } catch (error) {
          console.error("Error loading WhatsApp templates:", error);
          setCustomMessage(getDefaultMessageTemplate());
        } finally {
          setIsLoadingTemplates(false);
        }
      }
    };
    loadWhatsAppTemplates();
  }, [mode, whatsappTemplates.length]);

  useEffect(() => {
    const loadEmailTemplates = async () => {
      if (mode === "email" && emailTemplates.length === 0) {
        setIsLoadingEmailTemplates(true);
        try {
          const [templates, defaultTemplateName] = await Promise.all([fetchEmailTemplates(), getDefaultEmailTemplate()]);
          setEmailTemplates(templates);
          if (defaultTemplateName) {
            const defaultTemplate = templates.find((t) => t.name === defaultTemplateName);
            if (defaultTemplate) {
              setSelectedEmailTemplate(defaultTemplate);
              setEmailMessage(defaultTemplate.response_html || defaultTemplate.response);
            }
          } else {
            setEmailMessage(getDefaultEmailMessageTemplate());
          }
        } catch (error) {
          console.error("Error loading Email templates:", error);
          setEmailMessage(getDefaultEmailMessageTemplate());
        } finally {
          setIsLoadingEmailTemplates(false);
        }
      }
    };
    loadEmailTemplates();
  }, [mode, emailTemplates.length]);

  const handleTemplateChange = (templateName: string) => {
    const template = whatsappTemplates.find((t) => t.name === templateName);
    if (template) {
      setSelectedTemplate(template);
      setCustomMessage(template.template);
    }
  };

  const handleEmailTemplateChange = (templateName: string) => {
    const template = emailTemplates.find((t) => t.name === templateName);
    if (template) {
      setSelectedEmailTemplate(template);
      setEmailMessage(template.response_html || template.response);
    }
  };

  const getProcessedMessage = () => {
    const parameters: Record<string, string> = {
      customer_name: sharingData.name || "there",
      invoice_total: formatCurrencyWithSymbol(grandTotal, currencySymbol),
      invoice_number: invoiceData?.name || "",
      company_name: "KLiK PoS",
      date: new Date().toLocaleDateString(),
    };
    return processTemplate(customMessage, parameters);
  };

  const getProcessedEmailMessage = () => {
    const address = invoiceData?.customer_address_doc?.address_line1 || "";
    const parameters: Record<string, string | null> = {
      customer_name: sharingData.name || "Customer",
      customer: sharingData.name || "Customer",
      first_name: sharingData.name?.split(" ")[0] || "",
      last_name: sharingData.name?.split(" ").slice(1).join(" ") || "",
      address,
      customer_address: address,
      delivery_note: invoiceData?.name || "",
      grand_total: formatCurrencyWithSymbol(grandTotal, currencySymbol),
      departure_time: new Date().toLocaleTimeString(),
      estimated_arrival: new Date(Date.now() + 30 * 60000).toLocaleTimeString(),
      driver_name: "Delivery Driver",
      cell_number: "+1234567890",
      vehicle: "Delivery Vehicle",
      invoice_total: formatCurrencyWithSymbol(grandTotal, currencySymbol),
      invoice_number: invoiceData?.name || "",
      company_name: "KLiK PoS",
      date: new Date().toLocaleDateString(),
    };
    return processEmailTemplate(emailMessage, parameters);
  };

  const sendEmail = async () => {
    setIsSendingEmail(true);
    try {
      const { sendEmails } = await import("../../services/useSharing");
      await sendEmails({
        email: sharingData.email,
        customer_name: sharingData.name,
        invoice_data: invoiceData?.name || "",
        message: getProcessedEmailMessage(),
        sender: selectedSender || undefined,
      });
      toast.success("Email sent successfully!");
      onModeChange(null);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsSendingEmail(false);
    }
  };

  const sendWhatsApp = async () => {
    setIsSendingWhatsapp(true);
    try {
      const { sendWhatsAppMessage } = await import("../../services/useSharing");
      await sendWhatsAppMessage({
        mobile_no: sharingData.phone,
        customer_name: sharingData.name,
        invoice_data: invoiceData?.name || "",
        message: getProcessedMessage(),
      });
      alert("WhatsApp message sent successfully!");
      onModeChange(null);
    } catch (error: any) {
      alert(error.message);
    } finally {
      setIsSendingWhatsapp(false);
    }
  };

  const sendTelegram = async () => {
    setIsSendingTelegram(true);
    try {
      const { sendInvoiceTelegram } = await import("../../services/useSharing");
      await sendInvoiceTelegram({
        customer_name: invoiceData?.customer || "",
        invoice_name: invoiceData?.name || "",
      });
      toast.success("Invoice sent via Telegram!");
      onModeChange(null);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsSendingTelegram(false);
    }
  };

  const sendSMS = async () => {
    try {
      const { sendSMSMessage } = await import("../../services/useSharing");
      await sendSMSMessage({
        mobile_no: sharingData.phone,
        customer_name: sharingData.name,
        message: `Thank you for your purchase at KLiK PoS.\nInvoice Total: ${formatCurrencyWithSymbol(grandTotal, currencySymbol)}\nThank you!`,
      });
      alert("SMS sent successfully!");
      onModeChange(null);
    } catch (error: any) {
      alert(error.message);
    }
  };

  if (mode === "email") {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white capitalize">Share via Email</h3>
          <button onClick={() => onModeChange(null)} className="text-gray-500 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Customer Name</label>
            <input type="text" value={sharingData.name} onChange={(e) => setSharingData((prev) => ({ ...prev, name: e.target.value }))} className="w-full px-3 py-2 border rounded-lg" placeholder="Customer name" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Email Address</label>
            <input type="email" value={sharingData.email} onChange={(e) => setSharingData((prev) => ({ ...prev, email: e.target.value }))} className="w-full px-3 py-2 border rounded-lg" placeholder="customer@email.com" />
          </div>
          {outgoingAccounts.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Send From
              </label>
              <select
                value={selectedSender}
                onChange={(e) => setSelectedSender(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg"
              >
                {outgoingAccounts.map((account) => (
                  <option key={account.name} value={account.name}>
                    {account.default_sender}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email Message Preview</label>
              <button onClick={() => setIsEditingEmail(!isEditingEmail)} className="text-sm text-beveren-600">
                {isEditingEmail ? <Check className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
              </button>
            </div>
            {isEditingEmail && (
              <div className="space-y-3 mb-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Email Template</label>
                  {isLoadingEmailTemplates ? (
                    <div className="flex justify-center p-4">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : (
                    <select value={selectedEmailTemplate?.name || ""} onChange={(e) => handleEmailTemplateChange(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
                      <option value="">Select a template (optional)</option>
                      {emailTemplates.map((template) => (
                        <option key={template.name} value={template.name}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Custom Message</label>
                  <textarea value={emailMessage} onChange={(e) => setEmailMessage(e.target.value)} className="w-full px-3 py-2 border rounded-lg" rows={6} placeholder="Enter your email message..." />
                </div>
              </div>
            )}
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200">
              <p className="text-sm text-gray-600 mb-2">Subject: Your Invoice from KLiK PoS</p>
              <div className="text-sm text-gray-900 whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: getProcessedEmailMessage() }} />
            </div>
          </div>
          <button onClick={sendEmail} disabled={!sharingData.email || isSendingEmail || !modeEnabled} className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-300">
            {isSendingEmail ? "Sending..." : "Send Email"}
          </button>
          {!modeEnabled && (
            <div className="mt-2 text-sm text-red-600">
              Email server is not configured. Please set up email server in
              ERPNext to use this feature.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (mode === "whatsapp") {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white capitalize">Share via WhatsApp</h3>
          <button onClick={() => onModeChange(null)} className="text-gray-500 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Customer Name</label>
            <input type="text" value={sharingData.name} onChange={(e) => setSharingData((prev) => ({ ...prev, name: e.target.value }))} className="w-full px-3 py-2 border rounded-lg" placeholder="Customer name" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Phone Number</label>
            <input type="tel" value={sharingData.phone} onChange={(e) => setSharingData((prev) => ({ ...prev, phone: e.target.value }))} className="w-full px-3 py-2 border rounded-lg" placeholder="+254700000000" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">WhatsApp Message Preview</label>
              <button onClick={() => setIsEditingWhatsapp(!isEditingWhatsapp)} className="text-sm text-beveren-600">
                {isEditingWhatsapp ? <Check className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
              </button>
            </div>
            {isEditingWhatsapp && (
              <div className="space-y-3 mb-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">WhatsApp Template</label>
                  {isLoadingTemplates ? (
                    <div className="flex justify-center p-4">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : (
                    <select value={selectedTemplate?.name || ""} onChange={(e) => handleTemplateChange(e.target.value)} className="w-full px-3 py-2 border rounded-lg">
                      <option value="">Select a template (optional)</option>
                      {whatsappTemplates.map((template) => (
                        <option key={template.name} value={template.name}>
                          {template.template_name} - {template.category}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Custom Message</label>
                  <textarea value={customMessage} onChange={(e) => setCustomMessage(e.target.value)} className="w-full px-3 py-2 border rounded-lg" rows={4} placeholder="Enter your WhatsApp message..." />
                </div>
              </div>
            )}
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 border border-green-200">
              <div className="text-sm text-gray-900 whitespace-pre-wrap">{getProcessedMessage()}</div>
            </div>
          </div>
          <button onClick={sendWhatsApp} disabled={!sharingData.phone || isSendingWhatsapp || !modeEnabled} className="w-full py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:bg-gray-300">
            {isSendingWhatsapp ? "Sending..." : "Send WhatsApp Message"}
          </button>
          {!modeEnabled && (
            <div className="mt-2 text-sm text-red-600">
              WhatsApp integration is not configured. Please set up WhatsApp
              Business API in ERPNext to use this feature.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (mode === "telegram") {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white capitalize">Share via Telegram</h3>
          <button onClick={() => onModeChange(null)} className="text-gray-500 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Customer Name</label>
            <input type="text" value={sharingData.name} readOnly className="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-gray-700" placeholder="Customer name" />
          </div>
          {telegramDisplayName && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Linked Telegram contact: <span className="font-medium">{telegramDisplayName}</span>
            </p>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Message Preview</label>
            <div className="bg-sky-50 dark:bg-sky-900/20 rounded-lg p-4 border border-sky-200">
              <p className="text-sm text-gray-900">Invoice {invoiceData?.name} will be sent as a PDF attachment.</p>
            </div>
          </div>
          <button onClick={sendTelegram} disabled={isSendingTelegram || !modeEnabled} className="w-full py-3 bg-sky-600 text-white rounded-lg font-medium hover:bg-sky-700 disabled:bg-gray-300">
            {isSendingTelegram ? "Sending..." : "Send via Telegram"}
          </button>
          {!modeEnabled && (
            <div className="mt-2 text-sm text-red-600">
              This customer has no linked Telegram account. Link one from the customer profile to use this feature.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (mode === "sms") {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white capitalize">Share via SMS</h3>
          <button onClick={() => onModeChange(null)} className="text-gray-500 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Customer Name</label>
            <input type="text" value={sharingData.name} onChange={(e) => setSharingData((prev) => ({ ...prev, name: e.target.value }))} className="w-full px-3 py-2 border rounded-lg" placeholder="Customer name" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Phone Number</label>
            <input type="tel" value={sharingData.phone} onChange={(e) => setSharingData((prev) => ({ ...prev, phone: e.target.value }))} className="w-full px-3 py-2 border rounded-lg" placeholder="+254700000000" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">SMS Message Preview</label>
            <div className="bg-teal-50 dark:bg-teal-900/20 rounded-lg p-4 border border-teal-200">
              <div className="text-sm text-gray-900">
                <p>Hi {sharingData.name || "Customer"}!</p>
                <p className="mt-1">Thank you for your purchase at KLiK PoS.</p>
                <p className="mt-1">Invoice Total: {formatCurrencyWithSymbol(grandTotal, currencySymbol)}</p>
                <p className="mt-1">Thank you!</p>
              </div>
            </div>
          </div>
          <button onClick={sendSMS} disabled={!sharingData.phone || !modeEnabled} className="w-full py-3 bg-teal-600 text-white rounded-lg font-medium hover:bg-teal-700 disabled:bg-gray-300">
            Send SMS
          </button>
          {!modeEnabled && (
            <div className="mt-2 text-sm text-red-600">
              SMS gateway is not configured. Please set up SMS gateway in
              ERPNext to use this feature.
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
