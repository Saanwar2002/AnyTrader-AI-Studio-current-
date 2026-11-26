import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CreditCard, ShieldCheck, ArrowRight, X, Clock, Info
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/src/lib/utils";
import { useDialogA11y } from "@/src/lib/useDialogA11y";
import { db, doc, onSnapshot } from "@/src/firebase";
import { FlexiPayMode, resolveFlexiPayMode } from "@/src/lib/marketplaceContracts";

interface BnplFinancingModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialAmount?: number;
  jobTitle?: string;
  onSelectPlan?: (planDetails: any) => void;
  flexiPayMode?: FlexiPayMode;
}

export default function BnplFinancingModal({
  isOpen,
  onClose,
  initialAmount = 2400,
  jobTitle = "Major Home Repair",
  onSelectPlan,
  flexiPayMode: explicitMode,
}: BnplFinancingModalProps) {
  const [repairAmount, setRepairAmount] = useState<number>(initialAmount >= 500 ? initialAmount : 1500);
  const [selectedTerm, setSelectedTerm] = useState<number>(12); // 3, 6, 12, 24, 36 months
  const [depositAmount] = useState<number>(0);
  const [configMode, setConfigMode] = useState<FlexiPayMode>(explicitMode || "coming_soon");
  const dialogRef = useDialogA11y<HTMLDivElement>(isOpen, onClose);

  useEffect(() => {
    if (explicitMode) {
      setConfigMode(explicitMode);
      return;
    }
    if (!isOpen) return;
    const unsub = onSnapshot(
      doc(db, "platform_config", "global"),
      (snap) => {
        if (snap.exists()) {
          setConfigMode(resolveFlexiPayMode(snap.data()));
        } else {
          setConfigMode("coming_soon");
        }
      },
      () => setConfigMode("coming_soon")
    );
    return () => unsub();
  }, [explicitMode, isOpen]);

  useEffect(() => {
    if (initialAmount >= 500) {
      setRepairAmount(initialAmount);
    }
  }, [initialAmount]);

  if (!isOpen) return null;

  const activeMode: FlexiPayMode = explicitMode || configMode;
  if (activeMode === "off") return null;

  // Transparent "Coming Soon" mode controlled by Admin
  if (activeMode === "coming_soon") {
    return (
      <AnimatePresence>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bnpl-coming-soon-title"
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            className="bg-white rounded-3xl border border-black shadow-2xl max-w-lg w-full p-6 sm:p-7 space-y-5 relative focus:outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-black/15 pb-4">
              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 border border-black text-black text-[11px] font-black uppercase tracking-wider">
                  <Clock className="w-3.5 h-3.5 text-amber-700" />
                  <span>Coming Soon</span>
                </div>
                <h2 id="bnpl-coming-soon-title" className="text-xl font-black text-black tracking-tight">
                  FlexiPay Repair Financing
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close FlexiPay Coming Soon dialog"
                className="p-2 text-black hover:bg-slate-100 rounded-xl border border-black/20 transition shrink-0 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-sm text-black leading-relaxed">
              <p className="font-semibold">
                Flexible monthly payment plans for major home repairs (£1,000+) are coming soon to AnyTrader.
              </p>
              <div className="bg-slate-50 border border-black rounded-2xl p-4 space-y-2 text-xs text-black">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <p className="font-medium">
                    We are completing FCA-regulated lending partner integration before enabling live credit applications.
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
                  <p className="font-medium">
                    In the meantime, you can split larger projects safely into staged Escrow Milestones directly with your chosen tradesperson.
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full py-3 bg-slate-900 hover:bg-black text-white font-black text-xs rounded-2xl border border-black transition cursor-pointer"
            >
              Got It
            </button>
          </motion.div>
        </div>
      </AnimatePresence>
    );
  }

  // Live Mode: Illustrative Monthly Repayment Calculator (No fake credit check or internal merchant margin copy)
  const financedAmount = Math.max(0, repairAmount - depositAmount);

  let apr = 0; // Representative illustrative 0% APR for 3 & 6 months
  if (selectedTerm === 12) apr = 4.9;
  if (selectedTerm === 24) apr = 7.9;
  if (selectedTerm === 36) apr = 9.9;

  const monthlyRate = apr / 100 / 12;
  let monthlyPayment = 0;
  if (apr === 0) {
    monthlyPayment = financedAmount / selectedTerm;
  } else {
    monthlyPayment =
      (financedAmount * monthlyRate * Math.pow(1 + monthlyRate, selectedTerm)) /
      (Math.pow(1 + monthlyRate, selectedTerm) - 1);
  }

  const totalRepayable = monthlyPayment * selectedTerm + depositAmount;
  const totalInterest = totalRepayable - repairAmount;

  const handleConfirmPlan = () => {
    const plan = {
      repairAmount,
      depositAmount,
      financedAmount,
      termMonths: selectedTerm,
      monthlyPayment: Math.round(monthlyPayment * 100) / 100,
      apr,
      totalRepayable: Math.round(totalRepayable * 100) / 100,
    };
    if (onSelectPlan) onSelectPlan(plan);
    toast.success(`Illustrative FlexiPay plan noted: £${Math.round(monthlyPayment)}/mo over ${selectedTerm} months.`);
    onClose();
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="bnpl-financing-modal-title"
          tabIndex={-1}
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="bg-white rounded-3xl border border-black shadow-2xl max-w-2xl w-full p-6 sm:p-8 space-y-6 overflow-hidden relative max-h-[92vh] overflow-y-auto focus:outline-none"
        >
          <div className="flex items-start justify-between border-b border-black/15 pb-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-50 border border-black text-black text-xs font-black uppercase tracking-wider">
                <CreditCard className="w-3.5 h-3.5 text-indigo-700" />
                <span>FlexiPay Repair Financing (£1,000+)</span>
              </div>
              <h2 id="bnpl-financing-modal-title" className="text-2xl font-black text-black tracking-tight">
                Illustrative Payment Plan Calculator
              </h2>
              <p className="text-xs text-slate-700 font-semibold">
                Estimate monthly repayments for major home repairs (£1,000–£25,000). Subject to status and lender terms.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close FlexiPay financing modal"
              className="p-2 text-black hover:bg-slate-100 rounded-xl border border-black/20 transition shrink-0 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="bg-slate-50 p-4 rounded-2xl border border-black space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-600">Repair Project</p>
                <h4 className="text-sm font-black text-black">{jobTitle}</h4>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="bnpl-repair-cost-input" className="text-xs font-extrabold text-black">Cost:</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 font-black text-black text-sm">£</span>
                  <input
                    id="bnpl-repair-cost-input"
                    type="number"
                    min={1000}
                    max={25000}
                    step={100}
                    value={repairAmount}
                    onChange={(e) => setRepairAmount(Math.max(500, parseInt(e.target.value, 10) || 0))}
                    className="w-32 pl-7 pr-3 py-1.5 bg-white border border-black rounded-xl text-sm font-black text-black focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-bold text-black">
                <span>£1,000</span>
                <span>£10,000</span>
                <span>£25,000</span>
              </div>
              <input
                type="range"
                aria-label="Repair financing amount slider"
                min={1000}
                max={25000}
                step={250}
                value={repairAmount}
                onChange={(e) => setRepairAmount(parseInt(e.target.value, 10))}
                className="w-full accent-indigo-600 cursor-pointer"
              />
            </div>
          </div>

          <div className="space-y-3" role="group" aria-labelledby="bnpl-repayment-period-label">
            <p id="bnpl-repayment-period-label" className="text-xs font-black uppercase text-black flex items-center justify-between">
              <span>Select Repayment Period:</span>
              <span className="text-indigo-700 font-black">{apr === 0 ? "0% Representative APR" : `${apr}% Representative APR`}</span>
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[3, 6, 12, 24, 36].map((months) => {
                const termApr = months <= 6 ? 0 : months === 12 ? 4.9 : months === 24 ? 7.9 : 9.9;
                return (
                  <button
                    key={months}
                    type="button"
                    aria-pressed={selectedTerm === months}
                    onClick={() => setSelectedTerm(months)}
                    className={cn(
                      "p-3 rounded-2xl border text-center transition-all flex flex-col items-center justify-between gap-1 cursor-pointer",
                      selectedTerm === months
                        ? "bg-slate-900 text-white border-black shadow-md ring-2 ring-indigo-500"
                        : "bg-white text-black border-black hover:bg-slate-50"
                    )}
                  >
                    <span className="text-xs font-black">{months} Months</span>
                    <span className={cn(
                      "text-[9px] font-black uppercase px-2 py-0.5 rounded-full",
                      selectedTerm === months
                        ? (termApr === 0 ? "bg-emerald-500/20 text-emerald-300" : "bg-indigo-500/20 text-indigo-300")
                        : "bg-slate-100 text-black"
                    )}>
                      {termApr === 0 ? "0% APR" : `${termApr}% APR`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-slate-900 text-white p-6 rounded-3xl border border-white/20 shadow-lg space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/15 pb-4">
              <div>
                <p className="text-[10px] uppercase font-extrabold text-indigo-300 tracking-wider">Estimated Monthly Payment</p>
                <div className="flex items-baseline gap-1 mt-0.5">
                  <span className="text-3xl font-black text-amber-300">£{monthlyPayment.toFixed(2)}</span>
                  <span className="text-xs font-bold text-slate-300">/ month</span>
                </div>
              </div>

              <div className="bg-white/10 p-3 rounded-2xl border border-white/20 text-right text-xs">
                <p className="text-[10px] text-slate-300 font-bold uppercase">Illustrative Total</p>
                <p className="font-black text-white text-sm">£{totalRepayable.toFixed(2)}</p>
                {totalInterest > 0 ? (
                  <p className="text-[10px] text-indigo-300">Estimated Interest: £{totalInterest.toFixed(2)}</p>
                ) : (
                  <p className="text-[10px] text-emerald-400 font-bold">0% Representative APR</p>
                )}
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs text-slate-200">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                Figures shown are illustrative only. Final eligibility and credit terms are confirmed directly by our regulated finance partner at checkout.
              </span>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            {onSelectPlan && (
              <button
                type="button"
                onClick={handleConfirmPlan}
                className="flex-1 py-3.5 bg-slate-900 hover:bg-black text-white font-black text-xs rounded-2xl border border-black shadow-lg flex items-center justify-center gap-2 transition active:scale-95 cursor-pointer"
              >
                <span>Save Illustrative Plan</span>
                <ArrowRight className="w-4 h-4 text-amber-300" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={cn(
                "py-3.5 bg-slate-100 hover:bg-slate-200 text-black font-black text-xs rounded-2xl border border-black transition cursor-pointer",
                onSelectPlan ? "px-5" : "flex-1"
              )}
            >
              Close
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
