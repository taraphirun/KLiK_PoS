import { describe, expect, it } from "vitest";
import { formatPaymentAmount, formatPaymentTotal, mediaShortfall, paymentModeName } from "../deliveryPayments";

describe("delivery app payments", () => {
  it("names known modes and keeps a new bank readable", () => {
    expect(paymentModeName("cash")).toBe("Cash");
    expect(paymentModeName(" ABA ")).toBe("ABA");
    expect(paymentModeName("acleda")).toBe("ACLEDA");
    expect(paymentModeName("wing")).toBe("WING");
  });

  it("formats one payment row", () => {
    expect(formatPaymentAmount({ mode: "cash", amount_usd: 20, amount_khr: 0 })).toBe("$20.00");
    expect(formatPaymentAmount({ mode: "aba", amount_usd: 0, amount_khr: 120000 })).toBe("120,000៛");
    expect(formatPaymentAmount({ mode: "cash", amount_usd: 5, amount_khr: 20000 })).toBe("$5.00 + 20,000៛");
  });

  it("totals in dollars, saying the rate when riel were converted", () => {
    const cash = { mode: "cash", amount_usd: 20, amount_khr: 0 };
    const payments = [cash, { mode: "aba", amount_usd: 0, amount_khr: 122490 }];
    expect(formatPaymentTotal({ payments, total_usd: 50, exchange_rate: 4083 })).toBe("≈ $50.00 at 4,083៛");
    expect(formatPaymentTotal({ payments: [cash], total_usd: 20, exchange_rate: 4083 })).toBe("$20.00");
    expect(formatPaymentTotal({ payments, total_usd: 20, exchange_rate: null })).toBeNull();
    expect(formatPaymentTotal({ payments: [], total_usd: 0, exchange_rate: 4083 })).toBeNull();
  });

  it("counts missing files only for app reports", () => {
    const app = { source: "App", photos: '["/private/files/a.jpg"]', voice_note: "", expected_photos: 2, expected_voice: 1 as const };
    expect(mediaShortfall(app)).toEqual({ have: 1, expected: 3 });
    expect(mediaShortfall({ ...app, photos: '["a","b"]', voice_note: "/v.ogg" })).toBeNull();
    expect(mediaShortfall({ ...app, source: null })).toBeNull();
  });
});
