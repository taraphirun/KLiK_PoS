import React, { useState, useEffect, useRef } from "react";
import {
  X,
  User,
  Mail,
  MapPin,
  CreditCard,
  Building,
  Save,
  Search,
  Link,
  Check,
  Loader2,
  MessageCircle,
} from "lucide-react";
import { type Customer } from "../types/customer";

// Extended customer type for form data
type ExtendedCustomer = Customer & {
  address: Customer['address'] & {
    addressType?: string;
    buildingNumber?: string;
  };
};
import { useCustomerActions, type TelegramContact } from "../services/customerService";
import { toast } from "react-toastify";
import { usePOSDetails } from "../hooks/usePOSProfile";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import countryList from "react-select-country-list";
type CountryOption = { value: string; label: string };
interface AddCustomerModalProps {
  customer?: Customer | null;
  onClose: () => void;
  onSave: (customer: Partial<Customer>) => void;
  isFullPage?: boolean;
  prefilledName?: string;
  prefilledData?: { name?: string; email?: string; phone?: string };
}

export default function AddCustomerModal({
  customer,
  onClose,
  onSave,
  isFullPage = false,
  prefilledName = "",
  prefilledData = {},
}: AddCustomerModalProps) {
  const { createCustomer, updateCustomer, searchTelegramContact, linkTelegramToCustomer, getCustomerTelegramLink } = useCustomerActions();
  const isEditing = !!customer;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { posDetails } = usePOSDetails();

  const countryOptions: CountryOption[] = countryList().getData();

  const [formData, setFormData] = useState({
    customer_type: "individual" as Customer["type"],
    name: "",
    contactName: "Same as Customer Name",
    email: "",
    phone: "",
    address: {
      addressType: "Billing",
      street: "Siem Reap",
      buildingNumber: "",
      city: "Siem Reap",
      state: "",
      zipCode: "",
      country: "Cambodia",
    },
    status: "active" as Customer["status"],
    vatNumber: "",
    registrationScheme: "",
    registrationNumber: "",
    preferredPaymentMethod: "Cash" as Customer["preferredPaymentMethod"],
    customer_group: "All Customer Groups",
    territory: "All Territories",
  });

  // Set customer type based on POS Profile business type when component mounts
  useEffect(() => {
    if (posDetails && !isEditing) {
      let defaultCustomerType: Customer["type"] = "company";

      if (posDetails.business_type === "B2B") {
        defaultCustomerType = "company";
      } else if (posDetails.business_type === "B2C") {
        defaultCustomerType = "individual";
      } else if (posDetails.business_type === "B2B & B2C") {
        defaultCustomerType = "individual";
      }

      setFormData((prev) => ({ ...prev, customer_type: defaultCustomerType }));

    }
  }, [posDetails, isEditing]);


  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customerGroups, setCustomerGroups] = useState<Array<{name: string, customer_group_name: string}>>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [territories, setTerritories] = useState<Array<{name: string, territory_name: string}>>([]);
  const [loadingTerritories, setLoadingTerritories] = useState(true);
  const { getCustomerGroups, getTerritories } = useCustomerActions();
  const formInitializedRef = useRef(false);

  // Telegram linking state
  const [telegramSearch, setTelegramSearch] = useState('');
  const [telegramSearchType, setTelegramSearchType] = useState<'all' | 'phone' | 'username' | 'name'>('all');
  const [telegramSearchResults, setTelegramSearchResults] = useState<TelegramContact[]>([]);
  const [isSearchingTelegram, setIsSearchingTelegram] = useState(false);
  const [linkedTelegramContact, setLinkedTelegramContact] = useState<{
    telegram_contact_id: string;
    telegram_display_name: string;
  } | null>(null);
  const [isLinkingTelegram, setIsLinkingTelegram] = useState(false);
  const [selectedTelegramContact, setSelectedTelegramContact] = useState<TelegramContact | null>(null);

  // Auto-detected Telegram contact from phone number
  const [phoneMatchedTelegram, setPhoneMatchedTelegram] = useState<TelegramContact | null>(null);
  const [isCheckingPhoneTelegram, setIsCheckingPhoneTelegram] = useState(false);
  const phoneCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Watch phone number and auto-search Telegram
  useEffect(() => {
    // Clear previous timeout
    if (phoneCheckTimeoutRef.current) {
      clearTimeout(phoneCheckTimeoutRef.current);
    }

    // Don't search if already linked or phone is too short
    const phoneDigits = formData.phone.replace(/\D/g, '');
    if (linkedTelegramContact || selectedTelegramContact || phoneDigits.length < 10) {
      setPhoneMatchedTelegram(null);
      return;
    }

    // Debounce the search
    phoneCheckTimeoutRef.current = setTimeout(async () => {
      setIsCheckingPhoneTelegram(true);
      try {
        const result = await searchTelegramContact(formData.phone, 'phone');
        if (result.success && result.contacts.length > 0 && result.contacts[0]) {
          // Found a matching contact
          setPhoneMatchedTelegram(result.contacts[0]);
        } else {
          setPhoneMatchedTelegram(null);
        }
      } catch {
        setPhoneMatchedTelegram(null);
      } finally {
        setIsCheckingPhoneTelegram(false);
      }
    }, 500); // 500ms debounce

    return () => {
      if (phoneCheckTimeoutRef.current) {
        clearTimeout(phoneCheckTimeoutRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.phone, linkedTelegramContact, selectedTelegramContact]);

  // Fetch customer groups and territories
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch customer groups
        const groupsData = await getCustomerGroups();
        setCustomerGroups(groupsData);
        setLoadingGroups(false);

        // Fetch territories
        const territoriesData = await getTerritories();
        setTerritories(territoriesData);
        setLoadingTerritories(false);
      } catch (error) {
        console.error('Error fetching customer groups or territories:', error);
        setLoadingGroups(false);
        setLoadingTerritories(false);
      }
    };

    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty - only run once on mount

  useEffect(() => {
    if (customer && !formInitializedRef.current) {
      const newFormData = {
        customer_type: customer.type || "individual",
        name: customer.name,
        contactName: customer.contactPerson || "Same as Customer Name",
        email: customer.email,
        phone: customer.phone,
        address: {
          addressType: (customer.address as ExtendedCustomer['address'])?.addressType || "Billing",
          street: customer.address?.street || "Siem Reap",
          buildingNumber: (customer.address as ExtendedCustomer['address'])?.buildingNumber || "",
          city: customer.address?.city || "Siem Reap",
          state: customer.address?.state || "",
          zipCode: customer.address?.zipCode || "",
          country: customer.address?.country || "Cambodia",
        },
        status: customer.status,
        vatNumber: customer.taxId || "",
        registrationScheme: customer.registrationScheme || "",
        registrationNumber: customer.registrationNumber || "",
        preferredPaymentMethod: customer.preferredPaymentMethod || "Cash",
        customer_group: customer.customer_group || "All Customer Groups",
        territory: customer.territory || "Cambodia",
      };
      setFormData(newFormData);
      formInitializedRef.current = true;
    } else if (prefilledData && Object.keys(prefilledData).length > 0 && !formInitializedRef.current) {
      setFormData((prev) => ({
        ...prev,
        name: prefilledData.name || prev.name,
        email: prefilledData.email || prev.email,
        phone: prefilledData.phone || prev.phone,
      }));
      formInitializedRef.current = true;
    } else if (prefilledName && !formInitializedRef.current) {
      // Fallback to old prefilledName prop
      setFormData((prev) => ({
        ...prev,
        name: prefilledName,
      }));
      formInitializedRef.current = true;
    }
  }, [customer?.id, customer?.name, prefilledName, prefilledData, customer]); // Only depend on stable customer properties

  // Reset form initialization when customer changes
  useEffect(() => {
    formInitializedRef.current = false;
  }, [customer?.id]);

  const isB2B = posDetails?.business_type === "B2B";
  const isB2C = posDetails?.business_type === "B2C";
  const isBoth = posDetails?.business_type === "B2B & B2C";

  // Available customer types based on business type
  const getAvailableCustomerTypes = () => {
    if (isB2B)
      return [
        {
          value: "company",
          label: "Company",
          icon: Building,
          desc: "Business customer",
        },
      ];
    if (isB2C)
      return [
        {
          value: "individual",
          label: "Individual",
          icon: User,
          desc: "Personal customer",
        },
      ];
    if (isBoth)
      return [
        {
          value: "individual",
          label: "Individual",
          icon: User,
          desc: "Personal customer",
        },
        {
          value: "company",
          label: "Company",
          icon: Building,
          desc: "Business customer",
        },
      ];
    return [
      {
        value: "individual",
        label: "Individual",
        icon: User,
        desc: "Personal customer",
      },
      {
        value: "company",
        label: "Company",
        icon: Building,
        desc: "Business customer",
      },
    ];
  };

  // Validate form data
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Helper function to validate phone number (minimum 10 digits including country code)
    const isValidPhone = (phone: string): boolean => {
      if (!phone.trim()) return false;
      // Remove all non-digit characters and check if it has at least 10 digits
      const digitsOnly = phone.replace(/\D/g, '');
      return digitsOnly.length >= 10;
    };

    // Basic validation
    if (formData.customer_type === "company") {
      if (!formData.name.trim()) {
        newErrors.name = "Customer name is required";
      }
      if (!formData.contactName.trim()) {
        newErrors.contactName = "Contact name is required";
      }
      if (!formData.email.trim() && !formData.phone.trim()) {
        newErrors.contact = "Either email or phone number must be provided";
      }
      if (formData.phone.trim() && !isValidPhone(formData.phone)) {
        newErrors.phone = "Phone number must have at least 10 digits including country code";
      }
    } else if (formData.customer_type === "individual") {
      if (!formData.email.trim() && !formData.phone.trim()) {
        newErrors.contact = "Either email or phone number must be provided";
      } else if (formData.phone.trim() && !isValidPhone(formData.phone)) {
        newErrors.phone = "Phone number must have at least 10 digits including country code";
      }
    }

    // Email format validation if provided
    if (
      formData.email.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)
    ) {
      newErrors.email = "Please enter a valid email address";
    }

    // ZATCA validation for company (only when ZATCA is enabled)
    if (formData.customer_type === "company" && posDetails?.is_zatca_enabled) {
      if (!formData.vatNumber.trim() && !formData.registrationNumber.trim()) {
        newErrors.vatOrRegistration =
          "Either VAT number or Registration number must be provided";
      }

      if (formData.registrationScheme && formData.registrationScheme !== "" && !formData.registrationNumber.trim()) {
        newErrors.registrationNumber =
          "Registration number is required when registration scheme is selected";
      }
      if (formData.vatNumber.trim()) {
        if (!/^[3]\d{13}[3]$/.test(formData.vatNumber.trim())) {
          newErrors.vatNumber =
            "VAT number must be 15 digits, start with 3 and end with 3 (ZATCA format)";
        }
      }
    }

    // Address validation for company customers (mandatory only when ZATCA is enabled)
    if (formData.customer_type === "company" && posDetails && posDetails.is_zatca_enabled === true) {
      if (!formData.address.street.trim()) {
        newErrors.street = "Street address is required for company";
      }
      if (!formData.address.buildingNumber.trim()) {
        newErrors.buildingNumber = "Building number is required for company";
      } else if (formData.address.buildingNumber.trim().length !== 4) {
        newErrors.buildingNumber = "Building number must be exactly 4 digits";
      }
      if (!formData.address.city.trim()) {
        newErrors.city = "City is required for company";
      }
      if (!formData.address.state.trim()) {
        newErrors.state = "State/Province is required for company";
      }
      if (!formData.address.zipCode.trim()) {
        newErrors.zipCode = "Zip code is required for company";
      }
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      const firstErrorKey = Object.keys(newErrors)[0];
      if (firstErrorKey) {
        toast.error(newErrors[firstErrorKey]);
      }
      return false;
    }

    return true;
  };

  // Telegram search handler
  const handleTelegramSearch = async () => {
    if (!telegramSearch.trim()) {
      toast.error('Please enter a phone number, username, or name to search');
      return;
    }

    setIsSearchingTelegram(true);
    setTelegramSearchResults([]);

    try {
      const result = await searchTelegramContact(telegramSearch, telegramSearchType);
      if (result.success) {
        setTelegramSearchResults(result.contacts);
        if (result.contacts.length === 0) {
          toast.info('No Telegram contacts found');
        }
      } else {
        toast.error(result.message || 'Search failed');
      }
    } catch {
      toast.error('Error searching Telegram contacts');
    } finally {
      setIsSearchingTelegram(false);
    }
  };

  // Link Telegram contact to customer (called after customer is created)
  const handleLinkTelegramContact = async (customerName: string, contact: TelegramContact) => {
    setIsLinkingTelegram(true);
    try {
      const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 
                          (contact.telegram_username ? `@${contact.telegram_username}` : `User ${contact.telegram_user_id}`);
      
      const result = await linkTelegramToCustomer(customerName, contact.telegram_user_id, {
        telegramDisplayName: displayName,
        telegramUsername: contact.telegram_username,
        firstName: contact.first_name,
        lastName: contact.last_name,
        phoneNumber: contact.phone_number,
        isGroup: contact.is_group ? 1 : 0
      });

      if (result.success) {
        setLinkedTelegramContact({
          telegram_contact_id: result.telegram_contact_id || contact.telegram_user_id,
          telegram_display_name: result.telegram_display_name || displayName
        });
        toast.success(`Linked to Telegram: ${displayName}`);
        return true;
      } else {
        toast.error(result.message || 'Failed to link Telegram contact');
        return false;
      }
    } catch {
      toast.error('Error linking Telegram contact');
      return false;
    } finally {
      setIsLinkingTelegram(false);
    }
  };

  const handleSelectTelegramContact = (contact: TelegramContact) => {
    setSelectedTelegramContact(contact);
    setPhoneMatchedTelegram(null); // Clear phone match when manually selecting
    const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 
                        (contact.telegram_username ? `@${contact.telegram_username}` : `User ${contact.telegram_user_id}`);
    toast.success(`Selected: ${displayName}`);
  };

  // Quick link from phone number match
  const handleQuickLinkFromPhone = () => {
    if (phoneMatchedTelegram) {
      handleSelectTelegramContact(phoneMatchedTelegram);
    }
  };

  // Load existing Telegram link when editing
  useEffect(() => {
    const loadTelegramLink = async () => {
      if (isEditing && customer?.id) {
        try {
          const result = await getCustomerTelegramLink(customer.id);
          if (result.success && result.linked) {
            setLinkedTelegramContact({
              telegram_contact_id: result.telegram_contact_id!,
              telegram_display_name: result.telegram_display_name!
            });
          }
        } catch (error) {
          console.error('Error loading Telegram link:', error);
        }
      }
    };
    loadTelegramLink();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, customer?.id]); // Only reload when customer changes


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    // Validate form
    if (!validateForm()) return;
    setIsSubmitting(true);

    try {
      const customerData = {
        name: formData.name,
        customer_type: formData.customer_type === "individual" ? "Individual" : "Company",
        email: formData.email,
        phone: formData.phone,
        address: formData.address,
        preferredPaymentMethod: formData.preferredPaymentMethod,
        customer_group: formData.customer_group,
        territory: formData.territory,
        ...(formData.customer_type === "company" && {
          contactName: formData.contactName,
          vatNumber: formData.vatNumber || undefined,
          registrationScheme: formData.registrationScheme || undefined,
          registrationNumber: formData.registrationNumber || undefined,
        }),
      };

      if (isEditing && customer?.id) {
        const updatedCustomer = await updateCustomer(customer.id, customerData);
        
        // Link Telegram contact if selected (for editing)
        if (selectedTelegramContact) {
          await handleLinkTelegramContact(customer.id, selectedTelegramContact);
        }
        
        onSave({
          ...updatedCustomer,
          id: customer.id,
        });
      } else {
        const newCustomer = await createCustomer(customerData);
        
        // Link Telegram contact if selected (for new customer)
        if (selectedTelegramContact && newCustomer.customer_name) {
          await handleLinkTelegramContact(newCustomer.customer_name, selectedTelegramContact);
        }
        
        onSave({
          ...newCustomer,
          id: newCustomer.customer_name,
          name: formData.name,
          type: formData.customer_type,
          email: formData.email,
          phone: formData.phone,
          address: formData.address,
          preferredPaymentMethod: formData.preferredPaymentMethod,
          customer_group: formData.customer_group,
          territory: formData.territory,
        });
      }

      onClose();
    } catch (error) {
      console.error("Customer save error:", error);
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Failed to save customer. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const registrationSchemes = [
    {
      value: "Commercial Registration number(CRN)",
      label: "Commercial Registration number(CRN)",
    },
    { value: "MOMRAH(MOM)", label: "MOMRAH(MOM)" },
    { value: "MHRSD(MLS)", label: "MHRSD(MLS)" },
    { value: "700(700)", label: "700(700)" },
    { value: "MISA(SAG)", label: "MISA(SAG)" },
    { value: "Other OD(OTH)", label: "Other OD(OTH)" },
  ];


  const paymentMethods = [
    { value: "Cash", label: "Cash" },
    { value: "Bank Card", label: "Bank Card" },
    { value: "Bank Payment", label: "Bank Payment" },
    { value: "Credit", label: "Credit" },
  ];

  const addressTypes = [
    { value: "Billing", label: "Billing" },
    { value: "Shipping", label: "Shipping" },
    { value: "Office", label: "Office" },
    { value: "Personal", label: "Personal" },
    { value: "Plant", label: "Plant" },
    { value: "Postal", label: "Postal" },
    { value: "Shop", label: "Shop" },
    { value: "Subsidiary", label: "Subsidiary" },
    { value: "Warehouse", label: "Warehouse" },
    { value: "Current", label: "Current" },
    { value: "Permanent", label: "Permanent" },
    { value: "Other", label: "Other" },
  ];

  const availableCustomerTypes = getAvailableCustomerTypes();

  // Check if customer can be saved
  const canSaveCustomer = (): boolean => {
    // Helper function to validate phone number (minimum 10 digits including country code)
    const isValidPhone = (phone: string): boolean => {
      if (!phone.trim()) return false;
      // Remove all non-digit characters and check if it has at least 10 digits
      const digitsOnly = phone.replace(/\D/g, '');
      return digitsOnly.length >= 10;
    };

    if (formData.customer_type === "individual") {
      // For individual customers, at least email or valid phone must be provided
      const hasValidEmail = formData.email.trim() !== "";
      const hasValidPhone = isValidPhone(formData.phone);
      return hasValidEmail || hasValidPhone;
    } else if (formData.customer_type === "company") {
      // For company customers, basic fields are always required
      const hasBasicFields = (
        formData.name.trim() !== "" &&
        formData.contactName.trim() !== "" &&
        (formData.email.trim() !== "" || isValidPhone(formData.phone))
      );

      // Address fields are only required when ZATCA is enabled
      const hasAddressFields = !posDetails?.is_zatca_enabled || (
        formData.address.street.trim() !== "" &&
        formData.address.buildingNumber.trim() !== "" &&
        formData.address.buildingNumber.trim().length === 4 &&
        formData.address.city.trim() !== "" &&
        formData.address.state.trim() !== "" &&
        formData.address.zipCode.trim() !== ""
      );

      const hasRequiredFields = hasBasicFields && hasAddressFields;

      // If ZATCA is enabled, also check VAT or registration number
      // Only check ZATCA if posDetails is loaded and ZATCA is explicitly enabled
      if (posDetails && posDetails.is_zatca_enabled === true) {
        const hasZatcaData = formData.vatNumber.trim() !== "" || formData.registrationNumber.trim() !== "";
        return hasRequiredFields && hasZatcaData;
      }

      return hasRequiredFields;
    }
    return false;
  };


  return (
    <div
      className={
        isFullPage
          ? "h-full"
          : "fixed inset-0 bg-black/70 bg-opacity-50 flex items-center justify-center p-4 z-50"
      }
    >
      <div
        className={
          isFullPage
            ? "h-full bg-white dark:bg-gray-800 flex flex-col"
            : "bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        }
      >
        {/* Header */}
        {!isFullPage && (
          <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {isEditing ? "Edit Customer" : "Add New Customer"}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              <X size={24} />
            </button>
          </div>
        )}


        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className={
            isFullPage
              ? "flex-1 flex flex-col"
              : "flex flex-col h-full"
          }
        >
          <div className={
            isFullPage
              ? "flex-1 p-6 space-y-6 overflow-y-auto"
              : "flex-1 p-6 space-y-6 overflow-y-auto"
          }>
          {/* Customer Type & Basic Information */}
          <div>
            {/* Customer Type Selection - Only show if B2B & B2C business type */}
            {posDetails?.business_type === "B2B & B2C" ? (
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Customer Type
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {availableCustomerTypes.map((type) => {
                    const IconComponent = type.icon;
                    return (
                      <label
                        key={type.value}
                        className={`relative flex flex-col items-center p-4 border-2 rounded-lg cursor-pointer transition-all hover:bg-gray-50 dark:hover:bg-gray-700 ${
                          formData.customer_type === type.value
                            ? "border-beveren-500 bg-beveren-50 dark:bg-beveren-900/20"
                            : "border-gray-200 dark:border-gray-600"
                        }`}
                      >
                        <input
                          type="radio"
                          name="customerType"
                          value={type.value}
                          checked={formData.customer_type === type.value}
                          onChange={(e) => {
                            setFormData((prev) => ({
                              ...prev,
                              customer_type: e.target
                                .value as Customer["type"],
                            }));
                          }}
                          className="sr-only"
                        />
                        <IconComponent
                          size={24}
                          className={`mb-2 ${
                            formData.customer_type === type.value
                              ? "text-beveren-600"
                              : "text-gray-400"
                          }`}
                        />
                        <span
                          className={`font-medium text-sm ${
                            formData.customer_type === type.value
                              ? "text-beveren-900 dark:text-beveren-100"
                              : "text-gray-900 dark:text-white"
                          }`}
                        >
                          {type.label}
                        </span>
                        <span
                          className={`text-xs text-center mt-1 ${
                            formData.customer_type === type.value
                              ? "text-beveren-700 dark:text-beveren-300"
                              : "text-gray-500 dark:text-gray-400"
                          }`}
                        >
                          {type.desc}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* Show current customer type when automatically determined */
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Customer Type
                </h3>
                <div className="bg-beveren-50 dark:bg-beveren-900/20 border-2 border-beveren-500 rounded-lg p-4">
                  <div className="flex items-center">
                    {formData.customer_type === "company" ? (
                      <Building size={24} className="text-beveren-600 mr-3" />
                    ) : (
                      <User size={24} className="text-beveren-600 mr-3" />
                    )}
                    <div>
                      <span className="font-medium text-beveren-900 dark:text-beveren-100">
                        {formData.customer_type === "company"
                          ? "Company"
                          : "Individual"}{" "}
                        Customer
                      </span>
                      <p className="text-sm text-beveren-700 dark:text-beveren-300 mt-1">
                        {formData.customer_type === "company"
                          ? "Business customer (B2B)"
                          : "Personal customer (B2C)"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                <User size={20} className="mr-2" />
                Basic Information
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="name"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Customer Name
                    {formData.customer_type === "company" && (
                      <span className="text-red-500">*</span>
                    )}
                  </label>
                  <input
                    type="text"
                    id="name"
                    value={formData.name}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, name: e.target.value }))
                    }
                    className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white ${
                      errors.name ? "border-red-500" : "border-gray-300"
                    }`}
                    placeholder="Enter full name"
                  />
                  {errors.name && (
                    <p className="text-red-500 text-xs mt-1">{errors.name}</p>
                  )}
                </div>

                {formData.customer_type === "company" && posDetails?.is_zatca_enabled && (
                  <div>
                    <label
                      htmlFor="country"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Customer Country
                    </label>
                    <input
                      list="country-list"
                      id="country"
                      value={formData.address.country}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          address: { ...prev.address, country: e.target.value },
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white"
                      placeholder="Select country"
                    />
                    <datalist id="country-list">
                      {countryOptions.map((country) => (
                        <option key={country.value} value={country.label} />
                      ))}
                    </datalist>
                  </div>
                )}

                {/* Customer Group */}
                <div>
                  <label
                    htmlFor="customer_group"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Customer Group
                  </label>
                  <select
                    id="customer_group"
                    value={formData.customer_group}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, customer_group: e.target.value }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white"
                    disabled={loadingGroups}
                  >
                    {loadingGroups ? (
                      <option>Loading...</option>
                    ) : (
                      customerGroups.map((group) => (
                        <option key={group.name} value={group.name}>
                          {group.customer_group_name}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                {/* Territory */}
                <div>
                  <label
                    htmlFor="territory"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Territory
                  </label>
                  <select
                    id="territory"
                    value={formData.territory}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, territory: e.target.value }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white"
                    disabled={loadingTerritories}
                  >
                    <option value="All Territories">All Territories</option>
                    {territories.map((territory) => (
                      <option key={territory.name} value={territory.name}>
                        {territory.territory_name || territory.name}
                      </option>
                    ))}
                  </select>
                  {loadingTerritories && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Loading territories...
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Contact Information for Individual */}
            {formData.customer_type === "individual" && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4 mt-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                  <Mail size={20} className="mr-2" />
                  Contact Information
                  <span className="text-sm font-normal text-gray-500 ml-2">
                    (At least one required)
                  </span>
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="email"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Email Address
                    </label>
                    <input
                      type="email"
                      id="email"
                      value={formData.email}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          email: e.target.value,
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white ${
                        errors.email || errors.contact
                          ? "border-red-500"
                          : "border-gray-300"
                      }`}
                      placeholder="customer@email.com"
                    />
                    {errors.email && (
                      <p className="text-red-500 text-xs mt-1">
                        {errors.email}
                      </p>
                    )}
                  </div>

                  <div className="space-y-4">
                    {/* Phone Number */}
                    <div>
                      <label
                        htmlFor="phone"
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                      >
                        Phone Number
                      </label>
                      <PhoneInput
                        id="phone"
                        international
                        defaultCountry="KH"
                        value={formData.phone}
                        onChange={(value: string | undefined) =>
                          setFormData((prev) => ({ ...prev, phone: value || "" }))
                        }
                        className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white ${
                          errors.phone ? "border-red-500" : "border-gray-300 dark:border-gray-600"
                        }`}
                      />
                      {errors.phone && (
                        <p className="text-red-500 text-xs mt-1">{errors.phone}</p>
                      )}
                      
                      {/* Show Telegram quick link if phone matches a contact */}
                      {phoneMatchedTelegram && !linkedTelegramContact && (
                        <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-2">
                              <svg className="w-4 h-4 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.02-1.96 1.25-5.54 3.67-.52.36-1 .53-1.42.52-.47-.01-1.37-.27-2.04-.49-.82-.27-1.47-.42-1.42-.88.03-.24.37-.49 1.02-.75 4-1.74 6.67-2.89 8.01-3.45 3.81-1.58 4.6-1.85 5.12-1.86.11 0 .37.03.53.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"/>
                              </svg>
                              <span className="text-sm text-blue-700 dark:text-blue-300">
                                {isCheckingPhoneTelegram ? (
                                  "Checking Telegram..."
                                ) : (
                                  <>
                                    Found: <strong>{phoneMatchedTelegram.first_name} {phoneMatchedTelegram.last_name || ''}</strong>
                                    {phoneMatchedTelegram.telegram_username && (
                                      <span className="text-blue-500 ml-1">@{phoneMatchedTelegram.telegram_username}</span>
                                    )}
                                  </>
                                )}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={handleQuickLinkFromPhone}
                              disabled={isLinkingTelegram}
                              className="px-2 py-1 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors disabled:opacity-50"
                            >
                              {isLinkingTelegram ? 'Linking...' : 'Link'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {errors.contact && (
                  <p className="text-red-500 text-xs mt-1">{errors.contact}</p>
                )}
              </div>
            )}

          </div>

          {/* Contact Information (Company only) */}
          {formData.customer_type === "company" && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                  <Mail size={20} className="mr-2" />
                  Contact Information
                  {formData.customer_type === "company" && (
                    <span className="text-sm font-normal text-gray-500 ml-2">
                      (At least one required)
                    </span>
                  )}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="contactName"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Contact Name{" "}
                      <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      id="contactName"
                      value={formData.contactName}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          contactName: e.target.value,
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white ${
                        errors.contactName ? "border-red-500" : "border-gray-300"
                      }`}
                      placeholder="Enter contact person name"
                    />
                    {errors.contactName && (
                      <p className="text-red-500 text-xs mt-1">{errors.contactName}</p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="email"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Email Address
                    </label>
                    <input
                      type="email"
                      id="email"
                      value={formData.email}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          email: e.target.value,
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white ${
                        errors.email || errors.contact
                          ? "border-red-500"
                          : "border-gray-300"
                      }`}
                      placeholder="customer@email.com"
                    />
                    {errors.email && (
                      <p className="text-red-500 text-xs mt-1">
                        {errors.email}
                      </p>
                    )}
                  </div>

                </div>

                {/* Phone Number */}
                <div>
                  <label
                    htmlFor="phone"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Phone Number
                  </label>
                  <PhoneInput
                    id="phone"
                    international
                    defaultCountry="KH"
                    value={formData.phone}
                    onChange={(value: string | undefined) =>
                      setFormData((prev) => ({ ...prev, phone: value || "" }))
                    }
                    className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white ${
                      errors.phone ? "border-red-500" : "border-gray-300 dark:border-gray-600"
                    }`}
                  />
                  {errors.phone && (
                    <p className="text-red-500 text-xs mt-1">{errors.phone}</p>
                  )}
                  
                  {/* Show Telegram quick link if phone matches a contact */}
                  {phoneMatchedTelegram && !linkedTelegramContact && (
                    <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <svg className="w-4 h-4 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.02-1.96 1.25-5.54 3.67-.52.36-1 .53-1.42.52-.47-.01-1.37-.27-2.04-.49-.82-.27-1.47-.42-1.42-.88.03-.24.37-.49 1.02-.75 4-1.74 6.67-2.89 8.01-3.45 3.81-1.58 4.6-1.85 5.12-1.86.11 0 .37.03.53.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"/>
                          </svg>
                          <span className="text-sm text-blue-700 dark:text-blue-300">
                            {isCheckingPhoneTelegram ? (
                              "Checking Telegram..."
                            ) : (
                              <>
                                Found: <strong>{phoneMatchedTelegram.first_name} {phoneMatchedTelegram.last_name || ''}</strong>
                                {phoneMatchedTelegram.telegram_username && (
                                  <span className="text-blue-500 ml-1">@{phoneMatchedTelegram.telegram_username}</span>
                                )}
                              </>
                            )}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={handleQuickLinkFromPhone}
                          disabled={isLinkingTelegram}
                          className="px-2 py-1 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors disabled:opacity-50"
                        >
                          {isLinkingTelegram ? 'Linking...' : 'Link'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {errors.contact && (
                  <p className="text-red-500 text-xs mt-1">{errors.contact}</p>
                )}

              </div>
            )}

          {/* ZATCA Details (Company only, when ZATCA is enabled) */}
          {formData.customer_type === "company" && posDetails && posDetails.is_zatca_enabled === true && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                  <CreditCard size={20} className="mr-2" />
                  ZATCA Details
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="paymentMethod"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Payment Method
                    </label>
                    <select
                      id="paymentMethod"
                      value={formData.preferredPaymentMethod}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          preferredPaymentMethod: e.target
                            .value as Customer["preferredPaymentMethod"],
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white"
                    >
                      {paymentMethods.map((method) => (
                        <option key={method.value} value={method.value}>
                          {method.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="vatNumber"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      VAT Number
                    </label>
                    <input
                      type="text"
                      id="vatNumber"
                      value={formData.vatNumber}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          vatNumber: e.target.value,
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white ${
                        errors.vatOrRegistration
                          ? "border-red-500"
                          : "border-gray-300"
                      }`}
                      placeholder="Enter VAT number"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="registrationScheme"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Registration Scheme
                    </label>
                    <select
                      id="registrationScheme"
                      value={formData.registrationScheme}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          registrationScheme: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white"
                    >
                      <option value="">Select Registration Scheme</option>
                      {registrationSchemes.map((scheme) => (
                        <option key={scheme.value} value={scheme.value}>
                          {scheme.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="registrationNumber"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Registration Number{" "}
                      {formData.registrationScheme && formData.registrationScheme !== "" ? "*" : ""}
                    </label>
                    <input
                      type="text"
                      id="registrationNumber"
                      value={formData.registrationNumber}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          registrationNumber: e.target.value,
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white ${
                        errors.registrationNumber || errors.vatOrRegistration
                          ? "border-red-500"
                          : "border-gray-300"
                      }`}
                      placeholder="Enter registration number"
                    />
                    {errors.registrationNumber && (
                      <p className="text-red-500 text-xs mt-1">
                        {errors.registrationNumber}
                      </p>
                    )}
                  </div>
                </div>
                {errors.vatOrRegistration && (
                  <p className="text-red-500 text-xs mt-1">
                    {errors.vatOrRegistration}
                  </p>
                )}

              </div>
            )}

          {/* ZATCA Required Message */}
          {/* {formData.customer_type === "company" && posDetails && posDetails.is_zatca_enabled === true && formData.vatNumber.trim() === "" && formData.registrationNumber.trim() === "" && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg p-4">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="ml-3">
                  <p className="text-sm text-yellow-800 dark:text-yellow-200">
                    <strong>ZATCA E-Invoicing is enabled.</strong> Please provide either a VAT Number or Registration Number to complete the customer registration.
                  </p>
                </div>
              </div>
            </div>
          )} */}


          {/* Address Section */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
                <MapPin size={20} className="mr-2" />
                Address{formData.customer_type === "company" ? "" : " (Optional)"}
              </h3>

              <div className="space-y-4">
                {/* Address Type */}
                <div>
                  <label
                    htmlFor="addressType"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Address Type
                  </label>
                  <select
                    id="addressType"
                    value={formData.address.addressType}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        address: {
                          ...prev.address,
                          addressType: e.target.value,
                        },
                      }))
                    }
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white"
                  >
                    {addressTypes.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Street + Building Number */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="street"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Street Address{formData.customer_type === "company" && posDetails?.is_zatca_enabled && (
                        <span className="text-red-500"> *</span>
                      )}
                    </label>
                    <input
                      type="text"
                      id="street"
                      value={formData.address.street}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          address: {
                            ...prev.address,
                            street: e.target.value,
                          },
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white ${
                        errors.street ? "border-red-500" : "border-gray-300 dark:border-gray-600"
                      }`}
                      placeholder="Enter street address"
                    />
                    {errors.street && (
                      <p className="text-red-500 text-xs mt-1">{errors.street}</p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="buildingNumber"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Building Number (4 digits){formData.customer_type === "company" && posDetails?.is_zatca_enabled && (
                        <span className="text-red-500"> *</span>
                      )}
                    </label>
                    <input
                      type="text"
                      id="buildingNumber"
                      value={formData.address.buildingNumber}
                      onChange={(e) => {
                        const value = e.target.value.replace(/\D/g, ''); // Only allow digits
                        if (value.length <= 4) {
                          setFormData((prev) => ({
                            ...prev,
                            address: {
                              ...prev.address,
                              buildingNumber: value,
                            },
                          }));
                        }
                      }}
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white ${
                        errors.buildingNumber ? "border-red-500" : "border-gray-300 dark:border-gray-600"
                      }`}
                      placeholder="1234"
                      maxLength={4}
                    />
                    {errors.buildingNumber && (
                      <p className="text-red-500 text-xs mt-1">{errors.buildingNumber}</p>
                    )}
                  </div>
                </div>

                {/* City + State */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="city"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      City{formData.customer_type === "company" && posDetails?.is_zatca_enabled && (
                        <span className="text-red-500"> *</span>
                      )}
                    </label>
                    <input
                      type="text"
                      id="city"
                      value={formData.address.city}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          address: {
                            ...prev.address,
                            city: e.target.value,
                          },
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white ${
                        errors.city ? "border-red-500" : "border-gray-300 dark:border-gray-600"
                      }`}
                      placeholder="Enter city"
                    />
                    {errors.city && (
                      <p className="text-red-500 text-xs mt-1">{errors.city}</p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="state"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      State/Province{formData.customer_type === "company" && posDetails?.is_zatca_enabled && (
                        <span className="text-red-500"> *</span>
                      )}
                    </label>
                    <input
                      type="text"
                      id="state"
                      value={formData.address.state}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          address: {
                            ...prev.address,
                            state: e.target.value,
                          },
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white ${
                        errors.state ? "border-red-500" : "border-gray-300 dark:border-gray-600"
                      }`}
                      placeholder="Enter state/province"
                    />
                    {errors.state && (
                      <p className="text-red-500 text-xs mt-1">{errors.state}</p>
                    )}
                  </div>
                </div>

                {/* Zip Code + Country */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="zipCode"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Zip Code{formData.customer_type === "company" && posDetails?.is_zatca_enabled && (
                        <span className="text-red-500"> *</span>
                      )}
                    </label>
                    <input
                      type="text"
                      id="zipCode"
                      value={formData.address.zipCode}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          address: {
                            ...prev.address,
                            zipCode: e.target.value,
                          },
                        }))
                      }
                      className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white ${
                        errors.zipCode ? "border-red-500" : "border-gray-300 dark:border-gray-600"
                      }`}
                      placeholder="Enter zip code"
                    />
                    {errors.zipCode && (
                      <p className="text-red-500 text-xs mt-1">{errors.zipCode}</p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="country"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Country
                    </label>
                    <input
                      list="country-list"
                      id="country"
                      value={formData.address.country}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          address: {
                            ...prev.address,
                            country: e.target.value,
                          },
                        }))
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:bg-gray-700 dark:text-white"
                      placeholder="Select country"
                    />
                    <datalist id="country-list">
                      {countryOptions.map((country) => (
                        <option key={country.value} value={country.label} />
                      ))}
                    </datalist>
                  </div>
                </div>

              </div>

          </div>

          {/* Telegram Linking Section */}
          <div className="bg-sky-50 dark:bg-sky-900/20 rounded-lg p-4 border border-sky-200 dark:border-sky-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center">
              <MessageCircle size={20} className="mr-2 text-sky-500" />
              Link Telegram Contact
              <span className="text-sm font-normal text-gray-500 ml-2">(Optional)</span>
            </h3>

            {/* Show linked contact if exists */}
            {linkedTelegramContact && (
              <div className="mb-4 p-3 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-between">
                <div className="flex items-center">
                  <Check size={18} className="text-green-600 mr-2" />
                  <span className="text-green-800 dark:text-green-200">
                    Linked to: <strong>{linkedTelegramContact.telegram_display_name}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLinkedTelegramContact(null);
                    setSelectedTelegramContact(null);
                  }}
                  className="text-red-500 hover:text-red-700 text-sm"
                >
                  Remove
                </button>
              </div>
            )}

            {/* Show selected contact (before save) */}
            {selectedTelegramContact && !linkedTelegramContact && (
              <div className="mb-4 p-3 bg-sky-100 dark:bg-sky-900/30 rounded-lg flex items-center justify-between">
                <div className="flex items-center">
                  <Check size={18} className="text-sky-600 mr-2" />
                  <span className="text-sky-800 dark:text-sky-200">
                    Selected: <strong>
                      {[selectedTelegramContact.first_name, selectedTelegramContact.last_name].filter(Boolean).join(' ') || 
                       (selectedTelegramContact.telegram_username ? `@${selectedTelegramContact.telegram_username}` : `User ${selectedTelegramContact.telegram_user_id}`)}
                    </strong>
                    {selectedTelegramContact.phone_number && (
                      <span className="text-gray-500 ml-2">({selectedTelegramContact.phone_number})</span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTelegramContact(null)}
                  className="text-red-500 hover:text-red-700 text-sm"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Search Section */}
            {!linkedTelegramContact && !selectedTelegramContact && (
              <>
                <div className="flex flex-col md:flex-row gap-2 mb-3">
                  <div className="flex-1">
                    <input
                      type="text"
                      value={telegramSearch}
                      onChange={(e) => setTelegramSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleTelegramSearch();
                        }
                      }}
                      placeholder="Search by phone, @username, or name..."
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 dark:bg-gray-700 dark:text-white"
                    />
                  </div>
                  <select
                    value={telegramSearchType}
                    onChange={(e) => setTelegramSearchType(e.target.value as 'all' | 'phone' | 'username' | 'name')}
                    className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 dark:bg-gray-700 dark:text-white"
                  >
                    <option value="all">All</option>
                    <option value="phone">Phone</option>
                    <option value="username">Username</option>
                    <option value="name">Name</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleTelegramSearch}
                    disabled={isSearchingTelegram || !telegramSearch.trim()}
                    className="px-4 py-2 bg-sky-500 text-white rounded-lg hover:bg-sky-600 transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSearchingTelegram ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Search size={18} />
                    )}
                  </button>
                </div>

                {/* Search Results */}
                {telegramSearchResults.length > 0 && (
                  <div className="mt-3 border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden">
                    <div className="max-h-48 overflow-y-auto">
                      {telegramSearchResults.map((contact, index) => {
                        const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 
                                           (contact.telegram_username ? `@${contact.telegram_username}` : `User ${contact.telegram_user_id}`);
                        return (
                          <div
                            key={contact.telegram_user_id || index}
                            className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-600 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          >
                            <div className="flex-1">
                              <div className="font-medium text-gray-900 dark:text-white">
                                {displayName}
                                {contact.from_live_search && (
                                  <span className="ml-2 text-xs bg-sky-100 text-sky-700 px-2 py-0.5 rounded">Live</span>
                                )}
                              </div>
                              <div className="text-sm text-gray-500 dark:text-gray-400 flex flex-wrap gap-2">
                                {contact.telegram_username && (
                                  <span>@{contact.telegram_username}</span>
                                )}
                                {contact.phone_number && (
                                  <span>{contact.phone_number}</span>
                                )}
                                {contact.is_bot && (
                                  <span className="text-orange-500">[Bot]</span>
                                )}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleSelectTelegramContact(contact)}
                              disabled={isLinkingTelegram}
                              className="ml-3 px-3 py-1.5 bg-sky-500 text-white text-sm rounded-lg hover:bg-sky-600 transition-colors flex items-center disabled:opacity-50"
                            >
                              {isLinkingTelegram ? (
                                <Loader2 size={14} className="animate-spin mr-1" />
                              ) : (
                                <Link size={14} className="mr-1" />
                              )}
                              Select
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Help text */}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Search your synced Telegram contacts. The contact will be linked after saving the customer.
                </p>
              </>
            )}
          </div>

          {/* Error Display */}
          {submitError && (
            <div className="mt-4 p-3 bg-red-100 text-red-700 rounded-lg">
              {submitError}
            </div>
          )}
          </div>

          {/* Fixed Footer with Save Button */}
          <div className="sticky bottom-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 p-6">
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isSubmitting || !canSaveCustomer()}
                className={`px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center space-x-2 ${
                  isSubmitting || !canSaveCustomer() ? "opacity-50 cursor-not-allowed" : ""
                }`}
              >
                {isSubmitting ? (
                  <>
                    <span className="animate-spin">↻</span>
                    <span>{isEditing ? "Updating..." : "Creating..."}</span>
                  </>
                ) : (
                  <>
                    <Save size={18} />
                    <span>
                      {isEditing ? "Update Customer" : "Save Customer"}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>

        </form>
      </div>
    </div>
  );
}
