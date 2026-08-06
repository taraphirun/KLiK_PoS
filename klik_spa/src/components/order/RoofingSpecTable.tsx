import React, { useCallback, useEffect, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CartItem } from '../../../types';
import { useCartStore } from '../../stores/cartStore';

interface RoofingSpecTableProps {
  item: CartItem;
  onUpdateQuantity: (id: string, quantity: number) => void;
  isMobile?: boolean;
}

// Column order for "." keypad navigation (below) - must match the field names used in each spec
// row's onChange handlers.
const COLUMNS = ['straight', 'curve', 'end', 'quantity'] as const;

export const RoofingSpecTable: React.FC<RoofingSpecTableProps> = ({ item, onUpdateQuantity, isMobile }) => {
  const { updateCartItemField } = useCartStore();
  const specs = item.custom_ds_roofing_spec || [];

  // User request (2026-08-06): the numpad's "." key doesn't type a decimal point here - these
  // fields are whole-cm measurements, so a literal decimal was never useful - it instead hops to
  // the next column, and from the last column (Quantity) it adds a new row and hops there, so a
  // row can be entered start-to-finish without ever touching anything but the numpad. Keyed by
  // "row-column" since rows can be added/removed and refs need to track whichever input currently
  // occupies each cell, not a fixed identity.
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Set right before an insert that should move focus once the new row exists in the DOM -
  // consumed by the effect below on the next render (inserting is async: it goes through
  // saveSpecs -> updateCartItemField -> a prop update from the cart store).
  const pendingFocusRowRef = useRef<number | null>(null);

  const focusCell = (row: number, col: number) => {
    const el = inputRefs.current[`${row}-${COLUMNS[col]}`];
    el?.focus();
    el?.select();
  };

  // User request (2026-08-06): landing on any field - by tap, Tab, or the "." navigation above -
  // should select its whole value so typing overwrites it outright, rather than inserting into or
  // appending onto whatever was already there.
  //
  // Also scrolls the field into view (2026-08-06 follow-up) - this table scrolls horizontally
  // (overflow-x-auto) and a row inserted via "." navigation is focused programmatically, so
  // there's no guarantee its column is actually in view yet. That's what made the .zoom-on-focus
  // effect below look "off-center": the OS's own automatic input-zoom centers on wherever the
  // input currently sits, and an out-of-view column sits somewhere the zoom math doesn't expect.
  // scrollIntoView here brings it fully into view *before* anything zooms.
  const handleInputFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.select();
    e.target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  };

  useEffect(() => {
    if (pendingFocusRowRef.current !== null) {
      const row = pendingFocusRowRef.current;
      pendingFocusRowRef.current = null;
      // The new row's input isn't in the DOM yet on this same tick - wait one frame.
      requestAnimationFrame(() => focusCell(row, 0));
    }
  }, [specs.length]);

  const handleSpecChange = (index: number, field: string, value: number) => {
    const newSpecs = [...specs];
    newSpecs[index] = { ...newSpecs[index], [field]: value };
    saveSpecs(newSpecs);
  };

  const addSpec = () => {
    saveSpecs([...specs, { straight: 0, curve: 0, end: 0, quantity: 1 }]);
  };

  // Inserts directly below rowIndex (not necessarily at the end of the table) and arranges for
  // its Straight cell to get focus once it exists.
  const insertRowAfter = (rowIndex: number) => {
    const newSpecs = [...specs];
    newSpecs.splice(rowIndex + 1, 0, { straight: 0, curve: 0, end: 0, quantity: 1 });
    pendingFocusRowRef.current = rowIndex + 1;
    saveSpecs(newSpecs);
  };

  const handleDecimalKey = (e: React.KeyboardEvent<HTMLInputElement>, rowIndex: number, colIndex: number) => {
    if (e.key !== '.') return;
    e.preventDefault();
    if (colIndex < COLUMNS.length - 1) {
      focusCell(rowIndex, colIndex + 1);
    } else if (rowIndex + 1 < specs.length) {
      // A next row already exists (e.g. you went back to an earlier row to fix something) - go
      // to it instead of inserting a new blank one in between.
      focusCell(rowIndex + 1, 0);
    } else {
      insertRowAfter(rowIndex);
    }
  };

  const removeSpec = (index: number) => {
    // Never go back to zero rows - see the useEffect above for why.
    if (specs.length <= 1) return;
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

    // Only update quantity to 0 if all specs are removed, otherwise keep current quantity to prevent item deletion when adding new empty row
    if (newSpecs.length === 0 || totalMeters > 0) {
      onUpdateQuantity(item.id, Number(totalMeters.toFixed(2)));
    }
  }, [item.id, updateCartItemField, onUpdateQuantity]);

  // User request: always land on at least one row - a freshly-added coil item starts with zero
  // rows and no other affordance to open the cart (see MobilePOSLayout's hasCartItems fix), so an
  // empty table here was a second dead end right behind it. removeSpec below refuses to go back
  // to zero for the same reason, so this only ever fires for a genuinely fresh item.
  useEffect(() => {
    if (specs.length === 0) {
      addSpec();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs.length]);

  return (
    <div className="mt-2 w-full">
      <div className="flex justify-between items-center mb-2">
        <label className={`block text-gray-700 dark:text-gray-300 font-medium ${isMobile ? "text-sm" : "text-sm"}`}>
          Roofing Specifications (cm)
        </label>
      </div>

      {specs.length > 0 ? (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-600">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
              <tr>
                <th className="px-2 py-2 font-medium w-8 text-center">No</th>
                <th className="px-2 py-2 font-medium">Straight</th>
                <th className="px-2 py-2 font-medium">Curve</th>
                <th className="px-2 py-2 font-medium">End</th>
                <th className="px-2 py-2 font-medium">Quantity</th>
                <th className="px-2 py-2 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-600">
              {specs.map((spec, index) => (
                <tr key={index} className="bg-white dark:bg-gray-700">
                  <td className="px-2 py-1 text-center font-medium text-gray-500 dark:text-gray-400">
                    {index + 1}
                  </td>
                  <td className="px-2 py-1">
                    <input
                      ref={(el) => { inputRefs.current[`${index}-straight`] = el; }}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={spec.straight || ''}
                      onChange={(e) => handleSpecChange(index, 'straight', Number(e.target.value))}
                      onKeyDown={(e) => handleDecimalKey(e, index, 0)}
                      onFocus={handleInputFocus}
                      autoComplete="off"
                      className="zoom-on-focus w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-base text-gray-900 dark:text-white"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      ref={(el) => { inputRefs.current[`${index}-curve`] = el; }}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={spec.curve || ''}
                      onChange={(e) => handleSpecChange(index, 'curve', Number(e.target.value))}
                      onKeyDown={(e) => handleDecimalKey(e, index, 1)}
                      onFocus={handleInputFocus}
                      autoComplete="off"
                      className="zoom-on-focus w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-base text-gray-900 dark:text-white"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      ref={(el) => { inputRefs.current[`${index}-end`] = el; }}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={spec.end || ''}
                      onChange={(e) => handleSpecChange(index, 'end', Number(e.target.value))}
                      onKeyDown={(e) => handleDecimalKey(e, index, 2)}
                      onFocus={handleInputFocus}
                      autoComplete="off"
                      className="zoom-on-focus w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-base text-gray-900 dark:text-white"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      ref={(el) => { inputRefs.current[`${index}-quantity`] = el; }}
                      type="number"
                      inputMode="decimal"
                      min="1"
                      value={spec.quantity || ''}
                      onChange={(e) => handleSpecChange(index, 'quantity', Number(e.target.value))}
                      onKeyDown={(e) => handleDecimalKey(e, index, 3)}
                      onFocus={handleInputFocus}
                      autoComplete="off"
                      className="zoom-on-focus w-full px-1 py-1 border border-gray-300 dark:border-gray-500 rounded text-center bg-transparent text-base text-gray-900 dark:text-white"
                      placeholder="1"
                    />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <button
                      onClick={() => removeSpec(index)}
                      disabled={specs.length <= 1}
                      title={specs.length <= 1 ? "At least one row is required" : "Remove row"}
                      className="text-red-500 hover:text-red-700 disabled:text-gray-300 disabled:hover:text-gray-300 disabled:cursor-not-allowed dark:disabled:text-gray-600 dark:disabled:hover:text-gray-600"
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
        <div className="text-xs text-gray-500 dark:text-gray-400 italic mb-2">
          No specifications added.
        </div>
      )}

      <div className="mt-2 flex justify-start">
        <button
          onClick={addSpec}
          className="text-sm font-medium flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-beveren-50 dark:bg-beveren-900/30 text-beveren-600 dark:text-beveren-400 hover:bg-beveren-100 dark:hover:bg-beveren-900/50 transition-colors"
        >
          <Plus size={16} /> Add Row
        </button>
      </div>
      
    </div>
  );
};
