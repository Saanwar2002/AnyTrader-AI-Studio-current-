/**
 * Pure, deterministic property risk & predictive maintenance derivation helpers (Slice 5).
 * Ensures Risk Analytics and AI Insights always reflect real recorded passport data
 * rather than fabricated active compliance claims or blank template strings.
 */

export interface DerivedRiskVector {
  id: "roof" | "electrical" | "plumbing" | "damp";
  name: string;
  score: number; // 0 (safest) - 100 (highest risk)
  status: "Low Risk" | "Moderate Risk" | "High Risk";
  findings: string;
  recommendation: string;
}

export interface DerivedMaintenanceForecastItem {
  period: string;
  estimatedCost: string;
  priorityItems: string[];
  riskPrevented: string;
}

export interface DerivedPropertyRiskProfile {
  overallRiskScore: number;
  riskBand: "Very Low Risk" | "Low Risk" | "Moderate Risk" | "Elevated Risk";
  insuranceGrade: string;
  estInsuranceDiscount: string;
  isGasValid: boolean;
  isEicrValid: boolean;
  riskVectors: DerivedRiskVector[];
  maintenanceExpenditure: DerivedMaintenanceForecastItem[];
}

export interface DerivedPredictiveInsight {
  idKey: string;
  title: string;
  badge: string;
  badgeTone: "red" | "amber" | "blue" | "purple";
  summary: string;
  dispatchTitle: string;
  category: string;
  budget: string;
  urgency: "emergency" | "urgent" | "routine";
  ctaLabel: string;
}

function parseIsoDateValidFuture(raw: unknown, nowMs: number): { hasRecord: boolean; isExpired: boolean; daysRemaining: number | null } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { hasRecord: false, isExpired: false, daysRemaining: null };
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { hasRecord: false, isExpired: false, daysRemaining: null };
  const diffDays = Math.ceil((parsed - nowMs) / (1000 * 60 * 60 * 24));
  return { hasRecord: true, isExpired: diffDays <= 0, daysRemaining: diffDays };
}

function scoreToStatus(score: number): "Low Risk" | "Moderate Risk" | "High Risk" {
  if (score <= 25) return "Low Risk";
  if (score <= 55) return "Moderate Risk";
  return "High Risk";
}

export function derivePropertyRiskProfile(
  propertyPassport?: Record<string, any> | null,
  nowMs: number = Date.now()
): DerivedPropertyRiskProfile {
  const prop = propertyPassport || {};
  const gasCheck = parseIsoDateValidFuture(prop.gasSafetyExpiry, nowMs);
  const eicrCheck = parseIsoDateValidFuture(prop.eicrExpiry, nowMs);
  const isGasValid = gasCheck.hasRecord && !gasCheck.isExpired;
  const isEicrValid = eicrCheck.hasRecord && !eicrCheck.isExpired;

  const roofRaw = typeof prop.roofCondition === "string" ? prop.roofCondition.trim() : "";
  const roofLower = roofRaw.toLowerCase();
  const boilerBrand = typeof prop.boilerInfo?.brand === "string" ? prop.boilerInfo.brand.trim() : "";
  const boilerAgeNum = Number(prop.boilerInfo?.age);
  const hasBoilerAge = Number.isFinite(boilerAgeNum) && boilerAgeNum > 0;
  const epcRating = typeof prop.epcRating === "string" ? prop.epcRating.trim().toUpperCase() : "";

  // 1. Roof Vector
  let roofScore = 35;
  let roofFindings = "Roof condition has not yet been recorded in the Property Passport.";
  let roofRec = "Log your latest roof inspection or book a preventative roof & gutter check before winter.";
  if (roofLower === "excellent") {
    roofScore = 10;
    roofFindings = "Roof condition recorded as Excellent in the Property Passport.";
    roofRec = "Maintain annual autumn gutter clearance to protect fascia and flashing.";
  } else if (roofLower === "good") {
    roofScore = 18;
    roofFindings = "Roof condition recorded as Good with no critical defects flagged.";
    roofRec = "Schedule a bi-annual ridge tile & chimney mortar check ahead of winter storms.";
  } else if (roofLower === "fair") {
    roofScore = 44;
    roofFindings = "Roof condition is flagged as Fair — minor wear may accelerate under heavy rainfall.";
    roofRec = "Book a roofer to inspect flashing, tiles, and guttering before seasonal weather.";
  } else if (roofLower.includes("inspect") || roofLower === "poor") {
    roofScore = 72;
    roofFindings = `Roof condition is flagged as "${roofRaw}" — elevated water ingress risk.`;
    roofRec = "Dispatch a verified roofer promptly to inspect tiles, felt, and mortar joints.";
  }

  // 2. Electrical Vector (EICR)
  let elecScore = 48;
  let elecFindings = "No EICR electrical safety certificate expiry is currently recorded.";
  let elecRec = "Upload your EICR expiry date or book a Part P qualified electrician for a 5-year inspection.";
  if (isEicrValid) {
    elecScore = 14;
    elecFindings = `EICR electrical inspection certificate recorded as valid until ${prop.eicrExpiry}.`;
    elecRec = "Test RCD safety trip buttons every 6 months and renew before expiry.";
  } else if (eicrCheck.hasRecord && eicrCheck.isExpired) {
    elecScore = 74;
    elecFindings = `EICR electrical certificate expired on ${prop.eicrExpiry} — compliance renewal overdue.`;
    elecRec = "Book an NICEIC / NAPIT electrician immediately to restore statutory EICR compliance.";
  }

  // 3. Plumbing & Gas Vector (CP12 + Boiler)
  let plumbingScore = 45;
  let plumbingFindings = "No Gas Safety (CP12) certificate expiry is recorded.";
  let plumbingRec = "Record your CP12 expiry date or book a Gas Safe engineer for an annual inspection.";
  if (isGasValid) {
    plumbingScore = hasBoilerAge && boilerAgeNum >= 10 ? 34 : hasBoilerAge && boilerAgeNum >= 6 ? 24 : 16;
    plumbingFindings = `Gas CP12 certificate recorded as valid until ${prop.gasSafetyExpiry}.${
      hasBoilerAge ? ` ${boilerBrand || "Boiler"} is ${boilerAgeNum} years old.` : ""
    }`;
    plumbingRec =
      hasBoilerAge && boilerAgeNum >= 10
        ? "Boiler is 10+ years old — plan annual servicing and budget for high-efficiency replacement."
        : "Maintain annual boiler servicing and consider smart leak detection under wet appliances.";
  } else if (gasCheck.hasRecord && gasCheck.isExpired) {
    plumbingScore = 78;
    plumbingFindings = `Gas Safety (CP12) certificate expired on ${prop.gasSafetyExpiry}.`;
    plumbingRec = "Dispatch a Gas Safe registered engineer urgently to renew CP12 certification.";
  } else if (hasBoilerAge) {
    plumbingScore = boilerAgeNum >= 10 ? 60 : 48;
    plumbingFindings = `No CP12 date recorded. ${boilerBrand || "Boiler"} age recorded as ${boilerAgeNum} years.`;
  }

  // 4. Damp, Mould & Energy (EPC)
  let dampScore = 36;
  let dampFindings = "EPC energy performance grade is not yet recorded in the Property Passport.";
  let dampRec = "Record your EPC rating and ensure extractor fans and trickle vents maintain steady airflow.";
  if (epcRating === "A" || epcRating === "B") {
    dampScore = 12;
    dampFindings = `EPC Grade ${epcRating} indicates strong thermal envelope and lower condensation risk.`;
    dampRec = "Keep ventilation vents clear during winter heating cycles.";
  } else if (epcRating === "C") {
    dampScore = 20;
    dampFindings = "EPC Grade C provides solid insulation performance with low condensation risk.";
    dampRec = "Monitor bathroom & kitchen extraction rates annually (Awaab's Law readiness).";
  } else if (epcRating === "D" || epcRating === "E") {
    dampScore = 42;
    dampFindings = `EPC Grade ${epcRating} indicates moderate heat loss and higher winter condensation potential.`;
    dampRec = "Review loft/cavity insulation and verify humidity-controlled extraction fans.";
  } else if (epcRating === "F" || epcRating === "G") {
    dampScore = 68;
    dampFindings = `EPC Grade ${epcRating} indicates elevated heat loss, damp, and regulatory upgrade risk.`;
    dampRec = "Prioritise thermal upgrades, draught-proofing, and damp/ventilation assessment.";
  }

  const riskVectors: DerivedRiskVector[] = [
    {
      id: "roof",
      name: "Roof & Structural Flashing",
      score: roofScore,
      status: scoreToStatus(roofScore),
      findings: roofFindings,
      recommendation: roofRec,
    },
    {
      id: "electrical",
      name: "Electrical & Consumer Unit Safety",
      score: elecScore,
      status: scoreToStatus(elecScore),
      findings: elecFindings,
      recommendation: elecRec,
    },
    {
      id: "plumbing",
      name: "Plumbing, Gas & Boiler Safety",
      score: plumbingScore,
      status: scoreToStatus(plumbingScore),
      findings: plumbingFindings,
      recommendation: plumbingRec,
    },
    {
      id: "damp",
      name: "Damp, Mould & Thermal Index",
      score: dampScore,
      status: scoreToStatus(dampScore),
      findings: dampFindings,
      recommendation: dampRec,
    },
  ];

  const overallRiskScore = Math.round(
    riskVectors.reduce((sum, v) => sum + v.score, 0) / riskVectors.length
  );

  const riskBand: DerivedPropertyRiskProfile["riskBand"] =
    overallRiskScore <= 20
      ? "Very Low Risk"
      : overallRiskScore <= 35
        ? "Low Risk"
        : overallRiskScore <= 55
          ? "Moderate Risk"
          : "Elevated Risk";

  const insuranceGrade =
    overallRiskScore <= 20
      ? "Grade A (Low Risk Profile)"
      : overallRiskScore <= 35
        ? "Grade B (Good Compliance)"
        : overallRiskScore <= 55
          ? "Grade C (Action Advised)"
          : "Grade D (Compliance Gaps)";

  const estInsuranceDiscount =
    isGasValid && isEicrValid && overallRiskScore <= 25
      ? "Up to 10–15% est. credit"
      : "Complete CP12 & EICR to qualify";

  const year1Items: string[] = [];
  if (!isGasValid) year1Items.push("CP12 Gas Safety Certificate");
  else year1Items.push("Annual Boiler Service");
  if (!isEicrValid) year1Items.push("EICR Electrical Inspection");
  else year1Items.push("Gutter & Flashing Clearance");

  const year3Items = [
    roofScore >= 40 ? "Roof Tile & Flashing Remediation" : "Roof Ridge & Mortar Check",
    hasBoilerAge && boilerAgeNum >= 8 ? "Heating Controls & Flush" : "RCD & Electrical Check",
  ];

  const year5Items = [
    hasBoilerAge && boilerAgeNum >= 10 ? "Boiler System Replacement" : "Heating System Efficiency Review",
    epcRating && ["D", "E", "F", "G"].includes(epcRating) ? "EPC Thermal & Glazing Upgrade" : "Double Glazing Seal & Ventilation Check",
  ];

  const currentYear = new Date(nowMs).getUTCFullYear();
  const maintenanceExpenditure: DerivedMaintenanceForecastItem[] = [
    {
      period: `Year 1 (${currentYear}–${currentYear + 1})`,
      estimatedCost: !isGasValid || !isEicrValid ? "£290 – £480" : "£180 – £320",
      priorityItems: year1Items,
      riskPrevented: "Maintains statutory safety compliance and avoids callout surcharges",
    },
    {
      period: `Year 3 (${currentYear + 2}–${currentYear + 3})`,
      estimatedCost: roofScore >= 40 ? "£950 – £1,600" : "£450 – £850",
      priorityItems: year3Items,
      riskPrevented: "Prevents weather ingress and structural damp intrusion",
    },
    {
      period: `Year 5 (${currentYear + 4}–${currentYear + 5})`,
      estimatedCost: hasBoilerAge && boilerAgeNum >= 10 ? "£2,400 – £3,800" : "£1,200 – £2,200",
      priorityItems: year5Items,
      riskPrevented: epcRating ? `Protects EPC Grade ${epcRating} & long-term asset value` : "Protects long-term asset valuation & energy efficiency",
    },
  ];

  return {
    overallRiskScore,
    riskBand,
    insuranceGrade,
    estInsuranceDiscount,
    isGasValid,
    isEicrValid,
    riskVectors,
    maintenanceExpenditure,
  };
}

export function derivePropertyPredictiveInsights(
  property: Record<string, any>,
  nowMs: number = Date.now()
): DerivedPredictiveInsight[] {
  const insights: DerivedPredictiveInsight[] = [];
  const propName = String(property?.name || "Property").trim();
  const gasCheck = parseIsoDateValidFuture(property?.gasSafetyExpiry, nowMs);
  const eicrCheck = parseIsoDateValidFuture(property?.eicrExpiry, nowMs);
  const boilerBrand = typeof property?.boilerInfo?.brand === "string" ? property.boilerInfo.brand.trim() : "";
  const boilerModel = typeof property?.boilerInfo?.model === "string" ? property.boilerInfo.model.trim() : "";
  const boilerAgeNum = Number(property?.boilerInfo?.age);
  const hasBoilerAge = Number.isFinite(boilerAgeNum) && boilerAgeNum > 0;
  const roofCondition = typeof property?.roofCondition === "string" ? property.roofCondition.trim() : "";
  const epcRating = typeof property?.epcRating === "string" ? property.epcRating.trim().toUpperCase() : "";

  if (!gasCheck.hasRecord || gasCheck.isExpired || (gasCheck.daysRemaining !== null && gasCheck.daysRemaining <= 45)) {
    insights.push({
      idKey: "pred-cp12",
      title: gasCheck.isExpired ? "Overdue Gas Safety Certificate (CP12)" : !gasCheck.hasRecord ? "Missing Gas Safety Certificate (CP12)" : "CP12 Gas Safety Renewal Due Soon",
      badge: gasCheck.isExpired ? "Overdue" : "Compliance Action",
      badgeTone: gasCheck.isExpired ? "red" : "amber",
      summary: gasCheck.isExpired
        ? `Your recorded CP12 certificate expired on ${property.gasSafetyExpiry}. Book a Gas Safe engineer to restore statutory compliance.`
        : !gasCheck.hasRecord
          ? "No CP12 expiry date is recorded on this Property Passport. Add your certificate date or book a Gas Safe inspection."
          : `Your CP12 certificate expires in ${gasCheck.daysRemaining} days (${property.gasSafetyExpiry}).`,
      dispatchTitle: `CP12 Gas Safety Certificate Inspection (${propName})`,
      category: "Heating & Gas",
      budget: "110",
      urgency: gasCheck.isExpired ? "urgent" : "routine",
      ctaLabel: "1-Tap Dispatch Gas Engineer",
    });
  }

  if (!eicrCheck.hasRecord || eicrCheck.isExpired || (eicrCheck.daysRemaining !== null && eicrCheck.daysRemaining <= 60)) {
    insights.push({
      idKey: "pred-eicr",
      title: eicrCheck.isExpired ? "Overdue Electrical Inspection (EICR)" : !eicrCheck.hasRecord ? "Missing EICR Electrical Certificate" : "EICR Electrical Renewal Due Soon",
      badge: eicrCheck.isExpired ? "Overdue" : "Compliance Action",
      badgeTone: eicrCheck.isExpired ? "red" : "amber",
      summary: eicrCheck.isExpired
        ? `Your EICR electrical safety report expired on ${property.eicrExpiry}. Schedule a Part P certified electrician.`
        : !eicrCheck.hasRecord
          ? "No EICR expiry date is currently recorded. Upload your expiry date in Compliance or book a 5-year inspection."
          : `Your EICR report expires in ${eicrCheck.daysRemaining} days (${property.eicrExpiry}).`,
      dispatchTitle: `EICR Electrical Safety Inspection (${propName})`,
      category: "Electrical",
      budget: "180",
      urgency: eicrCheck.isExpired ? "urgent" : "routine",
      ctaLabel: "1-Tap Dispatch Electrician",
    });
  }

  const boilerLabel = [boilerBrand, boilerModel].filter(Boolean).join(" ") || "Heating Boiler";
  insights.push({
    idKey: "pred-boiler",
    title: hasBoilerAge && boilerAgeNum >= 10 ? "Ageing Boiler Service & Efficiency Check" : "Annual Boiler Servicing & Flue Check",
    badge: hasBoilerAge && boilerAgeNum >= 10 ? "High Priority" : "Recommended",
    badgeTone: hasBoilerAge && boilerAgeNum >= 10 ? "amber" : "blue",
    summary: hasBoilerAge
      ? `${boilerLabel} is recorded as ${boilerAgeNum} ${boilerAgeNum === 1 ? "year" : "years"} old. Annual servicing helps prevent winter breakdowns and maintains warranty cover.`
      : `${boilerLabel} age is not yet recorded. Regular annual servicing keeps your heating reliable and records verified maintenance history.`,
    dispatchTitle: `Annual Boiler Service & Maintenance (${boilerLabel})`,
    category: "Heating & Gas",
    budget: "95",
    urgency: "routine",
    ctaLabel: "1-Tap Dispatch Boiler Engineer",
  });

  const roofNeedsAction = !roofCondition || ["fair", "needs inspection", "poor"].includes(roofCondition.toLowerCase());
  insights.push({
    idKey: "pred-roof",
    title: roofNeedsAction ? "Priority Roof Tile & Gutter Inspection" : "Seasonal Gutter & Roof Maintenance Check",
    badge: roofNeedsAction ? "Inspection Advised" : "Seasonal Check",
    badgeTone: roofNeedsAction ? "amber" : "purple",
    summary: roofCondition
      ? `Roof condition is currently recorded as "${roofCondition}". Clearing gutters and checking flashing prevents damp and frost damage.`
      : "Roof condition has not yet been recorded on this passport. Schedule a roof and gutter inspection to establish a verified baseline.",
    dispatchTitle: `Roof Tile & Gutter Inspection (${propName})`,
    category: "Roofing",
    budget: "130",
    urgency: "routine",
    ctaLabel: "1-Tap Dispatch Roofer",
  });

  if (!epcRating || ["D", "E", "F", "G"].includes(epcRating)) {
    insights.push({
      idKey: "pred-epc",
      title: epcRating ? `Improve Energy Efficiency from EPC Grade ${epcRating}` : "Record or Renew EPC Energy Certificate",
      badge: "Energy & Value",
      badgeTone: "purple",
      summary: epcRating
        ? `Current EPC rating is Grade ${epcRating}. Insulation, draught-proofing, or smart heating controls can improve rental compliance and lower running costs.`
        : "No EPC rating is recorded yet. Adding your EPC grade improves your Property Passport health score and buyer readiness.",
      dispatchTitle: `EPC Assessment & Insulation Survey (${propName})`,
      category: "Insulation & Energy Efficiency",
      budget: "140",
      urgency: "routine",
      ctaLabel: "1-Tap Dispatch Energy Assessor",
    });
  }

  return insights;
}
