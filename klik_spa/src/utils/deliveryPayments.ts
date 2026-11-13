import { parseDeliveryPhotos, type DeliveryReport, type DeliveryReportPayment } from "../services/delivery";

/** Display names for the delivery app's payment modes. A mode not listed here (a bank added to
 * the app later) shows as sent, upper-cased - no change needed here to keep working. */
const MODE_NAMES: Record<string, string> = { cash: "Cash", aba: "ABA", acleda: "ACLEDA" };

export function paymentModeName(mode: string): string {
  const key = (mode || "").trim().toLowerCase();
  return MODE_NAMES[key] ?? key.toUpperCase();
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const khr = (n: number) => `${Math.round(n).toLocaleString("en-US")}៛`;

/** "$20.00", "120,000៛" or "$5.00 + 20,000៛" for one payment row. */
export function formatPaymentAmount(p: DeliveryReportPayment): string {
  const u = Number(p.amount_usd) || 0;
  const k = Number(p.amount_khr) || 0;
  if (u && k) return `${usd(u)} + ${khr(k)}`;
  return k ? khr(k) : usd(u);
}

/** The total in dollars: "$25.00", or "≈ $49.40 at 4,083៛" when riel were converted. Null when
 * there is nothing to add up (no rows, or riel without a rate - the rows then say it all). */
export function formatPaymentTotal(
  report: Pick<DeliveryReport, "payments" | "total_usd" | "exchange_rate">
): string | null {
  const rows = report.payments ?? [];
  if (!rows.length || report.total_usd == null) return null;
  const hasKhr = rows.some((p) => Number(p.amount_khr) > 0);
  if (!hasKhr) return usd(Number(report.total_usd));
  if (!report.exchange_rate) return null;
  return `≈ ${usd(Number(report.total_usd))} at ${khr(report.exchange_rate)}`;
}

/** Files attached vs the driver took, e.g. { have: 3, expected: 4 }; null when not known (bot
 * reports) or when nothing is missing. */
export function mediaShortfall(
  report: Pick<DeliveryReport, "source" | "photos" | "voice_note" | "expected_photos" | "expected_voice">
): { have: number; expected: number } | null {
  if (report.source !== "App") return null;
  const expected = (Number(report.expected_photos) || 0) + (report.expected_voice ? 1 : 0);
  const have = parseDeliveryPhotos(report.photos).length + (report.voice_note ? 1 : 0);
  return expected > have ? { have, expected } : null;
}
