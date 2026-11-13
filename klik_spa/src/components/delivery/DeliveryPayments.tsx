import type { DeliveryReport } from "../../services/delivery";
import { formatPaymentAmount, formatPaymentTotal, mediaShortfall, paymentModeName } from "../../utils/deliveryPayments";

interface DeliveryPaymentsProps {
  report: DeliveryReport;
}

/** What a delivery app report adds to a reconciliation row (2026-11-13): the payments the driver
 * collected with their total in dollars, "edited" when the driver changed the report, and
 * "media 3/4" while photos or the voice note are still uploading. Renders nothing for bot
 * reports. */
export default function DeliveryPayments({ report }: DeliveryPaymentsProps) {
  const rows = report.payments ?? [];
  const total = formatPaymentTotal(report);
  const media = mediaShortfall(report);
  const edited = Boolean(report.is_edited);
  if (!rows.length && !media && !edited) return null;

  return (
    <div className="mt-1 space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
      {rows.map((p, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-gray-500 dark:text-gray-400">{paymentModeName(p.mode)}</span>
          <span className="tabular-nums">{formatPaymentAmount(p)}</span>
        </div>
      ))}
      {total && rows.length > 1 && <div className="font-medium tabular-nums text-gray-800 dark:text-gray-100">{total}</div>}
      {total && rows.length === 1 && total.startsWith("≈") && (
        <div className="tabular-nums text-gray-500 dark:text-gray-400">{total}</div>
      )}
      {(edited || media) && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {edited && (
            <span
              title={`Edited by the driver (version ${report.revision ?? 2})`}
              className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
            >
              edited
            </span>
          )}
          {media && (
            <span
              title="Photos or voice note still uploading from the driver's phone"
              className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            >
              media {media.have}/{media.expected}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
