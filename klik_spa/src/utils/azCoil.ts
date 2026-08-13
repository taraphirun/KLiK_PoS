// utils/azCoil.ts
//
// Shared "is this an AZ Coil roofing item" check. Previously duplicated verbatim in three places
// (cartStore.ts's addToCart/addToCartWithQuantity, and CartItemRow.tsx) - each computed the same
// POS Profile custom_az_coil_item_groups -> lowercase group-name set, then tested item_group/
// category against it. Pulled out here so the swap-product picker (SwapAZProductModal) can reuse
// the exact same rule without a fourth copy.
export interface AZCoilCheckable {
  item_group?: string;
  category?: string;
}

// Deliberately not typed against types/index.ts's POSProfile: the codebase has a second, separate
// POSProfile interface local to posProfileStore.ts (posDetails there is typed POSDetails, which
// extends that one, not this one) - the two are structurally close but not identical, and every
// existing call site already just read this one field off an untyped/any-typed posDetails. Kept
// that loose here too rather than fighting the two-POSProfile split (out of scope for this change).
// A plain all-optional interface would trip TS's weak-type check against POSDetails (its only
// route to this field is an index signature, not a named property), so use Record instead.
type AZCoilItemGroupsSource = Record<string, unknown>;

export function getAZCoilItemGroups(posDetails: AZCoilItemGroupsSource | null | undefined): string[] {
  const azGroups = posDetails?.custom_az_coil_item_groups || [];
  let groups: string[] = [];
  if (typeof azGroups === 'string') {
    groups = (azGroups as string).split(',').map((g: string) => g.trim().toLowerCase());
  } else if (Array.isArray(azGroups)) {
    groups = azGroups.map((g: any) => g.item_group?.toLowerCase()).filter(Boolean);
  }
  // No POS Profile config yet - "zn" is the long-standing default fallback these call sites all
  // shared before this was centralized.
  if (groups.length === 0) groups = ['zn'];
  return groups;
}

export function isAZCoilItem(item: AZCoilCheckable, posDetails: AZCoilItemGroupsSource | null | undefined): boolean {
  const groups = getAZCoilItemGroups(posDetails);
  return groups.includes(item.item_group?.toLowerCase() || '') || groups.includes(item.category?.toLowerCase() || '');
}
