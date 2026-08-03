import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APIProvider, ControlPosition, Map, MapControl, Marker, useMap } from "@vis.gl/react-google-maps";
import { AlertTriangle, Crosshair, Layers, Loader2, MapPin, Minus, Plus, Receipt, Search, User, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import BottomNavigation from "../components/BottomNavigation";
import {
  getDeliveryReports,
  getShopLocations,
  subscribeToDeliveryUpdates,
  type DeliveryReport,
  type DeliveryRealtimeUpdate,
  type ReconciliationStatus,
  type ShopLocation,
} from "../services/delivery";
import { getRealtimeSocket } from "../utils/realtime";
import { usePOSProfileStore } from "../stores/posProfileStore";

const ALL_STATUSES = "Unmatched,Suggested,Confirmed,Rejected";
const DEFAULT_CENTER = { lat: 11.5564, lng: 104.9282 }; // Phnom Penh - used only when there are no pins yet.
const CLUSTER_RADIUS_METERS = 75;

// Priority order for a cluster's color/status when it contains a mix - the status most needing
// attention wins, mirroring the reconciliation queue's own grouping priority (2026-07-31).
const STATUS_PRIORITY: ReconciliationStatus[] = ["Unmatched", "Suggested", "Rejected", "Confirmed"];
const STATUS_COLOR: Record<ReconciliationStatus, string> = {
  Unmatched: "#ef4444",
  Suggested: "#eab308",
  Rejected: "#a855f7",
  Confirmed: "#22c55e",
};

// Solid teardrop "map pin" shape (same family as lucide-react's MapPin, already used elsewhere on
// this page) in a 24x24 path coordinate space - replaces the old flat SymbolPath.CIRCLE dot
// (2026-08-03 follow-up, user request: show the cluster's delivery count inside a pin, not a
// plain dot). anchor/labelOrigin are expressed in this same unscaled 24x24 space; Maps scales both
// together with the path via `scale`, so they stay aligned regardless of pin size.
const PIN_PATH = "M12 2C7.58 2 4 5.58 4 10c0 6.5 8 14 8 14s8-7.5 8-14c0-4.42-3.58-8-8-8z";
const PIN_ANCHOR = { x: 12, y: 24 };
const PIN_LABEL_ORIGIN = { x: 12, y: 9.5 };

type MapPin = {
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

function toPin(report: DeliveryReport, receivedAt: number): MapPin | null {
  if (report.gps_latitude == null || report.gps_longitude == null) return null;
  return {
    name: report.name,
    gps_latitude: report.gps_latitude,
    gps_longitude: report.gps_longitude,
    delivery_driver_name: report.delivery_driver_name || report.reported_driver_name || null,
    completion_status: report.completion_status,
    payment_status: report.payment_status,
    reconciliation_status: report.reconciliation_status,
    matched_invoice: report.matched_invoice ?? null,
    reported_invoice_no: report.reported_invoice_no ?? null,
    delivery_timestamp: report.delivery_timestamp ?? null,
    receivedAt,
  };
}

function updateToPin(update: DeliveryRealtimeUpdate, receivedAt: number): MapPin {
  return {
    name: update.name,
    gps_latitude: update.gps_latitude,
    gps_longitude: update.gps_longitude,
    delivery_driver_name: update.delivery_driver_name,
    completion_status: update.completion_status,
    payment_status: update.payment_status,
    reconciliation_status: update.reconciliation_status,
    matched_invoice: update.matched_invoice,
    reported_invoice_no: update.reported_invoice_no,
    delivery_timestamp: update.delivery_timestamp,
    receivedAt,
  };
}

/** Permissive by design (2026-08-03 follow-up): a report with no delivery_timestamp yet (e.g.
 * Unmatched, awaiting confirmation) is presumably very recent and shouldn't be hidden from the
 * feed just for lacking a stamp - only an *actually past-dated* timestamp excludes it. */
function isToday(timestamp: string | null): boolean {
  if (!timestamp) return true;
  const today = new Date();
  const ts = new Date(timestamp.replace(" ", "T"));
  return ts.getFullYear() === today.getFullYear() && ts.getMonth() === today.getMonth() && ts.getDate() === today.getDate();
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface ClusterData {
  id: string;
  lat: number;
  lng: number;
  items: MapPin[];
}

/** Simple radius-based grouping (nearest-cluster-append) - same approach as the reference bot UI
 * (hd-delivery-telegram/frontend/src/components/DeliveryMap.tsx), adapted rather than pulling in
 * a clustering library since it's plenty fast at this app's delivery volume. O(pins * clusters),
 * fine well beyond any realistic single-day delivery count. */
function buildClusters(pins: MapPin[], radiusMeters: number): ClusterData[] {
  const clusters: ClusterData[] = [];
  for (const pin of pins) {
    const match = clusters.find((c) => haversineMeters(pin.gps_latitude, pin.gps_longitude, c.lat, c.lng) <= radiusMeters);
    if (match) {
      match.items.push(pin);
    } else {
      clusters.push({ id: pin.name, lat: pin.gps_latitude, lng: pin.gps_longitude, items: [pin] });
    }
  }
  return clusters;
}

function clusterStatus(items: MapPin[]): ReconciliationStatus {
  for (const status of STATUS_PRIORITY) {
    if (items.some((i) => i.reconciliation_status === status)) return status;
  }
  return "Confirmed";
}

function ClusterMarker({ cluster, onClick }: { cluster: ClusterData; onClick: () => void }) {
  const color = STATUS_COLOR[clusterStatus(cluster.items)];
  const isGroup = cluster.items.length > 1;

  return (
    <Marker
      position={{ lat: cluster.lat, lng: cluster.lng }}
      onClick={onClick}
      zIndex={cluster.items.length}
      icon={{
        path: PIN_PATH,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 1.5,
        scale: isGroup ? 1.8 : 1.4,
        anchor: new google.maps.Point(PIN_ANCHOR.x, PIN_ANCHOR.y),
        labelOrigin: new google.maps.Point(PIN_LABEL_ORIGIN.x, PIN_LABEL_ORIGIN.y),
      }}
      label={{ text: String(cluster.items.length), color: "#ffffff", fontSize: "11px", fontWeight: "bold" }}
    />
  );
}

const SHOP_PIN_ICON = "/assets/klik_pos/klik_spa/shop-location-pin.png";
const SHOP_PIN_SIZE = 40;

/** A fixed shop pin (2026-08-03 follow-up) - most deliveries originate near a shop, so this gives
 * the map a reference point. User-provided teardrop-pin-with-building icon (self-hosted, served
 * from klik_spa/public - not hotlinked), distinct in shape from every delivery pin's flat
 * status-colored circle so it reads as fundamentally different at a glance. anchor is set to the
 * pin's actual tip (bottom-center of the square source image) so the marker points precisely at
 * the coordinate rather than centering the whole icon on it. */
function ShopMarker({ location }: { location: ShopLocation }) {
  return (
    <Marker
      position={{ lat: location.latitude, lng: location.longitude }}
      title={`${location.warehouse_name} (shop)`}
      icon={{
        url: SHOP_PIN_ICON,
        scaledSize: new google.maps.Size(SHOP_PIN_SIZE, SHOP_PIN_SIZE),
        anchor: new google.maps.Point(SHOP_PIN_SIZE / 2, SHOP_PIN_SIZE),
      }}
      zIndex={1000}
    />
  );
}

/** Custom floating controls (map type, recenter, zoom) instead of Google's default UI - matches
 * the reference bot UI's CustomMapControls. "Recenter" fits bounds around the currently visible
 * pins rather than a fixed home location, since this app has no equivalent "home" concept. */
function MapControls({ pins, shopLocations }: { pins: MapPin[]; shopLocations: ShopLocation[] }) {
  const map = useMap();
  const [mapType, setMapType] = useState<"roadmap" | "satellite">("roadmap");

  const toggleMapType = () => {
    const next = mapType === "roadmap" ? "satellite" : "roadmap";
    setMapType(next);
    map?.setMapTypeId(next);
  };

  const recenter = () => {
    if (!map || (pins.length === 0 && shopLocations.length === 0)) return;
    const bounds = new google.maps.LatLngBounds();
    pins.forEach((pin) => bounds.extend({ lat: pin.gps_latitude, lng: pin.gps_longitude }));
    shopLocations.forEach((location) => bounds.extend({ lat: location.latitude, lng: location.longitude }));
    map.fitBounds(bounds, 64);
  };

  const zoomBy = (delta: number) => {
    if (!map) return;
    map.setZoom((map.getZoom() || 12) + delta);
  };

  const buttonClass =
    "flex h-9 w-9 items-center justify-center bg-white/90 text-gray-700 transition-colors hover:bg-gray-50 dark:bg-gray-800/90 dark:text-gray-200 dark:hover:bg-gray-700";

  return (
    <MapControl position={ControlPosition.RIGHT_TOP}>
      <div className="m-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={toggleMapType}
          title="Toggle map type"
          className={`${buttonClass} rounded-lg border border-gray-200 shadow-md backdrop-blur-sm dark:border-gray-700`}
        >
          <Layers size={16} />
        </button>
        <button
          type="button"
          onClick={recenter}
          title="Center on deliveries"
          className={`${buttonClass} rounded-lg border border-gray-200 shadow-md backdrop-blur-sm dark:border-gray-700`}
        >
          <Crosshair size={16} />
        </button>
        <div className="flex flex-col overflow-hidden rounded-lg border border-gray-200 shadow-md backdrop-blur-sm dark:border-gray-700">
          <button type="button" onClick={() => zoomBy(1)} title="Zoom in" className={`${buttonClass} border-b border-gray-200 dark:border-gray-700`}>
            <Plus size={16} />
          </button>
          <button type="button" onClick={() => zoomBy(-1)} title="Zoom out" className={buttonClass}>
            <Minus size={16} />
          </button>
        </div>
      </div>
    </MapControl>
  );
}

const FLY_TARGET_ZOOM = 17;

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/** Imperatively "flies" the map to a target location - ported from the companion
 * hd-delivery-telegram bot's own live map (frontend/src/components/DeliveryMap.tsx's flyTo(),
 * 2026-08-03 follow-up: "check my hd delivery telegram and see how this issue is handled"). Drives
 * map.moveCamera() every animation frame with continuously-interpolated center/zoom, including a
 * parabolic zoom-out-then-in dip (their exact formula/thresholds, kept as-is) - not a discrete
 * step-by-step setZoom() loop, which is what caused the previous attempt's tile-reload flicker.
 * Genuinely smooth (no reload jumps) *if* the map is vector-rendered (custom_google_maps_map_id
 * set on the POS Profile, wired into <Map mapId=...> below) - on plain raster tiles this still
 * runs, but raster's own discrete per-zoom-level tiles are a rendering-technology limit that
 * animation code alone can't fix, confirmed with the user before porting this.
 *
 * Rendered inside <Map> purely to reach the raw map instance via useMap() (same reason
 * MapControls does). Deliberately imperative, not controlled center/zoom props on <Map> itself -
 * those would fight the user's own free panning/zooming on every re-render. */
function MapFocuser({ target }: { target: { lat: number; lng: number } | null }) {
  const map = useMap();
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    if (!map || !target) return;

    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    const currentCenter = map.getCenter();
    if (!currentCenter) {
      map.setCenter(target);
      map.setZoom(FLY_TARGET_ZOOM);
      return;
    }

    const startLat = currentCenter.lat();
    const startLng = currentCenter.lng();
    const startZoom = map.getZoom() ?? 12;
    const distance = haversineMeters(startLat, startLng, target.lat, target.lng);
    // Duration: 1s minimum, up to 3s based on distance - same formula as the bot's flyTo().
    const duration = Math.min(Math.max(1000, 1000 + distance * 150), 3000);
    const startTime = performance.now();

    const step = (now: number) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = easeInOutQuad(progress);

      const lat = startLat + (target.lat - startLat) * eased;
      const lng = startLng + (target.lng - startLng) * eased;

      let zoom = startZoom + (FLY_TARGET_ZOOM - startZoom) * eased;
      if (distance > 5) {
        // Parabolic dip: zoom out mid-transition, back in by the end - "so I can get a feel of
        // the relative location" (user request). zoomOutAmount caps how deep the dip goes and
        // fades to 0 the more zoomed-out the start already was, matching the bot's own tuning.
        const parabola = 4 * eased * (1 - eased);
        const zoomOutAmount = Math.min(3, Math.max(0, startZoom - 10));
        zoom -= parabola * zoomOutAmount;
      }

      map.moveCamera({ center: { lat, lng }, zoom });

      animationRef.current = progress < 1 ? requestAnimationFrame(step) : null;
    };

    animationRef.current = requestAnimationFrame(step);

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [map, target]);

  return null;
}

interface ClusterDetailPanelProps {
  cluster: ClusterData;
  onClose: () => void;
  onOpenInvoice: (invoice: string) => void;
  onOpenReconcile: () => void;
}

/** Bottom slide-up panel for a clicked cluster's deliveries - replaces a per-pin InfoWindow so a
 * multi-delivery cluster can show all of its items at once, matching the reference bot UI. */
function ClusterDetailPanel({ cluster, onClose, onOpenInvoice, onOpenReconcile }: ClusterDetailPanelProps) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 max-h-[45%] overflow-hidden rounded-t-xl border-t border-gray-200 bg-white/95 shadow-2xl backdrop-blur-sm dark:border-gray-700 dark:bg-gray-900/95">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 className="font-semibold text-gray-900 dark:text-white">
          {cluster.items.length} deliver{cluster.items.length === 1 ? "y" : "ies"} at this location
        </h3>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          <X size={18} />
        </button>
      </div>
      <div className="flex gap-3 overflow-x-auto p-4">
        {cluster.items.map((pin) => (
          <div
            key={pin.name}
            className="min-w-[220px] shrink-0 rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-gray-900 dark:text-white">
                {pin.delivery_driver_name || "Unknown driver"}
              </span>
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ backgroundColor: `${STATUS_COLOR[pin.reconciliation_status]}22`, color: STATUS_COLOR[pin.reconciliation_status] }}
              >
                {pin.reconciliation_status}
              </span>
            </div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {pin.completion_status} · {pin.payment_status}
            </div>
            {pin.matched_invoice && (
              <button
                type="button"
                onClick={() => onOpenInvoice(pin.matched_invoice as string)}
                className="mt-2 block text-xs font-medium text-beveren-600 hover:underline dark:text-beveren-400"
              >
                {pin.matched_invoice}
              </button>
            )}
            <button type="button" onClick={onOpenReconcile} className="mt-1 block text-xs text-beveren-600 hover:underline dark:text-beveren-400">
              Open reconciliation →
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface FiltersPanelProps {
  statusFilter: Set<ReconciliationStatus>;
  onToggleStatus: (status: ReconciliationStatus) => void;
  driverFilter: string;
  onDriverChange: (value: string) => void;
  availableDrivers: string[];
  search: string;
  onSearchChange: (value: string) => void;
  fromDate: string;
  onFromDateChange: (value: string) => void;
  toDate: string;
  onToDateChange: (value: string) => void;
}

function FiltersPanel({
  statusFilter,
  onToggleStatus,
  driverFilter,
  onDriverChange,
  availableDrivers,
  search,
  onSearchChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
}: FiltersPanelProps) {
  const inputClass =
    "w-full rounded-md border border-gray-300 bg-white text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {(Object.keys(STATUS_COLOR) as ReconciliationStatus[]).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => onToggleStatus(status)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              statusFilter.has(status)
                ? "border-beveren-500 bg-beveren-50 text-beveren-700 dark:border-beveren-600 dark:bg-beveren-900/20 dark:text-beveren-300"
                : "border-gray-200 text-gray-400 dark:border-gray-700 dark:text-gray-500"
            }`}
          >
            {status}
          </button>
        ))}
      </div>

      <div className="relative">
        <User className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
        <select value={driverFilter} onChange={(event) => onDriverChange(event.target.value)} className={`${inputClass} py-2 pl-8 pr-3`}>
          <option value="">All drivers</option>
          {availableDrivers.map((driver) => (
            <option key={driver} value={driver}>
              {driver}
            </option>
          ))}
        </select>
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
        <input
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search invoice number..."
          className={`${inputClass} py-2 pl-8 pr-3`}
        />
      </div>

      <div className="flex items-center gap-2">
        <input type="date" value={fromDate} onChange={(event) => onFromDateChange(event.target.value)} className={`${inputClass} px-2 py-1.5`} />
        <span className="shrink-0 text-xs text-gray-400">to</span>
        <input type="date" value={toDate} onChange={(event) => onToDateChange(event.target.value)} className={`${inputClass} px-2 py-1.5`} />
        {(fromDate || toDate) && (
          <button
            type="button"
            onClick={() => {
              onFromDateChange("");
              onToDateChange("");
            }}
            title="Clear date filter"
            className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function LiveFeedList({ pins, isConnected, onFocus }: { pins: MapPin[]; isConnected: boolean; onFocus: (pin: MapPin) => void }) {
  // Defaults to today only (2026-08-03 follow-up, user request) - a "live" feed showing months of
  // old history by default isn't actually useful; toggle-able for catching up on older activity.
  const [todayOnly, setTodayOnly] = useState(true);
  const feed = useMemo(() => {
    const scoped = todayOnly ? pins.filter((pin) => isToday(pin.delivery_timestamp)) : pins;
    return [...scoped].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 50);
  }, [pins, todayOnly]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className={`h-2 w-2 rounded-full ${isConnected ? "animate-pulse bg-green-500" : "bg-red-500"}`} />
          <span className={isConnected ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={todayOnly}
            onChange={(event) => setTodayOnly(event.target.checked)}
            className="rounded border-gray-300 text-beveren-600 focus:ring-beveren-500 dark:border-gray-600"
          />
          Today only
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {feed.length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-200 p-4 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {todayOnly ? "No deliveries today yet." : "No deliveries yet."}
          </div>
        ) : (
          feed.map((pin) => (
            <button
              key={pin.name}
              type="button"
              onClick={() => onFocus(pin)}
              className="block w-full rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-gray-900 dark:text-white">
                  <Receipt size={14} className="shrink-0 text-beveren-500" />
                  {pin.matched_invoice || pin.reported_invoice_no || "Unmatched"}
                </span>
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: `${STATUS_COLOR[pin.reconciliation_status]}22`, color: STATUS_COLOR[pin.reconciliation_status] }}
                >
                  {pin.reconciliation_status}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <User size={12} className="opacity-60" />
                {pin.delivery_driver_name || "N/A"}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export default function LiveDeliveryMapPage() {
  const navigate = useNavigate();
  const { posDetails } = usePOSProfileStore();
  const apiKey = posDetails?.custom_google_maps_api_key;
  const mapId = posDetails?.custom_google_maps_map_id;

  const [pins, setPins] = useState<Record<string, MapPin>>({});
  const [shopLocations, setShopLocations] = useState<ShopLocation[]>([]);
  const [statusFilter, setStatusFilter] = useState<Set<ReconciliationStatus>>(new Set(["Unmatched", "Suggested", "Confirmed"]));
  const [driverFilter, setDriverFilter] = useState("");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [selectedCluster, setSelectedCluster] = useState<ClusterData | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ lat: number; lng: number } | null>(null);

  const fetchPins = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getDeliveryReports(ALL_STATUSES, "", 0, 200);
      const now = Date.now();
      const next: Record<string, MapPin> = {};
      for (const report of response.data || []) {
        const pin = toPin(report, now);
        if (pin) next[pin.name] = pin;
      }
      setPins(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deliveries");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPins();
  }, [fetchPins]);

  // Shop pins are static reference data (unlike deliveries, no realtime subscription needed) -
  // fetched once on mount.
  useEffect(() => {
    getShopLocations()
      .then((response) => setShopLocations(response.data || []))
      .catch(() => setShopLocations([]));
  }, []);

  // Connection indicator for the Live Feed panel - separate from the delivery_report_update
  // subscription below, since this tracks the socket's own connect/disconnect state.
  useEffect(() => {
    const socket = getRealtimeSocket();
    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);
    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    setIsConnected(socket.connected);
    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
    };
  }, []);

  useEffect(() => {
    return subscribeToDeliveryUpdates((update) => {
      setPins((prev) => ({ ...prev, [update.name]: updateToPin(update, Date.now()) }));
    });
  }, []);

  const availableDrivers = useMemo(() => {
    const names = new Set(Object.values(pins).map((pin) => pin.delivery_driver_name).filter((name): name is string => Boolean(name)));
    return Array.from(names).sort();
  }, [pins]);

  const visiblePins = useMemo(() => {
    const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const toTs = toDate ? new Date(`${toDate}T23:59:59`).getTime() : null;
    const term = search.trim().toLowerCase();

    return Object.values(pins).filter((pin) => {
      if (!statusFilter.has(pin.reconciliation_status)) return false;
      if (driverFilter && pin.delivery_driver_name !== driverFilter) return false;

      if (term) {
        const haystack = `${pin.matched_invoice || ""} ${pin.reported_invoice_no || ""}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }

      if ((fromTs || toTs) && pin.delivery_timestamp) {
        const ts = new Date(pin.delivery_timestamp.replace(" ", "T")).getTime();
        if (fromTs && ts < fromTs) return false;
        if (toTs && ts > toTs) return false;
      }

      return true;
    });
  }, [pins, statusFilter, driverFilter, search, fromDate, toDate]);

  const clusters = useMemo(() => buildClusters(visiblePins, CLUSTER_RADIUS_METERS), [visiblePins]);

  const center = useMemo(() => {
    // Shop location(s) take priority over the delivery pins' own average (2026-08-03 follow-up,
    // user request: "make sure to open to around my warehouse location") - most deliveries happen
    // near the shop, so opening there is more useful than centering on whatever the current
    // (possibly filtered, possibly sparse) set of visible pins happens to average out to. Multiple
    // shops average together; "Recenter" still fits bounds around everything on demand.
    if (shopLocations.length > 0) {
      const sum = shopLocations.reduce((acc, loc) => ({ lat: acc.lat + loc.latitude, lng: acc.lng + loc.longitude }), { lat: 0, lng: 0 });
      return { lat: sum.lat / shopLocations.length, lng: sum.lng / shopLocations.length };
    }
    if (visiblePins.length > 0) {
      const sum = visiblePins.reduce((acc, pin) => ({ lat: acc.lat + pin.gps_latitude, lng: acc.lng + pin.gps_longitude }), { lat: 0, lng: 0 });
      return { lat: sum.lat / visiblePins.length, lng: sum.lng / visiblePins.length };
    }
    return DEFAULT_CENTER;
  }, [visiblePins, shopLocations]);

  const toggleStatus = (status: ReconciliationStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const focusOnPin = (pin: MapPin) => {
    // 2026-08-03 follow-up, user request: clicking a Live Feed item teleports the map there, on
    // top of the existing behavior of opening its cluster's detail panel.
    setFocusTarget({ lat: pin.gps_latitude, lng: pin.gps_longitude });
    const cluster = clusters.find((c) => c.items.some((item) => item.name === pin.name));
    if (cluster) setSelectedCluster(cluster);
  };

  return (
    <div className="flex h-screen flex-col bg-gray-50 pb-20 dark:bg-gray-900 lg:ml-20 lg:pb-0">
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Map - min-h-0 lets this flex-1 child actually shrink to its allotted space instead of
            the classic flexbox min-height:auto collapse (see Todo 032 notes: this exact pattern
            caused Google Maps to render zoomed-in and offset toward one corner). The map itself
            is positioned absolute/inset-0 rather than height:100% for the same reason. */}
        <div className="relative min-h-[50vh] min-w-0 flex-1 lg:min-h-0">
          {!apiKey ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-gray-500 dark:text-gray-400">
              <AlertTriangle size={28} className="text-amber-500" />
              <p className="font-medium">No Google Maps API key configured</p>
              <p className="max-w-sm text-sm">
                Set "Google Maps API Key" on this POS Profile (Desk → POS Profile) to enable the live map.
              </p>
            </div>
          ) : isLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={18} className="animate-spin" /> Loading deliveries...
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-red-600 dark:text-red-400">{error}</div>
          ) : (
            <div className="absolute inset-0">
              <APIProvider apiKey={apiKey}>
                <Map
                  defaultCenter={center}
                  defaultZoom={shopLocations.length ? 14 : visiblePins.length ? 12 : 6}
                  mapId={mapId || undefined}
                  gestureHandling="greedy"
                  disableDefaultUI
                  style={{ width: "100%", height: "100%" }}
                >
                  <MapControls pins={visiblePins} shopLocations={shopLocations} />
                  <MapFocuser target={focusTarget} />
                  {shopLocations.map((location) => (
                    <ShopMarker key={location.warehouse} location={location} />
                  ))}
                  {clusters.map((cluster) => (
                    <ClusterMarker key={cluster.id} cluster={cluster} onClick={() => setSelectedCluster(cluster)} />
                  ))}
                </Map>
              </APIProvider>

              {selectedCluster && (
                <ClusterDetailPanel
                  cluster={selectedCluster}
                  onClose={() => setSelectedCluster(null)}
                  onOpenInvoice={(invoice) => navigate(`/invoice/${invoice}`)}
                  onOpenReconcile={() => navigate("/deliveries/reconcile")}
                />
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="flex w-full flex-col border-t border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900 lg:h-full lg:w-[360px] lg:border-l lg:border-t-0">
          <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-4 dark:border-gray-700">
            <MapPin className="text-beveren-600 dark:text-beveren-400" size={22} />
            <div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-white">Live Delivery Map</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {visiblePins.length} delivery{visiblePins.length === 1 ? "" : "ies"} shown
              </p>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Filters</h2>
              <FiltersPanel
                statusFilter={statusFilter}
                onToggleStatus={toggleStatus}
                driverFilter={driverFilter}
                onDriverChange={setDriverFilter}
                availableDrivers={availableDrivers}
                search={search}
                onSearchChange={setSearch}
                fromDate={fromDate}
                onFromDateChange={setFromDate}
                toDate={toDate}
                onToDateChange={setToDate}
              />
            </section>

            <section className="flex min-h-[240px] flex-1 flex-col">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Live Feed</h2>
              <div className="min-h-0 flex-1">
                <LiveFeedList pins={visiblePins} isConnected={isConnected} onFocus={focusOnPin} />
              </div>
            </section>
          </div>
        </aside>
      </div>

      <div className="lg:hidden">
        <BottomNavigation />
      </div>
    </div>
  );
}
