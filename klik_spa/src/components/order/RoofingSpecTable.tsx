import React, { useEffect, useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CartItem } from '../../../types';
import { useCartStore } from '../../stores/cartStore';

interface RoofingSpecTableProps {
  item: CartItem;
  onUpdateQuantity: (id: string, quantity: number) => void;
  isMobile?: boolean;
}

export const RoofingSpecTable: React.FC<RoofingSpecTableProps> = ({ item, onUpdateQuantity, isMobile }) => {
  const { updateCartItemField } = useCartStore();
  const specs = item.custom_ds_roofing_spec || [];

  const handleSpecChange = (index: number, field: string, value: number) => {
    const newSpecs = [...specs];
    newSpecs[index] = { ...newSpecs[index], [field]: value };
    saveSpecs(newSpecs);
  };

  const addSpec = () => {
    saveSpecs([...specs, { straight: 0, curve: 0, end: 0, quantity: 1 }]);
  };

  const removeSpec = (index: number) => {
    const newSpecs = specs.filter((_, i) => i !== index);
    saveSpecs(newSpecs);
  };

  const saveSpecs = useCallback((newSpecs: any[]) => {
    // Calculate total quantity in meters
    let totalMeters = 0;
    let descriptionLines: string[] = [];

    newSpecs.forEach(spec => {
      const straight = Number(spec.straight) || 0;
      const curve = Number(spec.curve) || 0;
      const end = Number(spec.end) || 0;
      const qty = Number(spec.quantity) || 0;

      const sum = (straight + curve + end) / 100; // Assuming input is in cm? Wait, formula says "sum = (straight + curve + end) / 100".
      // Let's assume input is in CM, and output in Meters?
      // Wait, if it says "Straight Sheet: ត្រង់ 3.50m x 10 = 35.00m", and input is 350?
      // Let me re-read: "Formula (Option B): sum = (straight + curve + end) / 100".
      // Yes, if input is 350, then 350 / 100 = 3.50.
      const lineMeters = sum * qty;
      totalMeters += lineMeters;

      if (qty > 0 && sum > 0) {
        if (curve > 0 || end > 0) {
          // Curved Sheet: កោង (3.50m + 0.50m + 0.20m) x 10 = 42.00m
          const parts = [];
          if (straight > 0) parts.push(`${(straight / 100).toFixed(2)}m`);
          if (curve > 0) parts.push(`${(curve / 100).toFixed(2)}m`);
          if (end > 0) parts.push(`${(end / 100).toFixed(2)}m`);
          descriptionLines.push(`កោង (${parts.join(' + ')}) x ${qty} = ${lineMeters.toFixed(2)}m`);
        } else {
          // Straight Sheet: ត្រង់ 3.50m x 10 = 35.00m
          descriptionLines.push(`ត្រង់ ${(straight / 100).toFixed(2)}m x ${qty} = ${lineMeters.toFixed(2)}m`);
        }
      }
    });

    updateCartItemField(item.id, 'custom_ds_roofing_spec', newSpecs);
    updateCartItemField(item.id, 'custom_description', descriptionLines.join('\n'));
    onUpdateQuantity(item.id, Number(totalMeters.toFixed(2)));
  }, [item.id, updateCartItemField, onUpdateQuantity]);

  return (
    <div className="mt-2 w-full">
      <div className="flex justify-between items-center mb-2">
        <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"}`}>
          Roofing Specifications (cm)
        </label>
        <button
          onClick={addSpec}
          className="text-xs flex items-center gap-1 text-beveren-600 dark:text-beveren-400 hover:text-beveren-700"
        >
          <Plus size={14} /> Add Row
        </button>
      </div>

      {specs.length > 0 ? (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-600">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
              <tr>
                <th className="px-2 py-2 font-medium">Straight<br/>(cm)</th>
                <th className="px-2 py-2 font-medium">Curve<br/>(cm)</th>
                <th className="px-2 py-2 font-medium">End<br/>(cm)</th>
                <th className="px-2 py-2 font-medium">Qty</th>
                <th className="px-2 py-2 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-600">
              {specs.map((spec, index) => (
                <tr key={index} className="bg-white dark:bg-gray-700">
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min="0"
                      value={spec.straight || ''}
                      onChange={(e) => handleSpecChange(index, 'straight', Number(e.target.value))}
                      className="w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-gray-900 dark:text-white"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min="0"
                      value={spec.curve || ''}
                      onChange={(e) => handleSpecChange(index, 'curve', Number(e.target.value))}
                      className="w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-gray-900 dark:text-white"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min="0"
                      value={spec.end || ''}
                      onChange={(e) => handleSpecChange(index, 'end', Number(e.target.value))}
                      className="w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-gray-900 dark:text-white"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min="1"
                      value={spec.quantity || ''}
                      onChange={(e) => handleSpecChange(index, 'quantity', Number(e.target.value))}
                      className="w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-gray-900 dark:text-white"
                      placeholder="1"
                    />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <button
                      onClick={() => removeSpec(index)}
                      className="text-red-500 hover:text-red-700"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-xs text-gray-500 dark:text-gray-400 italic">
          No specifications added.
        </div>
      )}
      
      {item.custom_description && (
        <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-600">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Generated Note:</div>
          <pre className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap font-sans">
            {item.custom_description}
          </pre>
        </div>
      )}
    </div>
  );
};
