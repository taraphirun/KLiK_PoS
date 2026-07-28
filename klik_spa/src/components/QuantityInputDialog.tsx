"use client"

import { useState, useEffect, useRef } from "react"
import { X } from "lucide-react"
import type { MenuItem } from "../../types"

interface QuantityInputDialogProps {
  isOpen: boolean
  onClose: () => void
  item: MenuItem | null
  onConfirm: (item: MenuItem, quantity: number) => void
}

export default function QuantityInputDialog({
  isOpen,
  onClose,
  item,
  onConfirm,
}: QuantityInputDialogProps) {
  const [quantity, setQuantity] = useState("1")
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus and select input when dialog opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      // Small delay to ensure dialog is rendered
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [isOpen])

  // Reset quantity when item changes or dialog opens
  useEffect(() => {
    if (isOpen) {
      setQuantity("1")
    }
  }, [isOpen, item])

  const handleSubmit = () => {
    if (!item) return
    const qty = parseFloat(quantity) || 1
    if (qty > 0) {
      onConfirm(item, qty)
      onClose()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    }
  }

  if (!isOpen || !item) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Enter Quantity
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {/* Item info */}
          <div className="flex items-center space-x-3 mb-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
            {item.image ? (
              <img
                src={item.image}
                alt={item.name}
                className="w-12 h-12 rounded-lg object-cover"
              />
            ) : (
              <div className="w-12 h-12 bg-gray-200 dark:bg-gray-600 rounded-lg flex items-center justify-center">
                <span className="text-gray-400 text-xs">No img</span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900 dark:text-white truncate">
                {item.name}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {item.price.toLocaleString()} per {item.uom || "unit"}
              </p>
            </div>
          </div>

          {/* Quantity input */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Quantity ({item.uom || "units"})
            </label>
            <input
              ref={inputRef}
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              onKeyDown={handleKeyDown}
              min="0.001"
              step="any"
              className="w-full px-4 py-3 text-lg font-medium text-center border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-beveren-500 focus:border-transparent"
              placeholder="Enter quantity"
            />
            {item.available > 0 && (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 text-center">
                Available: {item.available} {item.uom || "units"}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex space-x-3 p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="flex-1 px-4 py-2.5 bg-beveren-600 hover:bg-beveren-700 text-white rounded-lg font-medium transition-colors"
          >
            Add to Cart
          </button>
        </div>
      </div>
    </div>
  )
}
