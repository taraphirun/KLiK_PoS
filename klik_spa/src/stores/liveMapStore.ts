import { create } from "zustand";
import type { ReconciliationStatus, ShopLocation } from "../services/delivery";

/** Local (browser) YYYY-MM-DD, not UTC - matches how LiveDeliveryMapPage's own timestamp handling
 * and DeliveryReconciliationPage's History tab filter both already treat these values. */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type MapPin = {
  name: string;
  gps_latitude: number;
  gps_longitude: number;
  delivery_driver_name: string | null;
  completion_status: string;
  payment_status: string;
  reconciliation_status: ReconciliationStatus;
  matched_invoice: string | null;
  reported_invoice_no: string | null;
  delivery_timestamp: string | null;
  /** Client-side only, set when this pin was first seen (initial fetch or realtime event) - used
   * purely to order the Live Feed by "what just happened", not delivery_timestamp itself. */
  receivedAt: number;
};

interface LiveMapState {
  pins: Record<string, MapPin>;
  shopLocations: ShopLocation[];
  /** True once the first getDeliveryReports fetch has ever completed this session - lets
   * LiveDeliveryMapPage skip its full-screen "Loading deliveries..." spinner (and the map
   * blanking out) on every remount, not just the very first visit. */
  hasLoadedOnce: boolean;
  statusFilter: Set<ReconciliationStatus>;
  driverFilter: string;
  search: string;
  fromDate: string;
  toDate: string;
  /** Last known camera position, written from the Map's onCameraChanged - read once (via
   * getState(), not a reactive selector - see LiveDeliveryMapPage) as the next mount's
   * defaultCenter/defaultZoom so panning/zooming survives navigating away and back. */
  cameraCenter: { lat: number; lng: number } | null;
  cameraZoom: number | null;
  setPins: (pins: Record<string, MapPin>) => void;
  upsertPin: (pin: MapPin) => void;
  setShopLocations: (locations: ShopLocation[]) => void;
  markLoaded: () => void;
  setStatusFilter: (
    updater: Set<ReconciliationStatus> | ((prev: Set<ReconciliationStatus>) => Set<ReconciliationStatus>)
  ) => void;
  setDriverFilter: (value: string) => void;
  setSearch: (value: string) => void;
  setFromDate: (value: string) => void;
  setToDate: (value: string) => void;
  setCamera: (center: { lat: number; lng: number }, zoom: number) => void;
}

/** Module-level (outside React) store for the Live Delivery Map page (2026-08-06 - "it seems to
 * refresh every time i navigate away and come back"). React Router unmounts the page's component
 * on navigation and mounts a brand-new instance on return - previously *all* of its state lived in
 * plain useState, so every trip away and back re-showed the loading spinner, re-fetched all pins,
 * dropped every filter, and snapped the camera back to the computed default instead of wherever the
 * user had panned/zoomed to. None of that is actually necessary to re-derive; it just needs to
 * outlive the component. Kept in-memory only (no persist middleware) - this only needs to survive
 * an SPA route change, not a real browser reload, and delivery pins are live data that should
 * always refetch fresh on an actual reload anyway. */
export const useLiveMapStore = create<LiveMapState>((set) => ({
  pins: {},
  shopLocations: [],
  hasLoadedOnce: false,
  statusFilter: new Set(["Unmatched", "Suggested", "Confirmed"]),
  driverFilter: "",
  search: "",
  // Defaults to today (2026-08-06, user request - replaces the Live Feed's old standalone "Today
  // Only" checkbox, which filtered independently of this range and could disagree with it). Staff
  // clear the date fields in the Filters panel to see older history.
  fromDate: todayStr(),
  toDate: todayStr(),
  cameraCenter: null,
  cameraZoom: null,
  setPins: (pins) => set({ pins }),
  upsertPin: (pin) => set((state) => ({ pins: { ...state.pins, [pin.name]: pin } })),
  setShopLocations: (shopLocations) => set({ shopLocations }),
  markLoaded: () => set({ hasLoadedOnce: true }),
  setStatusFilter: (updater) =>
    set((state) => ({
      statusFilter: typeof updater === "function" ? updater(state.statusFilter) : updater,
    })),
  setDriverFilter: (driverFilter) => set({ driverFilter }),
  setSearch: (search) => set({ search }),
  setFromDate: (fromDate) => set({ fromDate }),
  setToDate: (toDate) => set({ toDate }),
  setCamera: (cameraCenter, cameraZoom) => set({ cameraCenter, cameraZoom }),
}));
