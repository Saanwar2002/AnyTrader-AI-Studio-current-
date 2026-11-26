import React, { useState, useMemo } from "react";
import {
  ShieldCheck, Download, Thermometer, Droplets, Zap, Building
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/src/lib/utils";
import { derivePropertyRiskProfile } from "@/src/lib/propertyInsights";

interface PropertyRiskAnalyticsProps {
  propertyPassport?: any;
  userPostcode?: string;
  authoritativeRisk?: {
    overallRiskScore: number;
    primaryRiskSeverity: string;
    methodologyVersion: string;
    activeRiskAssessments?: any[];
  };
}

const VECTOR_ICONS = {
  roof: Building,
  electrical: Zap,
  plumbing: Droplets,
  damp: Thermometer,
} as const;

export default function PropertyRiskAnalyticsWidget({ propertyPassport, userPostcode = "UK", authoritativeRisk }: PropertyRiskAnalyticsProps) {
  const [selectedTab, setSelectedTab] = useState<"overview" | "forecast">("overview");
  const [isExporting, setIsExporting] = useState(false);

  const propName = propertyPassport?.name || propertyPassport?.address?.line1 || "Main Residence";
  const propAge = propertyPassport?.era || "Era not recorded";
  const resolvedPostcode = propertyPassport?.address?.postcode || propertyPassport?.postcode || userPostcode;

  const derived = useMemo(() => derivePropertyRiskProfile(propertyPassport), [propertyPassport]);

  // Task 21 Intelligence Boundary: Use authoritative risk score if present; otherwise derive truthfully from recorded passport fields.
  const isAuthoritative = Boolean(authoritativeRisk?.methodologyVersion);
  const overallRiskScore = isAuthoritative ? authoritativeRisk!.overallRiskScore : derived.overallRiskScore;
  const riskBandLabel = isAuthoritative
    ? String(authoritativeRisk!.primaryRiskSeverity || derived.riskBand).toUpperCase()
    : derived.riskBand;
  const insuranceGrade = isAuthoritative
    ? `Authoritative (${authoritativeRisk!.primaryRiskSeverity.toUpperCase()})`
    : derived.insuranceGrade;
  const estInsuranceDiscount = isAuthoritative
    ? "Evidence-Backed Risk Model"
    : derived.estInsuranceDiscount;

  const handleExportRiskCertificate = () => {
    setIsExporting(true);
    try {
      const lines = [
        "ANYTRADER PROPERTY RISK & COMPLIANCE SUMMARY",
        "============================================",
        `Property: ${propName}`,
        `Postcode: ${resolvedPostcode}`,
        `Era: ${propAge}`,
        `Generated: ${new Date().toLocaleString("en-GB")}`,
        `Aggregate Risk Index: ${overallRiskScore}/100 (${riskBandLabel})`,
        `Underwriter Rating: ${insuranceGrade}`,
        `CP12 Gas Safety: ${derived.isGasValid ? `Valid until ${propertyPassport?.gasSafetyExpiry}` : "Unverified / Action Required"}`,
        `EICR Electrical: ${derived.isEicrValid ? `Valid until ${propertyPassport?.eicrExpiry}` : "Unverified / Action Required"}`,
        "",
        "4-VECTOR RISK BREAKDOWN:",
        ...derived.riskVectors.map(
          (v) => `- ${v.name}: ${v.status} (${v.score}/100)\n  Findings: ${v.findings}\n  Action: ${v.recommendation}`
        ),
        "",
        "5-YEAR PREDICTIVE MAINTENANCE FORECAST:",
        ...derived.maintenanceExpenditure.map(
          (m) => `- ${m.period} (${m.estimatedCost}): ${m.priorityItems.join(", ")} — ${m.riskPrevented}`
        ),
      ];
      const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `property-risk-summary-${String(propName).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Property Risk & Compliance Summary downloaded.");
    } catch {
      window.print();
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="bg-white rounded-3xl border border-black p-5 sm:p-6 shadow-sm space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-black uppercase tracking-wider mb-2">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            <span>Property Risk Analytics & Underwriter Scoring</span>
          </div>
          <h2 className="text-2xl font-black text-black tracking-tight flex items-center gap-2 flex-wrap">
            <span>{propName}</span>
            <span className="text-xs font-extrabold text-black bg-slate-100 px-2.5 py-1 rounded-xl border border-black">
              {propAge}
            </span>
          </h2>
          <p className="text-xs text-slate-600 font-semibold mt-0.5">
            Derived directly from your recorded Property Passport certificates, appliance specs, and building condition.
          </p>
        </div>

        <button
          onClick={handleExportRiskCertificate}
          disabled={isExporting}
          className="px-4 py-2.5 bg-slate-900 hover:bg-black text-white font-extrabold text-xs rounded-2xl border border-black shadow-md flex items-center gap-2 transition active:scale-95 shrink-0"
        >
          <Download className="w-4 h-4 text-cyan-300" />
          {isExporting ? "Exporting..." : "Export Insurance Risk Summary"}
        </button>
      </div>

      {/* Metric Overview Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-5 rounded-2xl border border-white/20 shadow-md space-y-1">
          <p className="text-[10px] uppercase font-extrabold text-slate-400">Aggregate Risk Index</p>
          <div className="flex items-baseline gap-2">
            <span className={cn("text-3xl font-black", overallRiskScore <= 25 ? "text-emerald-400" : overallRiskScore <= 50 ? "text-amber-400" : "text-red-400")}>
              {overallRiskScore}
            </span>
            <span className="text-xs font-bold text-slate-300">/ 100 ({riskBandLabel})</span>
          </div>
          <p className="text-[11px] text-slate-300 font-medium">
            {resolvedPostcode ? `Benchmarking area: ${resolvedPostcode}` : "Based on recorded Property Passport specs"}
          </p>
        </div>

        <div className="bg-slate-50 p-5 rounded-2xl border border-black space-y-1">
          <p className="text-[10px] uppercase font-extrabold text-slate-500">Underwriter Risk Rating</p>
          <p className="text-xl font-black text-black">{insuranceGrade}</p>
          <p className="text-[11px] text-slate-600 font-medium">
            {derived.isGasValid && derived.isEicrValid
              ? "CP12 & EICR verified on passport"
              : "Add valid CP12 & EICR to improve grade"}
          </p>
        </div>

        <div className="bg-emerald-50 p-5 rounded-2xl border border-black space-y-1">
          <p className="text-[10px] uppercase font-extrabold text-emerald-900">Insurance Readiness</p>
          <p className="text-xl font-black text-black">{estInsuranceDiscount}</p>
          <p className="text-[11px] text-slate-700 font-medium">Lower-risk verified records support renewal reviews</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 gap-2 pb-1 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setSelectedTab("overview")}
          className={cn(
            "px-4 py-2.5 rounded-xl text-xs font-extrabold transition border shrink-0",
            selectedTab === "overview" ? "bg-slate-900 text-white border-black" : "bg-white text-black border-black hover:bg-slate-50"
          )}
        >
          4-Vector Risk Analysis
        </button>
        <button
          onClick={() => setSelectedTab("forecast")}
          className={cn(
            "px-4 py-2.5 rounded-xl text-xs font-extrabold transition border shrink-0",
            selectedTab === "forecast" ? "bg-slate-900 text-white border-black" : "bg-white text-black border-black hover:bg-slate-50"
          )}
        >
          Predictive Maintenance Expenditure (5-Yr)
        </button>
      </div>

      {/* Tab 1: 4-Vector Risk Analysis */}
      {selectedTab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {derived.riskVectors.map((vec) => {
            const Icon = VECTOR_ICONS[vec.id];
            return (
              <div key={vec.id} className="bg-slate-50 p-5 rounded-2xl border border-black space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-white border border-black flex items-center justify-center text-black font-bold shadow-sm">
                      <Icon className="w-5 h-5 text-indigo-600" />
                    </div>
                    <h4 className="font-extrabold text-black text-sm">{vec.name}</h4>
                  </div>
                  <span className={cn(
                    "text-[10px] font-black uppercase px-2.5 py-1 rounded-full border shrink-0",
                    vec.status === "Low Risk"
                      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                      : vec.status === "Moderate Risk"
                        ? "bg-amber-100 text-amber-800 border-amber-300"
                        : "bg-red-100 text-red-800 border-red-300"
                  )}>
                    {vec.status} ({vec.score}/100)
                  </span>
                </div>

                <p className="text-xs text-black font-medium leading-snug">{vec.findings}</p>

                <div className="bg-white p-3 rounded-xl border border-black text-xs">
                  <span className="font-black text-indigo-700 block text-[10px] uppercase">Underwriter Recommendation:</span>
                  <span className="text-black font-semibold">{vec.recommendation}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tab 2: Predictive Maintenance Expenditure (5-Yr) */}
      {selectedTab === "forecast" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {derived.maintenanceExpenditure.map((item, idx) => (
              <div key={idx} className="bg-slate-50 p-5 rounded-2xl border border-black space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-xs font-black text-indigo-700 uppercase">{item.period}</span>
                  <span className="text-sm font-black text-black">{item.estimatedCost}</span>
                </div>

                <div className="space-y-1">
                  <p className="text-[10px] font-extrabold uppercase text-slate-600">Key Planned Work:</p>
                  <ul className="text-xs text-black font-bold list-disc list-inside space-y-0.5">
                    {item.priorityItems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </div>

                <div className="bg-emerald-50 p-2.5 rounded-xl border border-black text-[11px] text-black font-semibold">
                  🛡 <strong>Impact:</strong> {item.riskPrevented}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
