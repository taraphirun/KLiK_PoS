import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { usePOSOpeningStatus } from "../../hooks/usePOSOpeningEntry";
import { usePOSProfileStore } from "../../stores/posProfileStore";
import LiveDeliveryMapPage from "../../pages/LiveDeliveryMapPage";

/** Keeps LiveDeliveryMapPage mounted for the app's whole lifetime instead of letting react-router
 * unmount/remount it on every navigation away and back (2026-08-06 follow-up - "it seems better
 * but it still load back in"). Caching pins/filters in useLiveMapStore fixed the *data* reload,
 * but the map widget itself kept visibly redrawing from scratch: @vis.gl/react-google-maps tears
 * down and reconstructs the real google.maps.Map instance whenever <APIProvider>/<Map> unmount, so
 * every tile and marker (and the camera) rebuilds from nothing regardless of how fast the cached
 * data reappears. Toggling visibility with a CSS class instead of conditional mounting keeps that
 * same Map instance alive across route changes - the browser just shows/hides the DOM, nothing
 * about Maps gets rebuilt.
 *
 * Rendered once in App.tsx, outside the router's <Outlet/> - so this replicates ProtectedRoute's
 * own gating (auth + requiresDeliveryManagement + POSOpeningEntryGuard's "must have an open POS
 * entry") itself, since the /deliveries/map route entry now renders nothing (kept registered only
 * so a direct/bookmarked visit without permission still gets ProtectedRoute's redirect, and so the
 * sidebar's active-link highlighting - driven by the URL, not by which component is visually on
 * screen - still matches). Not mounted at all until all three are satisfied, so an unprivileged or
 * pre-shift-open session never fetches delivery data in the background just because this component
 * exists in the tree. Doesn't reproduce POSOpeningEntryGuard's own reminder modal here - every
 * other route the user could be on still shows it (it isn't excluded there), so there's no path to
 * this page that skips seeing it.
 *
 * Lazy-mounted, not eager: gating alone would otherwise mean every permitted, shift-open session
 * starts fetching delivery pins, loading the Google Maps script, and holding open a realtime
 * subscription the instant they log in, on every page, whether or not they ever open this one -
 * hasVisitedOnce below delays actually mounting LiveDeliveryMapPage until the first real visit to
 * /deliveries/map, then leaves it mounted (just hidden) for the rest of the session. */
export default function LiveMapPersistent() {
  const location = useLocation();
  const { isAuthenticated } = useAuth();
  const { posDetails } = usePOSProfileStore();
  const { hasOpenEntry } = usePOSOpeningStatus();
  const [hasVisitedOnce, setHasVisitedOnce] = useState(false);

  const isActive = location.pathname === "/deliveries/map";

  useEffect(() => {
    if (isActive) setHasVisitedOnce(true);
  }, [isActive]);

  if (!isAuthenticated || posDetails?.custom_allow_delivery_management !== 1 || hasOpenEntry !== true) return null;
  if (!hasVisitedOnce) return null;

  // z-30: above Footer (z-10, fixed) so the map covers it while active, below RetailSidebar
  // (z-50, fixed) so the desktop nav rail stays clickable on top of the full-viewport map.
  return (
    <div className={isActive ? "fixed inset-0 z-30" : "hidden"}>
      <LiveDeliveryMapPage />
    </div>
  );
}
