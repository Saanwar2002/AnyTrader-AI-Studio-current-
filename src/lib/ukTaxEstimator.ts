/**
 * UK Sole-Trader Self-Assessment Income Tax & Class 4 NI Estimator (AT-CJ-FIN-01)
 *
 * Uses standard England/Wales/NI HMRC Self-Assessment bands & Class 4 NI rates
 * (2024/25–2026/27 frozen thresholds) with user-configurable expense ratios and
 * explicit non-advice disclosures.
 */

export interface UkTaxEstimatorInput {
  grossPaidGbp: number;
  expenseRatioPct?: number;
  personalAllowanceGbp?: number;
  applyAllowanceTaper?: boolean;
}

export interface UkTaxEstimatorResult {
  grossPaidGbp: number;
  expenseRatioPct: number;
  estimatedExpensesGbp: number;
  estimatedTaxableProfitGbp: number;
  effectivePersonalAllowanceGbp: number;
  taxableIncomeAboveAllowanceGbp: number;
  incomeTaxGbp: number;
  class4NiGbp: number;
  totalEstimatedReserveGbp: number;
  effectiveReserveRatePct: number;
  taxBandLabel: string;
  disclaimer: string;
}

const DEFAULT_PERSONAL_ALLOWANCE_GBP = 12570;
const BASIC_RATE_WIDTH_GBP = 37700; // 20% up to £50,270 total income with full PA
const ADDITIONAL_RATE_TAXABLE_START_GBP = 125140; // 45% on taxable income > £125,140
const PA_TAPER_THRESHOLD_GBP = 100000;
const CLASS4_LOWER_LIMIT_GBP = 12570;
const CLASS4_UPPER_LIMIT_GBP = 50270;

export const UK_TAX_ESTIMATOR_DISCLAIMER =
  "Illustrative guide only (England/Wales/NI sole-trader 20%–45% Income Tax bands & 6%/2% Class 4 NI). Assumes allowable business expenses before tax and excludes Scottish bands, Student Loans, VAT, CIS deductions, and payments on account. Not formal tax or accounting advice.";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

export function estimateUkSoleTraderTaxReserve(
  input: UkTaxEstimatorInput
): UkTaxEstimatorResult {
  const grossPaidGbp = Math.max(
    0,
    Number.isFinite(Number(input.grossPaidGbp)) ? Number(input.grossPaidGbp) : 0
  );
  const rawExpensePct = Number.isFinite(Number(input.expenseRatioPct))
    ? Number(input.expenseRatioPct)
    : 25;
  const expenseRatioPct = Math.max(0, Math.min(85, rawExpensePct));

  const basePersonalAllowance = Math.max(
    0,
    Math.min(
      30000,
      Number.isFinite(Number(input.personalAllowanceGbp))
        ? Number(input.personalAllowanceGbp)
        : DEFAULT_PERSONAL_ALLOWANCE_GBP
    )
  );
  const applyTaper = input.applyAllowanceTaper !== false;

  const estimatedExpensesGbp = round2(grossPaidGbp * (expenseRatioPct / 100));
  const estimatedTaxableProfitGbp = Math.max(0, round2(grossPaidGbp - estimatedExpensesGbp));

  let effectivePersonalAllowanceGbp = basePersonalAllowance;
  if (applyTaper && estimatedTaxableProfitGbp > PA_TAPER_THRESHOLD_GBP) {
    const reduction = (estimatedTaxableProfitGbp - PA_TAPER_THRESHOLD_GBP) / 2;
    effectivePersonalAllowanceGbp = Math.max(0, round2(basePersonalAllowance - reduction));
  }

  const taxableIncomeAboveAllowanceGbp = Math.max(
    0,
    round2(estimatedTaxableProfitGbp - effectivePersonalAllowanceGbp)
  );

  let incomeTaxGbp = 0;
  let taxBandLabel = "Within Personal Allowance (0%)";

  if (taxableIncomeAboveAllowanceGbp > 0) {
    const basicSlice = Math.min(taxableIncomeAboveAllowanceGbp, BASIC_RATE_WIDTH_GBP);
    const higherSlice = Math.max(
      0,
      Math.min(taxableIncomeAboveAllowanceGbp, ADDITIONAL_RATE_TAXABLE_START_GBP) -
        BASIC_RATE_WIDTH_GBP
    );
    const additionalSlice = Math.max(
      0,
      taxableIncomeAboveAllowanceGbp - ADDITIONAL_RATE_TAXABLE_START_GBP
    );

    incomeTaxGbp = round2(
      basicSlice * 0.2 + higherSlice * 0.4 + additionalSlice * 0.45
    );

    if (additionalSlice > 0) {
      taxBandLabel = "Additional Rate Band (up to 45% IT + 2% NI)";
    } else if (higherSlice > 0) {
      taxBandLabel = "Higher Rate Band (up to 40% IT + 2% NI)";
    } else {
      taxBandLabel = "Basic Rate Band (20% IT + 6% Class 4 NI)";
    }
  }

  // Class 4 NIC: 6% on profits between £12,570 and £50,270, 2% above £50,270
  let class4NiGbp = 0;
  if (estimatedTaxableProfitGbp > CLASS4_LOWER_LIMIT_GBP) {
    const mainNiSlice = Math.min(
      estimatedTaxableProfitGbp - CLASS4_LOWER_LIMIT_GBP,
      CLASS4_UPPER_LIMIT_GBP - CLASS4_LOWER_LIMIT_GBP
    );
    const upperNiSlice = Math.max(0, estimatedTaxableProfitGbp - CLASS4_UPPER_LIMIT_GBP);
    class4NiGbp = round2(mainNiSlice * 0.06 + upperNiSlice * 0.02);
  }

  const totalEstimatedReserveGbp = Math.round(incomeTaxGbp + class4NiGbp);
  const effectiveReserveRatePct =
    grossPaidGbp > 0 ? round1((totalEstimatedReserveGbp / grossPaidGbp) * 100) : 0;

  return {
    grossPaidGbp: round2(grossPaidGbp),
    expenseRatioPct: round1(expenseRatioPct),
    estimatedExpensesGbp,
    estimatedTaxableProfitGbp,
    effectivePersonalAllowanceGbp,
    taxableIncomeAboveAllowanceGbp,
    incomeTaxGbp,
    class4NiGbp,
    totalEstimatedReserveGbp,
    effectiveReserveRatePct,
    taxBandLabel,
    disclaimer: UK_TAX_ESTIMATOR_DISCLAIMER,
  };
}
