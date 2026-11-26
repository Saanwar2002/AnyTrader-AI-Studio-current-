import React, { useState, useEffect, useMemo } from "react";
import { useAuth } from "./AuthProvider";
import { useSearchParams } from "react-router-dom";
import { db, doc, setDoc, serverTimestamp, handleFirestoreError, OperationType, collection, query, where, getDocs, updateDoc, onSnapshot, auth, logout, increment, storage, ref, uploadBytes, getDownloadURL } from "@/src/firebase";
import { RecaptchaVerifier, linkWithPhoneNumber, PhoneAuthProvider } from "firebase/auth";
import { motion } from "motion/react";
import { User, Briefcase, Loader2, MapPin, Shield, CheckCircle2, ChevronRight, ChevronLeft, Upload, AlertCircle, Info, PoundSterling, Award, Gift, Home, Building2, Star, CarFront, Check, LogOut, Search, X, Wrench } from "lucide-react";
import { cn } from "@/src/lib/utils";
import { toast } from "sonner";
import { useCategories } from "../lib/CategoryProvider";
import { lookupPostcode } from "@/src/services/postcodeService";
import { generateMemberId } from "@/src/services/memberIdService";
import { BLOCKED_DOMAINS, CONSULTANCY_CATEGORIES } from "@/src/constants";
import { shortlistTradeCategories } from "@/src/lib/tradeCategoryShortlist";
import { isServiceProviderProfile } from "@/src/lib/accountRoles";
import { tokenize, tokenMatches } from "@/src/lib/fuzzyMatch";
import { getOnboardingStepProgress, getPreviousOnboardingStep } from "@/src/lib/onboardingSteps";
import {
  DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS,
  DEFAULT_PROVISIONAL_MAX_QUOTES,
  TRADER_COMPLIANCE_DECLARATION_SUMMARY,
} from "@/src/lib/traderCompliance";
import { CURRENT_TERMS_VERSION } from "@/src/constants/termsAndPrivacy";
import { TermsModal } from "./TermsModal";

const PROPERTY_BUSINESS_CATEGORIES = [
  { id: "private_landlord", name: "Private Landlord", icon: "🏠", description: "Manage 1–5 residential rental properties" },
  { id: "portfolio_landlord", name: "Portfolio Landlord", icon: "🏘️", description: "Multi-property residential & HMO portfolios" },
  { id: "letting_estate_agency", name: "Letting & Estate Agency", icon: "🔑", description: "Managed tenancies, maintenance & compliance" },
  { id: "block_property_management", name: "Block & Property Management", icon: "🏢", description: "Leasehold blocks, estates & communal repairs" },
  { id: "housing_association_council", name: "Housing Association / Local Council", icon: "🏛️", description: "Social housing stock, SLAs & Awaab's Law compliance" },
  { id: "commercial_asset_manager", name: "Commercial Property & Asset Manager", icon: "🏗️", description: "Offices, retail units, warehouses & facilities" },
  { id: "property_developer", name: "Property Developer & Investor", icon: "📐", description: "Refurbishments, flips & new-build projects" },
] as const;

export default function Onboarding() {
  const { user } = useAuth();
  const { categories } = useCategories();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(1);
  const [role, setRole] = useState<"homeowner" | "tradesperson" | "business" | "admin" | "fleet_driver" | null>(null);
  const [businessLayer, setBusinessLayer] = useState<"properties" | "field_services" | "consultancy" | null>(null);
  const [homeownerType, setHomeownerType] = useState<"homeowner" | "business" | null>(null); // Keep temporarily to not break types
  const [businessCategory, setBusinessCategory] = useState<string | null>(null);
  const [categorySearch, setCategorySearch] = useState("");
  const [tradeSearch, setTradeSearch] = useState("");
  const [vehicleCategories, setVehicleCategories] = useState<string[]>(['standard']);
  const [isPetFriendly, setIsPetFriendly] = useState<boolean>(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [invitationId, setInvitationId] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [name, setName] = useState(user?.displayName || "");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [selectedTrades, setSelectedTrades] = useState<string[]>([]);
  const [selectedSubcategories, setSelectedSubcategories] = useState<string[]>([]);
  const [verificationDocs, setVerificationDocs] = useState<Array<{
    type: string;
    fileUrl: string;
    fileName?: string;
    storagePath?: string;
    uploadedAt?: string;
  }>>([]);
  const [uploadingCert, setUploadingCert] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingInvite, setCheckingInvite] = useState(true);
  const [hasAdminClaim, setHasAdminClaim] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platformConfig, setPlatformConfig] = useState<any>(null);

  const [confirmationResult, setConfirmationResult] = useState<any>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [bypassPhoneAuth, setBypassPhoneAuth] = useState(false);
  const [acceptedComplianceDeclaration, setAcceptedComplianceDeclaration] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "platform_config", "global"), (doc) => {
      if (doc.exists()) {
        setPlatformConfig(doc.data());
      }
    });
    return () => unsub();
  }, []);

  const relevantCategories =
    role === "business" && businessLayer === "consultancy" ? CONSULTANCY_CATEGORIES : categories;

  const shortlistedTradeResults = useMemo(() => {
    return shortlistTradeCategories(relevantCategories as any[], tradeSearch);
  }, [relevantCategories, tradeSearch]);

  const queryTokensForHighlight = useMemo(() => tokenize(tradeSearch), [tradeSearch]);

  const requiredCerts = relevantCategories
    .filter((t: any) => selectedTrades.includes(t.name))
    .flatMap((t: any) => {
      const certs = [...(t.requiredCertifications || [])];
      if (t.subcategoryCertifications) {
        t.subcategories?.forEach((sub: string) => {
          if (selectedSubcategories.includes(sub) && t.subcategoryCertifications[sub]) {
            certs.push(...t.subcategoryCertifications[sub]);
          }
        });
      }
      return certs;
    });

  const uniqueRequiredCerts = Array.from(new Set([
    ...requiredCerts,
    ...(role === "fleet_driver" ? ["Driver License", "Private Hire Vehicle (PHV) Licence", "MOT / Vehicle Insurance"] : [])
  ]));

  const stepProgress = useMemo(
    () =>
      getOnboardingStepProgress({
        step,
        role,
        businessLayer,
        requiresVerification: uniqueRequiredCerts.length > 0,
      }),
    [step, role, businessLayer, uniqueRequiredCerts.length]
  );

  useEffect(() => {
    const checkInvitation = async () => {
      if (!user) {
        setCheckingInvite(false);
        return;
      }

      // Check for admin authority via Firebase custom claims
      try {
        const tokenResult = await user.getIdTokenResult();
        const isAdmin = tokenResult.claims.admin === true || tokenResult.claims.isAdmin === true;
        if (isAdmin) {
          setHasAdminClaim(true);
          setRole("admin");
          setCheckingInvite(false);
          return;
        }
      } catch (claimErr) {
        console.warn("Could not check admin custom claims:", claimErr);
      }

      if (!user.email) {
        setCheckingInvite(false);
        return;
      }

      const urlInviteId = searchParams.get("id");
      const urlInviteToken = searchParams.get("token");
      if (urlInviteId && urlInviteToken) {
        try {
          const authToken = await user.getIdToken();
          const acceptRes = await fetch(`/api/admin/invitations/${encodeURIComponent(urlInviteId)}/accept`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ token: urlInviteToken }),
          });
          if (acceptRes.ok) {
            const accepted = await acceptRes.json();
            await user.getIdToken(true);
            setHasAdminClaim(true);
            setRole("admin");
            setPermissions(accepted.permissions || []);
            setInvitationId(urlInviteId);
            setInviteToken(urlInviteToken);
            setCheckingInvite(false);
            return;
          } else {
            const errJson = await acceptRes.json().catch(() => ({} as any));
            setError(errJson?.error || "Staff invitation link could not be verified or has expired.");
          }
        } catch (tokenErr: any) {
          console.warn("[Onboarding] Invitation token acceptance error:", tokenErr?.message || tokenErr);
        }
      }

      try {
        const userEmail = (user.email || "").toLowerCase();
        const q = query(
          collection(db, "invitations"),
          where("email", "==", userEmail),
          where("status", "==", "pending")
        );
        const snapshot = await getDocs(q);
        const nowMs = Date.now();
        const activeDoc = snapshot.docs.find((d) => {
          const data = d.data();
          return !data.expiresAt || Date.parse(data.expiresAt) > nowMs;
        });

        if (activeDoc) {
          const invite = activeDoc.data();
          setHasAdminClaim(true);
          setRole("admin");
          setPermissions(invite.permissions || []);
          setInvitationId(activeDoc.id);
        }
      } catch (err: any) {
        // Non-blocking: absence of invitation permissions or pending records should proceed smoothly
        if (err?.code === "permission-denied" || err?.message?.includes("Missing or insufficient permissions")) {
          console.log("[Onboarding] No active admin invitation found for user email.");
        } else {
          console.warn("[Onboarding] Note checking invitation:", err?.message || err);
        }
      } finally {
        setCheckingInvite(false);
      }
    };

    checkInvitation();
  }, [user, searchParams]);

  const handleCertificationUpload = async (cert: string, file: File) => {
    if (!user) {
      setError("Please sign in before uploading verification documents.");
      return;
    }

    const maxBytes = 10 * 1024 * 1024; // 10 MB
    const isAllowedType = file.type === "application/pdf" || file.type.startsWith("image/");
    if (!isAllowedType) {
      const msg = "Please upload a PDF or image file (JPG, PNG, WebP).";
      setError(msg);
      toast.error(msg);
      return;
    }
    if (file.size > maxBytes) {
      const msg = "Document file must be 10 MB or smaller.";
      setError(msg);
      toast.error(msg);
      return;
    }

    setUploadingCert(cert);
    setError(null);
    try {
      const safeType = cert.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "certificate";
      const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "document";
      const storagePath = `verifications/${user.uid}/onboarding/${safeType}_${Date.now()}_${safeFileName}`;
      const storageRef = ref(storage, storagePath);
      const snapshot = await uploadBytes(storageRef, file, {
        contentType: file.type || "application/octet-stream",
      });
      const downloadUrl = await getDownloadURL(snapshot.ref);
      const uploadedAt = new Date().toISOString();

      setVerificationDocs((prev) => [
        ...prev.filter((d) => d.type !== cert),
        {
          type: cert,
          fileUrl: downloadUrl,
          fileName: file.name,
          storagePath,
          uploadedAt,
        },
      ]);
      toast.success(`${cert} uploaded securely.`);
    } catch (uploadErr: any) {
      console.error("[Onboarding] Certification upload failed:", uploadErr);
      const msg = "Could not upload document to secure storage. Please check your connection and try again.";
      setError(msg);
      toast.error(msg);
    } finally {
      setUploadingCert(null);
    }
  };

  const handleSubmit = async (submitOptions?: { skipVerificationDocs?: boolean; overrideTier?: string }) => {
    console.log("handleSubmit called. State:", { user: !!user, role, name, postcode, phone });
    const effectiveDocs = submitOptions?.skipVerificationDocs ? [] : verificationDocs;
    const effectiveTier = submitOptions?.overrideTier || selectedTier;
    // Administrators can skip providing phone/postcode initially if needed,
    // but the db still requires name to exist for users.
    if (!user || !role || (role !== 'admin' && (!name || !postcode || (!user?.isAnonymous && !phone)))) {
      console.log("handleSubmit returning early: Missing required fields");
      setError("Please complete your Name, Postcode, and UK Mobile Number in Step 1 to finish setup.");
      setLoading(false);
      setStep(1);
      return;
    }

    const cleanPhone = phone ? phone.replace(/\s/g, "") : "";
    
    let isAuthorizedAdmin = false;
    // Prevent unauthorized role elevation to admin: strictly require server-minted custom claims
    if (role === 'admin') {
      const tokenResult = await user.getIdTokenResult().catch(() => null);
      isAuthorizedAdmin = tokenResult?.claims.admin === true || tokenResult?.claims.isAdmin === true;
      if (!isAuthorizedAdmin) {
        setError("Unauthorized role selected. Administrative onboarding requires verified custom claims.");
        setRole("homeowner");
        setLoading(false);
        return;
      }
    }

    if (role !== 'admin') {
      // 1. Block Temporary Emails
      const emailDomain = user.email?.split("@")[1]?.toLowerCase();
      if (emailDomain && BLOCKED_DOMAINS.includes(emailDomain)) {
        setError("Sorry, we do not accept registrations from this email provider. Please use a standard email address.");
        setLoading(false);
        return;
      }

      // 2. Phone Number Validation (Basic UK format check)
      if (!user?.isAnonymous && !/^(\+44|0)7\d{9}$/.test(cleanPhone)) {
        setError("Please enter a valid UK mobile number (e.g., 07123 456789).");
        setLoading(false);
        setStep(1);
        return;
      }

      // 3. Postcode Restriction Check (runs unconditionally; duplicate checks are server-side in /api/account/bootstrap-profile)
      if (platformConfig?.onboardingRestrictionsEnabled) {
        const allowedPostcodes = platformConfig.allowedPostcodes || [];
        const userClean = postcode.toUpperCase().replace(/\s/g, "");
        
        const isAllowed = allowedPostcodes.some((p: string) => {
          const allowed = p.toUpperCase().replace(/\s/g, "");
          
          // Area Level: If allowed is just letters (e.g. "B", "HD"), match any postcode starting with it
          if (/^[A-Z]+$/.test(allowed)) {
            return userClean.startsWith(allowed);
          }
          
          // District Level: Match the outward code exactly (e.g. "B1" matches "B1 1AA" but not "B10 1AA")
          const userOutward = userClean.length > 3 ? userClean.slice(0, -3) : userClean;
          return userOutward === allowed || userClean === allowed;
        });
        
        if (!isAllowed) {
          setError("Sorry, we are not currently accepting registrations in your area. Please check back later.");
          setLoading(false);
          return;
        }
      }
    }

    setLoading(true);
    setError(null);

    const isBusiness = role === "business" || role === "tradesperson";

    // Temporarily disabled for development testing
    if (!user) return;

    if (false && isBusiness && !confirmationResult && !user?.phoneNumber && !bypassPhoneAuth) {
      try {
        if (!(window as any).recaptchaVerifier) {
          (window as any).recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", {
            size: "invisible",
          });
        }
        
        const fullPhone = cleanPhone.startsWith("0") ? "+44" + cleanPhone.slice(1) : cleanPhone;
        
        // Ensure to clear old verifier if it exists to prevent 'already rendered' errors
        if ((window as any).recaptchaVerifier) {
          try {
            (window as any).recaptchaVerifier.clear();
          } catch (e) {
            console.warn("Error clearing old recaptcha verifier:", e);
          }
          (window as any).recaptchaVerifier = null;
        }

        (window as any).recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", {
          size: "invisible",
        });
        
        const appVerifier = (window as any).recaptchaVerifier;
        
        const confirmation = await linkWithPhoneNumber(user!, fullPhone, appVerifier);
        setConfirmationResult(confirmation);
        setStep(4);
        setPhoneError("");
        setLoading(false);
        return;
      } catch (err: any) {
        console.error("Phone auth error:", err);
        if (err.code === "auth/credential-already-in-use") {
          setError("This phone number is already linked to another account. Please use a different number.");
        } else if (err.code === "auth/operation-not-allowed" || err.code === "auth/billing-not-enabled") {
          console.error("Phone Auth is disabled or billing is missing in Firebase Console.");
          const phoneConfigMsg = "SMS verification is currently unavailable. Please contact support or try again shortly.";
          setError(phoneConfigMsg);
          toast.error(phoneConfigMsg);
        } else {
          const fallbackMsg = err.message || "Failed to send verification SMS.";
          setError(fallbackMsg);
          toast.error(fallbackMsg);
        }
        if ((window as any).recaptchaVerifier) {
          (window as any).recaptchaVerifier.clear();
          (window as any).recaptchaVerifier = null;
        }
        setLoading(false);
        return;
      }
    }

    try {
      const finalRole = isAuthorizedAdmin && role === "admin" ? "admin" : role;
      const finalName = finalRole === "admin" && !name ? "System Admin" : name;
      const finalPhone = finalRole === "admin" && !phone ? "N/A" : cleanPhone;
      
      const finalPermissions = finalRole === "admin" ? ["manage_users", "manage_jobs", "manage_disputes", "view_logs", "manage_team"] : permissions;

      // AT-REF-02: Capture raw referral/affiliate code only; authoritative lookup & verification
      // runs server-side inside POST /api/account/bootstrap-profile (never query users from client).
      const referrerUid: string | null = null;
      const appliedAffiliateCode: string | null = null;
      let rawReferralCode: string | null = searchParams.get("ref")?.trim() || null;

      if (!rawReferralCode) {
        const storedRef = localStorage.getItem("anytrader_referral");
        if (storedRef) {
          try {
            const parsed = JSON.parse(storedRef);
            if (parsed.expiresAt > Date.now() && typeof parsed.code === "string" && parsed.code.trim()) {
              rawReferralCode = parsed.code.trim();
            } else {
              localStorage.removeItem("anytrader_referral");
            }
          } catch (e) {
            console.error(e);
          }
        }
      }

      // IP address is captured authoritatively server-side inside /api/account/bootstrap-profile
      const deviceId = btoa(
        `${navigator.userAgent}|${navigator.language}|${screen.width}x${screen.height}`
      ).slice(0, 256);

      // Generate Member ID (validated and persisted server-side)
      const { memberId, memberSequence } = await generateMemberId(isBusiness ? "business" : "homeowner");

      // Fraud/duplicate checks run authoritatively server-side inside /api/account/bootstrap-profile
      const accountFlags: string[] = [];

      // Derive canonical identity model fields
      const effectiveRole = (finalRole || role || "homeowner") as string;
      const canonicalAccountType = (isAuthorizedAdmin && effectiveRole === "admin")
        ? "admin"
        : (effectiveRole === "business" ? "business" : (effectiveRole === "fleet_driver" ? "driver" : (effectiveRole === "tradesperson" ? "service_provider" : "consumer")));

      const canonicalCapabilities = (isAuthorizedAdmin && effectiveRole === "admin")
        ? ["homeowner", "landlord", "estate_agent", "property_manager", "tradesperson", "contractor", "consultant", "fleet_driver"]
        : (effectiveRole === "business"
            ? ((businessLayer as string) === "field_services" || (businessLayer as string) === "trades"
                ? ["contractor", "tradesperson", "homeowner"]
                : businessLayer === "properties"
                ? ["homeowner", "landlord", "property_manager", "estate_agent"]
                : businessLayer === "consultancy"
                ? ["homeowner", "consultant"]
                : ["homeowner"])
            : (effectiveRole === "fleet_driver" ? ["fleet_driver", "homeowner"] : (effectiveRole === "tradesperson" ? ["tradesperson", "homeowner"] : ["homeowner"])));

      const isPropertyOnlyBusiness = effectiveRole === "business" && businessLayer === "properties";
      const profileTrades = isPropertyOnlyBusiness
        ? []
        : selectedTrades.length > 0
        ? selectedTrades
        : (businessCategory ? [businessCategory] : []);

      const profile = {
        uid: user.uid,
        email: user.email,
        isAnonymous: user.isAnonymous,
        name: finalName,
        phone: finalPhone,
        // Canonical Identity Model
        accountType: canonicalAccountType,
        capabilities: canonicalCapabilities,
        activeContext: {
          portal: finalRole === "fleet_driver" ? "anyroller" : "anytrader",
          role: finalRole,
        },
        // Legacy Compatibility Fields
        role: finalRole,
        businessLayer: role === "business" ? businessLayer : null,
        tierId: effectiveTier || (
          role === "homeowner"
            ? (homeownerType === "business" ? "Business Professional" : "Standard Homeowner")
            : isPropertyOnlyBusiness
            ? "Business Professional"
            : (platformConfig?.feeTiers?.[0]?.name || "Free Explorer")
        ),
        subscriptionType: role === "business" ? "business" : null,
        businessCategory: role === "business" ? businessCategory : null,
        category: isPropertyOnlyBusiness
          ? (businessCategory || "Property & Asset Management")
          : (businessCategory || selectedTrades[0] || (role === "homeowner" ? "" : "General Trades")),
        primaryTrade: isPropertyOnlyBusiness
          ? ""
          : (selectedTrades[0] || businessCategory || (role === "homeowner" ? "" : "General Trades")),
        permissions: finalPermissions,
        deviceId,
        accountFlags,
        memberId,
        memberSequence,
        fairnessScore: 100, // Starting score
        joinedDuringBeta: true,
        phantomFeesSaved: 0,
        postcode: finalRole === "admin" && !postcode ? "N/A" : postcode.toUpperCase().replace(/\s/g, ""),
        city,
        county,
        trades: profileTrades,
        subcategories: isPropertyOnlyBusiness ? [] : selectedSubcategories,
        vehicleCategories: finalRole === "fleet_driver" ? vehicleCategories : null,
        isPetFriendly: finalRole === "fleet_driver" ? isPetFriendly : false,
        referralCode: user.uid.slice(0, 8).toUpperCase(), // Generate a simple referral code
        referredBy: referrerUid,
        affiliateId: appliedAffiliateCode,
        verificationStatus: effectiveDocs.length > 0 ? "pending" : "unverified",
        verificationDocs: effectiveDocs.map(d => ({
          type: d.type,
          status: "pending",
          fileUrl: d.fileUrl,
          ...(d.fileName ? { fileName: d.fileName } : {}),
          ...(d.storagePath ? { storagePath: d.storagePath } : {}),
          uploadedAt: d.uploadedAt || new Date().toISOString(),
          createdAt: d.uploadedAt || new Date().toISOString(),
        })),
        createdAt: serverTimestamp(),
      };
      console.log("Saving profile via /api/account/bootstrap-profile, user.uid:", user.uid);
      let profileSavedServerSide = false;

      try {
        const token = await user.getIdToken();
        const response = await fetch("/api/account/bootstrap-profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            role: finalRole,
            name: finalName,
            phone: finalPhone || undefined,
            postcode: postcode ? postcode.toUpperCase().replace(/\s/g, "") : undefined,
            city: city || undefined,
            county: county || undefined,
            trades: profileTrades,
            subcategories: isPropertyOnlyBusiness ? [] : selectedSubcategories,
            businessLayer: role === "business" ? businessLayer : null,
            businessCategory: role === "business" ? businessCategory : null,
            vehicleCategories: finalRole === "fleet_driver" ? vehicleCategories : null,
            isPetFriendly: finalRole === "fleet_driver" ? isPetFriendly : false,
            verificationDocs: effectiveDocs.map((d) => ({
              type: d.type,
              fileUrl: d.fileUrl,
              ...(d.fileName ? { fileName: d.fileName } : {}),
              ...(d.storagePath ? { storagePath: d.storagePath } : {}),
              ...(d.uploadedAt ? { uploadedAt: d.uploadedAt } : {}),
            })),
            referralCode: rawReferralCode || null,
            referrerUid: null,
            affiliateCode: appliedAffiliateCode || null,
            memberId: memberId || undefined,
            memberSequence: typeof memberSequence === "number" ? memberSequence : undefined,
            deviceId: deviceId || undefined,
            ...(finalRole === "tradesperson" || (finalRole === "business" && businessLayer === "field_services")
              ? {
                  acceptedComplianceDeclaration,
                  termsVersion: CURRENT_TERMS_VERSION,
                }
              : {}),
          }),
        });

        if (response.ok) {
          const resData = await response.json().catch(() => ({}));
          if (resData.fallbackToClient) {
            console.log("[Onboarding] Server requested client-side persistence fallback.");
            profileSavedServerSide = false;
          } else {
            profileSavedServerSide = true;
            console.log("bootstrap-profile server success");
          }
        } else {
          const errorData = await response.json().catch(() => ({}));
          if (
            response.status === 503 ||
            response.status === 500 ||
            errorData.fallbackToClient ||
            errorData.code === "FIRESTORE_ACCESS_RESTRICTED"
          ) {
            console.warn("[Onboarding] Server persistence restricted; proceeding with client-side Firestore submission:", errorData);
            profileSavedServerSide = false;
          } else {
            throw new Error(errorData.error || "Failed to create user profile");
          }
        }
      } catch (reqErr: any) {
        if (reqErr.message && reqErr.message.includes("Failed to create user profile")) {
          throw reqErr;
        }
        console.warn("[Onboarding] Server API call encountered error; falling back to direct client profile creation:", reqErr);
        profileSavedServerSide = false;
      }

      if (!profileSavedServerSide) {
        console.log("[Onboarding] Writing allowlisted user profile doc directly via Firebase Client SDK, uid:", user.uid);
        const normalizedRole = String(finalRole || "");
        const safeClientRole =
          normalizedRole === "business" || normalizedRole === "tradesperson" || normalizedRole === "fleet_driver"
            ? normalizedRole
            : "homeowner";
        const clientFallbackProfile = {
          id: user.uid,
          uid: user.uid,
          email: user.email || "",
          isAnonymous: Boolean(user.isAnonymous),
          name: profile.name,
          displayName: profile.name,
          phone: profile.phone,
          role: safeClientRole,
          businessLayer: profile.businessLayer,
          businessCategory: profile.businessCategory,
          category: profile.category,
          primaryTrade: profile.primaryTrade,
          postcode: profile.postcode,
          city: profile.city,
          county: profile.county,
          trades: profile.trades,
          subcategories: profile.subcategories,
          vehicleCategories: profile.vehicleCategories,
          isPetFriendly: profile.isPetFriendly,
          referralCode: profile.referralCode,
          verificationDocs: profile.verificationDocs,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        await setDoc(doc(db, "users", user.uid), clientFallbackProfile, { merge: true });
      }

      // Sync non-PII public profile from client ONLY when server bootstrap fell back to client
      // and strictly for verified-eligible trade execution profiles (matching firestore.rules allowlist).
      if (!profileSavedServerSide && canonicalCapabilities.includes("tradesperson") && isServiceProviderProfile(profile)) {
        try {
          await setDoc(doc(db, "public_profiles", user.uid), {
            id: user.uid,
            uid: user.uid,
            name: profile.name,
            displayName: profile.name,
            role: profile.role,
            primaryTrade: profile.primaryTrade || "",
            trades: profile.trades || [],
            category: profile.category || "",
            categories: profile.trades || [],
            subcategories: profile.subcategories || [],
            city: profile.city || "",
            rating: 0,
            trustScore: 0,
            totalReviews: 0,
            verifiedTrader: false,
            isVerified: false,
            videoVerified: false,
            verificationStatus: "unverified",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }, { merge: true });
        } catch (pubErr) {
          console.warn("Public profile creation skipped:", pubErr);
        }
      }
      
      // Uploaded verification documents enter the authoritative Admin Verification Queue as "pending"

      if (invitationId && inviteToken) {
        try {
          const idToken = await user.getIdToken();
          await fetch(`/api/admin/invitations/${encodeURIComponent(invitationId)}/accept`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ token: inviteToken }),
          });
        } catch (invErr) {
          console.warn("Server invitation acceptance check failed:", invErr);
        }
      }

      // Affiliate usage attribution is incremented atomically server-side inside /api/account/bootstrap-profile

      console.log("Profile saved successfully.");
      // No need to reload, AuthProvider is listening to onSnapshot
    } catch (err) {
      console.error("Error creating profile:", err);
      try {
        console.log("Attempting to handle Firestore error...");
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
      } catch (e: any) {
        console.log("Firestore error handled, setting error state:", e.message);
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  if (checkingInvite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col relative overflow-y-auto pb-64">
      {/* Header Section with Background */}
      <div className="relative h-[40vh] min-h-[320px] bg-[#1e3a5f] flex flex-col items-center justify-center p-8 text-center overflow-hidden">
        {/* Background Image Overlay */}
        <div 
          className="absolute inset-0 opacity-20 mix-blend-overlay pointer-events-none"
          style={{ 
            backgroundImage: 'url("https://images.unsplash.com/photo-1513584684374-8bdb7489feef?q=80&w=2070&auto=format&fit=crop")',
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#1e3a5f]/50 to-[#1e3a5f]" />
        
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-10 space-y-4 max-w-2xl"
        >
          <div className="flex justify-center mb-2">
            <div className="w-14 h-14 bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center border border-black/20">
              <Shield className="w-7 h-7 text-white" />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-orange-500 font-black uppercase tracking-[0.3em] text-[10px]">Welcome to AnyTrader</p>
            <h1 className="text-4xl md:text-5xl font-display font-black text-white tracking-tight leading-tight">
              Find trusted tradespeople.<br />Get fair quotes.
            </h1>
          </div>
          <p className="text-blue-100/80 font-medium text-lg max-w-md mx-auto">
            Connect with verified local tradespeople across the UK.
          </p>
          {role === "admin" && (
            <button
               onClick={() => handleSubmit()}
               className="mt-4 bg-red-600 text-white font-bold py-2 px-6 rounded-xl text-sm hover:bg-red-700 transition-colors shadow-lg"
            >
              Skip Setup (Enter Admin)
            </button>
          )}
        </motion.div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex items-start justify-center -mt-16 sm:-mt-20 px-4 pb-12 relative z-20">
        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-lg w-full bg-white pt-8 sm:pt-10 px-5 sm:px-8 pb-8 rounded-[2rem] sm:rounded-[2.5rem] shadow-xl border border-black/10 space-y-6 relative"
        >
          {step === 1 && (
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-2 border-b border-black/5">
                <button 
                  type="button"
                  onClick={() => logout()}
                  className="flex items-center gap-2 text-xs font-bold text-slate-500 hover:text-slate-900 p-2 rounded-xl bg-slate-50 hover:bg-slate-100 transition-all border border-black/10"
                  title="Sign out or switch account"
                >
                  <LogOut className="w-3.5 h-3.5 text-slate-500" />
                  <span>Switch Account</span>
                </button>
                <span className="text-[11px] font-black uppercase tracking-wider text-black bg-slate-100 border border-black/20 px-2.5 py-1 rounded-lg">
                  {stepProgress.label}
                </span>
              </div>

              <div className="space-y-3">
                <div>
                  <h2 className="text-xl sm:text-2xl font-black text-black tracking-tight">Select your role</h2>
                  <p className="text-xs text-slate-600 font-medium">Choose how you plan to use AnyTrader & TradeOS</p>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setRole("homeowner");
                      setBusinessLayer(null);
                      setBusinessCategory(null);
                      setSelectedTier(null);
                    }}
                    className={cn(
                      "w-full p-3.5 rounded-2xl border text-left transition-all duration-200 flex items-center gap-3 relative group cursor-pointer",
                      role === "homeowner" 
                        ? "border-2 border-orange-500 bg-orange-50/40 shadow-sm" 
                        : "border-black bg-white hover:bg-slate-50"
                    )}
                  >
                    <div className={cn(
                      "w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors",
                      role === "homeowner" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600 group-hover:bg-slate-200"
                    )}>
                      <Home className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-black text-sm text-black block leading-tight">Homeowner / Customer</span>
                      <span className="text-[11px] text-slate-600 block leading-tight mt-0.5">Post jobs, hire trades & book rides</span>
                    </div>
                    <div className={cn(
                      "w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-all",
                      role === "homeowner" ? "border-orange-500 bg-orange-500" : "border-slate-300"
                    )}>
                      {role === "homeowner" && <Check className="w-3 h-3 text-white stroke-[3]" />}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setRole("tradesperson");
                      setBusinessLayer(null);
                      setBusinessCategory(null);
                      setSelectedTier(null);
                    }}
                    className={cn(
                      "w-full p-3.5 rounded-2xl border text-left transition-all duration-200 flex items-center gap-3 relative group cursor-pointer",
                      role === "tradesperson"
                        ? "border-2 border-orange-500 bg-orange-50/40 shadow-sm"
                        : "border-black bg-white hover:bg-slate-50"
                    )}
                  >
                    <div className={cn(
                      "w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors",
                      role === "tradesperson" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600 group-hover:bg-slate-200"
                    )}>
                      <Wrench className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-black text-sm text-black block leading-tight">Tradesperson</span>
                      <span className="text-[11px] text-slate-600 block leading-tight mt-0.5">Solo trader & side-hustle — quote jobs & TradeOS</span>
                    </div>
                    <div className={cn(
                      "w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-all",
                      role === "tradesperson" ? "border-orange-500 bg-orange-500" : "border-slate-300"
                    )}>
                      {role === "tradesperson" && <Check className="w-3 h-3 text-white stroke-[3]" />}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setRole("fleet_driver");
                      setBusinessLayer(null);
                      setBusinessCategory(null);
                      setSelectedTier(null);
                    }}
                    className={cn(
                      "w-full p-3.5 rounded-2xl border text-left transition-all duration-200 flex items-center gap-3 relative group cursor-pointer",
                      role === "fleet_driver"
                        ? "border-2 border-orange-500 bg-orange-50/40 shadow-sm"
                        : "border-black bg-white hover:bg-slate-50"
                    )}
                  >
                    <div className={cn(
                      "w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors",
                      role === "fleet_driver" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600 group-hover:bg-slate-200"
                    )}>
                      <CarFront className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-black text-sm text-black block leading-tight">Driver</span>
                      <span className="text-[11px] text-slate-600 block leading-tight mt-0.5">AnyRoller rides & deliveries</span>
                    </div>
                    <div className={cn(
                      "w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-all",
                      role === "fleet_driver" ? "border-orange-500 bg-orange-500" : "border-slate-300"
                    )}>
                      {role === "fleet_driver" && <Check className="w-3 h-3 text-white stroke-[3]" />}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setRole("business");
                      setBusinessLayer(null);
                      setBusinessCategory(null);
                      setSelectedTier(null);
                    }}
                    className={cn(
                      "w-full p-3.5 rounded-2xl border text-left transition-all duration-200 flex items-center gap-3 relative group cursor-pointer",
                      role === "business"
                        ? "border-2 border-orange-500 bg-orange-50/40 shadow-sm"
                        : "border-black bg-white hover:bg-slate-50"
                    )}
                  >
                    <div className={cn(
                      "w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors",
                      role === "business" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600 group-hover:bg-slate-200"
                    )}>
                      <Building2 className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-black text-sm text-black block leading-tight">Business</span>
                      <span className="text-[11px] text-slate-600 block leading-tight mt-0.5">Multi-staff firms, landlords & agencies</span>
                    </div>
                    <div className={cn(
                      "w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-all",
                      role === "business" ? "border-orange-500 bg-orange-500" : "border-slate-300"
                    )}>
                      {role === "business" && <Check className="w-3 h-3 text-white stroke-[3]" />}
                    </div>
                  </button>

                  {hasAdminClaim && (
                    <button
                      type="button"
                      onClick={() => {
                        setRole("admin");
                        setBusinessLayer(null);
                        setBusinessCategory(null);
                        setSelectedTier(null);
                      }}
                      className={cn(
                        "w-full p-3.5 rounded-2xl border text-left transition-all duration-200 flex items-center gap-3 relative group cursor-pointer sm:col-span-2",
                        role === "admin"
                          ? "border-2 border-red-500 bg-red-50/40 shadow-sm"
                          : "border-black bg-white hover:bg-slate-50 border-dashed"
                      )}
                    >
                      <div className={cn(
                        "w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors",
                        role === "admin" ? "bg-red-500 text-white" : "bg-red-50 text-red-500 group-hover:bg-red-100"
                      )}>
                        <Shield className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-black text-sm text-black block leading-tight">Master Admin</span>
                        <span className="text-[11px] text-slate-600 block leading-tight mt-0.5">Platform management</span>
                      </div>
                      <div className={cn(
                        "w-5 h-5 rounded-full border flex items-center justify-center shrink-0 transition-all",
                        role === "admin" ? "border-red-500 bg-red-500" : "border-slate-300"
                      )}>
                        {role === "admin" && <Check className="w-3 h-3 text-white stroke-[3]" />}
                      </div>
                    </button>
                  )}
                </div>
              </div>

              {/* Personal Info Fields */}
              {(role === "tradesperson" || role === "business" || role === "fleet_driver" || role === "homeowner") && (
                <motion.div 
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-3.5 pt-4 border-t border-black/10"
                >
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider ml-1">
                      Full Name <span className="text-red-500">*</span>
                    </label>
                    <input 
                      type="text" 
                      required
                      className="w-full p-3.5 rounded-xl border border-black bg-slate-50/60 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 focus:bg-white transition-all font-medium text-slate-900 text-sm"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. John Smith"
                    />
                  </div>
                  
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider ml-1">
                      Mobile Number {!user?.isAnonymous && <span className="text-red-500">*</span>}
                    </label>
                    <input 
                      type="tel" 
                      placeholder="07123 456789"
                      className="w-full p-3.5 rounded-xl border border-black bg-slate-50/60 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 focus:bg-white transition-all font-medium text-slate-900 text-sm"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider ml-1">
                      Postcode <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input 
                        type="text" 
                        required
                        className="w-full p-3.5 pl-10 rounded-xl border border-black bg-slate-50/60 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 focus:bg-white transition-all font-medium text-slate-900 uppercase text-sm"
                        placeholder="e.g. SW1A 1AA"
                        value={postcode}
                        onChange={(e) => setPostcode(e.target.value)}
                        onBlur={async (e) => {
                          const val = e.target.value;
                          if (!val) return;
                          try {
                            const data = await lookupPostcode(val);
                            if (data) {
                              setCity(data.city);
                              setCounty(data.county);
                              setPostcode(data.postcode);
                            }
                          } catch (err) {
                            console.error("Error looking up postcode:", err);
                          }
                        }}
                      />
                    </div>
                    {city && (
                      <div className="mt-1.5 px-3 py-1.5 bg-green-50 rounded-lg border border-green-200/60 flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                        <span className="text-xs text-green-800 font-bold">
                          Verified: {city}{county ? `, ${county}` : ""}
                        </span>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {/* Fleet Driver Setup */}
              {role === "fleet_driver" && (
                <motion.div 
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-3.5 pt-4 border-t border-black/10"
                >
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-wider ml-1">Vehicle Setup</p>
                  
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-700">Which categories do you want to drive for?</label>
                    <p className="text-[11px] text-slate-500 mb-2">You can select multiple categories (e.g. Executive cars also take Standard rides).</p>
                    
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: 'standard', name: 'Standard Car' },
                        { id: 'executive', name: 'Executive' },
                        { id: 'luxury', name: 'Luxury' },
                        { id: '6seater', name: '6-Seater XL' },
                        { id: '8seater', name: '8-Seater Max' },
                        { id: 'wav', name: 'Wheelchair WAV' }
                      ].map(cat => (
                        <label key={cat.id} className={cn("p-2.5 rounded-xl border flex items-center gap-2.5 transition-colors cursor-pointer", vehicleCategories.includes(cat.id) ? "border-orange-500 bg-orange-50/50 text-orange-950 font-bold" : "border-black bg-white hover:bg-slate-50 text-slate-700")}>
                          <input type="checkbox" className="hidden" checked={vehicleCategories.includes(cat.id)} onChange={(e) => {
                            if (e.target.checked) setVehicleCategories(prev => [...prev, cat.id]);
                            else setVehicleCategories(prev => prev.filter(c => c !== cat.id));
                          }} />
                          <div className={cn("w-4 h-4 rounded border flex items-center justify-center shrink-0", vehicleCategories.includes(cat.id) ? "bg-orange-500 border-orange-500" : "border-slate-400 bg-white")}>
                            {vehicleCategories.includes(cat.id) && <Check className="w-3 h-3 text-white stroke-[3]" />}
                          </div>
                          <span className="text-xs font-bold">{cat.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="pt-1">
                    <label className={cn("p-3 rounded-xl border flex items-center justify-between transition-colors cursor-pointer", isPetFriendly ? "border-orange-500 bg-orange-50/50" : "border-black bg-white hover:bg-slate-50")}>
                      <div>
                        <p className="text-xs font-black text-slate-900">Pet Friendly Vehicle</p>
                        <p className="text-[11px] text-slate-500">Allow passengers with pets (+£3 fare bonus)</p>
                      </div>
                      <input type="checkbox" className="hidden" checked={isPetFriendly} onChange={(e) => setIsPetFriendly(e.target.checked)} />
                      <div className={`w-9 h-5 outline-none rounded-full transition-colors relative shadow-inner shrink-0 ${isPetFriendly ? 'bg-orange-500' : 'bg-slate-200'}`}>
                        <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${isPetFriendly ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </div>
                    </label>
                  </div>
                </motion.div>
              )}

              {/* Trust Bar */}
              <div className="grid grid-cols-3 gap-2 py-3 border-y border-black/5 bg-slate-50/50 rounded-xl px-2">
                <div className="flex flex-col items-center text-center gap-0.5">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span className="text-[9px] font-black text-slate-700 uppercase tracking-tight">Verified Trades</span>
                </div>
                <div className="flex flex-col items-center text-center gap-0.5 border-x border-black/10">
                  <Shield className="w-4 h-4 text-blue-600" />
                  <span className="text-[9px] font-black text-slate-700 uppercase tracking-tight">Secure Platform</span>
                </div>
                <div className="flex flex-col items-center text-center gap-0.5">
                  <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                  <span className="text-[9px] font-black text-slate-700 uppercase tracking-tight">Genuine Reviews</span>
                </div>
              </div>

              {error && (
                <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-bold shadow-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* Continue Button & Helper message */}
              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    if (role === "fleet_driver") {
                      setStep(3); // Go straight to driver verification
                      return;
                    }
                    if (role === "tradesperson") {
                      setStep(2); // Go straight to trade category selection
                      return;
                    }
                    if (role === "business") {
                      // Always let business accounts select their business type & categories,
                      // even when Free Beta Mode (paywallEnabled === false) is active.
                      setStep(1.5);
                      return;
                    }
                    handleSubmit();
                  }}
                  disabled={
                    !role || 
                    loading || 
                    (role !== "admin" && (!name || !postcode || (!user?.isAnonymous && !phone))) ||
                    (role === "fleet_driver" && vehicleCategories.length === 0)
                  }
                  className="w-full flex items-center justify-center gap-2.5 bg-orange-500 text-white p-4 rounded-2xl font-black text-base hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/25 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none active:scale-98 group cursor-pointer"
                >
                  {loading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <span>{role === "tradesperson" || role === "business" || role === "fleet_driver" ? "Continue" : "Complete Setup"}</span>
                      <ChevronRight className="w-5 h-5 group-hover:translate-x-0.5 transition-transform" />
                    </>
                  )}
                </button>

                {/* Validation helper when button is disabled */}
                {!role && (
                  <p className="text-[11px] text-center text-slate-400 font-medium">
                    Please select a role above to proceed
                  </p>
                )}
                {role && role !== "admin" && (!name || !postcode || (!user?.isAnonymous && !phone)) && (
                  <p className="text-[11px] text-center text-amber-600 font-medium">
                    {!name ? "Enter your full name" : !postcode ? "Enter your postcode" : "Enter your mobile number"} to continue
                  </p>
                )}
              </div>
            </div>
          )}


          {/* Step 1.5: Business Layer Selection */}
          {step === 1.5 && role === "business" && (
            <div className="space-y-8">
              <div className="flex items-center justify-between pb-2 border-b border-black/10">
                <button
                  type="button"
                  onClick={() => setStep(getPreviousOnboardingStep(1.5, role))}
                  className="flex items-center gap-1.5 text-xs font-black text-black hover:bg-slate-100 px-3 py-2 rounded-xl bg-white transition-all border border-black cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span>Back</span>
                </button>
                <span className="text-[11px] font-black uppercase tracking-wider text-black bg-slate-100 border border-black/20 px-2.5 py-1 rounded-lg">
                  {stepProgress.label}
                </span>
              </div>
              <div className="text-center space-y-2">
                <h1 className="text-3xl font-display font-black text-black tracking-tight">
                  Select Business Type
                </h1>
                <p className="text-slate-600 font-medium text-sm">
                  Choose how you will use the platform.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <button
                  onClick={() => {
                     setBusinessLayer('properties');
                     setStep(2);
                  }}
                  className={cn(
                    "w-full p-5 rounded-3xl border-2 text-left transition-all duration-300 flex items-center gap-4 relative group",
                    businessLayer === "properties" 
                      ? "border-orange-500 bg-orange-50/30 ring-4 ring-orange-500/10" 
                      : "border-black bg-white hover:border-black"
                  )}
                >
                  <div className={cn(
                    "w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 transition-colors",
                    businessLayer === "properties" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-400 group-hover:bg-slate-200"
                  )}>
                    <Building2 className="w-7 h-7" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-black text-lg text-slate-900 block tracking-tight">Property & Asset Management</span>
                    <span className="text-sm text-slate-500 block leading-tight">Landlords, agents, fleet managers</span>
                  </div>
                  <div className={cn(
                    "w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                    businessLayer === "properties" ? "border-orange-500" : "border-black"
                  )}>
                    {businessLayer === 'properties' && <div className="w-3 h-3 rounded-full bg-orange-500" />}
                  </div>
                </button>

                <button
                  onClick={() => {
                     setBusinessLayer('field_services');
                     setStep(2);
                  }}
                  className={cn(
                    "w-full p-5 rounded-3xl border-2 text-left transition-all duration-300 flex items-center gap-4 relative group",
                    businessLayer === "field_services" 
                      ? "border-orange-500 bg-orange-50/30 ring-4 ring-orange-500/10" 
                      : "border-black bg-white hover:border-black"
                  )}
                >
                  <div className={cn(
                    "w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 transition-colors",
                    businessLayer === "field_services" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-400 group-hover:bg-slate-200"
                  )}>
                    <Briefcase className="w-7 h-7" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-black text-lg text-slate-900 block tracking-tight">Trades & Services</span>
                    <span className="text-sm text-slate-500 block leading-tight">Plumbers, electricians, cleaners</span>
                  </div>
                  <div className={cn(
                    "w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                    businessLayer === "field_services" ? "border-orange-500" : "border-black"
                  )}>
                    {businessLayer === 'field_services' && <div className="w-3 h-3 rounded-full bg-orange-500" />}
                  </div>
                </button>

                <button
                  onClick={() => {
                     setBusinessLayer('consultancy');
                     setStep(2);
                  }}
                  className={cn(
                    "w-full p-5 rounded-3xl border-2 text-left transition-all duration-300 flex items-center gap-4 relative group",
                    businessLayer === "consultancy" 
                      ? "border-orange-500 bg-orange-50/30 ring-4 ring-orange-500/10" 
                      : "border-black bg-white hover:border-black"
                  )}
                >
                  <div className={cn(
                    "w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 transition-colors",
                    businessLayer === "consultancy" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-400 group-hover:bg-slate-200"
                  )}>
                    <Award className="w-7 h-7" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-black text-lg text-slate-900 block tracking-tight">Professional & Consultancy</span>
                    <span className="text-sm text-slate-500 block leading-tight">Tutors, accountants, event planners</span>
                  </div>
                  <div className={cn(
                    "w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
                    businessLayer === "consultancy" ? "border-orange-500" : "border-black"
                  )}>
                    {businessLayer === 'consultancy' && <div className="w-3 h-3 rounded-full bg-orange-500" />}
                  </div>
                </button>
              </div>

            </div>
          )}

          {/* Step 2: Tradesperson, Field Services Business, or Consultancy - Select Categories */}
          {step === 2 && (role === "tradesperson" || (role === "business" && (businessLayer === "field_services" || businessLayer === "consultancy"))) && (
            <div className="space-y-6">
              <div className="flex justify-end">
                <span className="text-[11px] font-black uppercase tracking-wider text-black bg-slate-100 border border-black/20 px-2.5 py-1 rounded-lg">
                  {stepProgress.label}
                </span>
              </div>
              <div className="text-center space-y-2">
                <h1 className="text-3xl font-display font-black text-black tracking-tight">
                  {role === "business" && businessLayer === "consultancy" ? "Select Your Professional Categories" : "Select Your Trades"}
                </h1>
                <p className="text-slate-600 font-medium text-sm">
                  Type a few words of your trade to shortlist matching categories — you can select multiple.
                </p>
              </div>

              <div className="bg-primary/5 border border-black p-4 rounded-2xl flex gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Info className="w-5 h-5 text-primary" />
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-black text-black uppercase tracking-tight">Get More Job Offers</p>
                  <p className="text-xs text-black leading-relaxed">
                    Search by trade name, skill, or service (e.g. "boiler leak", "garden fence", "van courier") to shortlist categories, then tap as many as apply.
                  </p>
                </div>
              </div>

              {/* Pinned Multi-Category Selection Bar */}
              {selectedTrades.length > 0 && (
                <div className="p-3.5 bg-slate-50 border border-black rounded-2xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black uppercase tracking-wider text-black">
                      Selected Categories ({selectedTrades.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTrades([]);
                        setSelectedSubcategories([]);
                      }}
                      className="text-[11px] font-bold text-slate-600 hover:text-black underline cursor-pointer"
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTrades.map((tradeName) => (
                      <span
                        key={tradeName}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-black rounded-lg text-xs font-bold text-black shadow-2xs"
                      >
                        <span>{tradeName}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const matchedCat = (relevantCategories as any[]).find((c) => c.name === tradeName);
                            const catSubs = new Set<string>(matchedCat?.subcategories || []);
                            setSelectedTrades((prev) => prev.filter((name) => name !== tradeName));
                            if (catSubs.size > 0) {
                              setSelectedSubcategories((prev) => prev.filter((sub) => !catSubs.has(sub)));
                            }
                          }}
                          className="p-0.5 rounded hover:bg-slate-100 text-black cursor-pointer"
                          aria-label={`Remove ${tradeName}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Smart Multi-Word Search Bar for Shortlisting Trades */}
              <div className="space-y-2.5">
                <div className="relative">
                  <Search className="w-5 h-5 text-slate-500 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={tradeSearch}
                    onChange={(e) => setTradeSearch(e.target.value)}
                    placeholder={
                      role === "business" && businessLayer === "consultancy"
                        ? "Type words to shortlist categories (e.g. tutor, accountant, event planner...)"
                        : "Type words of your trade (e.g. boiler leak, electrical rewire, fence garden, tyres...)"
                    }
                    className="w-full pl-11 pr-10 py-3.5 bg-white border border-black rounded-xl text-black font-medium text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all shadow-sm"
                  />
                  {tradeSearch && (
                    <button
                      type="button"
                      onClick={() => setTradeSearch("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-black hover:bg-slate-100 rounded-full transition-all cursor-pointer"
                      title="Clear search"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between text-xs text-black px-1">
                  <span>
                    {tradeSearch.trim() ? (
                      <>
                        Shortlisted <strong className="font-black">{shortlistedTradeResults.length}</strong> matching {shortlistedTradeResults.length === 1 ? "category" : "categories"}
                      </>
                    ) : (
                      <>
                        <strong className="font-black">{relevantCategories.length}</strong> categories available — type keywords above to shortlist
                      </>
                    )}
                  </span>
                  {selectedTrades.length > 0 && (
                    <span className="bg-primary/10 text-primary font-black px-2.5 py-0.5 rounded-lg border border-black text-[11px]">
                      {selectedTrades.length} selected
                    </span>
                  )}
                </div>
              </div>

              {shortlistedTradeResults.length === 0 ? (
                <div className="p-8 text-center bg-slate-50 border border-black rounded-2xl space-y-3">
                  <p className="text-sm font-bold text-black">
                    No {role === "business" && businessLayer === "consultancy" ? "categories" : "trades"} shortlisted for "{tradeSearch}"
                  </p>
                  <p className="text-xs text-slate-600">
                    Try typing shorter keywords (e.g. "boiler", "roof", "paint", "van") or clear your search to browse all categories.
                  </p>
                  <button
                    type="button"
                    onClick={() => setTradeSearch("")}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-black rounded-xl text-xs font-black text-black hover:bg-slate-100 transition-all shadow-sm cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" /> Clear Search
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 max-h-96 overflow-y-auto pr-2 custom-scrollbar">
                  {shortlistedTradeResults.map(({ category: t, matchedSubcategories, matchedReasons, matchedTokenCount, totalQueryTokens }) => {
                    const isSelected = selectedTrades.includes(t.name);
                    const hasActiveQuery = tradeSearch.trim().length > 0;

                    return (
                      <div key={t.id} className="space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTrades(prev => {
                              if (prev.includes(t.name)) {
                                const catSubs = new Set<string>(t.subcategories || []);
                                if (catSubs.size > 0) {
                                  setSelectedSubcategories((curr) => curr.filter((sub) => !catSubs.has(sub)));
                                }
                                return prev.filter(name => name !== t.name);
                              }
                              return [...prev, t.name];
                            });
                          }}
                          className={cn(
                            "w-full p-4 rounded-2xl border text-left flex items-center justify-between gap-3 transition-all duration-200 group cursor-pointer",
                            isSelected
                              ? "bg-primary/5 border-2 border-primary text-black shadow-md shadow-primary/5"
                              : "bg-white border-black text-black hover:bg-slate-50"
                          )}
                        >
                          <div className="flex items-center gap-3.5 min-w-0">
                            <div className={cn(
                              "w-10 h-10 rounded-xl flex items-center justify-center text-xl transition-colors shrink-0 border border-black/15",
                              isSelected ? "bg-primary text-white" : "bg-slate-50"
                            )}>
                              {t.icon}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-black text-sm tracking-tight text-black block">{t.name}</span>
                                {hasActiveQuery && totalQueryTokens > 1 && matchedTokenCount > 1 && (
                                  <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-black/20">
                                    {matchedTokenCount}/{totalQueryTokens} words matched
                                  </span>
                                )}
                              </div>
                              {hasActiveQuery && !isSelected && (matchedSubcategories.length > 0 || matchedReasons.length > 0) && (
                                <span className="text-[11px] text-slate-600 line-clamp-1 mt-0.5 block">
                                  Matches: {(matchedSubcategories.length > 0 ? matchedSubcategories : matchedReasons).slice(0, 3).join(", ")}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className={cn(
                            "w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 transition-all",
                            isSelected ? "bg-primary border-primary text-white" : "bg-white border-black text-transparent"
                          )}>
                            <Check className="w-3.5 h-3.5 stroke-[3]" />
                          </div>
                        </button>
                        {isSelected && t.subcategories && t.subcategories.length > 0 && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            className="ml-4 p-4 bg-slate-50 border border-black rounded-2xl space-y-3"
                          >
                            <p className="text-xs font-black text-black uppercase tracking-wider">Select Specific Services (Optional):</p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {t.subcategories.map((sub: string, subIdx: number) => {
                                const subTokens = tokenize(sub);
                                const isSubMatched =
                                  hasActiveQuery &&
                                  queryTokensForHighlight.some((qt) => subTokens.some((st) => tokenMatches(qt, st)));
                                return (
                                  <label
                                    key={`${t.id}-${sub}-${subIdx}`}
                                    className={cn(
                                      "flex items-center gap-3 p-2 rounded-xl transition-colors cursor-pointer border group",
                                      isSubMatched
                                        ? "bg-primary/10 border-primary/40 font-semibold"
                                        : "hover:bg-white border-transparent hover:border-black"
                                    )}
                                  >
                                    <div className="relative flex items-center">
                                      <input
                                        type="checkbox"
                                        className="w-5 h-5 rounded-md border-2 border-black text-primary focus:ring-primary focus:ring-offset-0 transition-all cursor-pointer peer"
                                        checked={selectedSubcategories.includes(sub)}
                                        onChange={(e) => {
                                          if (e.target.checked) setSelectedSubcategories(prev => [...prev, sub]);
                                          else setSelectedSubcategories(prev => prev.filter(s => s !== sub));
                                        }}
                                      />
                                    </div>
                                    <span className="text-sm font-medium text-black transition-colors">{sub}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {(role === "tradesperson" || (role === "business" && businessLayer === "field_services")) &&
                uniqueRequiredCerts.length === 0 && (
                  <div className="space-y-3 rounded-2xl border border-black bg-amber-50/70 p-4">
                    <div className="flex items-start gap-2.5">
                      <Shield className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                      <div className="text-xs text-black space-y-1">
                        <p className="font-black uppercase tracking-tight">
                          {Number(platformConfig?.documentGracePeriodDays ?? DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS)}-Day Provisional Start ({Number(platformConfig?.provisionalMaxQuotes ?? DEFAULT_PROVISIONAL_MAX_QUOTES)} Quotes)
                        </p>
                        <p className="font-medium leading-relaxed text-slate-800">
                          Start matching with local jobs straight away for up to{" "}
                          <strong>{Number(platformConfig?.provisionalMaxQuotes ?? DEFAULT_PROVISIONAL_MAX_QUOTES)} quotes</strong>{" "}
                          during your{" "}
                          <strong>{Number(platformConfig?.documentGracePeriodDays ?? DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS)}-day</strong>{" "}
                          provisional cooling-off window while you upload your ID and insurance documents in your Profile.
                        </p>
                      </div>
                    </div>
                    <label className="flex items-start gap-3 p-3 rounded-xl bg-white border border-black cursor-pointer">
                      <input
                        type="checkbox"
                        checked={acceptedComplianceDeclaration}
                        onChange={(e) => {
                          setAcceptedComplianceDeclaration(e.target.checked);
                          if (e.target.checked) setError(null);
                        }}
                        className="mt-0.5 w-5 h-5 rounded border-2 border-black text-primary focus:ring-primary cursor-pointer shrink-0"
                      />
                      <span className="text-xs font-medium text-black leading-relaxed">
                        {TRADER_COMPLIANCE_DECLARATION_SUMMARY}{" "}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            setShowTermsModal(true);
                          }}
                          className="font-black text-primary underline hover:text-primary-hover cursor-pointer"
                        >
                          Read Terms &amp; Conditions
                        </button>
                      </span>
                    </label>
                  </div>
                )}

              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setStep(getPreviousOnboardingStep(2, role))}
                  className="flex-1 p-4 rounded-2xl border border-black font-black text-black hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ChevronLeft className="w-5 h-5" /> Back
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const needsComplianceHere =
                      (role === "tradesperson" || (role === "business" && businessLayer === "field_services")) &&
                      uniqueRequiredCerts.length === 0;
                    if (needsComplianceHere && !acceptedComplianceDeclaration) {
                      setError("Please tick the compliance declaration and accept the Terms & Conditions to continue.");
                      return;
                    }
                    if (uniqueRequiredCerts.length > 0) setStep(3);
                    else handleSubmit();
                  }}
                  disabled={
                    selectedTrades.length === 0 ||
                    loading ||
                    ((role === "tradesperson" || (role === "business" && businessLayer === "field_services")) &&
                      uniqueRequiredCerts.length === 0 &&
                      !acceptedComplianceDeclaration)
                  }
                  className="flex-[2] bg-primary text-white p-4 rounded-2xl font-black text-base hover:bg-primary-hover transition-all shadow-xl shadow-primary/25 disabled:opacity-50 flex items-center justify-center gap-2 active:scale-95 group cursor-pointer"
                >
                  {loading ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <>
                      {uniqueRequiredCerts.length > 0 ? "Next: Verification" : "Complete Setup"}
                      <ChevronRight className="w-5 h-5 group-hover:translate-x-0.5 transition-transform" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Property & Asset Management Business Setup */}
          {step === 2 && role === "business" && businessLayer === "properties" && (
            <div className="space-y-6">
              <div className="flex justify-end">
                <span className="text-[11px] font-black uppercase tracking-wider text-black bg-slate-100 border border-black/20 px-2.5 py-1 rounded-lg">
                  {stepProgress.label}
                </span>
              </div>
              <div className="text-center space-y-2">
                <h1 className="text-3xl font-display font-black text-black tracking-tight">
                  Property Business Setup
                </h1>
                <p className="text-slate-600 font-medium text-sm">
                  Select your property or asset management organisation type.
                </p>
              </div>

              {!businessCategory ? (
                <div className="space-y-3">
                  <label className="text-xs font-black text-black uppercase tracking-wider block">Select Property Organisation Type</label>
                  <input
                    type="text"
                    placeholder="Filter e.g. Landlord, Letting Agency, Housing Association..."
                    value={categorySearch}
                    onChange={(e) => setCategorySearch(e.target.value)}
                    className="w-full p-3.5 rounded-xl border border-black bg-white text-black focus:border-primary focus:ring-1 focus:ring-primary outline-none text-sm"
                  />
                  <div className="max-h-72 overflow-y-auto grid grid-cols-1 gap-2.5 custom-scrollbar">
                    {PROPERTY_BUSINESS_CATEGORIES
                      .filter(cat =>
                        cat.name.toLowerCase().includes(categorySearch.toLowerCase()) ||
                        cat.description.toLowerCase().includes(categorySearch.toLowerCase())
                      )
                      .map(cat => (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setBusinessCategory(cat.name)}
                          className="p-3.5 rounded-xl border border-black bg-white hover:bg-slate-50 text-left transition-all flex items-center gap-3 cursor-pointer"
                        >
                          <span className="text-2xl shrink-0">{cat.icon}</span>
                          <div className="min-w-0">
                            <span className="font-black text-sm text-black block">{cat.name}</span>
                            <span className="text-xs text-slate-600 block">{cat.description}</span>
                          </div>
                        </button>
                      ))}
                  </div>
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setStep(getPreviousOnboardingStep(2, role))}
                      className="w-full p-3.5 rounded-2xl border border-black font-black text-black hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <ChevronLeft className="w-5 h-5" /> Back to Business Type
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="p-5 bg-slate-50 rounded-2xl border border-black space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center">
                          <Building2 className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Organisation Type</p>
                          <p className="font-black text-black">{businessCategory}</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setBusinessCategory(null)} className="text-xs text-primary font-black underline cursor-pointer">Change</button>
                    </div>

                    <div className="flex items-start gap-3 bg-white p-4 rounded-xl border border-black">
                      <Gift className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest leading-none mb-1">Property Hub Ready</p>
                        <p className="text-xs text-black leading-tight">Manage property passports, compliance alerts (CP12 & EICR), hire verified trades, and book rides on AnyRoller from one account.</p>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4">
                    <button
                      type="button"
                      onClick={() => {
                        setBusinessCategory(null);
                      }}
                      className="flex-1 p-4 rounded-2xl border border-black font-black text-black hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <ChevronLeft className="w-5 h-5" /> Back
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const chosenTier = selectedTier || "Business Professional";
                        if (!selectedTier) setSelectedTier(chosenTier);
                        handleSubmit({ overrideTier: chosenTier });
                      }}
                      disabled={loading}
                      className="flex-[2] flex items-center justify-center gap-3 bg-primary text-white p-4 rounded-2xl font-black text-base hover:bg-primary-hover transition-all shadow-xl shadow-primary/25 disabled:opacity-50 active:scale-95 group cursor-pointer"
                    >
                      {loading ? (
                        <Loader2 className="w-6 h-6 animate-spin" />
                      ) : (
                        <>
                          Complete Setup
                          <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Tradesperson - Verification */}
          {step === 3 && (
            <div className="space-y-8">
              <div className="flex justify-end">
                <span className="text-[11px] font-black uppercase tracking-wider text-black bg-slate-100 border border-black/20 px-2.5 py-1 rounded-lg">
                  {stepProgress.label}
                </span>
              </div>
              <div className="text-center space-y-2">
                <h1 className="text-3xl font-display font-black text-black tracking-tight">
                  Verification Required
                </h1>
                <p className="text-slate-600 font-medium text-sm">
                  Some of your trades require certification to ensure platform safety.
                </p>
              </div>

              <div className="bg-orange-50 border border-orange-100 p-5 rounded-[2rem] flex gap-4">
                <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-5 h-5 text-orange-600" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-black text-orange-900 uppercase tracking-tight">Verification Required</p>
                  <p className="text-xs text-orange-700 leading-relaxed">You've selected trades that require specific certifications in the UK. You can still complete setup, but you won't be able to quote until verified.</p>
                </div>
              </div>

              {error && (
                <div className="p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-xs font-bold flex items-center justify-between shadow-sm animate-in fade-in">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                    <span>{error}</span>
                  </div>
                  <button type="button" onClick={() => setError(null)} className="text-red-900 font-extrabold hover:underline ml-2">✕</button>
                </div>
              )}

              <div className="space-y-4">
                {uniqueRequiredCerts.map((cert, idx) => {
                  const uploadedDoc = verificationDocs.find(d => d.type === cert);
                  const isUploadingThis = uploadingCert === cert;
                  return (
                    <div key={idx} className="p-5 rounded-2xl border border-black bg-slate-50/50 space-y-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-black tracking-tight">{cert}</p>
                          {uploadedDoc?.fileName && (
                            <p className="text-[11px] font-bold text-green-700 truncate mt-0.5">
                              File: {uploadedDoc.fileName}
                            </p>
                          )}
                        </div>
                        {isUploadingThis ? (
                          <span className="text-[10px] bg-blue-600 text-white px-3 py-1 rounded-full font-black uppercase tracking-widest flex items-center gap-1 shrink-0">
                            <Loader2 className="w-3 h-3 animate-spin" /> Uploading
                          </span>
                        ) : uploadedDoc ? (
                          <span className="text-[10px] bg-green-600 text-white px-3 py-1 rounded-full font-black uppercase tracking-widest shrink-0">Uploaded</span>
                        ) : (
                          <span className="text-[10px] bg-slate-200 text-black px-3 py-1 rounded-full font-black uppercase tracking-widest shrink-0">Required</span>
                        )}
                      </div>
                      <label 
                        htmlFor={`cert-upload-${idx}`}
                        className={cn(
                          "w-full flex items-center justify-center gap-3 p-4 rounded-xl border border-dashed border-black bg-white text-xs font-black text-black hover:border-primary hover:text-primary hover:bg-primary/5 transition-all group",
                          isUploadingThis || Boolean(uploadingCert) ? "opacity-60 cursor-wait pointer-events-none" : "cursor-pointer"
                        )}
                      >
                        {isUploadingThis ? (
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        ) : (
                          <Upload className="w-4 h-4 group-hover:-translate-y-0.5 transition-transform" />
                        )}
                        <span>
                          {isUploadingThis
                            ? "Uploading securely to storage..."
                            : uploadedDoc
                              ? "Replace Document"
                              : "Choose / Upload Document (PDF or Image, max 10MB)"}
                        </span>
                        <input
                          id={`cert-upload-${idx}`}
                          type="file"
                          accept="image/*,application/pdf"
                          disabled={Boolean(uploadingCert) || loading}
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (file) {
                              void handleCertificationUpload(cert as string, file);
                            }
                          }}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>

              {(role === "tradesperson" || (role === "business" && businessLayer === "field_services")) && (
                <label className="flex items-start gap-3 p-4 rounded-2xl bg-slate-50 border border-black cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acceptedComplianceDeclaration}
                    onChange={(e) => {
                      setAcceptedComplianceDeclaration(e.target.checked);
                      if (e.target.checked) setError(null);
                    }}
                    className="mt-0.5 w-5 h-5 rounded border-2 border-black text-primary focus:ring-primary cursor-pointer shrink-0"
                  />
                  <span className="text-xs font-medium text-black leading-relaxed">
                    {TRADER_COMPLIANCE_DECLARATION_SUMMARY}{" "}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        setShowTermsModal(true);
                      }}
                      className="font-black text-primary underline hover:text-primary-hover cursor-pointer"
                    >
                      Read Terms &amp; Conditions
                    </button>
                  </span>
                </label>
              )}

              <div className="flex flex-col sm:flex-row gap-4">
                <button
                  type="button"
                  onClick={() => setStep(getPreviousOnboardingStep(3, role))}
                  disabled={loading || Boolean(uploadingCert)}
                  className="w-full sm:w-auto p-5 rounded-2xl border border-black font-black text-black hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <ChevronLeft className="w-5 h-5" /> Back
                </button>
                <div className="flex-1 flex flex-col sm:flex-row gap-4">
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        (role === "tradesperson" || (role === "business" && businessLayer === "field_services")) &&
                        !acceptedComplianceDeclaration
                      ) {
                        setError("Please tick the compliance declaration and accept the Terms & Conditions to continue.");
                        return;
                      }
                      setError(null);
                      const defaultTier = platformConfig?.feeTiers?.[0]?.name || "Free Explorer";
                      setSelectedTier(defaultTier);
                      void handleSubmit({ skipVerificationDocs: true, overrideTier: defaultTier });
                    }}
                    disabled={
                      loading ||
                      Boolean(uploadingCert) ||
                      ((role === "tradesperson" || (role === "business" && businessLayer === "field_services")) &&
                        !acceptedComplianceDeclaration)
                    }
                    className="flex-1 bg-white border border-black text-black p-5 rounded-2xl font-black text-sm sm:text-base hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95 disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin text-black" /> : "I'll do this later"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        (role === "tradesperson" || (role === "business" && businessLayer === "field_services")) &&
                        !acceptedComplianceDeclaration
                      ) {
                        setError("Please tick the compliance declaration and accept the Terms & Conditions to continue.");
                        return;
                      }
                      setError(null);
                      const defaultTier = platformConfig?.feeTiers?.[0]?.name || "Free Explorer";
                      setSelectedTier(defaultTier);
                      void handleSubmit({ skipVerificationDocs: false, overrideTier: defaultTier });
                    }}
                    disabled={
                      loading ||
                      Boolean(uploadingCert) ||
                      ((role === "tradesperson" || (role === "business" && businessLayer === "field_services")) &&
                        !acceptedComplianceDeclaration)
                    }
                    className="flex-1 bg-primary text-white p-5 rounded-2xl font-black text-sm sm:text-base hover:bg-primary-hover transition-all shadow-xl shadow-primary/30 disabled:opacity-50 flex items-center justify-center gap-2 active:scale-95 cursor-pointer"
                  >
                    {loading ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : verificationDocs.length > 0 ? (
                      `Submit ${verificationDocs.length} Doc${verificationDocs.length === 1 ? "" : "s"} & Complete`
                    ) : (
                      "Complete Setup"
                    )}
                  </button>
                </div>
              </div>
              
              <div className="flex items-center gap-2 text-slate-400 justify-center">
                <Info className="w-4 h-4" />
                <p className="text-[10px] font-bold uppercase tracking-widest">You can also upload these later in your profile.</p>
              </div>
            </div>
          )}

          {/* Step 4: SMS Verification */}
          {step === 4 && (
            <div className="space-y-8">
              <div className="flex justify-end">
                <span className="text-[11px] font-black uppercase tracking-wider text-black bg-slate-100 border border-black/20 px-2.5 py-1 rounded-lg">
                  {stepProgress.label}
                </span>
              </div>
              <div className="text-center space-y-2">
                <h1 className="text-3xl font-display font-black text-black tracking-tight">
                  Verify Phone Number
                </h1>
                <p className="text-slate-600 font-medium text-sm">
                  We've sent a 6-digit code to {phone.startsWith("0") ? "+44" + phone.slice(1) : phone}
                </p>
              </div>

              {phoneError && (
                <div className="p-4 bg-red-50 text-red-700 text-sm rounded-2xl flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p>{phoneError}</p>
                </div>
              )}

              <div className="space-y-4">
                <input
                  type="text"
                  placeholder="000000"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full text-center text-3xl tracking-[1em] p-6 rounded-[2rem] border-2 border-black focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none font-mono"
                />
              </div>

              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => {
                    setStep(getPreviousOnboardingStep(4, role));
                    setConfirmationResult(null);
                  }}
                  className="flex-1 p-5 rounded-2xl border border-black font-black text-black hover:bg-slate-50 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ChevronLeft className="w-5 h-5" /> Cancel
                </button>
                <button
                  onClick={async () => {
                    try {
                      setLoading(true);
                      setPhoneError("");
                      await confirmationResult.confirm(verificationCode);
                      
                      // Now submit normally
                      await handleSubmit();
                    } catch (err: any) {
                      console.error("SMS verification error:", err);
                      setPhoneError(err.message || "Invalid verification code.");
                      setLoading(false);
                    }
                  }}
                  disabled={loading || verificationCode.length !== 6}
                  className="flex-[2] bg-primary text-white p-5 rounded-[2rem] font-black text-lg hover:bg-primary-hover transition-all shadow-2xl shadow-primary/30 disabled:opacity-50 flex items-center justify-center gap-2 active:scale-95"
                >
                  {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : "Verify & Complete"}
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      <div id="recaptcha-container"></div>
      <TermsModal isOpen={showTermsModal} onClose={() => setShowTermsModal(false)} />
    </div>
  );
}
