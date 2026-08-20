import { describe, expect, it } from "vitest";

import {
  getEffectiveDisplayRate,
  getEffectiveItemRate,
  getExclusiveTaxRateForItem,
} from "../cartPricing";

describe("getEffectiveItemRate", () => {
  it("returns the plain price when there is no discount", () => {
    expect(getEffectiveItemRate({ id: "A", price: 100 })).toBe(100);
  });

  it("applies a percentage discount", () => {
    expect(
      getEffectiveItemRate({ id: "A", price: 100 }, { itemDiscounts: { A: { discountPercentage: 10 } } })
    ).toBe(90);
  });

  it("applies a fixed-amount discount and never goes negative", () => {
    expect(
      getEffectiveItemRate({ id: "A", price: 100 }, { itemDiscounts: { A: { discountAmount: 30 } } })
    ).toBe(70);
    expect(
      getEffectiveItemRate({ id: "A", price: 100 }, { itemDiscounts: { A: { discountAmount: 250 } } })
    ).toBe(0);
  });

  it("uses a custom rate verbatim when the item has no exclusive tax", () => {
    expect(
      getEffectiveItemRate({ id: "A", price: 100 }, { itemDiscounts: { A: { customRate: 88 } } })
    ).toBe(88);
  });

  it("backs tax out of a tax-inclusive custom rate", () => {
    // entered 110 including 10% exclusive VAT -> net 100
    const item = { id: "A", price: 100, item_tax_rate: { "VAT - HD": 10 } };
    const selectedTaxLineMap = new Map([
      ["VAT - HD", { charge_type: "On Net Total", rate: 10, included_in_print_rate: false }],
    ]);
    expect(
      getEffectiveItemRate(item, { itemDiscounts: { A: { customRate: 110 } }, selectedTaxLineMap })
    ).toBe(100);
  });

  it("does not back tax out when customRateIncludesTax is false", () => {
    const item = { id: "A", price: 100, item_tax_rate: { "VAT - HD": 10 } };
    const selectedTaxLineMap = new Map([
      ["VAT - HD", { charge_type: "On Net Total", rate: 10, included_in_print_rate: false }],
    ]);
    expect(
      getEffectiveItemRate(item, {
        itemDiscounts: { A: { customRate: 110, customRateIncludesTax: false } },
        selectedTaxLineMap,
      })
    ).toBe(110);
  });
});

describe("getExclusiveTaxRateForItem", () => {
  it("is 0 when tax is included in the basic rate", () => {
    expect(
      getExclusiveTaxRateForItem({ item_tax_rate: { "VAT - HD": 10 } }, { isTaxIncludedInBasicRate: true })
    ).toBe(0);
  });

  it("sums matching On Net Total exclusive lines from item_tax_rate", () => {
    const item = { item_tax_rate: { "VAT - HD": 10 } };
    const selectedTaxLineMap = new Map([
      ["VAT - HD", { charge_type: "On Net Total", rate: 10, included_in_print_rate: false }],
    ]);
    expect(getExclusiveTaxRateForItem(item, { selectedTaxLineMap })).toBe(10);
  });

  it("ignores lines flagged included_in_print_rate", () => {
    const item = { item_tax_rate: { "VAT - HD": 10 } };
    const selectedTaxLineMap = new Map([
      ["VAT - HD", { charge_type: "On Net Total", rate: 10, included_in_print_rate: true }],
    ]);
    expect(getExclusiveTaxRateForItem(item, { selectedTaxLineMap })).toBe(0);
  });

  it("falls back to the selected template when the item has no matching account", () => {
    const selectedTaxTemplate = {
      tax_lines: [
        { account_head: "VAT - HD", charge_type: "On Net Total", rate: 7, included_in_print_rate: false },
      ],
    };
    expect(getExclusiveTaxRateForItem({ item_tax_rate: {} }, { selectedTaxTemplate })).toBe(7);
  });

  it("falls back to the legacy total_tax_rate for exclusive tax templates", () => {
    const item = { total_tax_rate: 15, tax_templates: [{ is_inclusive: false }] };
    expect(getExclusiveTaxRateForItem(item)).toBe(15);
  });

  it("parses a JSON-string item_tax_rate", () => {
    const item = { item_tax_rate: '{"VAT - HD": 10}' };
    const selectedTaxLineMap = new Map([
      ["VAT - HD", { charge_type: "On Net Total", rate: 10, included_in_print_rate: false }],
    ]);
    expect(getExclusiveTaxRateForItem(item, { selectedTaxLineMap })).toBe(10);
  });
});

describe("getEffectiveDisplayRate", () => {
  it("grosses the effective rate up by the exclusive tax rate", () => {
    const item = { id: "A", price: 100, item_tax_rate: { "VAT - HD": 10 } };
    const selectedTaxLineMap = new Map([
      ["VAT - HD", { charge_type: "On Net Total", rate: 10, included_in_print_rate: false }],
    ]);
    expect(getEffectiveDisplayRate(item, { selectedTaxLineMap })).toBe(110);
  });

  it("equals the effective rate when there is no exclusive tax", () => {
    expect(getEffectiveDisplayRate({ id: "A", price: 100 })).toBe(100);
  });
});
