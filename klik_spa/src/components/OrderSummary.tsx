"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Minus,
  Plus,
  X,
  Search,
  UserPlus,
  User,
  Building,
} from "lucide-react";
import type { CartItem, GiftCoupon } from "../../types";
import type { Customer } from "../types/customer";
import PaymentDialog from "./PaymentDialog";
import AddCustomerModal from "./AddCustomerModal";
import { createDraftSalesInvoice } from "../services/salesInvoice";
import { useCustomers } from "../hooks/useCustomers";
import { useProducts } from "../hooks/useProducts";
import { toast } from "react-toastify";
import { extractErrorFromException } from "../utils/errorExtraction";
import { getBatches } from "../utils/batch";
import { getSerials } from "../utils/serial";
import { usePOSDetails } from "../hooks/usePOSProfile";
import { useCustomerStatistics } from "../hooks/useCustomerStatistics";
import { useCustomerPermission } from "../hooks/useCustomerPermission";
import { useCartStore } from "../stores/cartStore";


interface OrderSummaryProps {
  cartItems: CartItem[];
  onUpdateQuantity: (id: string, quantity: number) => void;
  onRemoveItem?: (id: string) => void;
  onClearCart?: () => void;
  appliedCoupons: GiftCoupon[];
  onApplyCoupon: (coupon: GiftCoupon) => void;
  onRemoveCoupon: (couponCode: string) => void;
  isMobile?: boolean;
}

// Component to handle quantity input with local state
interface QuantityInputProps {
  item: CartItem;
  onUpdateQuantity: (id: string, quantity: number) => void;
  isMobile?: boolean;
  readOnly?: boolean;
}

const QuantityInput = ({ item, onUpdateQuantity, isMobile, readOnly }: QuantityInputProps) => {
  const [inputValue, setInputValue] = useState(item.quantity.toString());
  const [isEditing, setIsEditing] = useState(false);

  // Update input value when item quantity changes externally
  useEffect(() => {
    if (!isEditing) {
      setInputValue(item.quantity.toString());
    }
  }, [item.quantity, isEditing]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) return;
    const value = e.target.value;
    setInputValue(value);
  };

  const handleBlur = () => {
    setIsEditing(false);
    const numValue = Number(inputValue);

    if (isNaN(numValue) || numValue <= 0) {
      // Invalid input - reset to original value
      setInputValue(item.quantity.toString());
      if (numValue <= 0) {
        onUpdateQuantity(item.id, 0);
      }
    } else {
      // Valid input - update quantity
      setInputValue(numValue.toString());
      onUpdateQuantity(item.id, numValue);
    }
  };

  const handleFocus = () => {
    if (!readOnly) {
      setIsEditing(true);
    }
  };

  return (
    <input
      type="number"
      step="0.01"
      min="0"
      value={inputValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      readOnly={readOnly}
      disabled={readOnly}
      className={`w-full ${
        isMobile ? "text-sm" : "text-sm"
      } px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${
        readOnly ? "opacity-60 cursor-not-allowed bg-gray-100 dark:bg-gray-700" : ""
      }`}
    />
  );
};

// Simple UOM Select Field Component
interface UOMSelectFieldProps {
  item: CartItem;
  onUOMChange: (itemId: string, selectedUOM: string, newPrice: number) => void;
  isMobile?: boolean;
  selectedCustomer?: { id: string } | null;
}

const UOMSelectField = ({ item, onUOMChange, isMobile, selectedCustomer }: UOMSelectFieldProps) => {
  const [availableUOMs, setAvailableUOMs] = useState<string[]>(['Nos']);
  const [selectedUOM, setSelectedUOM] = useState<string>(item.uom || 'Nos'); //Mania: Local state for selected UOM
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);

  useEffect(() => {
    const loadItemSpecificUOMs = async () => {
      try {
        // Use item_code if available, otherwise fallback to item.id
        const itemCode = item.item_code || item.id;
        if (itemCode) {
          // console.log(`📡 Loading UOMs for item: ${itemCode} with customer: ${selectedCustomer?.id || 'None'}`);
          const customerParam = selectedCustomer?.id ? `&customer=${selectedCustomer.id}` : '';
          const response = await fetch(`/api/method/klik_pos.api.item.get_item_uoms_and_prices?item_code=${itemCode}${customerParam}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
          });

          if (response.ok) {
            const data = await response.json();

            if (data?.message?.uoms) {
              //eslint-disable-next-line @typescript-eslint/no-explicit-any
              const uoms = data.message.uoms.map((uom: any) => uom.uom);
              setAvailableUOMs(uoms);
            } else {
              setAvailableUOMs(['Nos']);
            }
          } else {
            setAvailableUOMs(['Nos']);
          }
        } else {
          setAvailableUOMs(['Nos']);
        }
      } catch (error) {
        console.error('❌ Error loading item-specific UOMs:', error);
        setAvailableUOMs(['Nos']);
      }
    };

    loadItemSpecificUOMs();
  }, [item.id, item.item_code, selectedCustomer?.id]);

  // Sync local state with item UOM changes
  useEffect(() => {
    setSelectedUOM(item.uom || 'Nos');
  }, [item.uom]);

  // Filter UOMs based on search query
  const filteredUOMs = availableUOMs.filter(uom =>
    uom.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleUOMSelect = async (newUOM: string) => {


    // Update local state immediately for UI responsiveness
    setSelectedUOM(newUOM);
    setIsDropdownOpen(false);
    setSearchQuery('');

    // Update UOM and price using item UOMs and prices API
    try {
      // Use item_code if available, otherwise fallback to item.id
      const itemCode = item.item_code || item.id;
      if (itemCode) {
        // console.log(`📡 API Call: get_item_uoms_and_prices for ${itemCode} with customer: ${selectedCustomer?.id || 'None'}`);
        const customerParam = selectedCustomer?.id ? `&customer=${selectedCustomer.id}` : '';
        const response = await fetch(`/api/method/klik_pos.api.item.get_item_uoms_and_prices?item_code=${itemCode}${customerParam}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();
          // console.log(`📦 API Response:`, data.message);

          if (data?.message?.uoms) {
            //eslint-disable-next-line @typescript-eslint/no-explicit-any
            const selectedUOMData = data.message.uoms.find((uom: any) => uom.uom === newUOM);
            if (selectedUOMData && selectedUOMData.price !== undefined) {
              console.log(`✅ Found UOM data for ${newUOM}:`, selectedUOMData);
              onUOMChange(item.id, newUOM, selectedUOMData.price);
            } else {
              console.warn(`⚠️ UOM data not found for ${newUOM}. Available UOMs:`, data.message.uoms.map((u: any) => u.uom));
              // Fallback: try to calculate price using fetch_item_price API
              try {
                const itemCode = item.item_code || item.id;
                const customerParam = selectedCustomer?.id ? `&customer=${selectedCustomer.id}` : '';
                const priceResponse = await fetch(`/api/method/klik_pos.api.item.get_item_price_for_customer?item_code=${itemCode}&uom=${encodeURIComponent(newUOM)}${customerParam}`, {
                  method: 'GET',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include'
                });
                if (priceResponse.ok) {
                  const priceData = await priceResponse.json();
                  if (priceData?.message?.success && priceData.message.price > 0) {
                    console.log(`✅ Got price from fallback API for ${newUOM}:`, priceData.message.price);
                    onUOMChange(item.id, newUOM, priceData.message.price);
                  } else {
                    console.error(`❌ Fallback API returned invalid price for ${newUOM}`);
                  }
                }
              } catch (fallbackError) {
                console.error(`❌ Error in fallback price fetch for ${newUOM}:`, fallbackError);
              }
            }
          } else {
            console.error('❌ No UOMs data in API response');
          }
        } else {
          // API call failed
        }
      } else {
        // No item_code or id found for item
      }
    } catch (error) {
      console.error('❌ Error fetching UOM pricing:', error);
    }
  };

  return (
    <div className="relative">
      {/* UOM Display Button */}
      <button
        type="button"
        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
        className={`w-full ${
          isMobile ? "text-sm" : "text-sm"
        } px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-left flex items-center justify-between`}
      >
        <span>{selectedUOM}</span>
        <svg className={`w-4 h-4 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {isDropdownOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-60 overflow-hidden">
          {/* Search Input */}
          <div className="p-2 border-b border-gray-200 dark:border-gray-600">
            <input
              type="text"
              placeholder="Search UOM..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded focus:ring-1 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              autoFocus
            />
          </div>

          {/* UOM List */}
          <div className="max-h-48 overflow-y-auto">
            {filteredUOMs.length > 0 ? (
              filteredUOMs.map((uom) => (
                <button
                  key={uom}
                  type="button"
                  onClick={() => handleUOMSelect(uom)}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 ${
                    uom === selectedUOM ? 'bg-beveren-50 dark:bg-beveren-900/20 text-beveren-600 dark:text-beveren-400' : 'text-gray-900 dark:text-white'
                  }`}
                >
                  {uom}
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                No UOMs found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Compact searchable dropdown for Batch selection
interface BatchSelectFieldProps {
  itemId: string;
  itemCode: string;
  options: { batch_id: string; qty: number }[];
  value: string;
  onChange: (value: string, availableQty: number) => void;
  isMobile?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const BatchSelectField = ({ itemId: _itemId, itemCode: _itemCode, options, value, onChange, isMobile }: BatchSelectFieldProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = options.filter(o => o.batch_id.toLowerCase().includes(query.toLowerCase()));

  const handleSelect = (batchId: string) => {
    const selectedQty = options.find(b => b.batch_id === batchId)?.qty || 0;
    onChange(batchId, selectedQty);
    setIsOpen(false);
    setQuery("");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full ${isMobile ? "text-xs" : "text-xs"} px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-left flex items-center justify-between`}
      >
        <span className="truncate">{value || "Select Batch"}</span>
        <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-44 overflow-hidden">
          <div className="p-1 border-b border-gray-200 dark:border-gray-600">
            <input
              type="text"
              placeholder="Filter batch..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:ring-1 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              autoFocus
            />
          </div>
          <div className="max-h-36 overflow-y-auto">
            {filtered.length > 0 ? filtered.map((b) => (
              <button
                key={b.batch_id}
                type="button"
                onClick={() => handleSelect(b.batch_id)}
                className={`w-full px-2 py-1 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700 ${value === b.batch_id ? 'bg-beveren-50 dark:bg-beveren-900/20 text-beveren-600 dark:text-beveren-400' : 'text-gray-900 dark:text-white'}`}
              >
                {b.batch_id} - {b.qty}
              </button>
            )) : (
              <div className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Roofing Spec Interface and Component
interface RoofingSpecRow {
  straight: number;
  curve: number;
  end: number;
  quantity: number;
}

interface RoofingSpecTableProps {
  item: CartItem;
  onSpecChange: (specs: RoofingSpecRow[]) => void;
  isMobile?: boolean;
}

const RoofingSpecTable = ({ item, onSpecChange, isMobile }: RoofingSpecTableProps) => {
  // Helper to safely parse roofing specs (handle JSON strings or arrays)
  const parseSpecs = (specs: RoofingSpecRow[] | string | undefined | null): RoofingSpecRow[] => {
    if (!specs) return [{ straight: 0, curve: 0, end: 0, quantity: 0 }];
    
    if (typeof specs === 'string') {
      try {
        const parsed = JSON.parse(specs);
        return Array.isArray(parsed) ? parsed : [{ straight: 0, curve: 0, end: 0, quantity: 0 }];
      } catch {
        console.warn(`Failed to parse specs JSON for item ${item.id}:`, specs);
        return [{ straight: 0, curve: 0, end: 0, quantity: 0 }];
      }
    }
    
    if (Array.isArray(specs) && specs.length > 0) {
      return specs;
    }
    
    return [{ straight: 0, curve: 0, end: 0, quantity: 0 }];
  };

  const [specs, setSpecs] = useState<RoofingSpecRow[]>(
    parseSpecs(item.custom_ds_roofing_spec)
  );

  // Sync specs when item changes (e.g., when editing a different item or returning to an item)
  useEffect(() => {
    const parsedSpecs = parseSpecs(item.custom_ds_roofing_spec);
    console.log(`🔄 RoofingSpecTable useEffect triggered for item: ${item.id}`, {
      itemId: item.id,
      itemName: item.name,
      incomingSpecs: item.custom_ds_roofing_spec,
      parsedSpecs,
      incomingSpecsLength: parsedSpecs?.length || 0,
    });

    if (parsedSpecs && parsedSpecs.length > 0) {
      console.log(`✅ Populating specs for ${item.id}:`, parsedSpecs);
      setSpecs(parsedSpecs);
    } else {
      console.log(`📝 No specs found for ${item.id}, using default empty spec`);
      setSpecs([{ straight: 0, curve: 0, end: 0, quantity: 0 }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.custom_ds_roofing_spec]);

  const handleSpecChange = (index: number, field: keyof RoofingSpecRow, value: number) => {
    const updatedSpecs = [...specs];
    updatedSpecs[index][field] = Math.max(0, value);
    console.log(`📝 Spec changed for item ${item.id} row ${index}, field ${field}: ${value}`, {
      updatedRow: updatedSpecs[index],
      allSpecs: updatedSpecs,
    });
    setSpecs(updatedSpecs);
    // Just notify of spec changes, don't update quantity here
    onSpecChange(updatedSpecs);
  };

  const addRow = () => {
    const newSpecs = [...specs, { straight: 0, curve: 0, end: 0, quantity: 0 }];
    console.log(`➕ Added new row to item ${item.id}, total rows: ${newSpecs.length}`, newSpecs);
    setSpecs(newSpecs);
    onSpecChange(newSpecs);
  };

  const removeRow = (index: number) => {
    if (specs.length > 1) {
      const newSpecs = specs.filter((_, i) => i !== index);
      console.log(`➖ Removed row ${index} from item ${item.id}, total rows: ${newSpecs.length}`, newSpecs);
      setSpecs(newSpecs);
      onSpecChange(newSpecs);
    }
  };

  return (
    <div className="mb-4">
      <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"} mb-2`}>
        Roofing Spec
      </label>
      <div style={{ overflowX: "auto", borderRadius: "4px" }}>
        <table className={`w-full border-collapse ${isMobile ? "text-xs" : "text-sm"}`}>
          <thead>
            <tr className="bg-gray-100 dark:bg-gray-700">
              <th className="border border-gray-300 dark:border-gray-600 px-2 py-2 text-left">Straight</th>
              <th className="border border-gray-300 dark:border-gray-600 px-2 py-2 text-left">Curve</th>
              <th className="border border-gray-300 dark:border-gray-600 px-2 py-2 text-left">End</th>
              <th className="border border-gray-300 dark:border-gray-600 px-2 py-2 text-left">Qty</th>
              <th className="border border-gray-300 dark:border-gray-600 px-2 py-2 text-center w-10"></th>
            </tr>
          </thead>
          <tbody>
            {specs.map((row, idx) => (
              <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="border border-gray-300 dark:border-gray-600 p-1">
                  <input
                    type="number"
                    min="0"
                    value={row.straight}
                    onChange={(e) => handleSpecChange(idx, "straight", parseInt(e.target.value) || 0)}
                    className={`w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${isMobile ? "text-xs" : "text-xs"}`}
                  />
                </td>
                <td className="border border-gray-300 dark:border-gray-600 p-1">
                  <input
                    type="number"
                    min="0"
                    value={row.curve}
                    onChange={(e) => handleSpecChange(idx, "curve", parseInt(e.target.value) || 0)}
                    className={`w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${isMobile ? "text-xs" : "text-xs"}`}
                  />
                </td>
                <td className="border border-gray-300 dark:border-gray-600 p-1">
                  <input
                    type="number"
                    min="0"
                    value={row.end}
                    onChange={(e) => handleSpecChange(idx, "end", parseInt(e.target.value) || 0)}
                    className={`w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${isMobile ? "text-xs" : "text-xs"}`}
                  />
                </td>
                <td className="border border-gray-300 dark:border-gray-600 p-1">
                  <input
                    type="number"
                    min="0"
                    value={row.quantity}
                    onChange={(e) => handleSpecChange(idx, "quantity", parseInt(e.target.value) || 0)}
                    className={`w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${isMobile ? "text-xs" : "text-xs"}`}
                  />
                </td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    disabled={specs.length === 1}
                    className={`${isMobile ? "text-xs" : "text-xs"} px-1 py-1 rounded transition-colors ${
                      specs.length === 1
                        ? "text-gray-300 dark:text-gray-600 cursor-not-allowed"
                        : "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                    }`}
                  >
                    −
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={addRow}
        className={`mt-2 px-3 py-1 bg-beveren-500 dark:bg-beveren-600 text-white rounded hover:bg-beveren-600 dark:hover:bg-beveren-700 transition-colors ${isMobile ? "text-xs" : "text-xs"}`}
      >
        + Add Row
      </button>
    </div>
  );
};

// Compact searchable dropdown for Serial selection
interface SerialSelectFieldProps {
  itemId: string;
  itemCode: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  isMobile?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SerialSelectField = ({ itemId: _itemId, itemCode: _itemCode, options, value, onChange, isMobile }: SerialSelectFieldProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = options.filter(sn => sn.toLowerCase().includes(query.toLowerCase()));

  const handleSelect = (sn: string) => {
    onChange(sn);
    setIsOpen(false);
    setQuery("");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full ${isMobile ? "text-xs" : "text-xs"} px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-left flex items-center justify-between`}
      >
        <span className="truncate">{value || "Select Serial"}</span>
        <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-44 overflow-hidden">
          <div className="p-1 border-b border-gray-200 dark:border-gray-600">
            <input
              type="text"
              placeholder="Filter serial..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:ring-1 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              autoFocus
            />
          </div>
          <div className="max-h-36 overflow-y-auto">
            {filtered.length > 0 ? filtered.map((sn) => (
              <button
                key={sn}
                type="button"
                onClick={() => handleSelect(sn)}
                className={`w-full px-2 py-1 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700 ${value === sn ? 'bg-beveren-50 dark:bg-beveren-900/20 text-beveren-600 dark:text-beveren-400' : 'text-gray-900 dark:text-white'}`}
              >
                {sn}
              </button>
            )) : (
              <div className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default function OrderSummary({
  cartItems,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  appliedCoupons,
  // onApplyCoupon,
  onRemoveCoupon,
  isMobile = false,
}: OrderSummaryProps) {
  // const [showCouponPopover, setShowCouponPopover] = useState(false);
  const { selectedCustomer, setSelectedCustomer, updateUOM, updatePricesForCustomer, updateItemCustomFields } = useCartStore();

  // Track if user has manually removed the default customer
  const [userRemovedDefaultCustomer, setUserRemovedDefaultCustomer] = useState(false);

  // Debug selectedCustomer changes
  // useEffect(() => {
  //   console.log();
  // }, [selectedCustomer]);

  // Track if this is the initial load to prevent price recalculation on page refresh
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  useEffect(() => {
    // Mark initial load as complete after a short delay
    const timer = setTimeout(() => {
      setIsInitialLoad(false);
    }, 2000); // 2 seconds should be enough for cart to restore from localStorage

    return () => clearTimeout(timer);
  }, []);

  // Log cartItems when they change to debug roofing spec data
  useEffect(() => {
    console.log(`📦 OrderSummary: cartItems updated`, {
      itemCount: cartItems.length,
      items: cartItems.map(item => {
        return {
          id: item.id,
          name: item.name,
          description: item.custom_description,
          category: item.category,
          quantity: item.quantity,
          custom_ds_roofing_spec: item.custom_ds_roofing_spec,
          custom_description: item.custom_description,
          hasRoofingSpec: !!item.custom_ds_roofing_spec,
          roofingSpecType: typeof item.custom_ds_roofing_spec,
        };
      }),
    });
  }, [cartItems]);

  // Initialize itemRoofingSpecs state from cartItems when they change
  useEffect(() => {
    const newItemRoofingSpecs: Record<string, RoofingSpecRow[]> = {};
    
    cartItems.forEach(item => {
      if (item.category?.toLowerCase() === "zn" && item.custom_ds_roofing_spec) {
        // Parse specs if it's a string
        let specs = item.custom_ds_roofing_spec;
        if (typeof specs === 'string') {
          try {
            specs = JSON.parse(specs);
          } catch {
            console.warn(`Failed to parse specs for item ${item.id}:`, specs);
            specs = [];
          }
        }
        
        if (Array.isArray(specs) && specs.length > 0) {
          newItemRoofingSpecs[item.id] = specs;
          console.log(`🔄 Initialized itemRoofingSpecs for ${item.id}:`, specs);
        }
      }
    });
    
    // Only update state if there are specs to initialize
    if (Object.keys(newItemRoofingSpecs).length > 0) {
      setItemRoofingSpecs(prev => ({
        ...prev,
        ...newItemRoofingSpecs,
      }));
    }
  }, [cartItems]);

  // Update prices when customer changes (but not on initial load to preserve restored prices)
  useEffect(() => {
    if (!isInitialLoad && selectedCustomer && cartItems.length > 0) {
      updatePricesForCustomer(selectedCustomer.id);
    }
  }, [selectedCustomer?.id, cartItems.length, isInitialLoad, updatePricesForCustomer]);
  const [customerSearchQuery, setCustomerSearchQuery] = useState("");
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [invoiceRef, setInvoiceRef] = useState<number | null>(null);
  
  // Ref for customer search input to enable Cmd+V focus
  const customerSearchInputRef = useRef<HTMLInputElement>(null);
  const customerDropdownRef = useRef<HTMLDivElement>(null);
  
  // Keyboard navigation for customer dropdown
  const [selectedCustomerIndex, setSelectedCustomerIndex] = useState(-1);
  
  // const couponButtonRef = useRef<HTMLButtonElement>(null);
  const { customers, isLoading, refetch: refetchCustomers } = useCustomers(customerSearchQuery);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { refetch: _refetchProducts, refreshStockOnly, updateStockForItems: _updateStockForItems, updateBatchQuantitiesForItems } = useProducts();
  // const navigate = useNavigate();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { posDetails, loading: _posLoading } = usePOSDetails();
  const { checkCustomerPermission } = useCustomerPermission();

  // Get customer statistics for the selected customer
  const { statistics: customerStats } = useCustomerStatistics(selectedCustomer?.id || null);
  const [prefilledCustomerName, setPrefilledCustomerName] = useState("");
  const [prefilledData, setPrefilledData] = useState<{
    name?: string;
    email?: string;
    phone?: string;
  }>({});

  // const currency = posDetails?.currency;
  const currency_symbol = posDetails?.currency_symbol;

  // UOM change handler
  const handleUOMChange = useCallback((itemId: string, selectedUOM: string, newPrice: number) => {
    // console.log(`🛒 Cart Update Started:`);
    // console.log(`  Item ID: ${itemId}`);
    // console.log(`  New UOM: ${selectedUOM}`);
    // console.log(`  New Price: $${newPrice}`);

    // Find the current item before update
    const currentItem = cartItems.find(item => item.id === itemId);
    if (currentItem) {
      console.log(`  Before Update:`, {
        name: currentItem.name,
        uom: currentItem.uom,
        price: currentItem.price,
        quantity: currentItem.quantity
      });
    }

    // Update the cart item with new UOM and price using the cart store
    updateUOM(itemId, selectedUOM, newPrice);

    // Debug: Check if the cart item was updated
    setTimeout(() => {
      // const updatedItem = cartItems.find(item => item.id === itemId);
      // Cart update completed
    }, 100);
  }, [updateUOM, cartItems]);
  // State for roofing specs per item
  const [itemRoofingSpecs, setItemRoofingSpecs] = useState<
    Record<string, RoofingSpecRow[]>
  >({});

  // Function to handle roofing spec changes
  const handleRoofingSpecChange = (itemId: string, specs: RoofingSpecRow[]) => {
    console.log(`🔧 handleRoofingSpecChange called for item ${itemId}`, {
      itemId,
      specs,
      specsCount: specs.length,
    });

    setItemRoofingSpecs((prev) => ({
      ...prev,
      [itemId]: specs,
    }));
    
    // Get the item to generate description
    const item = cartItems.find(i => i.id === itemId);
    if (item) {
      const newDescription = generateDescriptionFromSpecs(item, specs);
      console.log(`📝 Generated description for item ${itemId}:`, {
        description: newDescription,
        specs,
      });
      
      // Update the cart item custom fields through the store (this triggers persistence)
      updateItemCustomFields(itemId, {
        custom_ds_roofing_spec: specs,
        custom_description: newDescription,
      });
      
      console.log(`✨ Updated item ${itemId} custom fields via store`, {
        itemId,
        custom_ds_roofing_spec: specs,
        custom_description: newDescription,
      });
    }
  };

  // Function to calculate quantity from roofing specs
  const calculateQuantityFromSpecs = (specs?: RoofingSpecRow[] | string) => {
    console.log(`📊 calculateQuantityFromSpecs called with:`, {
      inputSpecs: specs,
      inputType: typeof specs,
      isArray: Array.isArray(specs),
    });

    // Parse specs if it's a JSON string
    let parsedSpecs: RoofingSpecRow[] | undefined = specs as RoofingSpecRow[];
    if (typeof specs === 'string') {
      try {
        parsedSpecs = JSON.parse(specs);
        console.log(`🔄 Parsed JSON specs:`, parsedSpecs);
      } catch (e) {
        console.warn(`⚠️ Failed to parse specs as JSON:`, specs, e);
        parsedSpecs = [];
      }
    }

    if (!parsedSpecs || !Array.isArray(parsedSpecs) || parsedSpecs.length === 0) {
      console.log(`📊 calculateQuantityFromSpecs: No specs provided, returning 0`, {
        inputSpecs: specs,
        parsedSpecs,
        isArray: Array.isArray(parsedSpecs),
        length: parsedSpecs?.length,
      });
      return 0;
    }

    // Filter out rows where all values are 0 (empty rows)
    const validSpecs = parsedSpecs.filter(
      row => (row.straight || 0) + (row.curve || 0) + (row.end || 0) + (row.quantity || 0) > 0
    );

    if (validSpecs.length === 0) {
      console.log(`📊 calculateQuantityFromSpecs: All specs are empty (all zeros), returning 0`, {
        parsedSpecs,
      });
      return 0;
    }

    let total = 0;
    validSpecs.forEach((row, idx) => {
      const straight = row.straight || 0;
      const curve = row.curve || 0;
      const end = row.end || 0;
      const qty = row.quantity || 0;
      const sum = (straight + curve + end) / 100;
      const rowQty = sum * qty;
      total += rowQty;
      console.log(`  Row ${idx}: (${straight}+${curve}+${end})/100 * ${qty} = ${rowQty.toFixed(2)}`);
    });
    console.log(`📊 calculateQuantityFromSpecs total: ${total.toFixed(2)}`, { specs: validSpecs, total });
    return total;
  };

  // Function to apply roofing specs to cart item
  const applyRoofingSpecToItem = useCallback((itemId: string, specs: RoofingSpecRow[]) => {
    const cartItem = cartItems.find(item => item.id === itemId);
    if (cartItem) {
      cartItem.custom_ds_roofing_spec = specs;
    }
  }, [cartItems]);

  // Function to generate description from roofing specs (similar to getAZDescription)
  const generateDescriptionFromSpecs = (item: CartItem, specs?: RoofingSpecRow[]): string => {
    if (!item || item.category?.toLowerCase() !== "zn") {
      return item.name || "";
    }

    if (!specs || specs.length === 0) {
      return "សង្ក័សី";
    }

    const hasData = specs.some(row => row.straight > 0 || row.curve > 0 || row.end > 0 || row.quantity > 0);
    if (!hasData) {
      return "សង្ក័សី";
    }

    let description = "";
    specs.forEach((row) => {
      if (row.end && row.end > 0) {
        description +=
          "កោង " +
          row.straight +
          "+" +
          row.curve +
          "+" +
          row.end +
          " x " +
          row.quantity +
          " សន្លឹក";
      } else if (row.straight && row.quantity) {
        description +=
          "ត្រង់ " + row.straight + " x " + row.quantity + " សន្លឹក";
      }
      if (description && !description.endsWith("<br>")) {
        description += "<br>";
      }
    });

    return description || "សង្ក័សី";
  };

  // State for item-level discounts and details
  const [itemDiscounts, setItemDiscounts] = useState<
    Record<
      string,
      {
        discountPercentage: number;
        discountAmount: number;
        batchNumber: string;
        serialNumber: string;
        availableQuantity: number;
      }
    >
  >({});

  const [itemBatches, setItemBatches] = useState<
    Record<string, { batch_id: string; qty: number }[]>
  >({});

  const [itemSerials, setItemSerials] = useState<
    Record<string, string[]>
  >({});

  // Pending pre-selections when item not yet in cart
  const [pendingPreselect, setPendingPreselect] = useState<
    Record<string, { batchId?: string; serialNo?: string }>
  >({});

  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Helper function to calculate item price after discount
  const getDiscountedPrice = (item: CartItem) => {
    const itemDiscount = itemDiscounts[item.id] || {
      discountPercentage: 0,
      discountAmount: 0,
    };
    let discountedPrice = item.price;

    // Apply percentage discount first
    if (itemDiscount.discountPercentage > 0) {
      discountedPrice =
        item.price * (1 - itemDiscount.discountPercentage / 100);
    }

    // Then apply fixed amount discount
    if (itemDiscount.discountAmount > 0) {
      discountedPrice = Math.max(
        0,
        discountedPrice - itemDiscount.discountAmount
      );
    }

    return Math.max(0, discountedPrice);
  };

  // Calculate subtotal with item-level discounts
  const subtotal = cartItems.reduce((sum, item) => {
    const discountedPrice = getDiscountedPrice(item);
    // Use calculated quantity for 'zn' items, otherwise use item.quantity
    const specsToUse = itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec;
    const quantity = item.category?.toLowerCase() === "zn" 
      ? calculateQuantityFromSpecs(specsToUse)
      : item.quantity;
    
    if (item.category?.toLowerCase() === "zn") {
      console.log(`💰 Subtotal calculation for ZN item ${item.id}:`, {
        itemId: item.id,
        itemName: item.name,
        itemRoofingSpecsState: itemRoofingSpecs[item.id],
        itemCustomSpec: item.custom_ds_roofing_spec,
        specsToUse: specsToUse,
        specsToUseType: typeof specsToUse,
        quantity,
        discountedPrice,
        contribution: discountedPrice * quantity,
      });
    }
    
    return sum + discountedPrice * quantity;
  }, 0);

  // Calculate total discount amount for display
  const totalItemDiscount = cartItems.reduce((sum, item) => {
    // Use calculated quantity for 'zn' items, otherwise use item.quantity
    const quantity = item.category?.toLowerCase() === "zn" 
      ? calculateQuantityFromSpecs(itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec)
      : item.quantity;
    const originalAmount = item.price * quantity;
    const discountedAmount = getDiscountedPrice(item) * quantity;
    return sum + (originalAmount - discountedAmount);
  }, 0);

  // Calculate coupon discount
  const couponDiscount = appliedCoupons.reduce(
    (sum, coupon) => sum + coupon.value,
    0
  );

  // Calculate final total
  const total = Math.max(0, subtotal - couponDiscount);
  
  const handleCustomerSearchKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>
  ) => {
    // Arrow key navigation
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (showCustomerDropdown && visibleCustomers.length > 0) {
        setSelectedCustomerIndex(prev => {
          const nextIndex = prev + 1;
          const newIndex = nextIndex >= visibleCustomers.length ? 0 : nextIndex;
          // Scroll the selected item into view
          setTimeout(() => {
            const dropdown = customerDropdownRef.current;
            if (dropdown) {
              const selectedItem = dropdown.children[newIndex] as HTMLElement;
              if (selectedItem) {
                selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            }
          }, 0);
          return newIndex;
        });
      }
      return;
    }
    
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (showCustomerDropdown && visibleCustomers.length > 0) {
        setSelectedCustomerIndex(prev => {
          const nextIndex = prev - 1;
          const newIndex = nextIndex < 0 ? visibleCustomers.length - 1 : nextIndex;
          // Scroll the selected item into view
          setTimeout(() => {
            const dropdown = customerDropdownRef.current;
            if (dropdown) {
              const selectedItem = dropdown.children[newIndex] as HTMLElement;
              if (selectedItem) {
                selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            }
          }, 0);
          return newIndex;
        });
      }
      return;
    }
    
    if (e.key === "Escape") {
      e.preventDefault();
      setShowCustomerDropdown(false);
      setSelectedCustomerIndex(-1);
      return;
    }
    
    if (e.key === "Enter") {
      e.preventDefault();
      
      // If a customer is selected via arrow keys, select them
      if (selectedCustomerIndex >= 0 && selectedCustomerIndex < visibleCustomers.length) {
        const selectedCustomerFromList = visibleCustomers[selectedCustomerIndex];
        if (selectedCustomerFromList) {
          handleCustomerSelect(selectedCustomerFromList);
          setSelectedCustomerIndex(-1);
          return;
        }
      }
      
      // Original Enter logic for when no customer is selected via arrows
      if (customerSearchQuery.trim() !== "") {
        // Check if there are no matching customers
        if (filteredCustomers.length === 0) {
          // This is a new customer - detect input type and set prefilled data
          const trimmedValue = customerSearchQuery.trim();
          let prefilledData = {};

          // Check if it's an email
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedValue)) {
            prefilledData = { email: trimmedValue };
          }
          // Check if it's a phone number (contains mostly digits with some special characters)
          else if (
            /^[\d\s+()-]+$/.test(trimmedValue) &&
            trimmedValue.replace(/[\s+()-]/g, "").length >= 7
          ) {
            // Format phone number with Cambodia country code if it doesn't already have one
            let formattedPhone = trimmedValue;
            const cleanNumber = trimmedValue.replace(/[\s+()-]/g, "");

            // If the number doesn't start with +855 (Cambodia code), add it
            if (
              !cleanNumber.startsWith("855") &&
              !cleanNumber.startsWith("+855")
            ) {
              // If it starts with 0, replace with +855
              if (cleanNumber.startsWith("0")) {
                formattedPhone = "+855" + cleanNumber.substring(1);
              } else {
                // Otherwise just add +855
                formattedPhone = "+855" + cleanNumber;
              }
            } else if (
              cleanNumber.startsWith("855") &&
              !cleanNumber.startsWith("+855")
            ) {
              // If it starts with 855 but no +, add the +
              formattedPhone = "+" + cleanNumber;
            }


            prefilledData = { phone: formattedPhone };
          }
          // Otherwise treat as name
          else {
            console.log("Detected name:", trimmedValue);
            prefilledData = { name: trimmedValue };
          }

          // Set the prefilled data and open the modal
          setPrefilledData(prefilledData);
          setPrefilledCustomerName(trimmedValue);
          setShowAddCustomerModal(true);
          setShowCustomerDropdown(false);
        } else if (filteredCustomers.length === 1 && !userRemovedDefaultCustomer && filteredCustomers[0]) {
          handleCustomerSelect(filteredCustomers[0]);
        }
      }
    }
  };
  
  // Reset selected index when search query changes
  useEffect(() => {
    setSelectedCustomerIndex(-1);
  }, [customerSearchQuery]);

  // Function to update item discount
  const updateItemDiscount = (
    itemId: string,
    field: string,
    value: number | string
  ) => {
    setItemDiscounts((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || {
          discountPercentage: 0,
          discountAmount: 0,
          batchNumber: "",
          serialNumber: "",
          availableQuantity: 150,
        }),
        [field]: typeof value === "string" ? value : Math.max(0, value),
      },
    }));
  };

  // Filtered customers based on search query
  const filteredCustomers =
    customerSearchQuery.trim() === ""
      ? customers
      : customers.filter(
          (customer) =>
            customer.name
              .toLowerCase()
              .includes(customerSearchQuery.toLowerCase()) ||
            customer.email
              .toLowerCase()
              .includes(customerSearchQuery.toLowerCase()) ||
            customer.phone.includes(customerSearchQuery) ||
            customer.tags.some((tag) =>
              tag.toLowerCase().includes(customerSearchQuery.toLowerCase())
            )
        );

  // Get the visible customers (limited to 8 as shown in dropdown)
  const visibleCustomers = filteredCustomers.slice(0, 8);

  const validateCustomer = () => {
    if (!selectedCustomer) {
      toast.error("Kindly choose customer");
      return false;
    }
    return true;
  };

  const handleCustomerSelect = (customer: Customer) => {

    setSelectedCustomer(customer);
    setCustomerSearchQuery(customer.name);
    setShowCustomerDropdown(false);
    setUserRemovedDefaultCustomer(false); // Reset flag when user explicitly selects a customer
  };

  const handleSaveCustomer = async (newCustomer: Partial<Customer> & { customer_name?: string }) => {

    // Automatically select the newly created customer in the cart
    if (newCustomer && newCustomer.customer_name) {
      try {
        // Fetch the full customer data using the customer_name returned from backend
        const response = await fetch(`/api/method/klik_pos.api.customer.get_customer_info?customer_name=${encodeURIComponent(newCustomer.customer_name)}`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const resData = await response.json();

        if (resData.message) {
          // Convert the ERP customer data to our Customer format
          const erpCustomer = resData.message;
          const customerToSelect: Customer = {
            id: erpCustomer.name,
            name: erpCustomer.customer_name || erpCustomer.name,
            email: erpCustomer.email_id || '',
            phone: erpCustomer.mobile_no || '',
            type: erpCustomer.customer_type === "Individual" ? "individual" : "company",
            address: {
              street: '',
              city: '',
              state: '',
              zipCode: '',
              country: 'Cambodia'
            },
            loyaltyPoints: erpCustomer.custom_loyalty_points || 0,
            totalSpent: erpCustomer.custom_total_spent || 0,
            totalOrders: erpCustomer.custom_total_orders || 0,
            preferredPaymentMethod: 'Cash',
            tags: erpCustomer.custom_tags?.split(',').filter(Boolean) || [],
            status: erpCustomer.custom_status || 'active',
            createdAt: erpCustomer.creation || new Date().toISOString()
          };

          setSelectedCustomer(customerToSelect);
          setCustomerSearchQuery(''); // Clear the search query

          // Also refresh the customers list to include the new customer
          if (refetchCustomers) {
            refetchCustomers();
          }
        }
      } catch (error) {
        console.error('Error fetching customer details:', error);
        // Fallback: create a basic customer object from the returned data
        const customerToSelect: Customer = {
          id: newCustomer.customer_name || '',
          name: newCustomer.customer_name || '',
          email: '',
          phone: '',
          type: 'company',
          address: {
            street: '',
            city: '',
            state: '',
            zipCode: '',
            country: 'Cambodia'
          },
          loyaltyPoints: 0,
          totalSpent: 0,
          totalOrders: 0,
          preferredPaymentMethod: 'Cash',
          tags: [],
          status: 'active',
          createdAt: new Date().toISOString()
        };

        setSelectedCustomer(customerToSelect);
        setCustomerSearchQuery('');
      }
    }

    setShowAddCustomerModal(false);
    setPrefilledCustomerName(""); // Clear the prefilled name
    setPrefilledData({}); // Clear the prefilled data
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCompletePayment = async (paymentData: any) => {
    console.log("OrderSummary: Payment completed, invoice created - modal stays open for preview", paymentData);
    // Don't close modal or clear cart - let user see invoice preview
    // Cart will be cleared when modal is closed via "New Order" button
  };

  const handleClosePaymentDialog = async (paymentCompleted?: boolean) => {
    setShowPaymentDialog(false);

    // Only clear cart if payment was completed
    if (paymentCompleted) {
      // console.log("OrderSummary: Payment was completed - clearing cart for next order");
      handleClearCart();
    } else {
      console.log("OrderSummary: Payment was not completed - keeping cart items");
    }

    // Refresh stock so cashier can see updated availability
    try {
      const success = await refreshStockOnly();
      if (success) {
        // toast.success("Stock updated - ready for next order!");
      } else {
        console.log("OrderSummary: No stock updates needed");
      }

      // Also update batch quantities for items that were in the cart
      const cartItemCodes = cartItems.map(item => item.item_code || item.id);
      if (cartItemCodes.length > 0) {
        try {
          await updateBatchQuantitiesForItems(cartItemCodes);
        } catch (error) {
          console.error("OrderSummary: Failed to update batch quantities:", error);
        }
      }
      //eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error("OrderSummary: Failed to refresh stock:", error);
      const errorMessage = error?.message || "Unknown error";
      toast.error(`Failed to update stock: ${errorMessage}`);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleHoldOrder = useCallback(async (orderData: any) => {
    if (!selectedCustomer) {
      toast.error("Kindly select a customer");
      return;
    }

    try {
      // Creates a draft invoice and saves the order
      setShowPaymentDialog(false);

      const result = await createDraftSalesInvoice(orderData);

      if (result && result.success) {
        // Clear cart after successful hold
        if (onClearCart) {
          onClearCart();
        }
        toast.success("Draft invoice created and order held successfully!");
      } else {
        toast.error("Failed to create draft invoice");
      }
      //eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error("Error creating draft invoice:", error);
      const errorMessage = extractErrorFromException(error, "Failed to create draft invoice");
      toast.error(errorMessage);
    }
  }, [selectedCustomer, onClearCart]);

  const handleClearCartLocal = useCallback(() => {
    if (cartItems.length === 0) return;

    // Use dedicated clear function if available
    if (onClearCart) {
      onClearCart();
    }

    // Defensive: also remove items individually to ensure the cart is empty
    const itemsToRemove = [...cartItems];
    itemsToRemove.forEach((item) => {
      if (onRemoveItem) {
        onRemoveItem(item.id);
      }
    });

    // Clear applied coupons
    appliedCoupons.forEach((coupon) => {
      onRemoveCoupon(coupon.code);
    });

    // Clear item discounts
    setItemDiscounts({});

    // Reset customer selection
    setSelectedCustomer(null);
    setCustomerSearchQuery("");
  }, [cartItems, onClearCart, onRemoveItem, appliedCoupons, onRemoveCoupon]);

  // Alias for backward compatibility
  const handleClearCart = handleClearCartLocal;

  const getCustomerTypeIcon = (customer: Customer) => {
    switch (customer.type) {
      case "company":
        return <Building size={14} className="text-purple-600" />;
      case "walk-in":
        return <User size={14} className="text-gray-600" />;
      default:
        return <User size={14} className="text-blue-600" />;
    }
  };

  const toggleItemExpansion = (itemId: string) => {
    const newExpanded = new Set(expandedItems);
    const item = cartItems.find(i => i.id === itemId);
    
    if (newExpanded.has(itemId)) {
      console.log(`🔒 Collapsing item ${itemId} (${item?.name})`);
      newExpanded.delete(itemId);
    } else {
      console.log(`🔓 Expanding item ${itemId} (${item?.name})`, {
        itemId,
        itemName: item?.name,
        itemSpecs: item?.custom_ds_roofing_spec,
        itemDescription: item?.custom_description,
        itemRoofingSpecsState: itemRoofingSpecs[itemId],
      });
      newExpanded.add(itemId);
    }
    setExpandedItems(newExpanded);
  };

  useEffect(() => {
    if (customers.length === 1 && !selectedCustomer && !isLoading) {
      const singleCustomer = customers[0];
      if (singleCustomer) {
        setSelectedCustomer(singleCustomer);
        setCustomerSearchQuery(singleCustomer.name);
      }
      setShowCustomerDropdown(false);

      // toast.info(`Automatically selected customer: ${singleCustomer.name}`);
    }
  }, [customers, selectedCustomer, isLoading]);

  // Set default customer from POS profile when available
  useEffect(() => {

    if (posDetails?.default_customer && !selectedCustomer && !_posLoading && !userRemovedDefaultCustomer) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const defaultCustomer = posDetails.default_customer as any;

      // Use the new API to check if user has permission to access the default customer
      checkCustomerPermission(defaultCustomer.id).then((result) => {
        if (result.success && result.has_permission) {
          // Transform the default customer data to match the Customer interface
          const transformedCustomer: Customer = {
            id: defaultCustomer.id,
            name: defaultCustomer.name,
            email: defaultCustomer.email || '',
            phone: defaultCustomer.phone || '',
            type: (defaultCustomer.customer_type === "Company" ? "company" : "individual") as 'individual' | 'company',
            address: {
              street: "",
              city: "",
              state: "",
              zipCode: "",
              country: "Cambodia",
            },
            loyaltyPoints: 0,
            totalSpent: 0,
            totalOrders: 0,
            preferredPaymentMethod: "Cash" as const,
            notes: "",
            tags: [],
            status: "active",
            createdAt: new Date().toISOString(),
            defaultCurrency: defaultCustomer.default_currency || undefined,
          };

          setSelectedCustomer(transformedCustomer);
          setCustomerSearchQuery(transformedCustomer.name);
          setShowCustomerDropdown(false);
        } else {
          console.log("User does not have permission to access default customer:", defaultCustomer.id, result);
          // Don't set the default customer if user doesn't have permission
          // The single customer auto-selection logic below will handle selecting the first available customer
        }
      }).catch((error) => {
        console.error("Error checking default customer permission:", error);
        // Don't set the default customer if there's an error checking permissions
      });
    }
  }, [posDetails, selectedCustomer, _posLoading, userRemovedDefaultCustomer, checkCustomerPermission]);

  useEffect(() => {
    const fetchAndSetInfo = async () => {
      const newBatches = { ...itemBatches };
      const newSerials = { ...itemSerials } as Record<string, string[]>;

      for (const item of cartItems) {
        const key = item.item_code || item.id;
        if (key && key !== 'undefined') {
          if (!newBatches[key]) {
            try {
              const batches = await getBatches(item.id);
              if (Array.isArray(batches)) newBatches[key] = batches;
            } catch (err) {
              console.error("Error fetching batches", err);
            }
          }
          if (!newSerials[key]) {
            try {
              const serials = await getSerials(key);
              if (Array.isArray(serials)) newSerials[key] = serials;
            } catch (err) {
              console.error("Error fetching serials", err);
            }
          }
        } else {
          console.log(`OrderSummary: Skipping initial info loading for key "${key}"`);
        }
      }

      setItemBatches(newBatches);
      setItemSerials(newSerials);
    };

    if (cartItems.length) {
      fetchAndSetInfo();
    }
  }, [cartItems]);

  // Listen for batch quantity updates from ProductProvider
  useEffect(() => {
    const handleBatchUpdate = (event: CustomEvent) => {
      const { updatedItems } = event.detail;

      setItemBatches(prevBatches => {
        const newBatches = { ...prevBatches };

        //eslint-disable-next-line @typescript-eslint/no-explicit-any
        updatedItems.forEach(({ itemCode, batches }: { itemCode: string; batches: any[] }) => {
          if (itemCode && itemCode !== 'undefined') {
            newBatches[itemCode] = batches;
          } else {
            console.log(`OrderSummary: Skipping invalid itemCode: "${itemCode}"`);
          }
        });

        // Remove any undefined keys
        if (newBatches['undefined'] !== undefined) {
          delete newBatches['undefined'];
        }
        const undefinedKey = undefined as unknown as string;
        if (newBatches[undefinedKey] !== undefined) {
          delete newBatches[undefinedKey];
        }

        return newBatches;
      });
    };

    window.addEventListener('batchQuantitiesUpdated', handleBatchUpdate as EventListener);

    // Listen for preselection from search (batch/serial)
    const handleSetBatch = (event: CustomEvent) => {
      const { itemCode, batchId } = event.detail as { itemCode: string; batchId: string };
      const item = cartItems.find(ci => (ci.item_code || ci.id) === itemCode)
      if (item) {
        const selectedQty = itemBatches[item.item_code || item.id]?.find(b => b.batch_id === batchId)?.qty || 0
        setItemDiscounts(prev => ({
          ...prev,
          [item.id]: {
            ...(prev[item.id] || { discountPercentage: 0, discountAmount: 0, batchNumber: '', serialNumber: '', availableQuantity: 0 }),
            batchNumber: batchId || '',
            availableQuantity: selectedQty,
          }
        }))
      } else {
        // Save pending, to be applied when item appears in cart
        setPendingPreselect(prev => ({
          ...prev,
          [itemCode]: { ...(prev[itemCode] || {}), batchId }
        }))
      }
    }

    const handleSetSerial = (event: CustomEvent) => {
      const { itemCode, serialNo } = event.detail as { itemCode: string; serialNo: string };
      const item = cartItems.find(ci => (ci.item_code || ci.id) === itemCode)
      if (item) {
        setItemDiscounts(prev => ({
          ...prev,
          [item.id]: {
            ...(prev[item.id] || { discountPercentage: 0, discountAmount: 0, batchNumber: '', serialNumber: '', availableQuantity: 0 }),
            serialNumber: serialNo || '',
          }
        }))
        // Ensure the serial exists in options for visibility; if not, inject it
        setItemSerials(prev => {
          const key = item.item_code || item.id
          const existing = new Set(prev[key] || [])
          if (!existing.has(serialNo)) {
            return { ...prev, [key]: [...existing, serialNo] as string[] }
          }
          return prev
        })
      } else {
        // Save pending, to be applied when item appears in cart
        setPendingPreselect(prev => ({
          ...prev,
          [itemCode]: { ...(prev[itemCode] || {}), serialNo }
        }))
      }
    }

    window.addEventListener('cart:setBatchForItem', handleSetBatch as EventListener)
    window.addEventListener('cart:setSerialForItem', handleSetSerial as EventListener)

    return () => {
      window.removeEventListener('batchQuantitiesUpdated', handleBatchUpdate as EventListener);
      window.removeEventListener('cart:setBatchForItem', handleSetBatch as EventListener)
      window.removeEventListener('cart:setSerialForItem', handleSetSerial as EventListener)
    };
  }, [cartItems, itemBatches]);

  // Keyboard shortcuts for checkout, hold, and clear cart
  useEffect(() => {
    const handleKeyboardShortcuts = (e: KeyboardEvent) => {
      // Skip shortcuts when PaymentDialog is open (it has its own shortcuts)
      if (showPaymentDialog) return;
      
      // Only handle if Cmd (Mac) or Ctrl (Windows/Linux) is pressed
      if (!(e.metaKey || e.ctrlKey)) return;
      
      // Don't trigger shortcuts when typing in input fields (except for these specific shortcuts)
      const target = e.target as HTMLElement;
      const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      
      if (e.key === 'Enter') {
        // Cmd+Enter: Open checkout/payment dialog
        e.preventDefault();
        if (cartItems.length > 0 && selectedCustomer) {
          setShowPaymentDialog(true);
        } else if (cartItems.length > 0 && !selectedCustomer) {
          toast.error("Please select a customer first");
        }
      } else if (e.key === 'x' && !isInputField) {
        // Cmd+X: Hold order (only when not in input field to avoid conflicting with cut)
        e.preventDefault();
        if (cartItems.length > 0 && selectedCustomer) {
          // Build order data and call handleHoldOrder
          const orderData = {
            items: cartItems.map((item) => ({
              id: item.id,
              quantity: item.quantity,
              description: item.custom_description,
              price: item.price,
              item_group: item.item_group,
              custom_ds_roofing_spec: itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec,
              custom_description: item.custom_description,
            })),
            customer: { id: selectedCustomer.id },
            subtotal,
            total,
            appliedCoupons,
            itemDiscounts,
            totalItemDiscount,
            status: "held",
          };
          handleHoldOrder(orderData);
        } else if (cartItems.length > 0 && !selectedCustomer) {
          toast.error("Please select a customer first");
        }
      } else if (e.key === 'c' && !isInputField) {
        // Cmd+C: Clear cart (only when not in input field to avoid conflicting with copy)
        e.preventDefault();
        if (cartItems.length > 0 && onClearCart) {
          onClearCart();
          toast.info('Cart cleared');
        }
      } else if (e.key === 'v' && !isInputField) {
        // Cmd+V: Focus customer search (only when not in input field to avoid conflicting with paste)
        e.preventDefault();
        if (customerSearchInputRef.current) {
          setCustomerSearchQuery(''); // Clear existing search
          setSelectedCustomer(null); // Clear selected customer to enable search
          setShowCustomerDropdown(true);
          // Use setTimeout to ensure state updates before focus
          setTimeout(() => {
            customerSearchInputRef.current?.focus();
            customerSearchInputRef.current?.select(); // Select all text if any remains
          }, 10);
        }
      }
    };

    window.addEventListener('keydown', handleKeyboardShortcuts);
    return () => {
      window.removeEventListener('keydown', handleKeyboardShortcuts);
    };
  }, [cartItems, selectedCustomer, onClearCart, subtotal, total, appliedCoupons, itemDiscounts, totalItemDiscount, itemRoofingSpecs, handleHoldOrder, showPaymentDialog]);

  // Apply any pending pre-selections when cart items change
  useEffect(() => {
    if (!cartItems.length) return
    const nextPending = { ...pendingPreselect }
    cartItems.forEach(item => {
      const key = item.item_code || item.id
      const pending = nextPending[key]
      if (pending) {
        if (pending.batchId) {
          const selectedQty = itemBatches[key]?.find(b => b.batch_id === pending.batchId)?.qty || 0
          setItemDiscounts(prev => ({
            ...prev,
            [item.id]: {
              ...(prev[item.id] || { discountPercentage: 0, discountAmount: 0, batchNumber: '', serialNumber: '', availableQuantity: 0 }),
              batchNumber: pending.batchId || '',
              availableQuantity: selectedQty,
            }
          }))
        }
        if (pending.serialNo) {
          setItemDiscounts(prev => ({
            ...prev,
            [item.id]: {
              ...(prev[item.id] || { discountPercentage: 0, discountAmount: 0, batchNumber: '', serialNumber: '', availableQuantity: 0 }),
              serialNumber: pending.serialNo || '',
            }
          }))
          setItemSerials(prev => {
            const existing = new Set(prev[key] || [])
            if (!existing.has(pending.serialNo!)) {
              return { ...prev, [key]: [...existing, pending.serialNo!] as string[] }
            }
            return prev
          })
        }
        delete nextPending[key]
      }
    })
    if (Object.keys(nextPending).length !== Object.keys(pendingPreselect).length) {
      setPendingPreselect(nextPending)
    }
  }, [cartItems, itemBatches, pendingPreselect])

  return (
    <div
      className={`${
        isMobile ? "h-full flex flex-col" : "h-full flex flex-col"
      } bg-white dark:bg-gray-800 ${
        !isMobile ? "border-l" : ""
      } border-gray-200 dark:border-gray-700`}
    >
      {/* Header */}
      {!isMobile && (
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          {/* Customer Search */}
          <div className="relative">
            <div className="flex items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  ref={customerSearchInputRef}
                  type="text"
                  placeholder="Search customers... (name, email, or phone)"
                  value={customerSearchQuery}
                  onChange={(e) => {
                    setCustomerSearchQuery(e.target.value);
                    setShowCustomerDropdown(e.target.value.length > 0);
                    setSelectedCustomerIndex(-1); // Reset selection when query changes
                  }}
                  onKeyDown={handleCustomerSearchKeyDown} // Add this line
                  onFocus={() => setShowCustomerDropdown(true)}
                  className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />

                {/* Customer Dropdown */}
                {showCustomerDropdown && filteredCustomers.length > 0 && (
                  <div 
                    ref={customerDropdownRef}
                    className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto"
                  >
                    {filteredCustomers.slice(0, 8).map((customer, index) => (
                      <button
                        key={customer.id}
                        onClick={() => handleCustomerSelect(customer)}
                        className={`w-full px-3 py-2 text-left border-b border-gray-100 dark:border-gray-700 last:border-b-0 ${
                          selectedCustomerIndex === index
                            ? 'bg-beveren-100 dark:bg-beveren-900'
                            : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        <div className="flex items-center space-x-2">
                          {getCustomerTypeIcon(customer)}
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900 dark:text-white text-sm truncate">
                              {customer.name}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                               {customer.phone} • {customer.email}
                            </div>
                          </div>
                          {/* {customer.status === "vip" && (
                            <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300 rounded">
                              VIP
                            </span>
                          )} */}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={() => setShowAddCustomerModal(true)}
                className="ml-2 p-2 bg-beveren-600 text-white rounded-lg hover:bg-beveren-700 transition-colors"
                title="Add New Customer"
              >
                <UserPlus size={16} />
              </button>
            </div>

            {/* Selected Customer Display */}
            {selectedCustomer && (
              <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                {/* Debug: Log customer data */}
                {/* {console.log("Selected Customer Data (Mobile):", {
                  name: selectedCustomer,
                  phone: selectedCustomer.phone,
                  phoneType: typeof selectedCustomer.phone,
                  phoneLength: selectedCustomer.phone?.length,
                  phoneNotNA: selectedCustomer.phone !== "N/A",
                  phoneTruthy: !!selectedCustomer.phone,
                  totalOrders: selectedCustomer.totalOrders,
                  realTimeOrders: customerStats?.total_orders,
                  loyaltyPoints: selectedCustomer.loyaltyPoints
                })} */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    {selectedCustomer && getCustomerTypeIcon(selectedCustomer)}
                    <div>
                      <div className="font-medium text-gray-900 dark:text-white text-sm">
                        {selectedCustomer?.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {/* Debug phone rendering */}
                        {/* {console.log("Phone rendering check:", {
                          phone: selectedCustomer.phone,
                          phoneExists: !!selectedCustomer.phone,
                          phoneNotNA: selectedCustomer.phone !== "N/A",
                          shouldShowPhone: selectedCustomer.phone && selectedCustomer.phone !== "N/A"
                        })} */}
                        {selectedCustomer.phone && selectedCustomer.phone !== "N/A" && selectedCustomer.phone.trim() !== "" && (
                          <span>{selectedCustomer.phone}</span>
                        )}
                        {selectedCustomer.phone && selectedCustomer.phone !== "N/A" && selectedCustomer.phone.trim() !== "" && (customerStats?.total_orders || 0) > 0 && (
                          <span className="mx-2">•</span>
                        )}
                        {(customerStats?.total_orders || 0) > 0 && (
                          <span>{customerStats?.total_orders || 0} orders</span>
                        )}
                        {(!selectedCustomer.phone || selectedCustomer.phone === "N/A" || selectedCustomer.phone.trim() === "") && (customerStats?.total_orders || 0) === 0 && (
                          <span className="text-gray-400 italic">No additional info</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedCustomer(null);
                      setCustomerSearchQuery("");
                      setUserRemovedDefaultCustomer(true);
                    }}
                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* Invoice Ref Input */}
            <div className="mt-3">
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Invoice Ref (Optional)
              </label>
              <input
                type="number"
                value={invoiceRef || ''}
                onChange={(e) => setInvoiceRef(e.target.value ? parseInt(e.target.value, 10) : null)}
                placeholder="Enter hard copy invoice number"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
            </div>
          </div>
        </div>
      )}

      {/* Mobile Customer Search */}

      {isMobile && (
        <div className="flex-shrink-0 p-4 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center space-x-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search customers... (name, email, or phone)"
                value={customerSearchQuery}
                onChange={(e) => {
                  setCustomerSearchQuery(e.target.value);
                  setShowCustomerDropdown(e.target.value.length > 0);
                }}
                onKeyPress={handleCustomerSearchKeyDown}
                onFocus={() => setShowCustomerDropdown(true)}
                className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />

              {/* ADD THIS MISSING DROPDOWN - This was missing in mobile version */}
              {showCustomerDropdown && filteredCustomers.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
                  {filteredCustomers.slice(0, 8).map((customer) => (
                    <button
                      key={customer.id}
                      onClick={() => handleCustomerSelect(customer)}
                      className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                    >
                      <div className="flex items-center space-x-2">
                        {getCustomerTypeIcon(customer)}
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-900 dark:text-white text-sm truncate">
                            {customer.name}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            {customer.email} • {customer.phone}
                          </div>
                        </div>
                        {/* {customer.status === "vip" && (
                          <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300 rounded">
                            VIP
                          </span>
                        )} */}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setShowAddCustomerModal(true)}
              className="p-2 bg-beveren-600 text-white rounded-lg hover:bg-beveren-700 transition-colors"
            >
              <UserPlus size={16} />
            </button>
          </div>

          {selectedCustomer && (
            <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
              {/* Debug: Log customer data */}
              {/* {console.log("Selected Customer Data:", {
                name: selectedCustomer.name,
                phone: selectedCustomer.phone,
                phoneType: typeof selectedCustomer.phone,
                phoneLength: selectedCustomer.phone?.length,
                phoneNotNA: selectedCustomer.phone !== "N/A",
                phoneTruthy: !!selectedCustomer.phone,
                totalOrders: selectedCustomer.totalOrders,
                realTimeOrders: customerStats?.total_orders,
                loyaltyPoints: selectedCustomer.loyaltyPoints
              })} */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  {selectedCustomer && getCustomerTypeIcon(selectedCustomer)}
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white text-sm">
                      {selectedCustomer?.name}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {/* Debug phone rendering */}
                      {/* {console.log("Phone rendering check (Desktop):", {
                        phone: selectedCustomer.phone,
                        phoneExists: !!selectedCustomer.phone,
                        phoneNotNA: selectedCustomer.phone !== "N/A",
                        shouldShowPhone: selectedCustomer.phone && selectedCustomer.phone !== "N/A"
                      })} */}
                      {selectedCustomer.phone && selectedCustomer.phone !== "N/A" && selectedCustomer.phone.trim() !== "" && (
                        <span>{selectedCustomer.phone}</span>
                      )}
                      {selectedCustomer.phone && selectedCustomer.phone !== "N/A" && selectedCustomer.phone.trim() !== "" && (customerStats?.total_orders || 0) > 0 && (
                        <span className="mx-2">•</span>
                      )}
                      {(customerStats?.total_orders || 0) > 0 && (
                        <span>{customerStats?.total_orders || 0} orders</span>
                      )}
                      {(!selectedCustomer.phone || selectedCustomer.phone === "N/A" || selectedCustomer.phone.trim() === "") && (customerStats?.total_orders || 0) === 0 && (
                        <span className="text-gray-400 italic">No additional info</span>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSelectedCustomer(null);
                    setCustomerSearchQuery("");
                    setUserRemovedDefaultCustomer(true);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Cart Items - Scrollable on Mobile */}
      <div
        className={`${
          isMobile
            ? "flex-1 overflow-y-auto custom-scrollbar p-4"
            : "flex-1 overflow-y-auto p-6 cart-scroll"
        }`}
      >
        <div className="space-y-4">
          {cartItems.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-6xl mb-4">🛒</div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                Your cart is empty
              </h3>
              <p className="text-gray-500 dark:text-gray-400">
                Add some items to get started!
              </p>
            </div>
          ) : (
            cartItems.map((item) => {
              const discountedPrice = getDiscountedPrice(item);
              // Calculate display quantity for 'zn' items
              const displayQuantity = item.category?.toLowerCase() === "zn" 
                ? calculateQuantityFromSpecs(itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec)
                : item.quantity;
              const originalTotal = item.price * displayQuantity;
              const discountedTotal = discountedPrice * displayQuantity;
              const itemDiscount = itemDiscounts[item.id] || {
                discountPercentage: 0,
                discountAmount: 0,
                batchNumber: "",
                serialNumber: "",
                availableQuantity: 150,
              };

              return (
                <div
                  key={item.id}
                  className={`${
                    isMobile
                      ? "bg-gray-50 dark:bg-gray-700 rounded-lg overflow-hidden"
                      : ""
                  }`}
                >
                  {/* Main item row */}
                  <div
                    className={`flex items-center ${isMobile ? "p-3" : "py-2"}`}
                  >
                    {/* Expand/Collapse Arrow */}
                    <div className="flex-shrink-0 mr-2">
                      <button
                        onClick={() => toggleItemExpansion(item.id)}
                        className={`${
                          isMobile ? "w-5 h-5" : "w-5 h-5"
                        } rounded-full bg-gray-100 dark:bg-gray-600 flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-500 transition-all duration-200`}
                        title="Show/Hide Details"
                      >
                        <svg
                          className={`${
                            isMobile ? "w-3 h-3" : "w-4 h-4"
                          } text-beveren-500 dark:text-gray-400 transform transition-transform duration-200 ${
                            expandedItems.has(item.id) ? "rotate-90" : ""
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </button>
                    </div>

                    {/* Product Image - Only show if image exists */}
                    {item.image && (
                      <div className="flex-shrink-0">
                        <img
                          src={item.image}
                          alt={item.name}
                          className={`${
                            isMobile ? "w-16 h-16" : "w-12 h-12"
                          } rounded-lg object-cover`}
                          crossOrigin="anonymous"
                        />
                      </div>
                    )}

                    {/* Product Info */}
                    <div className="flex-1 min-w-0 px-3">
                      <h4
                        className={`font-semibold text-gray-900 dark:text-white ${
                          isMobile ? "text-base" : "text-sm"
                        } truncate`}
                      >
                        {item.name}
                      </h4>
                      <p
                        className={`text-gray-500 dark:text-gray-400 capitalize font-medium ${
                          isMobile ? "text-sm" : "text-xs"
                        }`}
                      >
                        {item.category}
                      </p>
                      
                      <div className={`${isMobile ? "text-base" : "text-sm"}`}>
                        {discountedPrice < item.price ? (
                          <div className="flex items-center space-x-2">
                            <span className="text-gray-400 line-through text-xs">
                              {currency_symbol}
                              {item.price.toFixed(2)}
                            </span>

                            <span className="text-beveren-600 dark:text-beveren-400 font-semibold">
                              {currency_symbol}
                              {discountedPrice.toFixed(2)}
                            </span>
                          </div>
                        ) : (
                          <div className="text-beveren-600 dark:text-beveren-400 font-semibold">
                            {currency_symbol}
                            {item.price.toFixed(2)}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Quantity Controls - Fixed Width Container */}
                    <div className="flex-shrink-0 flex items-center ml-10 space-x-1 min-w-[70px] justify-center">
                      <button
                        onClick={() =>
                          onUpdateQuantity(item.id, item.quantity - 1)
                        }
                        disabled={item.category?.toLowerCase() === "zn"}
                        className={`${
                          isMobile ? "w-8 h-8" : "w-5 h-5"
                        } rounded-full bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors ${
                          item.category?.toLowerCase() === "zn" ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                      >
                        <Minus
                          size={isMobile ? 16 : 14}
                          className="text-gray-600 dark:text-gray-400"
                        />
                      </button>
                      <span
                        className={`${
                          isMobile ? "w-10" : "w-8"
                        } text-center font-semibold text-gray-900 dark:text-white text-sm`}
                      >
                        {displayQuantity.toFixed(2)}
                      </span>
                      <button
                        onClick={() =>
                          onUpdateQuantity(item.id, item.quantity + 1)
                        }
                        disabled={item.category?.toLowerCase() === "zn"}
                        className={`${
                          isMobile ? "w-8 h-8" : "w-7 h-7"
                        } rounded-full bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-center justify-center hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors ${
                          item.category?.toLowerCase() === "zn" ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                      >
                        <Plus size={isMobile ? 16 : 14} className="text-blue-600 dark:text-blue-400" />
                      </button>
                    </div>

                    {/* Total Price - Fixed Width */}
                    <div className="flex-shrink-0 text-right min-w-[80px] px-2">
                      {discountedTotal < originalTotal ? (
                        <div>
                          <p className="text-gray-400 line-through text-xs">
                            {currency_symbol}
                            {originalTotal.toFixed(2)}
                          </p>
                          <p
                            className={`text-beveren-600 dark:text-beveren-400 font-semibold ${
                              isMobile ? "text-base" : "text-sm"
                            }`}
                          >
                            {currency_symbol}
                            {discountedTotal.toFixed(2)}
                          </p>
                        </div>
                      ) : (
                        <p
                          className={`text-beveren-600 dark:text-beveren-400 font-semibold ${
                            isMobile ? "text-base" : "text-sm"
                          }`}
                        >
                          {currency_symbol}
                          {discountedTotal.toFixed(2)}
                        </p>
                      )}
                    </div>

                    {/* Remove Button */}
                    <div className="flex-shrink-0 ml-2">
                      <button
                        onClick={() =>
                          onRemoveItem
                            ? onRemoveItem(item.id)
                            : onUpdateQuantity(item.id, 0)
                        }
                        className={`${
                          isMobile ? "w-8 h-8" : "w-6 h-6"
                        } rounded-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-200 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400 transition-colors`}
                        title="Remove item"
                      >
                        <X size={isMobile ? 16 : 12} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Details Section */}
                  {expandedItems.has(item.id) && (
                    <div
                      className={`border-t border-gray-200 dark:border-gray-600 ${
                        isMobile ? "px-3 pb-3" : "px-6 py-3 ml-7"
                      } bg-gray-25 dark:bg-gray-750`}
                    >
                      <div className="w-full">
                        
                        
                        {/* Row 3: Roofing Spec (only for item_group 'zn') */}
                        {item.category?.toLowerCase() === "zn" && (
                          
                          <RoofingSpecTable
                            item={item}
                            onSpecChange={(specs) => {
                              handleRoofingSpecChange(item.id, specs);
                              applyRoofingSpecToItem(item.id, specs);
                            }}
                            isMobile={isMobile}
                          />
                        )}
                        {/* Row 1: Quantity | UOM */}
                        <div className="grid grid-cols-2 gap-4 mb-4">
                          <div>
                            <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"} mb-2`}>
                              Quantity {item.category?.toLowerCase() === "zn" && <span className="text-red-500 text-xs">(Auto-calculated from spec)</span>}
                            </label>
                            {item.category?.toLowerCase() === "zn" ? (
                              <div className={`w-full ${isMobile ? "text-sm" : "text-sm"} px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white opacity-60 cursor-not-allowed flex items-center`}>
                                {calculateQuantityFromSpecs(itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec).toFixed(2)}
                              </div>
                            ) : (
                              <QuantityInput
                                item={item}
                                onUpdateQuantity={onUpdateQuantity}
                                isMobile={isMobile}
                              />
                            )}
                          </div>
                          <div>
                            <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"} mb-2`}>
                              UOM
                            </label>
                            <UOMSelectField item={item} onUOMChange={handleUOMChange} isMobile={isMobile} selectedCustomer={selectedCustomer} />
                          </div>
                        </div>

                        {/* Row 2: Discount Amount | Discount (%) */}
                        <div className="grid grid-cols-2 gap-4 mb-4">
                          <div>
                            <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"} mb-2`}>
                              Discount Amount
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={itemDiscount.discountAmount || ""}
                              onChange={(e) =>
                                updateItemDiscount(
                                  item.id,
                                  "discountAmount",
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              placeholder="0.00"
                              className={`w-full ${isMobile ? "text-sm" : "text-sm"} px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white`}
                            />
                          </div>
                          <div>
                            <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"} mb-2`}>
                              Discount (%)
                            </label>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.1"
                              value={itemDiscount.discountPercentage || ""}
                              onChange={(e) =>
                                updateItemDiscount(
                                  item.id,
                                  "discountPercentage",
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              placeholder="0.0"
                              className={`w-full ${isMobile ? "text-sm" : "text-sm"} px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-beveren-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-white`}
                            />
                          </div>
                        </div>

                        
                        {/* Row 4: Batch | Serial No */}
                        <div className="grid grid-cols-2 gap-4 mb-4">
                          <div>
                            <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"} mb-2`}>
                              Batch
                            </label>
                            <BatchSelectField
                              itemId={item.id}
                              itemCode={item.item_code || item.id}
                              options={itemBatches[item.item_code || item.id] || []}
                              value={itemDiscount.batchNumber || ""}
                              onChange={(selectedBatch, selectedQty) => {
                                updateItemDiscount(item.id, "batchNumber", selectedBatch)
                                updateItemDiscount(item.id, "availableQuantity", selectedQty)
                              }}
                              isMobile={isMobile}
                            />
                          </div>
                          <div>
                            <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"} mb-2`}>
                              Serial No
                            </label>
                            <SerialSelectField
                              itemId={item.id}
                              itemCode={item.item_code || item.id}
                              options={itemSerials[item.item_code || item.id] || []}
                              value={itemDiscount.serialNumber || ""}
                              onChange={(sn) => updateItemDiscount(item.id, "serialNumber", sn)}
                              isMobile={isMobile}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Discount Summary */}
                      {(itemDiscount.discountPercentage > 0 ||
                        itemDiscount.discountAmount > 0) && (
                        <div className="mt-3 p-2 bg-green-50 dark:bg-green-900/20 rounded-md border border-green-200 dark:border-green-800">
                          <div className="text-xs text-green-800 dark:text-green-300 font-medium">
                            Discount Applied:
                          </div>
                          <div className="flex justify-between items-center mt-1">
                            <span className="text-xs text-green-700 dark:text-green-400">
                              {itemDiscount.discountPercentage > 0 &&
                                `${itemDiscount.discountPercentage}% off`}
                              {itemDiscount.discountPercentage > 0 &&
                                itemDiscount.discountAmount > 0 &&
                                " + "}
                              {itemDiscount.discountAmount > 0 &&
                                `${itemDiscount.discountAmount.toFixed(2)} off`}
                            </span>
                            <span className="text-xs font-semibold text-green-800 dark:text-green-300">
                              Save $
                              {(originalTotal - discountedTotal).toFixed(2)}
                            </span>
                          </div>
                        </div>
                      )}

                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Summary - Always Visible at Bottom on Mobile */}
      {cartItems.length > 0 && (
        <div
          className={`${
            isMobile
              ? "flex-shrink-0 p-3 bg-white dark:bg-gray-800 border-t border-gray-100 dark:border-gray-700 shadow-lg"
              : "p-4 border-t border-gray-100 dark:border-gray-700"
          } space-y-3`}
        >

          {/* Action Buttons */}
          <div className={`grid grid-cols-2 gap-3 ${isMobile ? "mb-3" : ""}`}>
            <button
              onClick={() => {
                if (!validateCustomer()) return;

                const sc = selectedCustomer;
                if (!sc) return;

                const orderData = {
                  items: cartItems.map((item) => ({
                    id: item.id,
                    quantity: item.quantity,
                    description: item.custom_description,
                    price: getDiscountedPrice(item),
                    item_group: item.item_group,
                    custom_ds_roofing_spec: itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec,
                    custom_description: item.custom_description,
                  })),
                  customer: { id: sc.id },
                  subtotal,
                  total,
                  appliedCoupons,
                  itemDiscounts,
                  totalItemDiscount,
                  totalSavings: totalItemDiscount + couponDiscount,
                  status: "held",
                };

                handleHoldOrder(orderData);
              }}
              className="px-3 py-2 border border-beveren-600 text-beveren-600 dark:text-beveren-400 rounded-lg font-medium hover:bg-beveren-600 hover:text-white transition-colors text-sm"
            >
              Hold
            </button>
            <button
              onClick={handleClearCart}
              className="px-3 py-2 border border-red-500 text-red-600 dark:text-red-400 rounded-lg font-medium hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-sm"
            >
              Clear Cart
            </button>
          </div>



          {/* Pay Button */}
          <button
            onClick={() => {
              if (!validateCustomer()) return;
              setShowPaymentDialog(true);
            }}
            className={`w-full bg-beveren-600 text-white rounded-xl font-semibold hover:bg-beveren-700 transition-colors ${
              isMobile ? "py-3 text-base" : "py-2 text-sm"
            }`}
          >
            Checkout {currency_symbol}
            {total.toFixed(2)}
          </button>
        </div>
      )}

      {/* Add Customer Modal */}
      {showAddCustomerModal && (
        <AddCustomerModal
          customer={null}
          onClose={() => {
            setShowAddCustomerModal(false);
            setPrefilledCustomerName("");
            setPrefilledData({});
          }}
          onSave={handleSaveCustomer}
          prefilledName={prefilledCustomerName}
          prefilledData={prefilledData}
        />
      )}

      {/* Payment Dialog */}
      {showPaymentDialog && (
        <PaymentDialog
          isOpen={showPaymentDialog}
          onClose={handleClosePaymentDialog}
          cartItems={cartItems.map((item) => {
            // Use calculated quantity for 'zn' items
            const quantity = item.category?.toLowerCase() === "zn" 
              ? calculateQuantityFromSpecs(itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec)
              : item.quantity;
            const discountedPrice = getDiscountedPrice(item);
            return {
              ...item,
              category: item.category,
              description: item.custom_description,
              quantity: quantity,
              discountedPrice: discountedPrice,
              itemDiscount: itemDiscounts[item.id] || {},
              originalPrice: item.price,
              finalAmount: discountedPrice * quantity,
              custom_ds_roofing_spec: itemRoofingSpecs[item.id] || item.custom_ds_roofing_spec,
            };
          })}
          appliedCoupons={appliedCoupons}
          selectedCustomer={selectedCustomer}
          onCompletePayment={handleCompletePayment}
          onHoldOrder={handleHoldOrder}
          isMobile={isMobile}
          itemDiscounts={itemDiscounts}
          totalItemDiscount={totalItemDiscount}
          invoiceRef={invoiceRef}
        />
      )}
    </div>
  );
}
