import { extractErrorMessage } from "../utils/errorExtraction";

export interface SellerDayRow {
  user: string;
  seller_name: string;
  sales: number;
  paid: number;
  transactions: number;
  variance: number | null;
  closed: boolean;
}

export interface SellerDaySummary {
  success: boolean;
  data: SellerDayRow[];
  from_date: string;
  to_date: string;
  pos_profile: string | null;
}

/**
 * Manager "Sales by Seller" day overview. Admin-gated on the server; read-only aggregation.
 * pos_profile omitted => all profiles. to_date defaults to from_date server-side.
 */
export async function getSellerDaySummary(
  fromDate: string,
  toDate?: string,
  posProfile?: string
): Promise<SellerDayRow[]> {
  const params = new URLSearchParams({ from_date: fromDate });
  if (toDate) params.append("to_date", toDate);
  if (posProfile) params.append("pos_profile", posProfile);

  const response = await fetch(
    `/api/method/klik_pos.hd.reports.get_seller_day_summary?${params.toString()}`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    }
  );

  const result = await response.json();

  if (!response.ok || !result.message || result.message.success === false) {
    throw new Error(
      extractErrorMessage(result, result.message?.error || "Failed to fetch seller summary")
    );
  }

  return (result.message.data as SellerDayRow[]) || [];
}
