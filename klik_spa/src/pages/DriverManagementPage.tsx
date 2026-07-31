import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Pencil, Plus, Search, Send, UserCheck, X, XCircle } from "lucide-react";
import { toast } from "react-toastify";
import BottomNavigation from "../components/BottomNavigation";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { getDrivers, setDriverStatus, upsertDriver, type DeliveryDriver, type DriverStatus } from "../services/driver";

type StatusFilter = "all" | DriverStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "Pending", label: "Pending" },
  { value: "Active", label: "Active" },
  { value: "Rejected", label: "Rejected" },
];

function statusBadgeClass(status: DriverStatus): string {
  switch (status) {
    case "Active":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "Rejected":
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
  }
}

interface DriverFormState {
  name?: string;
  driver_name: string;
  phone_number: string;
}

const EMPTY_FORM: DriverFormState = { driver_name: "", phone_number: "" };

interface DriverFormDialogProps {
  initial: DriverFormState;
  onCancel: () => void;
  onSaved: () => void;
}

function DriverFormDialog({ initial, onCancel, onSaved }: DriverFormDialogProps) {
  const [form, setForm] = useState<DriverFormState>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const isEdit = Boolean(initial.name);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.driver_name.trim()) {
      toast.error("Driver name is required.");
      return;
    }

    setIsSaving(true);
    try {
      const result = await upsertDriver({
        name: form.name,
        driver_name: form.driver_name.trim(),
        phone_number: form.phone_number.trim() || undefined,
      });
      if (!result.success) throw new Error(result.message || "Failed to save driver");
      toast.success(isEdit ? "Driver updated" : "Driver created");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save driver");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEdit ? "Edit Driver" : "New Driver"}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Driver Name
            </label>
            <input
              type="text"
              value={form.driver_name}
              onChange={(event) => setForm((f) => ({ ...f, driver_name: event.target.value }))}
              autoFocus
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Phone Number
            </label>
            <input
              type="text"
              value={form.phone_number}
              onChange={(event) => setForm((f) => ({ ...f, phone_number: event.target.value }))}
              placeholder="Optional"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-beveren-700 disabled:opacity-50"
            >
              {isSaving && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DriverRowProps {
  driver: DeliveryDriver;
  onChanged: () => void;
  onEdit: () => void;
}

function DriverRow({ driver, onChanged, onEdit }: DriverRowProps) {
  const [pendingAction, setPendingAction] = useState<null | { status: DriverStatus; label: string }>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const applyStatus = async (status: DriverStatus) => {
    setIsSubmitting(true);
    try {
      const result = await setDriverStatus(driver.name, status);
      if (!result.success) throw new Error(result.message || "Failed to update status");
      toast.success(`${driver.driver_name} is now ${status}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update driver status");
    } finally {
      setIsSubmitting(false);
      setPendingAction(null);
    }
  };

  const telegramLinked = Boolean(driver.telegram_user_id);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-white">{driver.driver_name}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(driver.status)}`}>
            {driver.status}
          </span>
        </div>
        <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {driver.phone_number || "No phone number"}
        </div>
        <div className="mt-1 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <Send size={12} className={telegramLinked ? "text-beveren-500" : "text-gray-400"} />
          {telegramLinked ? `@${driver.telegram_username || driver.telegram_user_id}` : "Not yet linked to Telegram"}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <Pencil size={14} />
          Edit
        </button>

        {driver.status !== "Active" && (
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setPendingAction({ status: "Active", label: "approve" })}
            className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            <CheckCircle2 size={14} />
            Approve
          </button>
        )}

        {driver.status !== "Rejected" && (
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() =>
              setPendingAction({
                status: "Rejected",
                label: driver.status === "Active" ? "suspend" : "reject",
              })
            }
            className="inline-flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <XCircle size={14} />
            {driver.status === "Active" ? "Suspend" : "Reject"}
          </button>
        )}
      </div>

      <ConfirmDialog
        isOpen={Boolean(pendingAction)}
        onClose={() => setPendingAction(null)}
        onConfirm={() => pendingAction && applyStatus(pendingAction.status)}
        title={`${pendingAction?.label === "approve" ? "Approve" : pendingAction?.label === "suspend" ? "Suspend" : "Reject"} driver?`}
        message={`This will ${pendingAction?.label} ${driver.driver_name}.`}
        confirmText={pendingAction?.label === "approve" ? "Approve" : "Confirm"}
        confirmButtonClass={
          pendingAction?.label === "approve" ? "bg-green-600 hover:bg-green-700 text-white" : "bg-red-600 hover:bg-red-700 text-white"
        }
      />
    </div>
  );
}

export default function DriverManagementPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [drivers, setDrivers] = useState<DeliveryDriver[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState<DriverFormState | null>(null);

  const fetchDrivers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const status = statusFilter === "all" ? undefined : statusFilter;
      const response = await getDrivers(status, search);
      setDrivers(response.data || []);
      setTotalCount(response.total_count || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch drivers");
      setDrivers([]);
      setTotalCount(0);
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    const timer = window.setTimeout(fetchDrivers, search ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [fetchDrivers, search]);

  return (
    <div className="min-h-screen bg-gray-50 pb-20 dark:bg-gray-900 lg:ml-20 lg:pb-12">
      <div className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="text-beveren-600 dark:text-beveren-400" size={24} />
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Drivers</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {totalCount} driver{totalCount === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setFormState(EMPTY_FORM)}
              className="inline-flex items-center gap-1 rounded-lg bg-beveren-600 px-3 py-2 text-sm font-medium text-white hover:bg-beveren-700"
            >
              <Plus size={16} />
              New Driver
            </button>
          </div>
        </div>
      </div>

      <main className="space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative max-w-xl flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, phone, or Telegram handle"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-beveren-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-800">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setStatusFilter(filter.value)}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  statusFilter === filter.value
                    ? "bg-white text-beveren-700 shadow-sm dark:bg-gray-900 dark:text-beveren-300"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-6 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            <Loader2 size={18} className="animate-spin" /> Loading drivers...
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        ) : drivers.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            No drivers found.
          </div>
        ) : (
          <div className="space-y-3">
            {drivers.map((driver) => (
              <DriverRow
                key={driver.name}
                driver={driver}
                onChanged={fetchDrivers}
                onEdit={() =>
                  setFormState({
                    name: driver.name,
                    driver_name: driver.driver_name,
                    phone_number: driver.phone_number || "",
                  })
                }
              />
            ))}
          </div>
        )}
      </main>

      {formState && (
        <DriverFormDialog
          initial={formState}
          onCancel={() => setFormState(null)}
          onSaved={() => {
            setFormState(null);
            fetchDrivers();
          }}
        />
      )}

      <div className="lg:hidden">
        <BottomNavigation />
      </div>
    </div>
  );
}
