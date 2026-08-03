import { useEffect, useState } from "react"
import { Receipt, Grid3X3, BarChart3, Users, MonitorX, Banknote, Truck, UserCheck, Map as MapIcon, BookOpen, CalendarCheck } from "lucide-react"
import { useNavigate, useLocation } from "react-router-dom"
import { useUserInfo } from "../hooks/useUserInfo"
import { usePOSProfileStore } from "../stores/posProfileStore";
import { getDeliveryReports } from "../services/delivery";
import { getDrivers } from "../services/driver";

const PENDING_DELIVERY_POLL_MS = 60000;
const PENDING_DRIVER_POLL_MS = 60000;

// Inside your component
export default function RetailSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { userInfo } = useUserInfo()
  const {posDetails} = usePOSProfileStore()

  const canAccessSalesDashboard = userInfo?.is_admin_user ?? false
  const canAccessDeliveryManagement = posDetails?.custom_allow_delivery_management === 1
  const [pendingDeliveryCount, setPendingDeliveryCount] = useState(0)
  const [pendingDriverCount, setPendingDriverCount] = useState(0)

  useEffect(() => {
    if (!canAccessDeliveryManagement) return
    let isCurrent = true
    const fetchCount = () => {
      getDeliveryReports()
        .then((response) => {
          if (isCurrent) setPendingDeliveryCount(response.total_count || 0)
        })
        .catch(() => {
          // Nav badge is best-effort - a failed poll just skips this refresh.
        })
    }
    fetchCount()
    const interval = window.setInterval(fetchCount, PENDING_DELIVERY_POLL_MS)
    return () => {
      isCurrent = false
      window.clearInterval(interval)
    }
  }, [canAccessDeliveryManagement])

  useEffect(() => {
    if (!canAccessDeliveryManagement) return
    let isCurrent = true
    const fetchCount = () => {
      getDrivers("Pending")
        .then((response) => {
          if (isCurrent) setPendingDriverCount(response.total_count || 0)
        })
        .catch(() => {
          // Nav badge is best-effort - a failed poll just skips this refresh.
        })
    }
    fetchCount()
    const interval = window.setInterval(fetchCount, PENDING_DRIVER_POLL_MS)
    return () => {
      isCurrent = false
      window.clearInterval(interval)
    }
  }, [canAccessDeliveryManagement])

  const menuItems = [
    { icon: Grid3X3, path: "/pos", label: "POS" },
     { icon: Receipt, path: "/invoice", label: "InvoiceHistory" },
     { icon: Banknote, path: "/payments", label: "Payments" },
     { icon: Users, path: "/customers", label: "Customers", requiresEditCreatePermission: true },
    { icon: BarChart3, path: "/dashboard", label: "Dashboard", requiresSalesDashboard: true },
    { icon: MonitorX, path: "/closing_shift", label: "Closing Shift" },
    { icon: Truck, path: "/deliveries/reconcile", label: "Deliveries", requiresDeliveryManagement: true },
    { icon: UserCheck, path: "/drivers", label: "Drivers", requiresDeliveryManagement: true },
    { icon: MapIcon, path: "/deliveries/map", label: "Live Map", requiresDeliveryManagement: true },
    { icon: BookOpen, path: "/deliveries/booklets", label: "Booklets", requiresDeliveryManagement: true },
    { icon: CalendarCheck, path: "/deliveries/daily-reconcile", label: "Daily Close", requiresDeliveryManagement: true },

  ]

  const isActive = (path: string) => {
    if (path === "/pos") {
      return location.pathname === "/" || location.pathname === "/pos"
    }
    return location.pathname.startsWith(path)
  }

  const handleNav = (item: (typeof menuItems)[0]) => {
    if (item.requiresSalesDashboard && !canAccessSalesDashboard) return
    if (item.requiresDeliveryManagement && !canAccessDeliveryManagement) return
    navigate(item.path)
  }

  if (!posDetails) return (
    <div className="hidden lg:flex fixed h-screen w-20 top-0 left-0 bg-white dark:bg-gray-800 shadow-lg flex-col border-r border-gray-200 dark:border-gray-700 z-50">
      <div
          className="h-20 flex items-center justify-center border-gray-100 dark:border-gray-700 cursor-pointer active:scale-90 transition-transform duration-150"
          onClick={() => navigate("/")}
        >
          <img
            src="/assets/klik_pos/klik_spa/bev_logo.jpeg"
            alt="KLiK PoS"
            className="w-12 h-12 rounded-full object-cover"
          />
        </div>
    </div>
  )

  return (
<div className="hidden lg:flex fixed h-screen w-20 top-0 left-0 bg-white dark:bg-gray-800 shadow-lg flex-col border-r border-gray-200 dark:border-gray-700 z-50">
      {/* Logo Section - Fixed height to match other sections */}
      <div
          className="h-20 flex items-center justify-center border-gray-100 dark:border-gray-700 cursor-pointer active:scale-90 transition-transform duration-150"
          onClick={() => navigate("/")}
        >
          <img
            src="/assets/klik_pos/klik_spa/bev_logo.jpeg"
            alt="KLiK PoS"
            className="w-12 h-12 rounded-full object-cover"
          />
        </div>

      {/* Menu Items - Flexible space */}
      <div className="flex-1 flex flex-col items-center py-6 space-y-4">
        {menuItems.map((item, index) => {
          const disabled =
            (item.requiresSalesDashboard && !canAccessSalesDashboard) ||
            (item.requiresDeliveryManagement && !canAccessDeliveryManagement)
          if (item.requiresEditCreatePermission && posDetails?.custom_allow_to_create_and_edit_customers !== 1) {
            return null; // Don't render this menu item if the user doesn't have permission
           }
           
          const badgeCount =
            item.path === "/deliveries/reconcile"
              ? pendingDeliveryCount
              : item.path === "/drivers"
              ? pendingDriverCount
              : 0
          const showPendingBadge = badgeCount > 0
          return (
          <button
            key={index}
            onClick={() => handleNav(item)}
            disabled={disabled}
            title={
              disabled
                ? item.requiresDeliveryManagement
                  ? `${item.label} (not enabled for this POS Profile)`
                  : `${item.label} (Sales Manager, System Manager or Administrator only)`
                : item.label
            }
            className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-150 ${
              disabled
                ? "opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-600"
                : "cursor-pointer active:scale-90 " + (
              isActive(item.path)
                ? "bg-beveren-100 dark:bg-beveren-900/20 text-beveren-600 dark:text-beveren-400"
                : "text-beveren-600 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            )
            }`}
          >
            <item.icon size={20} />
            {showPendingBadge && (
              <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
                {badgeCount > 99 ? "99+" : badgeCount}
              </span>
            )}
          </button>
        )})}
      </div>

      {/* Settings at bottom */}
      {/* <div className="p-4 border-t border-gray-100 dark:border-gray-700">
        <button
          onClick={() => navigate("/settings")}
          className="w-12 h-12 rounded-xl flex items-center justify-center text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors mx-auto"
        >
          <Settings size={20} />
        </button>
      </div> */}
    </div>
  )
}
