import { describe, expect, it } from "vitest";

import {
  addCurrency,
  calculateChange,
  calculateRemainingAmount,
  calculateTotalPayments,
  divideCurrency,
  formatCurrencyAmount,
  isPaymentComplete,
  multiplyCurrency,
  roundCurrency,
  subtractCurrency,
  toCents,
  toDollars,
} from "../currencyMath";

// No globalThis.frappe in the test env, so getCurrencyPrecision falls back to 2 decimals.

describe("roundCurrency", () => {
  it("rounds to 2 decimals", () => {
    expect(roundCurrency(1.129)).toBe(1.13);
    expect(roundCurrency(1.004)).toBe(1.0);
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
    // JS float trap: 1.005 is stored as 1.00499..., so Math.round-based rounding
    // yields 1.00, not 1.01. Documented here so the behaviour is intentional, not a surprise.
    expect(roundCurrency(1.005)).toBe(1.0);
  });
  it("coerces invalid input to 0", () => {
    expect(roundCurrency(NaN)).toBe(0);
    // @ts-expect-error exercising runtime coercion
    expect(roundCurrency(undefined)).toBe(0);
  });
});

describe("toCents / toDollars", () => {
  it("round-trips cleanly", () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toDollars(1234)).toBe(12.34);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
});

describe("add/subtract/multiply/divide", () => {
  it("adds without float drift", () => {
    expect(addCurrency(0.1, 0.2)).toBe(0.3);
    expect(addCurrency(19.99, 0.01)).toBe(20);
  });
  it("subtracts without float drift", () => {
    expect(subtractCurrency(0.3, 0.1)).toBe(0.2);
    expect(subtractCurrency(100, 33.33)).toBe(66.67);
  });
  it("multiplies with rounding", () => {
    expect(multiplyCurrency(9.99, 3)).toBe(29.97);
    expect(multiplyCurrency(10, 0.1)).toBe(1);
  });
  it("divides with rounding", () => {
    expect(divideCurrency(10, 3)).toBe(3.33);
  });
});

describe("payment helpers", () => {
  it("calculateTotalPayments sums with precision", () => {
    expect(calculateTotalPayments([10.1, 20.2, 0.05])).toBe(30.35);
    expect(calculateTotalPayments([])).toBe(0);
  });
  it("calculateRemainingAmount clamps at 0", () => {
    expect(calculateRemainingAmount(100, [30, 20])).toBe(50);
    expect(calculateRemainingAmount(100, [60, 60])).toBe(0);
    expect(calculateRemainingAmount(100, [])).toBe(100);
  });
  it("calculateChange returns overpayment only", () => {
    expect(calculateChange(100, [150])).toBe(50);
    expect(calculateChange(100, [100])).toBe(0);
    expect(calculateChange(100, [40, 40])).toBe(0);
    expect(calculateChange(99.99, [100])).toBe(0.01);
  });
  it("isPaymentComplete uses exact cent equality", () => {
    expect(isPaymentComplete(100, [40, 60])).toBe(true);
    expect(isPaymentComplete(100, [40, 59.99])).toBe(false);
    expect(isPaymentComplete(0.3, [0.1, 0.2])).toBe(true);
  });
});

describe("formatCurrencyAmount", () => {
  it("formats to 2 decimal string", () => {
    expect(formatCurrencyAmount(5)).toBe("5.00");
    expect(formatCurrencyAmount(5.1)).toBe("5.10");
    expect(formatCurrencyAmount(1.129)).toBe("1.13");
  });
});
