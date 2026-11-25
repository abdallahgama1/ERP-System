import { describe, expect, it } from "vitest";
import { computeMonthlyDepreciationAmount } from "../../src/services/fixed-assets.service.ts";

describe("Wave 2B Fixed Asset Monthly Depreciation Calculator", () => {
  it("computes Straight-Line monthly depreciation and caps final month cleanly at salvage value", () => {
    // Cost 1,000, salvage 100, useful life 3 months => 300/month
    const m1 = computeMonthlyDepreciationAmount({
      acquisitionCost: 1000,
      salvageValue: 100,
      usefulLifeMonths: 3,
      depreciationMethod: "straight_line",
      decliningRatePct: 200,
      accumulatedDepreciation: 0,
      elapsedMonths: 0,
    });
    expect(m1).toBe(300);

    // Repeating remainder rounding: Cost 1,000, salvage 0, life 3m => 333.3333, 333.3333, final month = 333.3334
    const finalMonth = computeMonthlyDepreciationAmount({
      acquisitionCost: 1000,
      salvageValue: 0,
      usefulLifeMonths: 3,
      depreciationMethod: "straight_line",
      decliningRatePct: 200,
      accumulatedDepreciation: 666.6666,
      elapsedMonths: 2,
    });
    expect(finalMonth).toBe(333.3334);

    // Fully depreciated returns 0
    const afterFull = computeMonthlyDepreciationAmount({
      acquisitionCost: 1000,
      salvageValue: 100,
      usefulLifeMonths: 3,
      depreciationMethod: "straight_line",
      decliningRatePct: 200,
      accumulatedDepreciation: 900,
      elapsedMonths: 3,
    });
    expect(afterFull).toBe(0);
  });

  it("computes Double-Declining Balance depreciation and never depreciates below salvage value", () => {
    // Cost 12,000, salvage 2,000, life 24m (2 years) => DDB annual rate = 200%/2 = 100%/yr => 1/12 per month = 1,000 first month
    const m1 = computeMonthlyDepreciationAmount({
      acquisitionCost: 12000,
      salvageValue: 2000,
      usefulLifeMonths: 24,
      depreciationMethod: "declining_balance",
      decliningRatePct: 200,
      accumulatedDepreciation: 0,
      elapsedMonths: 0,
    });
    expect(m1).toBe(1000);

    // When NBV is 2,100 (only 100 above 2,000 salvage), caps at 100
    const nearSalvage = computeMonthlyDepreciationAmount({
      acquisitionCost: 12000,
      salvageValue: 2000,
      usefulLifeMonths: 24,
      depreciationMethod: "declining_balance",
      decliningRatePct: 200,
      accumulatedDepreciation: 9900,
      elapsedMonths: 15,
    });
    expect(nearSalvage).toBe(100);
  });
});
