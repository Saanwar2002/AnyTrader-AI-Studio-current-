import React, { useEffect, useState } from "react";
import { AlertTriangle, ShieldAlert, Clock, Upload, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { db, doc, onSnapshot } from "@/src/firebase";
import { isServiceProviderProfile } from "@/src/lib/accountRoles";
import {
  DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS,
  DEFAULT_PROVISIONAL_MAX_QUOTES,
  evaluateTraderDocumentCompliance,
} from "@/src/lib/traderCompliance";

interface DocumentComplianceReminderBannerProps {
  profile: any;
  onOpenVerification?: () => void;
  compact?: boolean;
}

export default function DocumentComplianceReminderBanner({
  profile,
  onOpenVerification,
  compact = false,
}: DocumentComplianceReminderBannerProps) {
  const navigate = useNavigate();
  const [gracePeriodDays, setGracePeriodDays] = useState<number>(DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS);
  const [enforceGracePeriod, setEnforceGracePeriod] = useState<boolean>(true);
  const [provisionalMaxQuotes, setProvisionalMaxQuotes] = useState<number>(DEFAULT_PROVISIONAL_MAX_QUOTES);

  const isProvider = isServiceProviderProfile(profile);

  useEffect(() => {
    if (!isProvider) return;
    const unsub = onSnapshot(doc(db, "platform_config", "global"), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const rawDays = Number(data?.documentGracePeriodDays);
        if (Number.isFinite(rawDays) && rawDays >= 0) {
          setGracePeriodDays(Math.floor(rawDays));
        }
        if (typeof data?.enforceDocumentGracePeriod === "boolean") {
          setEnforceGracePeriod(data.enforceDocumentGracePeriod);
        }
        const rawMaxQuotes = Number(data?.provisionalMaxQuotes);
        if (Number.isFinite(rawMaxQuotes) && rawMaxQuotes >= 0) {
          setProvisionalMaxQuotes(Math.floor(rawMaxQuotes));
        }
      }
    });
    return () => unsub();
  }, [isProvider]);

  if (!isProvider) return null;

  const compliance = evaluateTraderDocumentCompliance(profile, {
    gracePeriodDays,
    enforceGracePeriod,
    provisionalMaxQuotes,
  });

  if (!compliance.needsDocumentReminder) return null;

  const handleAction = () => {
    if (onOpenVerification) {
      onOpenVerification();
    } else {
      navigate("/profile#verification");
    }
  };

  const formattedDeadline = compliance.graceDeadlineIso
    ? new Date(compliance.graceDeadlineIso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  if (compliance.status === "grace_expired_restricted") {
    return (
      <div className="bg-red-50 rounded-2xl border border-black p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-red-600 text-white border border-black flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-black text-black leading-tight">
              Quoting Restricted — Upload Verification Paperwork
            </h4>
            <p className="text-xs font-medium text-black mt-0.5 leading-relaxed">
              Your {compliance.gracePeriodDays}-day document upload window has passed with no paperwork on file. Upload Photo ID or Public Liability Insurance to lift quoting restrictions.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleAction}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white border border-black text-xs font-black shrink-0 cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Upload Documents Now</span>
        </button>
      </div>
    );
  }

  if (compliance.status === "provisional_quote_cap_reached") {
    return (
      <div className="bg-red-50 rounded-2xl border border-black p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-red-600 text-white border border-black flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-black text-black leading-tight">
              Provisional Quote Limit Reached ({compliance.provisionalQuotesUsed}/{compliance.provisionalMaxQuotes})
            </h4>
            <p className="text-xs font-medium text-black mt-0.5 leading-relaxed">
              You've used all {compliance.provisionalMaxQuotes} provisional quotes available before paperwork is uploaded. Upload Photo ID or Public Liability Insurance to lift this cap immediately.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleAction}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white border border-black text-xs font-black shrink-0 cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Upload Documents Now</span>
        </button>
      </div>
    );
  }

  if (compliance.status === "regulated_pending_admin") {
    return (
      <div className="bg-amber-50 rounded-2xl border border-black p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-400 text-black border border-black flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-black text-black leading-tight">
              {compliance.duplicatePhoneFingerprintDetected
                ? "Admin Identity Check Required Before Quoting"
                : "Admin Certificate Approval Required"}
            </h4>
            <p className="text-xs font-medium text-black mt-0.5 leading-relaxed">
              {compliance.duplicatePhoneFingerprintDetected
                ? compliance.hasUploadedAnyDoc
                  ? "Your uploaded verification documents are in our Admin Verification Queue. Quoting will unlock automatically once approved."
                  : "This phone number was previously linked to another trader profile. Please upload Photo ID or Public Liability Insurance for Admin approval before quoting."
                : compliance.hasUploadedAnyDoc
                  ? `Your documents for ${compliance.regulatedCategories.join(", ")} are in our Admin Verification Queue. Quoting will unlock automatically once approved.`
                  : `Upload your required certificates (${compliance.requiredCertifications.join(", ") || "trade licences"}) for ${compliance.regulatedCategories.join(", ")} so an Admin can approve your profile for quoting.`}
            </p>
          </div>
        </div>
        {!compliance.hasUploadedAnyDoc && (
          <button
            type="button"
            onClick={handleAction}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white border border-black text-xs font-black shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{compliance.duplicatePhoneFingerprintDetected ? "Upload Documents" : "Upload Certificates"}</span>
          </button>
        )}
      </div>
    );
  }

  if (compliance.status === "provisional_grace_active") {
    const quoteCounterText =
      compliance.provisionalMaxQuotes > 0
        ? ` · ${compliance.provisionalQuotesRemaining} of ${compliance.provisionalMaxQuotes} provisional quote${compliance.provisionalQuotesRemaining === 1 ? "" : "s"} left`
        : "";
    return (
      <div className="bg-amber-50 rounded-2xl border border-black p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-white text-amber-700 border border-black flex items-center justify-center shrink-0">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-black text-black leading-tight">
              Document Reminder — {compliance.daysRemaining} Day{compliance.daysRemaining === 1 ? "" : "s"} Left{quoteCounterText}
            </h4>
            <p className="text-xs font-medium text-black mt-0.5 leading-relaxed">
              {compact
                ? `Upload Photo ID or Public Liability Insurance${formattedDeadline ? ` by ${formattedDeadline}` : ""} to keep quoting active.`
                : `You haven't uploaded any verification paperwork yet. Upload Photo ID or Public Liability Insurance${formattedDeadline ? ` before ${formattedDeadline}` : ` within ${compliance.gracePeriodDays} days`} to lift the provisional quote cap, prevent automatic quoting restrictions, and unlock your Verified Pro badge.`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleAction}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-black text-xs font-black shrink-0 cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Upload Documents</span>
        </button>
      </div>
    );
  }

  // Fallback for general unverified / rejected status
  return (
    <div className="bg-slate-50 rounded-2xl border border-black p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-white text-black border border-black flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h4 className="text-sm font-black text-black leading-tight">
            Verification Paperwork Needed
          </h4>
          <p className="text-xs font-medium text-black mt-0.5 leading-relaxed">
            {compliance.blockReason || "Upload your Photo ID, Public Liability Insurance, and trade certificates in Verification Center to unlock full quoting access."}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={handleAction}
        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white border border-black text-xs font-black shrink-0 cursor-pointer"
      >
        <Upload className="w-3.5 h-3.5" />
        <span>Open Verification Center</span>
      </button>
    </div>
  );
}
