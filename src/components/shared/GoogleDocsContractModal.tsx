import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { FileText, ShieldAlert, CheckCircle2, FileCheck, ExternalLink, Loader2, X } from "lucide-react";
import { generateLegalContractDoc, ContractDetails, VerifiedTraderCredentials } from "@/src/services/googleDriveDocsService";
import { useDialogA11y } from "@/src/lib/useDialogA11y";
import { toast } from "sonner";

interface GoogleDocsContractModalProps {
  isOpen: boolean;
  onClose: () => void;
  job: any;
  quote?: any;
  traderName?: string;
  clientName?: string;
  traderProfile?: any;
}

export function GoogleDocsContractModal({
  isOpen,
  onClose,
  job,
  quote,
  traderName = "Assigned Tradesperson",
  clientName = "Client / Homeowner",
  traderProfile,
}: GoogleDocsContractModalProps) {
  const [selectedType, setSelectedType] = useState<"Trade Service Agreement" | "Liability Waiver" | "Job Completion Certificate">("Trade Service Agreement");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedDocUrl, setGeneratedDocUrl] = useState<string | null>(null);
  const dialogRef = useDialogA11y<HTMLDivElement>(isOpen && Boolean(job), onClose);

  if (!isOpen || !job) return null;

  const jobTitle = job.title || "Trade Service Job";
  const jobRef = job.id ? `JOB-${job.id.substring(0, 8).toUpperCase()}` : "JOB-REF";
  const amount = quote?.amount || job.estimatedBudget || job.price || 0;

  const handleGenerate = async () => {
    setIsGenerating(true);
    setGeneratedDocUrl(null);

    const verifiedCredentials: VerifiedTraderCredentials = {
      publicLiabilityVerified: Boolean(
        traderProfile?.insuranceVerified === true ||
          traderProfile?.publicLiabilityVerified === true
      ),
      insuranceProvider: traderProfile?.insuranceProvider || undefined,
      insurancePolicyNumber: traderProfile?.insurancePolicyNumber || undefined,
      publicLiabilityLimit: traderProfile?.publicLiabilityLimit || undefined,
      warrantyVerified: Boolean(traderProfile?.warrantyVerified === true && Number(traderProfile?.warrantyMonths) > 0),
      warrantyMonths: Number(traderProfile?.warrantyMonths) > 0 ? Number(traderProfile.warrantyMonths) : undefined,
      siteSafetyVerified: Boolean(traderProfile?.siteSafetyVerified === true || traderProfile?.isVerified === true),
      certifications: Array.isArray(traderProfile?.verifiedCertifications)
        ? traderProfile.verifiedCertifications
        : undefined,
    };

    const details: ContractDetails = {
      documentType: selectedType,
      jobTitle,
      jobRef,
      clientName: clientName || job.clientName || "Client",
      clientAddress: job.postcode ? `${job.location || "Location"}, ${job.postcode}` : job.location,
      traderName: traderName || "Trader",
      amount,
      startDate: quote?.startDate || job.preferredStartDate || new Date().toISOString().split("T")[0],
      scopeOfWork: quote?.quoteScope || job.description || jobTitle,
      completionNotes: job.completionNotes || undefined,
      verifiedCredentials,
    };

    const res = await generateLegalContractDoc(details);
    setIsGenerating(false);

    if (res.success && res.documentUrl) {
      setGeneratedDocUrl(res.documentUrl);
      toast.success(`${selectedType} created and saved in Google Drive!`);
    } else {
      toast.error(res.error || "Failed to generate Google Doc contract.");
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="google-docs-contract-modal-title"
          tabIndex={-1}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="bg-white rounded-2xl border border-black shadow-2xl max-w-lg w-full overflow-hidden focus:outline-none"
        >
          {/* Header */}
          <div className="bg-[#1e3a5f] text-white p-5 flex items-center justify-between border-b border-black">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center shrink-0">
                <FileText className="w-5 h-5 text-blue-300" />
              </div>
              <div>
                <h3 id="google-docs-contract-modal-title" className="text-base font-bold text-white">Google Docs Legal Contract Engine</h3>
                <p className="text-xs text-blue-200">{jobRef} • {jobTitle}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Google Docs contract modal"
              className="p-1.5 hover:bg-white/10 rounded-xl text-white/80 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6 space-y-5">
            <div>
              <p className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
                Select Contract / Certificate Type
              </p>
              <div className="grid grid-cols-1 gap-2.5">
                <button
                  type="button"
                  onClick={() => setSelectedType("Trade Service Agreement")}
                  className={`p-3.5 rounded-xl border text-left transition-all flex items-start gap-3 ${
                    selectedType === "Trade Service Agreement"
                      ? "border-blue-600 bg-blue-50 text-blue-900 shadow-sm"
                      : "border-slate-200 hover:border-slate-300 bg-slate-50 text-slate-700"
                  }`}
                >
                  <FileCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-sm">Formal UK Trade Service Agreement</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Includes scope of work, £{amount} financial terms, UK standards & dispute protocol.
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedType("Liability Waiver")}
                  className={`p-3.5 rounded-xl border text-left transition-all flex items-start gap-3 ${
                    selectedType === "Liability Waiver"
                      ? "border-amber-600 bg-amber-50 text-amber-900 shadow-sm"
                      : "border-slate-200 hover:border-slate-300 bg-slate-50 text-slate-700"
                  }`}
                >
                  <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-sm">Worksite Liability & Access Permit</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Clears site hazard inspections and confirms public liability insurance coverage.
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedType("Job Completion Certificate")}
                  className={`p-3.5 rounded-xl border text-left transition-all flex items-start gap-3 ${
                    selectedType === "Job Completion Certificate"
                      ? "border-emerald-600 bg-emerald-50 text-emerald-900 shadow-sm"
                      : "border-slate-200 hover:border-slate-300 bg-slate-50 text-slate-700"
                  }`}
                >
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-sm">Job Completion & Handover Certificate</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Formal sign-off certificate with 12-month workmanship guarantee clause.
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* Parties summary box */}
            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs space-y-1.5 text-slate-600">
              <div className="flex justify-between">
                <span className="font-semibold text-slate-500">Contractor:</span>
                <span className="font-bold text-slate-800">{traderName}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-semibold text-slate-500">Client:</span>
                <span className="font-bold text-slate-800">{clientName}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-semibold text-slate-500">Agreed Value:</span>
                <span className="font-bold text-emerald-700">£{amount}</span>
              </div>
            </div>

            {generatedDocUrl && (
              <div className="p-4 bg-emerald-50 border border-emerald-300 rounded-xl flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-emerald-900 text-xs font-bold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Google Doc Generated Successfully!</span>
                </div>
                <a
                  href={generatedDocUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700 transition-colors flex items-center gap-1 shrink-0"
                >
                  <span>Open Doc</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 text-xs font-bold text-slate-600 hover:text-slate-800 rounded-xl transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isGenerating}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl border border-black shadow-sm flex items-center gap-2 transition-all disabled:opacity-50"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Generating Doc...</span>
                  </>
                ) : (
                  <>
                    <FileText className="w-4 h-4 text-indigo-200" />
                    <span>Generate & Save in Google Drive</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
