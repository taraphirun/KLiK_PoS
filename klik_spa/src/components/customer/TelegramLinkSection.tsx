import { useEffect, useState } from "react";
import { MessageCircle, Check, Loader2, Search, Link } from "lucide-react";
import { toast } from "react-toastify";
import { useCustomerActions, type TelegramContact } from "../../services/customerService";

interface LinkedContact {
  telegram_contact_id: string;
  telegram_display_name: string;
}

interface TelegramLinkSectionProps {
  /** Existing customer id when editing. Enables immediate linking and loads any existing link. */
  customerId?: string;
  /**
   * Reports the contact the user selected but that has not been linked yet
   * (new-customer flow). The parent links it once the customer is created.
   */
  onPendingContactChange?: (contact: TelegramContact | null) => void;
}

const getDisplayName = (contact: TelegramContact): string =>
  [contact.first_name, contact.last_name].filter(Boolean).join(" ") ||
  (contact.telegram_username ? `@${contact.telegram_username}` : `User ${contact.telegram_user_id}`);

export default function TelegramLinkSection({
  customerId,
  onPendingContactChange,
}: TelegramLinkSectionProps) {
  const { searchTelegramContact, linkTelegramToCustomer, getCustomerTelegramLink } = useCustomerActions();

  const [telegramSearch, setTelegramSearch] = useState("");
  const [telegramSearchType, setTelegramSearchType] = useState<"all" | "phone" | "username" | "name">("all");
  const [searchResults, setSearchResults] = useState<TelegramContact[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [linkedContact, setLinkedContact] = useState<LinkedContact | null>(null);
  const [selectedContact, setSelectedContact] = useState<TelegramContact | null>(null);

  // Load an existing Telegram link when editing.
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getCustomerTelegramLink(customerId);
        if (!cancelled && result.success && result.linked) {
          setLinkedContact({
            telegram_contact_id: result.telegram_contact_id!,
            telegram_display_name: result.telegram_display_name!,
          });
        }
      } catch (error) {
        console.error("Error loading Telegram link:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const handleSearch = async () => {
    if (!telegramSearch.trim()) {
      toast.error("Please enter a phone number, username, or name to search");
      return;
    }
    setIsSearching(true);
    setSearchResults([]);
    try {
      const result = await searchTelegramContact(telegramSearch, telegramSearchType);
      if (result.success) {
        setSearchResults(result.contacts);
        if (result.contacts.length === 0) {
          toast.info("No Telegram contacts found");
        }
      } else {
        toast.error(result.message || "Search failed");
      }
    } catch {
      toast.error("Error searching Telegram contacts");
    } finally {
      setIsSearching(false);
    }
  };

  const linkContactNow = async (customerName: string, contact: TelegramContact) => {
    setIsLinking(true);
    try {
      const displayName = getDisplayName(contact);
      const result = await linkTelegramToCustomer(customerName, contact.telegram_user_id, {
        telegramDisplayName: displayName,
        telegramUsername: contact.telegram_username,
        firstName: contact.first_name,
        lastName: contact.last_name,
        phoneNumber: contact.phone_number,
        isGroup: contact.is_group ? 1 : 0,
      });
      if (result.success) {
        setLinkedContact({
          telegram_contact_id: result.telegram_contact_id || contact.telegram_user_id,
          telegram_display_name: result.telegram_display_name || displayName,
        });
        setSelectedContact(null);
        setSearchResults([]);
        toast.success(`Linked to Telegram: ${displayName}`);
      } else {
        toast.error(result.message || "Failed to link Telegram contact");
      }
    } catch {
      toast.error("Error linking Telegram contact");
    } finally {
      setIsLinking(false);
    }
  };

  const handleSelectContact = (contact: TelegramContact) => {
    if (customerId) {
      // Editing an existing customer: link immediately.
      linkContactNow(customerId, contact);
    } else {
      // New customer: defer linking until the customer is created.
      setSelectedContact(contact);
      setSearchResults([]);
      onPendingContactChange?.(contact);
      toast.success(`Selected: ${getDisplayName(contact)}`);
    }
  };

  const handleRemoveLinked = () => {
    setLinkedContact(null);
    setSelectedContact(null);
    onPendingContactChange?.(null);
  };

  const handleClearSelected = () => {
    setSelectedContact(null);
    onPendingContactChange?.(null);
  };

  return (
    <div className="bg-sky-50 dark:bg-sky-900/20 rounded-lg p-4 border border-sky-200 dark:border-sky-700">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
        <MessageCircle size={20} className="mr-2 text-sky-500" />
        Link Telegram Contact
        <span className="text-sm font-normal text-gray-500 ml-2">(Optional)</span>
      </h3>

      {/* Linked contact (green badge) */}
      {linkedContact && (
        <div className="mb-4 p-3 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-between">
          <div className="flex items-center">
            <Check size={18} className="text-green-600 mr-2" />
            <span className="text-green-800 dark:text-green-200">
              Linked to: <strong>{linkedContact.telegram_display_name}</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={handleRemoveLinked}
            className="text-red-500 hover:text-red-700 text-sm"
          >
            Remove
          </button>
        </div>
      )}

      {/* Selected contact, pending link on save */}
      {selectedContact && !linkedContact && (
        <div className="mb-4 p-3 bg-sky-100 dark:bg-sky-900/30 rounded-lg flex items-center justify-between">
          <div className="flex items-center">
            <Check size={18} className="text-sky-600 mr-2" />
            <span className="text-sky-800 dark:text-sky-200">
              Selected: <strong>{getDisplayName(selectedContact)}</strong>
              {selectedContact.phone_number && (
                <span className="text-gray-500 ml-2">({selectedContact.phone_number})</span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={handleClearSelected}
            className="text-red-500 hover:text-red-700 text-sm"
          >
            Clear
          </button>
        </div>
      )}

      {/* Search */}
      {!linkedContact && !selectedContact && (
        <>
          <div className="flex flex-col md:flex-row gap-2 mb-3">
            <div className="flex-1">
              <input
                type="text"
                value={telegramSearch}
                onChange={(e) => setTelegramSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
                placeholder="Search by phone, @username, or name..."
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 dark:bg-gray-700 dark:text-white"
              />
            </div>
            <select
              value={telegramSearchType}
              onChange={(e) => setTelegramSearchType(e.target.value as "all" | "phone" | "username" | "name")}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 dark:bg-gray-700 dark:text-white"
            >
              <option value="all">All</option>
              <option value="phone">Phone</option>
              <option value="username">Username</option>
              <option value="name">Name</option>
            </select>
            <button
              type="button"
              onClick={handleSearch}
              disabled={isSearching || !telegramSearch.trim()}
              className="px-4 py-2 bg-sky-500 text-white rounded-lg hover:bg-sky-600 transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSearching ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
            </button>
          </div>

          {/* Autocomplete results */}
          {searchResults.length > 0 && (
            <div className="mt-3 border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden">
              <div className="max-h-48 overflow-y-auto">
                {searchResults.map((contact, index) => (
                  <div
                    key={contact.telegram_user_id || index}
                    className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-600 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-gray-900 dark:text-white">
                        {getDisplayName(contact)}
                        {contact.from_live_search && (
                          <span className="ml-2 text-xs bg-sky-100 text-sky-700 px-2 py-0.5 rounded">Live</span>
                        )}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 flex flex-wrap gap-2">
                        {contact.telegram_username && <span>@{contact.telegram_username}</span>}
                        {contact.phone_number && <span>{contact.phone_number}</span>}
                        {contact.is_bot && <span className="text-orange-500">[Bot]</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectContact(contact)}
                      disabled={isLinking}
                      className="ml-3 px-3 py-1.5 bg-sky-500 text-white text-sm rounded-lg hover:bg-sky-600 transition-colors flex items-center disabled:opacity-50"
                    >
                      {isLinking ? (
                        <Loader2 size={14} className="animate-spin mr-1" />
                      ) : (
                        <Link size={14} className="mr-1" />
                      )}
                      {customerId ? "Link" : "Select"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {customerId
              ? "Search your synced Telegram contacts to link one to this customer."
              : "Search your synced Telegram contacts. The contact will be linked after saving the customer."}
          </p>
        </>
      )}
    </div>
  );
}
