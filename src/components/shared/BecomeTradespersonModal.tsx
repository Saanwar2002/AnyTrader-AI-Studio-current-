import React, { useState, useMemo, useEffect } from "react";
import {
  Briefcase,
  Search,
  X,
  Check,
  ShieldCheck,
  AlertTriangle,
  Upload,
  FileCheck,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import { auth, db, doc, onSnapshot, storage, ref, uploadBytes, getDownloadURL } from "@/src/firebase";
import { TRADE_CATEGORIES } from "@/src/constants";
import { shortlistTradeCategories } from "@/src/lib/tradeCategoryShortlist";
import {
  DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS,
  DEFAULT_PROVISIONAL_MAX_QUOTES,
  TRADER_COMPLIANCE_DECLARATION_SUMMARY,
  getRequiredCertificationsForTrades,
} from "@/src/lib/traderCompliance";
import { CURRENT_TERMS_VERSION } from "@/src/constants/termsAndPrivacy";
import { TermsModal } from "../TermsModal";
import { cn } from "@/src/lib/utils";

interface UploadedUpgradeDoc {
  type: string;
  fileUrl: string;
  storagePath: string;
  fileName: string;
  contentType: string;
  uploadedAt: string;
}

interface BecomeTradespersonModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: any;
  profile: any;
  onUpgraded?: (result: any) => void;
}

const OPTIONAL_BASE_DOCS = [
  "Identity Verification (Passport/Driving License)",
  "Public Liability Insurance",
];

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

export default function BecomeTradespersonModal({
  isOpen,
  onClose,
  user,
  profile,
  onUpgraded,
}: BecomeTradespersonModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [city, setCity] = useState("");
  const [bio, setBio] = useState("");
  const [tradeSearch, setTradeSearch] = useState("");
  const [selectedTrades, setSelectedTrades] = useState<string[]>([]);
  const [selectedSubcategories, setSelectedSubcategories] = useState<string[]>([]);
  const [verificationDocs, setVerificationDocs] = useState<UploadedUpgradeDoc[]>([]);
  const [uploadingCert, setUploadingCert] = useState<string | null>(null);
  const [acceptedCompliance, setAcceptedCompliance] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [gracePeriodDays, setGracePeriodDays] = useState<number>(DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS);
  const [provisionalMaxQuotes, setProvisionalMaxQuotes] = useState<number>(DEFAULT_PROVISIONAL_MAX_QUOTES);

  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setErrorMsg(null);
    setDisplayName(profile?.displayName || profile?.name || user?.displayName || "");
    setPhone(profile?.phone || "");
    setPostcode(profile?.postcode || "");
    setCity(profile?.city || "");
    setBio(profile?.bio || "");
    setSelectedTrades(Array.isArray(profile?.trades) ? profile.trades : []);
    setSelectedSubcategories(Array.isArray(profile?.subcategories) ? profile.subcategories : []);
    setAcceptedCompliance(false);
    setTradeSearch("");
  }, [isOpen, profile, user]);

  useEffect(() => {
    if (!isOpen) return;
    const unsub = onSnapshot(doc(db, "platform_config", "global"), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const rawDays = Number(data?.documentGracePeriodDays);
        if (Number.isFinite(rawDays) && rawDays >= 0) {
          setGracePeriodDays(Math.floor(rawDays));
        }
        const rawMaxQ = Number(data?.provisionalMaxQuotes);
        if (Number.isFinite(rawMaxQ) && rawMaxQ >= 0) {
          setProvisionalMaxQuotes(Math.floor(rawMaxQ));
        }
      }
    });
    return () => unsub();
  }, [isOpen]);

  const shortlistedCategories = useMemo(
    () => shortlistTradeCategories(TRADE_CATEGORIES as any[], tradeSearch),
    [tradeSearch]
  );

  const certInfo = useMemo(
    () => getRequiredCertificationsForTrades(selectedTrades, selectedSubcategories),
    [selectedTrades, selectedSubcategories]
  );

  const toggleTrade = (tradeName: string) => {
    setSelectedTrades((prev) => {
      if (prev.includes(tradeName)) {
        // Also clear subcategories belonging to the removed trade
        const removedCat = TRADE_CATEGORIES.find((c) => c.name === tradeName);
        if (removedCat?.subcategories?.length) {
          setSelectedSubcategories((subs) =>
            subs.filter((s) => !removedCat.subcategories.includes(s))
          );
        }
        return prev.filter((t) => t !== tradeName);
      }
      if (prev.length >= 20) {
        toast.info("You can select up to 20 trade categories.");
        return prev;
      }
      return [...prev, tradeName];
    });
  };

  const toggleSubcategory = (subName: string) => {
    setSelectedSubcategories((prev) =>
      prev.includes(subName) ? prev.filter((s) => s !== subName) : [...prev, subName]
    );
  };

  const validateStep1 = (): string | null => {
    if (displayName.trim().length < 2) return "Please enter your name or trading name.";
    if (phone.trim().length < 7) return "Please enter a valid contact phone number.";
    if (postcode.trim().length < 3) return "Please enter your UK postcode so nearby jobs match you.";
    if (bio.trim().length < 15) return "Please add a short service description (at least 15 characters).";
    if (selectedTrades.length === 0) return "Please select at least one trade or service category.";
    return null;
  };

  const handleNextStep = () => {
    const err = validateStep1();
    if (err) {
      setErrorMsg(err);
      return;
    }
    setErrorMsg(null);
    setStep(2);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, certType: string) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user?.uid) return;

    const allowed =
      file.type === "application/pdf" ||
      file.type.startsWith("image/") ||
      /\.(pdf|png|jpe?g|webp)$/i.test(file.name);
    if (!allowed) {
      toast.error("Please upload a PDF or image file (JPG, PNG, WebP).");
      return;
    }
    if (file.size > MAX_DOC_BYTES) {
      toast.error("File is too large. Maximum document size is 10 MB.");
      return;
    }

    setUploadingCert(certType);
    setErrorMsg(null);
    try {
      const safeCert = certType.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      const storagePath = `verifications/${user.uid}/upgrade/${safeCert}_${Date.now()}_${safeName}`;
      const storageRef = ref(storage, storagePath);
      await uploadBytes(storageRef, file, {
        contentType: file.type || "application/octet-stream",
      });
      const fileUrl = await getDownloadURL(storageRef);
      const uploadedDoc: UploadedUpgradeDoc = {
        type: certType,
        fileUrl,
        storagePath,
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        uploadedAt: new Date().toISOString(),
      };
      setVerificationDocs((prev) => [...prev.filter((d) => d.type !== certType), uploadedDoc]);
      toast.success(`${certType} uploaded securely.`);
    } catch (err: any) {
      console.error("Upgrade document upload failed:", err);
      toast.error(err?.message || "Failed to upload document. Please try again.");
    } finally {
      setUploadingCert(null);
    }
  };

  const handleRemoveUploadedDoc = (certType: string) => {
    setVerificationDocs((prev) => prev.filter((d) => d.type !== certType));
  };

  const handleSubmitUpgrade = async (skipDocs = false) => {
    if (!user?.uid) return;
    const step1Err = validateStep1();
    if (step1Err) {
      setStep(1);
      setErrorMsg(step1Err);
      return;
    }
    if (!acceptedCompliance) {
      setErrorMsg(
        "Please tick the Terms & Compliance declaration confirming your business paperwork, insurance, and health & safety are in order."
      );
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        setErrorMsg("Your sign-in session expired. Please sign in again.");
        return;
      }

      const payload = {
        displayName: displayName.trim(),
        phone: phone.trim(),
        postcode: postcode.trim().toUpperCase(),
        city: city.trim(),
        county: profile?.county || "",
        bio: bio.trim(),
        trades: selectedTrades,
        subcategories: selectedSubcategories,
        acceptedComplianceDeclaration: true as const,
        termsVersion: CURRENT_TERMS_VERSION,
        verificationDocs: skipDocs ? [] : verificationDocs,
      };

      const res = await fetch("/api/account/upgrade-to-trader", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(data.error || "Unable to activate Tradesperson profile right now.");
        return;
      }

      if (data.duplicatePhoneFingerprintDetected) {
        toast.info(
          "Tradesperson profile created! Because this phone number was previously linked to another trader profile, please upload Photo ID or Insurance for Admin approval before quoting."
        );
      } else if (data.requiresAdminVerification) {
        toast.success(
          data.uploadedDocsCount > 0
            ? "Tradesperson profile created! Your certificates have been sent to our Admin Verification Queue."
            : "Tradesperson profile created! Upload your required certificates in Profile -> Verification Center to unlock quoting."
        );
      } else {
        const maxQ = data.provisionalMaxQuotes ?? provisionalMaxQuotes;
        toast.success(
          data.uploadedDocsCount > 0
            ? "Tradesperson profile activated! You can now switch between Homeowner & Tradesperson."
            : `Tradesperson profile activated! Upload Photo ID or Insurance within ${data.documentGracePeriodDays ?? gracePeriodDays} days (up to ${maxQ} provisional quotes before upload).`
        );
      }

      onUpgraded?.(data);
      onClose();
    } catch (err: any) {
      console.error("Upgrade to tradesperson error:", err);
      setErrorMsg(err?.message || "Network error while activating Tradesperson profile.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const docsToDisplay = certInfo.hasRegulatedCategory
    ? Array.from(new Set([...certInfo.requiredCertifications, ...OPTIONAL_BASE_DOCS]))
    : OPTIONAL_BASE_DOCS;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-2xl border border-black w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="p-5 border-b border-black flex items-start justify-between gap-3 bg-slate-50">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600 text-white border border-black flex items-center justify-center shrink-0">
                <Briefcase className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-black text-black leading-tight">
                  Activate Your Tradesperson Profile
                </h2>
                <p className="text-xs font-medium text-black mt-0.5">
                  Keep your Homeowner account & manage both profiles from one dashboard.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-xl bg-white hover:bg-slate-100 border border-black text-black transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Step Indicator */}
          <div className="px-5 py-2.5 bg-white border-b border-black flex items-center justify-between text-xs font-bold text-black">
            <div className="flex items-center gap-2">
              <span className={cn("px-2.5 py-0.5 rounded-lg border border-black", step === 1 ? "bg-blue-600 text-white" : "bg-emerald-100 text-black")}>
                1. Basic Details & Services
              </span>
              <span className="text-black">→</span>
              <span className={cn("px-2.5 py-0.5 rounded-lg border border-black", step === 2 ? "bg-blue-600 text-white" : "bg-slate-100 text-black")}>
                2. Paperwork & Agreement
              </span>
            </div>
            <span className="text-[11px] font-black text-black">Step {step} of 2</span>
          </div>

          {/* Body */}
          <div className="p-5 overflow-y-auto space-y-5 flex-1">
            {errorMsg && (
              <div className="p-3.5 rounded-xl bg-red-50 border border-black text-xs font-bold text-red-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {step === 1 ? (
              <div className="space-y-5">
                {/* Basic Info */}
                <div className="bg-slate-50 p-4 rounded-2xl border border-black space-y-3.5">
                  <div>
                    <h3 className="text-sm font-black text-black">Basic Profile Information</h3>
                    <p className="text-xs font-medium text-black">
                      Pre-filled from your Homeowner profile. Complete these details before quoting.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-black uppercase text-black mb-1">
                        Name / Trading Name *
                      </label>
                      <input
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="e.g. Alex Smith Handyman"
                        className="w-full px-3 py-2 rounded-xl border border-black bg-white text-sm font-medium text-black focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-black uppercase text-black mb-1">
                        Phone Number *
                      </label>
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="e.g. 07700 900123"
                        className="w-full px-3 py-2 rounded-xl border border-black bg-white text-sm font-medium text-black focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-black uppercase text-black mb-1">
                        UK Postcode *
                      </label>
                      <input
                        type="text"
                        value={postcode}
                        onChange={(e) => setPostcode(e.target.value.toUpperCase())}
                        placeholder="e.g. SW1A 1AA"
                        className="w-full px-3 py-2 rounded-xl border border-black bg-white text-sm font-mono font-bold text-black focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-black uppercase text-black mb-1">
                        Town / City
                      </label>
                      <input
                        type="text"
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        placeholder="e.g. Birmingham"
                        className="w-full px-3 py-2 rounded-xl border border-black bg-white text-sm font-medium text-black focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-black uppercase text-black mb-1">
                      About Your Services & Experience * (min 15 chars)
                    </label>
                    <textarea
                      rows={3}
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      placeholder="Describe the services you offer, your experience, and areas you cover..."
                      className="w-full px-3 py-2 rounded-xl border border-black bg-white text-sm font-medium text-black focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                    />
                  </div>
                </div>

                {/* Smart Multi-Word Trade Category Shortlister */}
                <div className="bg-white p-4 rounded-2xl border border-black space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-black text-black">Select Your Service Categories *</h3>
                      <p className="text-xs font-medium text-black">
                        Type a few words (e.g. "garden fence", "handyman", "cleaning", "plumbing") to shortlist. Select multiple if needed.
                      </p>
                    </div>
                    <span className="text-xs font-black px-2.5 py-1 rounded-lg bg-blue-50 border border-black text-black shrink-0">
                      {selectedTrades.length} selected
                    </span>
                  </div>

                  {/* Pinned Selected Categories */}
                  {selectedTrades.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 p-2.5 rounded-xl bg-blue-50 border border-black">
                      {selectedTrades.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 bg-white border border-black px-2.5 py-1 rounded-lg text-xs font-bold text-black"
                        >
                          {t}
                          <button
                            type="button"
                            onClick={() => toggleTrade(t)}
                            aria-label={`Remove ${t}`}
                            className="hover:text-red-700 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Search Input */}
                  <div className="relative">
                    <Search className="w-4 h-4 text-black absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={tradeSearch}
                      onChange={(e) => setTradeSearch(e.target.value)}
                      placeholder="Type keywords to shortlist categories..."
                      className="w-full pl-9 pr-9 py-2.5 rounded-xl border border-black bg-slate-50 focus:bg-white text-sm font-medium text-black focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                    {tradeSearch && (
                      <button
                        type="button"
                        onClick={() => setTradeSearch("")}
                        aria-label="Clear search"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-lg hover:bg-slate-200 text-black cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Shortlisted Grid */}
                  <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                    {shortlistedCategories.slice(0, 30).map(({ category, matchedSubcategories }) => {
                      const isSelected = selectedTrades.includes(category.name);
                      const hasCerts =
                        Array.isArray((category as any).requiredCertifications) &&
                        (category as any).requiredCertifications.length > 0;

                      return (
                        <div
                          key={String(category.id)}
                          className={cn(
                            "rounded-xl border border-black p-3 transition-colors",
                            isSelected ? "bg-blue-50" : "bg-white hover:bg-slate-50"
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => toggleTrade(category.name)}
                            className="w-full flex items-center justify-between gap-2 text-left cursor-pointer"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-xs font-black text-black">{category.name}</span>
                                {hasCerts && (
                                  <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-100 border border-black text-black">
                                    Admin Cert Approval Required
                                  </span>
                                )}
                              </div>
                              {matchedSubcategories.length > 0 && (
                                <p className="text-[11px] font-medium text-black mt-0.5 truncate">
                                  Matches: {matchedSubcategories.slice(0, 3).join(", ")}
                                </p>
                              )}
                            </div>
                            <div
                              className={cn(
                                "w-5 h-5 rounded-md border border-black flex items-center justify-center shrink-0",
                                isSelected ? "bg-blue-600 text-white" : "bg-white"
                              )}
                            >
                              {isSelected && <Check className="w-3.5 h-3.5" />}
                            </div>
                          </button>

                          {isSelected && Array.isArray(category.subcategories) && category.subcategories.length > 0 && (
                            <div className="mt-2.5 pt-2 border-t border-black/15 flex flex-wrap gap-1.5">
                              {category.subcategories.slice(0, 8).map((sub) => {
                                const subActive = selectedSubcategories.includes(sub);
                                return (
                                  <button
                                    key={sub}
                                    type="button"
                                    onClick={() => toggleSubcategory(sub)}
                                    className={cn(
                                      "text-[11px] font-bold px-2 py-0.5 rounded-lg border border-black cursor-pointer",
                                      subActive ? "bg-slate-900 text-white" : "bg-white text-black hover:bg-slate-100"
                                    )}
                                  >
                                    {sub}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {shortlistedCategories.length === 0 && (
                      <div className="p-4 text-center text-xs font-bold text-black bg-slate-50 rounded-xl border border-black">
                        No categories matched "{tradeSearch}". Try another keyword.
                      </div>
                    )}
                  </div>

                  {certInfo.hasRegulatedCategory && (
                    <div className="p-3 rounded-xl bg-amber-50 border border-black text-xs font-medium text-black flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-black">Admin Document Approval Required:</span>{" "}
                        {certInfo.regulatedCategories.join(", ")} require mandatory UK certifications ({certInfo.requiredCertifications.join(", ")}). You can upload them on Step 2.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Regulated vs Non-Regulated Policy Callout */}
                {certInfo.hasRegulatedCategory ? (
                  <div className="p-4 rounded-2xl bg-amber-50 border border-black space-y-1.5">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-5 h-5 text-amber-800" />
                      <h3 className="text-sm font-black text-black">
                        Regulated Trade Approval Required
                      </h3>
                    </div>
                    <p className="text-xs font-medium text-black leading-relaxed">
                      Because you selected <strong>{certInfo.regulatedCategories.join(", ")}</strong>, our Admin team must review and approve your required certificates before you can submit quotes. You can upload them below now or later from <strong>Profile → Verification Center</strong>.
                    </p>
                  </div>
                ) : (
                  <div className="p-4 rounded-2xl bg-emerald-50 border border-black space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-emerald-800" />
                      <h3 className="text-sm font-black text-black">
                        Fast Activation + {gracePeriodDays}-Day Paperwork Window
                      </h3>
                    </div>
                    <p className="text-xs font-medium text-black leading-relaxed">
                      Your selected categories can start quoting immediately ({provisionalMaxQuotes > 0 ? `up to ${provisionalMaxQuotes} provisional quotes` : "provisional access"} while paperwork is pending). To protect customers and unlock full quoting, please upload your <strong>Photo ID</strong> or <strong>Public Liability Insurance</strong> now or within <strong>{gracePeriodDays} days</strong> in your Profile.
                    </p>
                  </div>
                )}

                {/* Document Upload Section */}
                <div className="bg-white p-4 rounded-2xl border border-black space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-black text-black">
                      {certInfo.hasRegulatedCategory
                        ? "Required Trade Certificates & Supporting Paperwork"
                        : "Upload ID / Insurance (Recommended Now)"}
                    </h4>
                    <span className="text-[11px] font-bold text-black">PDF, JPG, PNG • Max 10 MB</span>
                  </div>

                  <div className="space-y-2.5">
                    {docsToDisplay.map((certType) => {
                      const isMandatory = certInfo.requiredCertifications.includes(certType);
                      const uploaded = verificationDocs.find((d) => d.type === certType);
                      const isBusy = uploadingCert === certType;

                      return (
                        <div
                          key={certType}
                          className="p-3 rounded-xl border border-black bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-black text-black">{certType}</span>
                              <span
                                className={cn(
                                  "text-[10px] font-black px-2 py-0.5 rounded border border-black",
                                  isMandatory ? "bg-amber-100 text-black" : "bg-white text-black"
                                )}
                              >
                                {isMandatory ? "Required for Approval" : `Within ${gracePeriodDays} Days`}
                              </span>
                            </div>
                            {uploaded && (
                              <p className="text-[11px] font-bold text-emerald-800 mt-1 flex items-center gap-1 truncate">
                                <FileCheck className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">{uploaded.fileName}</span>
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {uploaded && (
                              <button
                                type="button"
                                onClick={() => handleRemoveUploadedDoc(certType)}
                                className="px-2.5 py-1.5 rounded-xl bg-white border border-black text-xs font-bold text-red-700 hover:bg-red-50 cursor-pointer"
                              >
                                Remove
                              </button>
                            )}
                            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-blue-50 border border-black text-xs font-black text-black cursor-pointer">
                              {isBusy ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  <span>Uploading...</span>
                                </>
                              ) : (
                                <>
                                  <Upload className="w-3.5 h-3.5" />
                                  <span>{uploaded ? "Replace" : "Upload"}</span>
                                </>
                              )}
                              <input
                                type="file"
                                accept=".pdf,image/*"
                                className="sr-only"
                                disabled={Boolean(uploadingCert)}
                                onChange={(e) => handleFileUpload(e, certType)}
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Mandatory Terms & Compliance Declaration Tick Box */}
                <div className="bg-blue-50 p-4 rounded-2xl border border-black space-y-2.5">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acceptedCompliance}
                      onChange={(e) => {
                        setAcceptedCompliance(e.target.checked);
                        if (e.target.checked) setErrorMsg(null);
                      }}
                      className="mt-0.5 w-4 h-4 rounded border-black text-blue-600 focus:ring-blue-600 shrink-0"
                    />
                    <div className="space-y-1">
                      <p className="text-xs font-black text-black">
                        Terms & Conditions, Insurance & Health & Safety Declaration *
                      </p>
                      <p className="text-xs font-medium text-black leading-relaxed">
                        {TRADER_COMPLIANCE_DECLARATION_SUMMARY}
                      </p>
                      <p className="text-[11px] font-bold text-black flex items-center gap-1 pt-0.5">
                        <Clock className="w-3.5 h-3.5 text-blue-700 shrink-0" />
                        <span>
                          Profiles with no documents uploaded within {gracePeriodDays} days may have quoting restricted until paperwork is provided.
                        </span>
                      </p>
                    </div>
                  </label>

                  <div className="pl-7">
                    <button
                      type="button"
                      onClick={() => setShowTermsModal(true)}
                      className="text-xs font-black text-blue-800 underline hover:text-blue-950 cursor-pointer"
                    >
                      Read Full AnyTrader Terms & Conditions
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-black bg-slate-50 flex flex-wrap items-center justify-between gap-2.5">
            {step === 1 ? (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl bg-white border border-black text-xs font-bold text-black hover:bg-slate-100 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleNextStep}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-black text-xs font-black cursor-pointer"
                >
                  <span>Continue to Paperwork & Terms</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg(null);
                    setStep(1);
                  }}
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white border border-black text-xs font-bold text-black hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Back</span>
                </button>

                <div className="flex flex-wrap items-center gap-2">
                  {verificationDocs.length === 0 && (
                    <button
                      type="button"
                      onClick={() => handleSubmitUpgrade(true)}
                      disabled={isSubmitting || Boolean(uploadingCert) || !acceptedCompliance}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-black text-xs font-black disabled:opacity-50 cursor-pointer"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Activating...</span>
                        </>
                      ) : certInfo.hasRegulatedCategory ? (
                        <span>Activate Profile (Upload Certs Later)</span>
                      ) : (
                        <span>Activate Tradesperson Profile</span>
                      )}
                    </button>
                  )}

                  {verificationDocs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleSubmitUpgrade(false)}
                      disabled={isSubmitting || Boolean(uploadingCert) || !acceptedCompliance}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white border border-black text-xs font-black disabled:opacity-50 cursor-pointer"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Activating...</span>
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="w-4 h-4" />
                          <span>
                            Submit {verificationDocs.length} Doc{verificationDocs.length === 1 ? "" : "s"} & Activate
                          </span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <TermsModal isOpen={showTermsModal} onClose={() => setShowTermsModal(false)} />
    </>
  );
}
