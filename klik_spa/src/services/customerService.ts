interface CustomerAddress {
  addressType?: string;
  street: string;
  buildingNumber?: string;
  city: string;
  state?: string;
  zipCode?: string;
  country: string;
}

interface CustomerData {
  name: string;
  customer_type: string;
  email: string;
  phone: string;
  taxId?: string;
  name_arabic?: string;
  address: CustomerAddress;
  preferredPaymentMethod?: string;
  contactName?: string;
  vatNumber?: string;
  registrationScheme?: string;
  registrationNumber?: string;
  customer_group?: string;
  territory?: string;
}

export interface TelegramContact {
  telegram_user_id: string;
  telegram_username?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  is_bot?: boolean;
  is_group?: boolean;
  from_live_search?: boolean;
}

export interface TelegramLinkResult {
  success: boolean;
  message: string;
  telegram_contact_id?: string;
  telegram_display_name?: string;
}

export interface CustomerTelegramLink {
  success: boolean;
  linked: boolean;
  telegram_contact_id?: string;
  telegram_display_name?: string;
  is_group_chat?: number;
  linked_by?: string;
  message?: string;
}

export const useCustomerActions = () => {
  const csrfToken = window.csrf_token;

  const createCustomer = async (customerData: CustomerData) => {
    try {
      const response = await fetch('/api/method/klik_pos.api.customer.create_or_update_customer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
           "X-Frappe-CSRF-Token": csrfToken,

        },
        body: JSON.stringify({ customer_data: customerData }),
        credentials: 'include'
      });

      const result = await response.json();

      if (!result.message || !result.message.success) {
        throw new Error(result.message?.error || "Customer creation failed");
      }

      return result.message;
    } catch (error) {
      console.error("❌ Error creating customer:", error);
      throw error;
    }
  };

  const updateCustomer = async (customerId: string, customerData: Partial<CustomerData>) => {
    try {
      const response = await fetch('/api/method/klik_pos.api.customer.update_customer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
             "X-Frappe-CSRF-Token": csrfToken,

        },
        body: JSON.stringify({
          customer_id: customerId,
          customer_data: customerData
        }),
        credentials: 'include'

      });

      const result = await response.json();

      if (!result.message || !result.message.success) {
        throw new Error(result.message?.error || "Customer update failed");
      }

      return result.message;
    } catch (error) {
      console.error("❌ Error updating customer:", error);
      throw error;
    }
  };

  const getCustomerGroups = async () => {
    try {
      const response = await fetch('/api/method/klik_pos.api.customer.get_customer_groups', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include'
      });

      const result = await response.json();

      if (!result.message || !result.message.success) {
        throw new Error(result.message?.error || "Failed to fetch customer groups");
      }

      return result.message.data;
    } catch (error) {
      console.error("❌ Error fetching customer groups:", error);
      throw error;
    }
  };

  const getTerritories = async () => {
    try {
      const response = await fetch('/api/method/klik_pos.api.customer.get_territories', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include'
      });

      const result = await response.json();

      if (!result.message || !result.message.success) {
        throw new Error(result.message?.error || "Failed to fetch territories");
      }

      return result.message.data;
    } catch (error) {
      console.error("❌ Error fetching territories:", error);
      throw error;
    }
  };

  const searchTelegramContact = async (searchQuery: string, searchType: 'phone' | 'username' | 'name' | 'all' = 'all'): Promise<{ success: boolean; contacts: TelegramContact[]; message: string }> => {
    try {
      const response = await fetch('/api/method/erpnext_telegram_integration.telegram_api.search_telegram_contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Frappe-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          search_query: searchQuery,
          search_type: searchType
        }),
        credentials: 'include'
      });

      const result = await response.json();
      return result.message || { success: false, contacts: [], message: 'Unknown error' };
    } catch (error) {
      console.error("❌ Error searching Telegram contacts:", error);
      return { success: false, contacts: [], message: String(error) };
    }
  };

  const linkTelegramToCustomer = async (
    customerName: string,
    telegramUserId: string,
    options?: {
      telegramDisplayName?: string;
      telegramUsername?: string;
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      isGroup?: number;
    }
  ): Promise<TelegramLinkResult> => {
    try {
      const response = await fetch('/api/method/erpnext_telegram_integration.telegram_api.link_telegram_to_customer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Frappe-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          customer_name: customerName,
          telegram_user_id: telegramUserId,
          telegram_display_name: options?.telegramDisplayName || '',
          telegram_username: options?.telegramUsername || '',
          first_name: options?.firstName || '',
          last_name: options?.lastName || '',
          phone_number: options?.phoneNumber || '',
          is_group: options?.isGroup || 0
        }),
        credentials: 'include'
      });

      const result = await response.json();
      return result.message || { success: false, message: 'Unknown error' };
    } catch (error) {
      console.error("❌ Error linking Telegram to customer:", error);
      return { success: false, message: String(error) };
    }
  };

  const getCustomerTelegramLink = async (customerName: string): Promise<CustomerTelegramLink> => {
    try {
      const response = await fetch('/api/method/erpnext_telegram_integration.telegram_api.get_customer_telegram_link', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Frappe-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          customer_name: customerName
        }),
        credentials: 'include'
      });

      const result = await response.json();
      return result.message || { success: false, linked: false, message: 'Unknown error' };
    } catch (error) {
      console.error("❌ Error getting customer Telegram link:", error);
      return { success: false, linked: false, message: String(error) };
    }
  };

  return {
    createCustomer,
    updateCustomer,
    getCustomerGroups,
    getTerritories,
    searchTelegramContact,
    linkTelegramToCustomer,
    getCustomerTelegramLink
  };
};
