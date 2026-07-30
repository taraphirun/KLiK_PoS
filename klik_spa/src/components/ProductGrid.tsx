"use client";

import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import type { MenuItem } from "../../types";
import { useProduct } from "../providers/ProductProvider";
import ProductCard from "./ProductCard";
import ProductLineView from "./ProductLineView";
import SalespersonAuthModal from "./dialog/SalespersonAuthModal";
import VariantPickerModal from "./VariantPickerModal";
import QuantityDialog from "./QuantityDialog";
import { useCartStore } from "../stores/cartStore";
import { usePOSProfileStore } from "../stores/posProfileStore";
import { useSalespersonStore } from "../stores/salespersonStore";


interface ProductGridProps {
  isMobile?: boolean;
  scannerOnly?: boolean;
  viewMode?: "grid" | "list";
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  totalCount?: number;
  isSearching?: boolean;
}

export default function ProductGrid({
  isMobile = false,
  scannerOnly = false,
  viewMode: propViewMode,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  totalCount = 0,
  isSearching = false,
}: ProductGridProps) {
  const { filteredItems, hideUnavailableItems, selectedCustomer } = useProduct();
  const { addToCart, addToCartWithQuantity } = useCartStore();
  const { posDetails } = usePOSProfileStore();
  const { activeSalesperson, ensureInitialized, isRestoring } = useSalespersonStore();
  const [showSalespersonModal, setShowSalespersonModal] = useState(false);
  const [pendingCartItem, setPendingCartItem] = useState<MenuItem | null>(null);
  const [variantTemplateItem, setVariantTemplateItem] = useState<MenuItem | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [quantityDialogItem, setQuantityDialogItem] = useState<MenuItem | null>(null);

  const defaultView = posDetails?.custom_default_view || "Grid View";
  const viewMode = propViewMode || (defaultView === "List View" ? "list" : "grid");
  const showItemCode = !!posDetails?.custom_show_item_code_in_product_list;
  const requiresSalespersonPin = !!posDetails?.custom_sales_person_pin_required;
  const isSalespersonLockActive = requiresSalespersonPin && !activeSalesperson && !isRestoring;

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  const inStockItems = useMemo(
    () => (
      hideUnavailableItems
        ? filteredItems.filter((item) => item.is_stock_item === false || item.available > 0)
        : filteredItems
    ),
    [filteredItems, hideUnavailableItems],
  );

  useEffect(() => {
    if (requiresSalespersonPin) {
      void ensureInitialized();
    }
  }, [requiresSalespersonPin, ensureInitialized]);

  useEffect(() => {
    if (isSalespersonLockActive) {
      setShowSalespersonModal(true);
      return;
    }

    setShowSalespersonModal(false);
    setPendingCartItem(null);
  }, [isSalespersonLockActive]);

  const addConcreteItemToCart = useCallback(async (item: MenuItem) => {
    await addToCart({
      ...item,
      item_code: item.id,
    });
  }, [addToCart]);

  const addItemToCart = useCallback(async (item: MenuItem) => {
    if (item.is_variant_template || item.has_variants) {
      setVariantTemplateItem(item);
      return;
    }

    await addConcreteItemToCart(item);
  }, [addConcreteItemToCart]);

  const handleAddToCart = useCallback(async (item: MenuItem) => {
    if (item.is_stock_item !== false && item.available <= 0) return;
    if (scannerOnly) return;

    if (requiresSalespersonPin) {
      await ensureInitialized();

      const {
        activeSalesperson: currentSalesperson,
        isRestoring: isCurrentlyRestoring,
      } = useSalespersonStore.getState();

      if (isCurrentlyRestoring) {
        return;
      }

      if (!currentSalesperson) {
        setPendingCartItem(item);
        setShowSalespersonModal(true);
        return;
      }
    }

    await addItemToCart(item);
  }, [addItemToCart, ensureInitialized, requiresSalespersonPin, scannerOnly]);

  const handleSalespersonAuthenticated = useCallback(() => {
    const itemToAdd = pendingCartItem;
    setPendingCartItem(null);
    setShowSalespersonModal(false);

    if (!itemToAdd) {
      return;
    }

    void addItemToCart(itemToAdd);
  }, [addItemToCart, pendingCartItem]);

  const handleVariantSelected = useCallback(async (variant: MenuItem) => {
    await addConcreteItemToCart(variant);
  }, [addConcreteItemToCart]);

  // Keep the highlight in range as search/pagination changes the result set,
  // without resetting position on every unrelated re-render.
  useEffect(() => {
    setHighlightedIndex((prev) => (prev >= inStockItems.length ? 0 : prev));
  }, [inStockItems]);

  const openQuantityDialogForItem = useCallback((item: MenuItem) => {
    if (item.is_stock_item !== false && item.available <= 0) return;
    if (scannerOnly) return;

    if (item.is_variant_template || item.has_variants) {
      setVariantTemplateItem(item);
      return;
    }

    if (requiresSalespersonPin && !activeSalesperson) {
      setPendingCartItem(item);
      setShowSalespersonModal(true);
      return;
    }

    setQuantityDialogItem(item);
  }, [scannerOnly, requiresSalespersonPin, activeSalesperson]);

  const handleQuantityConfirm = useCallback(async (item: MenuItem, quantity: number) => {
    await addToCartWithQuantity({ ...item, item_code: item.id }, quantity);
    setQuantityDialogItem(null);
  }, [addToCartWithQuantity]);

  const getColumnCount = useCallback(() => {
    const el = gridContainerRef.current;
    if (!el) return 1;
    const columns = window.getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
    return columns || 1;
  }, []);

  // Desktop-only grid keyboard navigation: Arrow keys move the highlight, Shift+Enter
  // opens the quantity dialog for the highlighted product. Scoped to grid view only —
  // list view uses a different component (ProductLineView) with no highlight support yet.
  useEffect(() => {
    if (isMobile || viewMode !== "grid") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSalespersonModal || variantTemplateItem || quantityDialogItem) return;
      if (inStockItems.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const isSearchInput = active?.getAttribute("data-pos-search-input") === "true";
      const isOtherEditable = !!active && !isSearchInput && (
        active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable
      );
      if (isOtherEditable) return;

      const isArrowLeftRight = e.key === "ArrowLeft" || e.key === "ArrowRight";
      // Let the search box's own cursor movement win when it's focused.
      if (isSearchInput && isArrowLeftRight) return;

      const isShiftEnter = e.key === "Enter" && e.shiftKey;
      const isArrow = e.key === "ArrowUp" || e.key === "ArrowDown" || isArrowLeftRight;
      if (!isArrow && !isShiftEnter) return;

      e.preventDefault();

      if (isShiftEnter) {
        const item = inStockItems[highlightedIndex];
        if (item) openQuantityDialogForItem(item);
        return;
      }

      const cols = getColumnCount();
      const max = inStockItems.length - 1;
      setHighlightedIndex((prev) => {
        if (e.key === "ArrowRight") return Math.min(max, prev + 1);
        if (e.key === "ArrowLeft") return Math.max(0, prev - 1);
        if (e.key === "ArrowDown") return Math.min(max, prev + cols);
        if (e.key === "ArrowUp") return Math.max(0, prev - cols);
        return prev;
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isMobile,
    viewMode,
    inStockItems,
    highlightedIndex,
    showSalespersonModal,
    variantTemplateItem,
    quantityDialogItem,
    getColumnCount,
    openQuantityDialogForItem,
  ]);

  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const target = entries[0];
      if (!target) return;
      if (target.isIntersecting && hasMore && !isLoadingMore && onLoadMore) {
        onLoadMore();
      }
    },
    [hasMore, isLoadingMore, onLoadMore],
  );

  useEffect(() => {
    const option = {
      root: null,
      rootMargin: "200px",
      threshold: 0,
    };

    const observer = new IntersectionObserver(handleObserver, option);
    const currentLoadMoreRef = loadMoreRef.current;

    if (currentLoadMoreRef) {
      observer.observe(currentLoadMoreRef);
    }

    return () => {
      if (currentLoadMoreRef) {
        observer.unobserve(currentLoadMoreRef);
      }
    };
  }, [handleObserver]);

  if (viewMode === "list") {
    return (
      <>
        <div className="flex flex-col relative">
        {isSearching && (
          <div className="absolute inset-0 bg-white/50 dark:bg-gray-900/50 z-10 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-beveren-600"></div>
          </div>
        )}
        <ProductLineView
          items={inStockItems}
          onAddToCart={handleAddToCart}
          isMobile={isMobile}
          showItemCode={showItemCode}
          scannerOnly={scannerOnly}
        />

        {onLoadMore && (
          <div ref={loadMoreRef} className="py-4 flex justify-center">
            {isLoadingMore && (
              <div className="flex items-center space-x-2">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-beveren-600"></div>
                <span className="text-gray-500 dark:text-gray-400 text-sm">
                  Loading more items...
                </span>
              </div>
            )}
            {!isLoadingMore && hasMore && (
              <span className="text-gray-400 dark:text-gray-500 text-sm">
                Showing {inStockItems.length} of {totalCount} items
              </span>
            )}
            {!hasMore && inStockItems.length > 0 && (
              <span className="text-gray-400 dark:text-gray-500 text-sm">
                All {inStockItems.length} items loaded
              </span>
            )}
          </div>
        )}
        </div>

        <SalespersonAuthModal
          isOpen={showSalespersonModal}
          onClose={() => {
            setShowSalespersonModal(false);
            setPendingCartItem(null);
          }}
          onAuthenticated={handleSalespersonAuthenticated}
          title="Verify salesperson"
          description="Verify the salesperson before adding items to the cart."
        />
        {variantTemplateItem && (
          <VariantPickerModal
            item={variantTemplateItem}
            customerId={selectedCustomer?.id}
            onClose={() => setVariantTemplateItem(null)}
            onSelectVariant={handleVariantSelected}
          />
        )}
      </>
    );
  }

  if (inStockItems.length === 0 && !isSearching) {
    return (
      <>
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="text-6xl mb-4">🔍</div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
              No items found
            </h3>
            <p className="text-gray-500 dark:text-gray-400">
              Try adjusting your search or filters
            </p>
          </div>
        </div>

        <SalespersonAuthModal
          isOpen={showSalespersonModal}
          onClose={() => {
            if (isSalespersonLockActive) {
              return;
            }
            setShowSalespersonModal(false);
            setPendingCartItem(null);
          }}
          onAuthenticated={handleSalespersonAuthenticated}
          allowDismiss={!isSalespersonLockActive}
          title={isSalespersonLockActive ? "Unlock POS" : "Verify salesperson"}
          description={
            isSalespersonLockActive
              ? "Enter the salesperson PIN to unlock this POS session and continue."
              : "Verify the salesperson before adding items to the cart."
          }
        />
        {variantTemplateItem && (
          <VariantPickerModal
            item={variantTemplateItem}
            customerId={selectedCustomer?.id}
            onClose={() => setVariantTemplateItem(null)}
            onSelectVariant={handleVariantSelected}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className={`${isMobile ? "p-3" : "p-6"} bg-gray-50 dark:bg-gray-900 relative`}>
      {isSearching && (
        <div className="absolute inset-0 bg-white/50 dark:bg-gray-900/50 z-10 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-beveren-600"></div>
        </div>
      )}
      <div
        ref={gridContainerRef}
        className={`grid ${isMobile ? "gap-3 grid-cols-2 sm:grid-cols-2" : "gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4"}`}
      >
        {inStockItems.map((item, index) => (
          <ProductCard
            key={item.id}
            item={item}
            onAddToCart={handleAddToCart}
            isMobile={isMobile}
            showItemCode={showItemCode}
            scannerOnly={scannerOnly}
            isHighlighted={!isMobile && index === highlightedIndex}
          />
        ))}
      </div>

      {onLoadMore && (
        <div ref={loadMoreRef} className="py-6 flex justify-center">
          {isLoadingMore && (
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-beveren-600"></div>
              <span className="text-gray-500 dark:text-gray-400 text-sm">
                Loading more items...
              </span>
            </div>
          )}
          {!isLoadingMore && hasMore && (
            <span className="text-gray-400 dark:text-gray-500 text-sm">
              Showing {inStockItems.length} of {totalCount} items • Scroll for more
            </span>
          )}
          {!hasMore && inStockItems.length > 0 && totalCount > 0 && (
            <span className="text-gray-400 dark:text-gray-500 text-sm">
              All {inStockItems.length} items loaded
            </span>
          )}
        </div>
      )}
      </div>

      <SalespersonAuthModal
        isOpen={showSalespersonModal}
        onClose={() => {
          if (isSalespersonLockActive) {
            return;
          }
          setShowSalespersonModal(false);
          setPendingCartItem(null);
        }}
        onAuthenticated={handleSalespersonAuthenticated}
        allowDismiss={!isSalespersonLockActive}
        title={isSalespersonLockActive ? "Unlock POS" : "Verify salesperson"}
        description={
          isSalespersonLockActive
            ? "Enter the salesperson PIN to unlock this POS session and continue."
            : "Verify the salesperson before adding items to the cart."
        }
      />
      {variantTemplateItem && (
        <VariantPickerModal
          item={variantTemplateItem}
          customerId={selectedCustomer?.id}
          onClose={() => setVariantTemplateItem(null)}
          onSelectVariant={handleVariantSelected}
        />
      )}
      {quantityDialogItem && (
        <QuantityDialog
          item={quantityDialogItem}
          onCancel={() => setQuantityDialogItem(null)}
          onConfirm={(quantity) => handleQuantityConfirm(quantityDialogItem, quantity)}
        />
      )}
    </>
  );
}
