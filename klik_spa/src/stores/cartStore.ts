// stores/cartStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CartItem, GiftCoupon } from '../../types'
import type { Customer } from '../types/customer'
import { toast } from 'react-toastify'
import { clearDraftInvoiceCache } from '../utils/draftInvoiceCache'
import { usePOSProfileStore } from './posProfileStore'
import { roundCurrency } from '../utils/currencyMath'

interface SerialBatchEntry {
  serial_no?: string;
  batch_no?: string;
  qty?: number;
}

interface ItemTaxDetailsPayload {
  item_tax_template?: string;
  item_tax_rate?: Record<string, number>;
  rate?: number;
  tax_info?: {
    tax_templates?: Array<{ account: string; rate: number; is_inclusive: boolean }>;
    total_tax_rate?: number;
  };
}

interface PricedItemPayload {
  id?: string;
  item_code?: string;
  price?: number;
  original_price?: number;
  discount_percentage?: number;
  discount_amount?: number;
  pricing_rules?: unknown;
  has_pricing_rule?: boolean;
}

const roundToCurrencyPrecision = (value: number): number => {
  return roundCurrency(value);
};

const hasFiniteAvailableStock = (item: { available?: number; is_stock_item?: boolean }) => {
  if (item.is_stock_item === false) {
    return false;
  }
  // Stock Settings > Allow Negative Stock is a backend-wide setting - once it's on, the backend
  // itself will happily let a Sales Invoice push a bin below zero, so this cart-side guard (out-
  // of-stock blocking, "only N available" capping) has nothing left to enforce and must get out
  // of the way. Without this, turning the setting on server-side did nothing here: the cart kept
  // refusing to add items sitting at 0 or negative `available`, since this check never looked at
  // the setting at all.
  if (usePOSProfileStore.getState().allowNegativeStock) {
    return false;
  }
  return typeof item.available === 'number' && Number.isFinite(item.available);
};

const fetchItemTaxDetails = async (
  itemCode: string,
  customerId?: string,
  quantity: number = 1,
  uom?: string,
) => {
  try {
    const params = new URLSearchParams({
      item_code: itemCode,
      qty: String(quantity > 0 ? quantity : 1),
      uom: uom || 'Nos',
    });

    if (customerId) {
      params.append('customer', customerId);
    }

    const response = await fetch(
      `/api/method/klik_pos.api.item.item_tax_details.get_item_tax_details?${params.toString()}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    const message: ItemTaxDetailsPayload & { success?: boolean } = result?.message || {};

    if (!message.success) {
      return {
        item_tax_template: '',
        item_tax_rate: {},
        rate: 0,
        tax_templates: [],
        total_tax_rate: 0,
      };
    }

    return {
      item_tax_template: message.item_tax_template || '',
      item_tax_rate: message.item_tax_rate || {},
      rate: roundToCurrencyPrecision(Number(message.rate || 0)),
      tax_templates: message.tax_info?.tax_templates || [],
      total_tax_rate: Number(message.tax_info?.total_tax_rate || 0),
    };
  } catch (error) {
    console.error('Error fetching item tax details:', error);
    return {
      item_tax_template: '',
      item_tax_rate: {},
      rate: 0,
      tax_templates: [],
      total_tax_rate: 0,
    };
  }
};

interface CartState {
  cartItems: CartItem[]
  appliedCoupons: GiftCoupon[]
  selectedCustomer: Customer | null
  selectedPriceList: string | null
  isPricingLoading: boolean
  pricingError: string | null
  additionalDiscountAmount: number
  additionalDiscountPercentage: number
  applyDiscountOn: string

  addToCart: (item: Omit<CartItem, 'quantity'>) => Promise<void>
  addToCartWithQuantity: (item: Omit<CartItem, 'quantity'>, quantity: number) => Promise<void>
  updateQuantity: (id: string, quantity: number) => Promise<void>
  updateUOM: (id: string, uom: string, price: number) => Promise<void>
  removeItem: (id: string) => void
  clearCart: () => void
  applyCoupon: (coupon: GiftCoupon) => void
  removeCoupon: (couponCode: string) => void
  setSelectedCustomer: (customer: Customer | null) => Promise<void>
  setSelectedPriceList: (priceList: string | null) => Promise<void>
  refreshCartPricing: () => Promise<void>
  updateItemBundleEntries: (id: string, entries: SerialBatchEntry[]) => void
  updateCartItemField: <K extends keyof CartItem>(id: string, field: K, value: CartItem[K]) => void
  setAdditionalDiscountAmount: (amount: number) => void
  setAdditionalDiscountPercentage: (percentage: number) => void
  setApplyDiscountOn: (value: string) => void
}

const shouldInsertNewItemsAtTop = (): boolean => {
  const position = usePOSProfileStore.getState().posDetails?.custom_cart_item_insertion_position;
  return position === 'Top';
};

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      cartItems: [],
      appliedCoupons: [],
      selectedCustomer: null,
      selectedPriceList: null,
      isPricingLoading: false,
      pricingError: null,
      additionalDiscountAmount: 0,
      additionalDiscountPercentage: 0,
      applyDiscountOn: 'Grand Total',

      refreshCartPricing: async () => {
        const state = get();
        if (state.cartItems.length === 0) return;

        set({ isPricingLoading: true, pricingError: null });

        try {
          const itemsForPricing = state.cartItems.map(item => ({
            id: item.id,
            item_code: item.item_code || item.id,
            quantity: item.quantity,
            price: item.price,
            uom: item.uom,
          }));

          const customerId = state.selectedCustomer?.id;
          const params = new URLSearchParams({
            cart_items: JSON.stringify(itemsForPricing),
          });
          if (customerId) params.append('customer', customerId);
          const allowPriceListSwitching = !!usePOSProfileStore.getState().posDetails?.allow_price_list_switching;
          if (allowPriceListSwitching && state.selectedPriceList) params.append('price_list', state.selectedPriceList);
          const url = `/api/method/klik_pos.api.item.pricing.get_cart_pricing?${params.toString()}`;
          
          const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const result = await response.json();
          const pricingData = result.message;

          if (pricingData?.items) {
            set((state) => ({
              cartItems: state.cartItems.map(item => {
                const pricedItem = (pricingData.items as PricedItemPayload[]).find((p) => 
                  (p.id === item.id) || (p.item_code === (item.item_code || item.id))
                );
                if (pricedItem) {
                  const basePrice = Number(pricedItem.price || 0);

                  return {
                    ...item,
                    price: roundToCurrencyPrecision(basePrice),
                    original_price: pricedItem.original_price,
                    discount_percentage: pricedItem.discount_percentage,
                    discount_amount: pricedItem.discount_amount,
                    pricing_rules: pricedItem.pricing_rules,
                    has_pricing_rule: pricedItem.has_pricing_rule,
                  };
                }
                return item;
              }),
              isPricingLoading: false,
            }));
          } else {
            set({ isPricingLoading: false });
          }
        } catch (error) {
          console.error('Error refreshing cart pricing:', error);
          set({ 
            pricingError: error instanceof Error ? error.message : 'Failed to update prices',
            isPricingLoading: false 
          });
        }
      },

      addToCart: async (item) => {
        const state = get();
        const incomingCode = item.item_code || item.id;
        const customerId = state.selectedCustomer?.id;
        const existingItem = state.cartItems.find((cartItem) =>
          cartItem.id === item.id || (cartItem.item_code || cartItem.id) === incomingCode
        );
        const totalMatchingQty = state.cartItems
          .filter((cartItem) => (cartItem.item_code || cartItem.id) === incomingCode)
          .reduce((sum, cartItem) => sum + cartItem.quantity, 0);

        const posDetails = usePOSProfileStore.getState().posDetails;
        const azGroups = posDetails?.custom_az_coil_item_groups || [];
        let groups: string[] = [];
        if (typeof azGroups === 'string') {
            groups = (azGroups as string).split(',').map((g: string) => g.trim().toLowerCase());
        } else if (Array.isArray(azGroups)) {
            groups = azGroups.map((g: any) => g.item_group?.toLowerCase()).filter(Boolean);
        }
        if (groups.length === 0) groups = ["zn"];
        const isAZCoilItem = groups.includes((item as any).item_group?.toLowerCase() || "") || groups.includes(item.category?.toLowerCase() || "");

        if (hasFiniteAvailableStock(item) && item.available <= 0) {
          toast.error(`${item.name} is out of stock`);
          return;
        }

        if (existingItem) {
          if (isAZCoilItem) {
            toast.info(`Item already in cart. Expand it to adjust specifications.`);
            return;
          }
          if (hasFiniteAvailableStock(item) && totalMatchingQty >= item.available) {
            toast.error(`Only ${item.available} ${item.uom || 'units'} of ${item.name} available`);
            return;
          }

          const targetId = existingItem.id;
          const updatedQty = existingItem.quantity + 1;
          const taxDetails = await fetchItemTaxDetails(
            incomingCode,
            customerId,
            updatedQty,
            existingItem.uom || item.uom,
          );

          set((state) => ({
            cartItems: state.cartItems.map((cartItem) =>
              cartItem.id === targetId
                ? {
                    ...cartItem,
                    quantity: updatedQty,
                    item_tax_template: taxDetails.item_tax_template,
                    item_tax_rate: taxDetails.item_tax_rate,
                    tax_templates: taxDetails.tax_templates,
                    total_tax_rate: taxDetails.total_tax_rate,
                  }
                : cartItem
            )
          }));
        } else {
          const initialQty = isAZCoilItem ? 0 : 1;
          const taxDetails = await fetchItemTaxDetails(
            incomingCode,
            customerId,
            initialQty || 1,
            item.uom,
          );

          const newItem = {
            ...item, 
            quantity: initialQty,
            bundle_entries: [],
            item_tax_template: taxDetails.item_tax_template,
            item_tax_rate: taxDetails.item_tax_rate,
            tax_templates: taxDetails.tax_templates,
            total_tax_rate: taxDetails.total_tax_rate,
          };
          const newCartItems = shouldInsertNewItemsAtTop()
            ? [newItem, ...state.cartItems]
            : [...state.cartItems, newItem];
          set({ cartItems: newCartItems });
        }

        await get().refreshCartPricing();
      },

      addToCartWithQuantity: async (item, quantity) => {
        const state = get();
        const incomingCode = item.item_code || item.id;
        const customerId = state.selectedCustomer?.id;
        const existingItem = state.cartItems.find((cartItem) =>
          cartItem.id === item.id || (cartItem.item_code || cartItem.id) === incomingCode
        );
        const totalMatchingQty = state.cartItems
          .filter((cartItem) => (cartItem.item_code || cartItem.id) === incomingCode)
          .reduce((sum, cartItem) => sum + cartItem.quantity, 0);

        const posDetails = usePOSProfileStore.getState().posDetails;
        const azGroups = posDetails?.custom_az_coil_item_groups || [];
        let groups: string[] = [];
        if (typeof azGroups === 'string') {
            groups = (azGroups as string).split(',').map((g: string) => g.trim().toLowerCase());
        } else if (Array.isArray(azGroups)) {
            groups = azGroups.map((g: any) => g.item_group?.toLowerCase()).filter(Boolean);
        }
        if (groups.length === 0) groups = ["zn"];
        const isAZCoilItem = groups.includes((item as any).item_group?.toLowerCase() || "") || groups.includes(item.category?.toLowerCase() || "");

        if (hasFiniteAvailableStock(item) && item.available < quantity) {
          toast.error(`Only ${item.available} ${item.uom || 'units'} of ${item.name} available`);
          return;
        }

        if (existingItem) {
          if (isAZCoilItem) {
            toast.info(`Item already in cart. Expand it to adjust specifications.`);
            return;
          }
          if (hasFiniteAvailableStock(item) && (totalMatchingQty + quantity) > item.available) {
            toast.error(`Only ${item.available} ${item.uom || 'units'} of ${item.name} available`);
            return;
          }

          const targetId = existingItem.id;
          const updatedQty = existingItem.quantity + quantity;
          const taxDetails = await fetchItemTaxDetails(
            incomingCode,
            customerId,
            updatedQty,
            existingItem.uom || item.uom,
          );

          set((state) => ({
            cartItems: state.cartItems.map((cartItem) =>
              cartItem.id === targetId
                ? {
                    ...cartItem,
                    quantity: updatedQty,
                    item_tax_template: taxDetails.item_tax_template,
                    item_tax_rate: taxDetails.item_tax_rate,
                    tax_templates: taxDetails.tax_templates,
                    total_tax_rate: taxDetails.total_tax_rate,
                  }
                : cartItem
            )
          }));
        } else {
          const initialQty = isAZCoilItem ? 0 : quantity;
          const taxDetails = await fetchItemTaxDetails(
            incomingCode,
            customerId,
            initialQty || 1,
            item.uom,
          );

          const newItem = {
            ...item, 
            quantity: initialQty,
            bundle_entries: [],
            item_tax_template: taxDetails.item_tax_template,
            item_tax_rate: taxDetails.item_tax_rate,
            tax_templates: taxDetails.tax_templates,
            total_tax_rate: taxDetails.total_tax_rate,
          };
          const newCartItems = shouldInsertNewItemsAtTop()
            ? [newItem, ...state.cartItems]
            : [...state.cartItems, newItem];
          set({ cartItems: newCartItems });
        }

        await get().refreshCartPricing();
      },

      updateQuantity: async (id, quantity) => {
        const state = get();
        if (quantity <= 0) {
          set({
            cartItems: state.cartItems.filter((item) => item.id !== id)
          });
          await get().refreshCartPricing();
          return;
        }

        const item = state.cartItems.find((cartItem) => cartItem.id === id);
        if (item && hasFiniteAvailableStock(item) && quantity > item.available) {
          toast.error(`Only ${item.available} ${item.uom || 'units'} of ${item.name} available`);
          return;
        }

        set({
          cartItems: state.cartItems.map((item) =>
            item.id === id ? { ...item, quantity } : item
          )
        });

        await get().refreshCartPricing();
      },

      updateUOM: async (id, uom, price) => {
        set((state) => ({
          cartItems: state.cartItems.map((item) => {
            if (item.id === id) {
              return { ...item, uom, price };
            }
            return item;
          })
        }));
        await get().refreshCartPricing();
      },

      removeItem: (id) => {
        set((state) => ({
          cartItems: state.cartItems.filter((item) => item.id !== id)
        }));
        get().refreshCartPricing();
      },

      clearCart: () => {
        clearDraftInvoiceCache();
        set(() => ({
          cartItems: [],
          appliedCoupons: [],
          selectedCustomer: null,
          selectedPriceList: null,
          additionalDiscountAmount: 0,
          additionalDiscountPercentage: 0,
          applyDiscountOn: 'Grand Total',
        }));
      },

      applyCoupon: (coupon) => set((state) => {
        if (!state.appliedCoupons.some((c) => c.code === coupon.code)) {
          return {
            appliedCoupons: [...state.appliedCoupons, coupon]
          }
        }
        return state
      }),

      removeCoupon: (couponCode) => set((state) => ({
        appliedCoupons: state.appliedCoupons.filter((coupon) => coupon.code !== couponCode)
      })),

      setSelectedCustomer: async (customer) => {
        set({ selectedCustomer: customer });
        const state = get();
        if (state.cartItems.length > 0) {
          await state.refreshCartPricing();
        }
      },

      setSelectedPriceList: async (priceList) => {
        set({ selectedPriceList: priceList });
        const state = get();
        if (state.cartItems.length > 0) {
          await state.refreshCartPricing();
        }
      },

      updateItemBundleEntries: (id: string, entries: SerialBatchEntry[]) => {
        set((state) => ({
          cartItems: state.cartItems.map((item) =>
            item.id === id
              ? { ...item, bundle_entries: entries }
              : item
          )
        }));
      },

      updateCartItemField: (id, field, value) => {
        set((state) => ({
          cartItems: state.cartItems.map((item) =>
            item.id === id ? { ...item, [field]: value } : item
          ),
        }))
      },

      setAdditionalDiscountAmount: (amount) => set({ additionalDiscountAmount: amount }),
      setAdditionalDiscountPercentage: (percentage) => set({ additionalDiscountPercentage: percentage }),
      setApplyDiscountOn: (value) => set({ applyDiscountOn: value }),
    }),
    {
      name: 'beveren-cart-storage'
    }
  )
)
