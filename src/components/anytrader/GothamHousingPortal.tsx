import React, { useState, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Building2, Receipt, Plus, Search, ArrowRight, CheckCircle2, AlertTriangle,
  Wrench, ShieldCheck, Zap, TrendingUp, Download, RefreshCw, X,
  CreditCard, Calculator, Sparkles, LayoutGrid, Loader2, ExternalLink,
  Copy, MapPin, Check
} from "lucide-react";
import { db, auth, collection, query, where, onSnapshot, limit, doc, updateDoc } from "@/src/firebase";
import { useAuth } from "../AuthProvider";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/src/lib/utils";
import { calculateGothamSaaSPlan } from "@/src/services/subscriptionService";
import { createPropertyViaCommand } from "@/src/services/propertyCommandService";
import { createJobViaCommand } from "@/src/services/jobCommandService";
import { lookupPostcode } from "@/src/services/postcodeService";

interface EstateRecord {
  id: string;
  name: string;
  association: string;
  unitsCount: number;
  postcode: string;
  city: string;
  addressLine1: string;
  lat?: number;
  lng?: number;
  gasSafetyExpiry?: string;
  eicrExpiry?: string;
  epcRating?: string;
  boilerBrand?: string;
  boilerAge?: string | number;
  roofCondition?: string;
  accessInstructions?: string;
  cp12Valid: boolean;
  eicrValid: boolean;
  cp12Status: "valid" | "expired" | "missing";
  eicrStatus: "valid" | "expired" | "missing";
}

interface RepairTicketRecord {
  id: string;
  propertyId?: string;
  estateName: string;
  unitLabel: string;
  tenantName: string;
  category: string;
  description: string;
  urgency: "emergency" | "urgent" | "normal";
  priorityLabel: string;
  isAwaabRisk: boolean;
  createdAtMs: number;
  reportedLabel: string;
  slaCountdownLabel: string;
  slaStatus: "ok" | "warning" | "breached";
  status: "open" | "dispatched" | "resolved";
  linkedJobId?: string;
  postcode?: string;
}

interface ApprovedContractor {
  uid: string;
  name: string;
  primaryTrade: string;
  rating: number;
  reviewCount: number;
  completedJobsCount: number;
  avgResponseMinutes?: number;
  verified: boolean;
  city?: string;
}

interface PortfolioJobSummary {
  id: string;
  propertyId?: string;
  status: string;
  amount: number;
  createdAtMs: number;
}

function parseTimestampMs(raw: any): number {
  if (!raw) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw?.toMillis === "function") return raw.toMillis();
  if (typeof raw?.seconds === "number") return raw.seconds * 1000;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getCertStatus(dateStr?: string): "valid" | "expired" | "missing" {
  if (!dateStr || !String(dateStr).trim()) return "missing";
  const parsed = Date.parse(String(dateStr));
  if (!Number.isFinite(parsed)) return "missing";
  return parsed > Date.now() ? "valid" : "expired";
}

function formatRelativeTime(createdAtMs: number): string {
  if (!createdAtMs) return "Recently";
  const diffMin = Math.max(0, Math.floor((Date.now() - createdAtMs) / 60000));
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function computeSlaState(
  urgency: "emergency" | "urgent" | "normal",
  createdAtMs: number,
  status: "open" | "dispatched" | "resolved"
): { label: string; slaStatus: "ok" | "warning" | "breached" } {
  if (status === "resolved") {
    return { label: "Resolved", slaStatus: "ok" };
  }
  const windowHours = urgency === "emergency" ? 2 : urgency === "urgent" ? 24 : 120;
  if (!createdAtMs) {
    return { label: `${windowHours}h SLA`, slaStatus: urgency === "emergency" ? "warning" : "ok" };
  }
  const deadlineMs = createdAtMs + windowHours * 3600 * 1000;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    const overdueHrs = Math.max(1, Math.ceil(Math.abs(remainingMs) / 3600000));
    return { label: `Overdue by ${overdueHrs}h`, slaStatus: "breached" };
  }
  const remainingMins = Math.ceil(remainingMs / 60000);
  if (remainingMins < 60) {
    return { label: `${remainingMins}m remaining`, slaStatus: "warning" };
  }
  const remainingHrs = Math.floor(remainingMins / 60);
  const minsPart = remainingMins % 60;
  if (remainingHrs < 24) {
    return {
      label: `${remainingHrs}h ${minsPart}m remaining`,
      slaStatus: remainingHrs <= (urgency === "emergency" ? 1 : 4) ? "warning" : "ok",
    };
  }
  const days = Math.floor(remainingHrs / 24);
  return { label: `${days}d ${remainingHrs % 24}h remaining`, slaStatus: "ok" };
}

function mapCategoryToJobTrade(rawCategory: string): string {
  const lower = (rawCategory || "").toLowerCase();
  if (lower.includes("boiler") || lower.includes("heating") || lower.includes("gas")) return "Gas & Heating";
  if (lower.includes("plumb") || lower.includes("leak") || lower.includes("water")) return "Plumbing";
  if (lower.includes("electric") || lower.includes("eicr") || lower.includes("power")) return "Electrical";
  if (lower.includes("damp") || lower.includes("mould") || lower.includes("mold")) return "Damp Proofing & Timber Treatment";
  if (lower.includes("roof")) return "Roofing";
  if (lower.includes("lock") || lower.includes("door") || lower.includes("window")) return "Locksmith";
  return rawCategory || "Handyman & Property Maintenance";
}

export default function GothamHousingPortal() {
  const { user, profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<"overview" | "estates" | "repairs" | "billing" | "contractors">("overview");
  const [searchQuery, setSearchQuery] = useState("");

  // Live Firestore state (zero hardcoded mock records)
  const [estates, setEstates] = useState<EstateRecord[]>([]);
  const [tickets, setTickets] = useState<RepairTicketRecord[]>([]);
  const [contractors, setContractors] = useState<ApprovedContractor[]>([]);
  const [portfolioJobs, setPortfolioJobs] = useState<PortfolioJobSummary[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const [dispatchingTicketId, setDispatchingTicketId] = useState<string | null>(null);
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(null);
  const [lastAuditSummary, setLastAuditSummary] = useState<{
    runAt: string;
    breachedCount: number;
    awaabOpenCount: number;
    expiredCertProperties: number;
  } | null>(null);

  // Onboarding Modal state
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [newEstateName, setNewEstateName] = useState("");
  const [newEstateAssoc, setNewEstateAssoc] = useState("");
  const [newEstateAddress, setNewEstateAddress] = useState("");
  const [newEstatePostcode, setNewEstatePostcode] = useState("");
  const [newEstateCity, setNewEstateCity] = useState("");
  const [newEstateLat, setNewEstateLat] = useState<number | undefined>(undefined);
  const [newEstateLng, setNewEstateLng] = useState<number | undefined>(undefined);
  const [newEstateUnits, setNewEstateUnits] = useState("10");
  const [verifyingPostcode, setVerifyingPostcode] = useState(false);
  const [savingEstate, setSavingEstate] = useState(false);

  // Gotham B2B Enterprise SaaS Subscription State
  const [saasBillingCycle, setSaasBillingCycle] = useState<"monthly" | "annual">("monthly");
  const [isSaaSCalculatorOpen, setIsSaaSCalculatorOpen] = useState(false);
  const [calculatorDoors, setCalculatorDoors] = useState(100);
  const [isProcessing, setIsProcessing] = useState(false);

  const isGothamTerminal = ["canceled", "cancelled", "unpaid", "incomplete_expired"].includes(
    String(profile?.gothamSubscriptionStatus || "").toLowerCase()
  );
  const isGothamActive = !isGothamTerminal && Boolean(profile?.isGothamSubscriber || profile?.subscriptionType === "gotham_saas");
  const isGothamCanceling = Boolean(profile?.gothamCancelAtPeriodEnd);

  // Surface confirmation when returning from Stripe checkout
  useEffect(() => {
    if (searchParams.get("gotham_saas") === "success") {
      toast.success("Gotham B2B SaaS checkout completed! Your portfolio license will activate momentarily.");
      const next = new URLSearchParams(searchParams);
      next.delete("gotham_saas");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Real-time Firestore subscriptions for owner's estates, tenant issues, jobs, and approved contractors
  useEffect(() => {
    if (!user?.uid) {
      setEstates([]);
      setTickets([]);
      setPortfolioJobs([]);
      setLoadingData(false);
      return;
    }

    setLoadingData(true);
    let propsLoaded = false;
    let issuesLoaded = false;
    const markReady = () => {
      if (propsLoaded && issuesLoaded) setLoadingData(false);
    };

    const unsubProperties = onSnapshot(
      query(collection(db, "properties"), where("ownerId", "==", user.uid)),
      (snap) => {
        const mapped: EstateRecord[] = snap.docs.map((d) => {
          const data = d.data() as Record<string, any>;
          const addrObj = typeof data.address === "object" && data.address ? data.address : {};
          const addressLine1 = typeof data.address === "string"
            ? data.address
            : String(addrObj.line1 || "");
          const postcode = String(data.postcode || addrObj.postcode || "").trim();
          const city = String(data.city || addrObj.city || "").trim();
          const cp12Status = getCertStatus(data.gasSafetyExpiry);
          const eicrStatus = getCertStatus(data.eicrExpiry);

          return {
            id: d.id,
            name: String(data.name || addressLine1 || "Unnamed Property"),
            association: String(data.association || "Managed Portfolio"),
            unitsCount: Math.max(1, Number(data.unitCount) || 1),
            postcode,
            city,
            addressLine1,
            lat: typeof data.lat === "number" ? data.lat : undefined,
            lng: typeof data.lng === "number" ? data.lng : undefined,
            gasSafetyExpiry: data.gasSafetyExpiry,
            eicrExpiry: data.eicrExpiry,
            epcRating: data.epcRating,
            boilerBrand: data.boilerBrand,
            boilerAge: data.boilerAge,
            roofCondition: data.roofCondition,
            accessInstructions: data.accessInstructions,
            cp12Valid: cp12Status === "valid",
            eicrValid: eicrStatus === "valid",
            cp12Status,
            eicrStatus,
          };
        });
        setEstates(mapped);
        propsLoaded = true;
        markReady();
      },
      (err) => {
        console.error("Gotham properties subscription error:", err);
        propsLoaded = true;
        markReady();
      }
    );

    const unsubIssues = onSnapshot(
      query(collection(db, "tenant_issues"), where("landlordOwnerId", "==", user.uid)),
      (snap) => {
        const mapped: RepairTicketRecord[] = snap.docs
          .map((d) => {
            const data = d.data() as Record<string, any>;
            const rawUrgency = String(data.urgency || "normal").toLowerCase();
            const urgency: "emergency" | "urgent" | "normal" =
              rawUrgency === "emergency" ? "emergency" : rawUrgency === "urgent" ? "urgent" : "normal";
            const rawStatus = String(data.status || "open").toLowerCase();
            const status: "open" | "dispatched" | "resolved" =
              rawStatus === "resolved" || rawStatus === "completed" || rawStatus === "closed"
                ? "resolved"
                : rawStatus === "dispatched" || Boolean(data.linkedJobId)
                ? "dispatched"
                : "open";
            const createdAtMs = parseTimestampMs(data.createdAt);
            const category = String(data.category || "General Maintenance");
            const description = String(data.description || "");
            const isAwaabRisk = /damp|mould|mold|condensation/i.test(`${category} ${description}`);
            const sla = computeSlaState(urgency, createdAtMs, status);

            return {
              id: d.id,
              propertyId: data.propertyId ? String(data.propertyId) : undefined,
              estateName: String(data.propertyName || data.manualAddress || data.address || "Portfolio Property"),
              unitLabel: String(data.unit || data.postcode || data.address || "Registered Unit"),
              tenantName: String(data.tenantName || "Tenant"),
              category,
              description,
              urgency,
              priorityLabel:
                urgency === "emergency"
                  ? "Emergency (2h SLA)"
                  : urgency === "urgent"
                  ? "Urgent (24h SLA)"
                  : "Routine (5-Day SLA)",
              isAwaabRisk,
              createdAtMs,
              reportedLabel: formatRelativeTime(createdAtMs),
              slaCountdownLabel: sla.label,
              slaStatus: sla.slaStatus,
              status,
              linkedJobId: data.linkedJobId ? String(data.linkedJobId) : undefined,
              postcode: data.postcode ? String(data.postcode) : undefined,
            };
          })
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        setTickets(mapped);
        issuesLoaded = true;
        markReady();
      },
      (err) => {
        console.error("Gotham tenant_issues subscription error:", err);
        issuesLoaded = true;
        markReady();
      }
    );

    const unsubJobs = onSnapshot(
      query(collection(db, "jobs"), where("homeownerId", "==", user.uid)),
      (snap) => {
        const mapped: PortfolioJobSummary[] = snap.docs.map((d) => {
          const data = d.data() as Record<string, any>;
          return {
            id: d.id,
            propertyId: data.propertyId || data.propertyPassportId || data.linkedPropertyId,
            status: String(data.status || "open"),
            amount: Number(data.agreedAmount ?? data.finalAmount ?? data.budget ?? 0) || 0,
            createdAtMs: parseTimestampMs(data.createdAt || data.postedDate),
          };
        });
        setPortfolioJobs(mapped);
      },
      (err) => {
        console.error("Gotham jobs subscription error:", err);
      }
    );

    const unsubContractors = onSnapshot(
      query(collection(db, "public_profiles"), where("role", "==", "tradesperson"), limit(12)),
      (snap) => {
        const mapped: ApprovedContractor[] = snap.docs
          .map((d) => {
            const data = d.data() as Record<string, any>;
            return {
              uid: d.id,
              name: String(data.businessName || data.companyName || data.displayName || data.name || "Verified Tradesperson"),
              primaryTrade: String(data.primaryTrade || data.trade || data.category || "Multi-Trade"),
              rating: Number(data.rating) || 0,
              reviewCount: Number(data.reviewCount ?? data.totalReviews) || 0,
              completedJobsCount: Number(data.completedJobsCount) || 0,
              avgResponseMinutes: typeof data.avgResponseMinutes === "number" ? Math.round(data.avgResponseMinutes) : undefined,
              verified: Boolean(data.isVerified || data.verified || data.verificationStatus === "verified"),
              city: data.city ? String(data.city) : undefined,
            };
          })
          .sort((a, b) => Number(b.verified) - Number(a.verified) || b.rating - a.rating);
        setContractors(mapped);
      },
      (err) => {
        console.error("Gotham public_profiles subscription error:", err);
      }
    );

    return () => {
      unsubProperties();
      unsubIssues();
      unsubJobs();
      unsubContractors();
    };
  }, [user?.uid]);

  const handleSyncStripeB2BInvoice = async (doorCountOverride?: number) => {
    if (!user) {
      toast.error("Please sign in to proceed with Gotham SaaS onboarding");
      return;
    }
    const targetDoors = Math.max(10, doorCountOverride ?? calculatorDoors);
    const plan = calculateGothamSaaSPlan(targetDoors, saasBillingCycle);
    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          userId: user.uid,
          priceId: "price_gotham_saas",
          tierName: plan.tierName,
          mode: "subscription",
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(plan.monthlyFee * 100),
            recurring: { interval: "month" },
            product_data: {
              name: `Gotham B2B SaaS (${plan.tierName})`,
              description: `Metered licensing for ${targetDoors.toLocaleString()} housing doors. Regulatory & Awaab's Law SLA compliance.`,
            },
          },
          successUrl: `${window.location.origin}/gotham-portal?gotham_saas=success`,
          cancelUrl: `${window.location.origin}/gotham-portal`,
          metadata: {
            subscriptionType: "gotham_saas",
            type: "gotham_saas",
            gothamDoorsCount: String(targetDoors),
            gothamTierName: plan.tierName,
            gothamBillingCycle: saasBillingCycle,
            userId: user.uid,
          },
        }),
      });

      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.error) {
        toast.error(data.error);
      } else {
        toast.error("Checkout did not return a payment URL. Gotham SaaS has not been activated.");
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to initiate Gotham SaaS checkout session");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelGothamSaaS = async () => {
    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/cancel-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ subscriptionType: "gotham_saas" }),
      });
      const data = await response.json();
      if (data.success) {
        toast.success("Gotham SaaS subscription scheduled for cancellation at renewal.", {
          description: "Full regulatory SLA access remains active until your renewal date.",
        });
      } else {
        toast.error(data.error || "Failed to cancel Gotham subscription");
      }
    } catch {
      toast.error("Error scheduling Gotham cancellation");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReactivateGothamSaaS = async () => {
    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/reactivate-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ subscriptionType: "gotham_saas" }),
      });
      const data = await response.json();
      if (data.success) {
        toast.success("Gotham SaaS subscription reactivated!", {
          description: "Your B2B SaaS license will continue auto-renewing normally.",
        });
      } else {
        toast.error(data.error || "Failed to reactivate Gotham subscription");
      }
    } catch {
      toast.error("Error reactivating Gotham subscription");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleOpenStripePortal = async () => {
    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/create-customer-portal-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error(data.error || "Failed to open Stripe Customer Portal");
      }
    } catch {
      toast.error("Failed to connect to Stripe Portal");
    } finally {
      setIsProcessing(false);
    }
  };

  // Real derived portfolio KPIs
  const totalUnits = useMemo(
    () => estates.reduce((acc, e) => acc + e.unitsCount, 0),
    [estates]
  );
  const purchasedDoors = Number(profile?.gothamDoorsCount) || 0;
  const billingDoorCount = totalUnits > 0 ? totalUnits : purchasedDoors;
  const currentSaasPlan = useMemo(
    () => calculateGothamSaaSPlan(billingDoorCount, saasBillingCycle),
    [billingDoorCount, saasBillingCycle]
  );

  const openTickets = useMemo(() => tickets.filter((t) => t.status !== "resolved"), [tickets]);
  const urgentOrAwaabCount = useMemo(
    () => openTickets.filter((t) => t.isAwaabRisk || t.slaStatus === "breached" || t.slaStatus === "warning").length,
    [openTickets]
  );

  const complianceMetrics = useMemo(() => {
    if (estates.length === 0) {
      return { cp12Pct: null as number | null, eicrPct: null as number | null, awaabPct: null as number | null };
    }
    const cp12ValidCount = estates.filter((e) => e.cp12Valid).length;
    const eicrValidCount = estates.filter((e) => e.eicrValid).length;
    const cp12Pct = Math.round((cp12ValidCount / estates.length) * 100);
    const eicrPct = Math.round((eicrValidCount / estates.length) * 100);
    const awaabTickets = tickets.filter((t) => t.isAwaabRisk);
    const awaabWithinSla = awaabTickets.filter((t) => t.slaStatus !== "breached").length;
    const awaabPct = awaabTickets.length === 0 ? 100 : Math.round((awaabWithinSla / awaabTickets.length) * 100);
    return { cp12Pct, eicrPct, awaabPct };
  }, [estates, tickets]);

  // Real Month-To-Date (MTD) maintenance outlays from owner's jobs
  const mtdOutlays = useMemo(() => {
    const now = new Date();
    const startOfMonthMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const mtdJobs = portfolioJobs.filter(
      (j) => j.createdAtMs >= startOfMonthMs && j.status !== "cancelled"
    );
    const total = mtdJobs.reduce((sum, j) => sum + j.amount, 0);
    return { total, count: mtdJobs.length };
  }, [portfolioJobs]);

  const handleAutoDispatchTicket = async (ticket: RepairTicketRecord) => {
    if (!user) {
      toast.error("Please sign in to dispatch repairs.");
      return;
    }
    if (ticket.status === "dispatched" || ticket.linkedJobId) {
      toast.info("This ticket has already been dispatched.");
      return;
    }

    const linkedEstate = estates.find((e) => e.id === ticket.propertyId);
    setDispatchingTicketId(ticket.id);
    try {
      const postcode = linkedEstate?.postcode || ticket.postcode || "";
      let lat = linkedEstate?.lat;
      let lng = linkedEstate?.lng;
      let city = linkedEstate?.city || "";
      if ((lat === undefined || lng === undefined) && postcode) {
        try {
          const geo = await lookupPostcode(postcode);
          if (geo) {
            lat = geo.latitude;
            lng = geo.longitude;
            if (!city) city = geo.city;
          }
        } catch {
          // non-fatal geocode fallback
        }
      }

      const specsNote = linkedEstate
        ? [
            linkedEstate.boilerBrand ? `Boiler: ${linkedEstate.boilerBrand}` : null,
            linkedEstate.epcRating ? `EPC: ${linkedEstate.epcRating}` : null,
            linkedEstate.accessInstructions ? `Access: ${linkedEstate.accessInstructions}` : null,
          ]
            .filter(Boolean)
            .join(" | ")
        : "";

      const created = await createJobViaCommand({
        user,
        payload: {
          title: `${ticket.category} — ${ticket.estateName}`,
          category: mapCategoryToJobTrade(ticket.category),
          description: [
            `Tenant repair report (${ticket.priorityLabel}) logged by ${ticket.tenantName}.`,
            ticket.description || `Issue reported at ${ticket.estateName} (${ticket.unitLabel}).`,
            specsNote ? `Property Passport Specs: ${specsNote}` : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
          location: linkedEstate?.addressLine1 || ticket.estateName,
          postcode: postcode || undefined,
          city: city || undefined,
          lat,
          lng,
          urgency: ticket.urgency === "emergency" ? "emergency" : ticket.urgency === "urgent" ? "urgent" : "standard",
          isEmergency: ticket.urgency === "emergency",
          budget: 0,
          propertyId: linkedEstate?.id || ticket.propertyId,
          propertyPassportId: linkedEstate?.id || ticket.propertyId,
          propertyName: ticket.estateName,
          fromPropertyPassport: Boolean(linkedEstate),
          tenantIssueId: ticket.id,
        },
      });

      const nowIso = new Date().toISOString();
      await updateDoc(doc(db, "tenant_issues", ticket.id), {
        status: "dispatched",
        linkedJobId: created.jobId,
        dispatchedAt: nowIso,
        updatedAt: nowIso,
      });

      toast.success(`Repair job dispatched for ${ticket.estateName}!`);
    } catch (err: any) {
      console.error("Gotham dispatch failed:", err);
      toast.error(err?.message || "Failed to dispatch repair ticket.");
    } finally {
      setDispatchingTicketId(null);
    }
  };

  const handleResolveTicket = async (ticket: RepairTicketRecord) => {
    if (!user) return;
    setResolvingTicketId(ticket.id);
    try {
      const nowIso = new Date().toISOString();
      await updateDoc(doc(db, "tenant_issues", ticket.id), {
        status: "resolved",
        resolvedAt: nowIso,
        updatedAt: nowIso,
      });
      toast.success(`Marked repair ticket for ${ticket.estateName} as resolved.`);
    } catch (err: any) {
      console.error("Resolve ticket failed:", err);
      toast.error(err?.message || "Could not mark ticket resolved.");
    } finally {
      setResolvingTicketId(null);
    }
  };

  const handleVerifyNewEstatePostcode = async () => {
    const clean = newEstatePostcode.trim();
    if (!clean) {
      toast.error("Enter a UK postcode first.");
      return;
    }
    setVerifyingPostcode(true);
    try {
      const geo = await lookupPostcode(clean);
      if (geo) {
        setNewEstatePostcode(geo.postcode || clean.toUpperCase());
        setNewEstateCity(geo.city || newEstateCity);
        setNewEstateLat(geo.latitude);
        setNewEstateLng(geo.longitude);
        toast.success(`Postcode verified: ${geo.city || geo.postcode}`);
      } else {
        toast.error("Could not find that UK postcode. Please double-check it.");
      }
    } catch {
      toast.error("Postcode lookup failed.");
    } finally {
      setVerifyingPostcode(false);
    }
  };

  const handleAddEstate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast.error("Please sign in to onboard an estate.");
      return;
    }
    if (!newEstateName.trim()) {
      toast.error("Estate or block name is required.");
      return;
    }

    const addedUnits = Math.max(1, parseInt(newEstateUnits, 10) || 1);
    setSavingEstate(true);
    try {
      let lat = newEstateLat;
      let lng = newEstateLng;
      let city = newEstateCity.trim();
      const postcode = newEstatePostcode.trim().toUpperCase();

      if ((lat === undefined || lng === undefined) && postcode) {
        try {
          const geo = await lookupPostcode(postcode);
          if (geo) {
            lat = geo.latitude;
            lng = geo.longitude;
            if (!city) city = geo.city;
          }
        } catch {
          // non-fatal
        }
      }

      await createPropertyViaCommand(user, {
        name: newEstateName.trim(),
        association: newEstateAssoc.trim() || "Managed Portfolio",
        propertyType: "apartment",
        unitCount: addedUnits,
        address: {
          line1: newEstateAddress.trim() || newEstateName.trim(),
          city,
          postcode,
          country: "UK",
        },
        postcode,
        city,
        lat,
        lng,
      });

      const newTotal = totalUnits + addedUnits;
      const updatedPlan = calculateGothamSaaSPlan(newTotal, saasBillingCycle);
      toast.success(
        `Onboarded ${newEstateName.trim()} (${addedUnits} ${addedUnits === 1 ? "door" : "doors"}). ` +
        `Portfolio total: ${newTotal.toLocaleString()} doors (${updatedPlan.tierName}).`
      );

      setIsOnboardingOpen(false);
      setNewEstateName("");
      setNewEstateAssoc("");
      setNewEstateAddress("");
      setNewEstatePostcode("");
      setNewEstateCity("");
      setNewEstateLat(undefined);
      setNewEstateLng(undefined);
      setNewEstateUnits("10");
    } catch (err: any) {
      console.error("Onboard estate error:", err);
      toast.error(err?.message || "Could not onboard estate block.");
    } finally {
      setSavingEstate(false);
    }
  };

  const handleRunSlaAudit = () => {
    const breachedCount = openTickets.filter((t) => t.slaStatus === "breached").length;
    const awaabOpenCount = openTickets.filter((t) => t.isAwaabRisk).length;
    const expiredCertProperties = estates.filter(
      (e) => e.cp12Status !== "valid" || e.eicrStatus !== "valid"
    ).length;

    setLastAuditSummary({
      runAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      breachedCount,
      awaabOpenCount,
      expiredCertProperties,
    });

    if (breachedCount > 0 || awaabOpenCount > 0 || expiredCertProperties > 0) {
      toast.warning(
        `SLA Audit complete: ${breachedCount} overdue ticket(s), ${awaabOpenCount} open Awaab damp/mould case(s), ${expiredCertProperties} block(s) needing CP12/EICR update.`
      );
    } else {
      toast.success("SLA Audit complete: All monitored tickets and certificates are currently compliant.");
    }
  };

  const handleExportRegulatorAudit = async () => {
    const dateStamp = new Date().toISOString().slice(0, 10);
    const lines = [
      "ANYTRADER GOTHAM — REGULATORY COMPLIANCE & SLA AUDIT REPORT",
      `Generated: ${new Date().toISOString()}`,
      `Account: ${profile?.displayName || profile?.name || user?.email || "Portfolio Owner"}`,
      `Gotham Subscription Status: ${isGothamActive ? (isGothamCanceling ? "Active (Canceling at period end)" : "Active") : "Not Active (Preview)"}`,
      "",
      "--- PORTFOLIO SUMMARY ---",
      `Onboarded Estates / Blocks: ${estates.length}`,
      `Total Managed Doors: ${totalUnits}`,
      `CP12 Gas Safety Compliant Blocks: ${estates.filter((e) => e.cp12Valid).length} / ${estates.length}`,
      `EICR Electrical Compliant Blocks: ${estates.filter((e) => e.eicrValid).length} / ${estates.length}`,
      `Open Tenant Repair Tickets: ${openTickets.length}`,
      `MTD Maintenance Outlays: GBP ${mtdOutlays.total.toFixed(2)} (${mtdOutlays.count} jobs)`,
      "",
      "--- REGISTERED ESTATES ---",
      ...(estates.length === 0
        ? ["No estates onboarded yet."]
        : estates.map(
            (e) =>
              `• ${e.name} (${e.association}) | ${e.unitsCount} doors | ${e.postcode || "No postcode"} | CP12: ${e.cp12Status.toUpperCase()} | EICR: ${e.eicrStatus.toUpperCase()}`
          )),
      "",
      "--- OPEN REPAIR TICKETS ---",
      ...(openTickets.length === 0
        ? ["No open tenant repair tickets."]
        : openTickets.map(
            (t) =>
              `• [${t.priorityLabel}] ${t.category} at ${t.estateName} — Status: ${t.status.toUpperCase()} — SLA: ${t.slaCountdownLabel}${t.linkedJobId ? ` (Job ${t.linkedJobId})` : ""}`
          )),
    ];

    const reportText = lines.join("\n");
    try {
      const blob = new Blob([reportText], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gotham-regulator-audit-${dateStamp}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Downloaded Regulatory Compliance Audit Report.");
    } catch {
      try {
        await navigator.clipboard.writeText(reportText);
        toast.success("Audit report copied to clipboard.");
      } catch {
        toast.error("Could not export audit report.");
      }
    }
  };

  const handleCopyPartnerInvite = async () => {
    const inviteUrl = `${window.location.origin}/onboarding`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Copied contractor onboarding link to clipboard.");
    } catch {
      toast.error("Could not copy invite link.");
    }
  };

  const filteredEstates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return estates;
    return estates.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.association.toLowerCase().includes(q) ||
        e.postcode.toLowerCase().includes(q) ||
        e.city.toLowerCase().includes(q)
    );
  }, [estates, searchQuery]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 font-sans">
      {/* Gotham Enterprise Layer Branding Header */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-6 sm:p-8 rounded-2xl border border-white/20 shadow-xl relative overflow-hidden">
        <div className="absolute right-0 top-0 bottom-0 w-1/3 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-500/20 via-transparent to-transparent pointer-events-none" />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider">
              <Building2 className="w-4 h-4 text-slate-950" />
              Gotham B2B Enterprise & Housing Association Layer
            </div>
            <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight">
              Social Housing & Portfolio Automation
            </h1>
            <p className="text-sm text-slate-300 font-medium leading-relaxed">
              Portfolio management command center monitoring <strong>{totalUnits.toLocaleString()} {totalUnits === 1 ? "door" : "doors"}</strong> across {estates.length} registered {estates.length === 1 ? "estate" : "estates"} with live SLA repair tracking and server-authoritative job dispatch.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              onClick={() => {
                setCalculatorDoors(Math.max(10, totalUnits || purchasedDoors || 100));
                setIsSaaSCalculatorOpen(true);
              }}
              className="px-4 py-3 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black text-xs rounded-2xl border border-black shadow-lg flex items-center gap-2 transition active:scale-95"
            >
              <Calculator className="w-4 h-4 text-slate-950" />
              <span>SaaS Fee Calculator</span>
              <span className="bg-slate-950 text-amber-300 text-[10px] px-2 py-0.5 rounded-md font-mono">
                £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)}/door
              </span>
            </button>

            <button
              onClick={() => setIsOnboardingOpen(true)}
              className="px-5 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-xs rounded-2xl border border-white/20 shadow-lg flex items-center gap-2 transition active:scale-95"
            >
              <Plus className="w-4 h-4" />
              <span>Onboard Housing Estate</span>
            </button>
          </div>
        </div>

        {/* Quick KPI Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8 pt-6 border-t border-white/15">
          <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
            <p className="text-[10px] uppercase font-extrabold text-slate-400">Total Managed Doors</p>
            <p className="text-2xl font-black text-white mt-1">{totalUnits.toLocaleString()} Units</p>
            <p className="text-[10px] text-emerald-400 font-semibold mt-0.5">
              {estates.length} {estates.length === 1 ? "Estate Block" : "Estate Blocks"} Registered
            </p>
          </div>

          <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
            <p className="text-[10px] uppercase font-extrabold text-slate-400">Open Tenant Repairs</p>
            <p className="text-2xl font-black text-amber-300 mt-1">{openTickets.length} Tickets</p>
            <p className="text-[10px] text-slate-300 font-semibold mt-0.5">
              {tickets.filter((t) => t.status === "dispatched").length} Dispatched to Trades
            </p>
          </div>

          <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
            <p className="text-[10px] uppercase font-extrabold text-slate-400">Priority / Awaab Alerts</p>
            <p className="text-2xl font-black text-rose-400 mt-1">{urgentOrAwaabCount} Flagged</p>
            <p className="text-[10px] text-rose-300 font-semibold mt-0.5">24h Mandatory Remediation</p>
          </div>

          <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
            <p className="text-[10px] uppercase font-extrabold text-slate-400">
              {isGothamActive ? "Monthly Gotham License" : "Estimated Monthly License"}
            </p>
            <p className="text-2xl font-black text-indigo-300 mt-1">
              £{currentSaasPlan.monthlyFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-emerald-400 font-semibold mt-0.5">
              {isGothamActive ? "Active" : "Preview"} • £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)}/door
            </p>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 overflow-x-auto no-scrollbar gap-2">
        {[
          { id: "overview", label: "Dashboard Overview", icon: LayoutGrid },
          { id: "estates", label: `Housing Estates (${estates.length})`, icon: Building2 },
          { id: "repairs", label: `SLA Repairs (${openTickets.length})`, icon: Wrench },
          { id: "billing", label: "Gotham B2B SaaS Billing", icon: Receipt },
          { id: "contractors", label: "Approved Trader Network", icon: ShieldCheck },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={cn(
                "flex items-center gap-2 px-5 py-3 font-extrabold text-xs whitespace-nowrap border-b-2 transition -mb-px rounded-t-2xl",
                isActive
                  ? "border-indigo-600 text-indigo-700 bg-indigo-50/50"
                  : "border-transparent text-black/70 hover:text-black hover:bg-slate-50"
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {loadingData ? (
        <div className="bg-white p-12 rounded-2xl border border-black flex items-center justify-center gap-3 text-sm font-bold text-black">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
          Loading portfolio estates and live tenant SLA tickets...
        </div>
      ) : (
        <>
          {/* --- TAB 1: OVERVIEW --- */}
          {activeTab === "overview" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Live Repairs Monitor */}
                <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-black shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <div>
                      <h3 className="text-base font-black text-black">Live SLA Repair Tickets</h3>
                      <p className="text-xs text-slate-600 font-semibold mt-0.5">
                        Real-time tenant repair reports with Awaab&apos;s Law damp/mould SLA tracking
                      </p>
                    </div>
                    <span className="bg-rose-50 text-rose-700 font-black text-[10px] px-3 py-1 rounded-full border border-rose-200 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 text-rose-600" />
                      Awaab&apos;s Law Monitor
                    </span>
                  </div>

                  {tickets.length === 0 ? (
                    <div className="p-8 rounded-2xl bg-slate-50 border border-black text-center space-y-3">
                      <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
                      <div>
                        <p className="font-black text-sm text-black">No tenant repair tickets logged yet</p>
                        <p className="text-xs text-slate-600 mt-1">
                          Share your Property Passport tenant repair link from Portfolio so tenants can report issues directly into this SLA queue.
                        </p>
                      </div>
                      <Link
                        to="/portfolio"
                        className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-extrabold rounded-xl border border-black transition"
                      >
                        Open Property Portfolio
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {tickets.slice(0, 6).map((ticket) => (
                        <div
                          key={ticket.id}
                          className="p-4 rounded-2xl bg-slate-50 border border-black space-y-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-black text-black bg-white px-2 py-0.5 rounded border border-black">
                                #{ticket.id.slice(-6).toUpperCase()}
                              </span>
                              <span className="text-xs font-extrabold text-black">{ticket.estateName}</span>
                              {ticket.isAwaabRisk && (
                                <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-300">
                                  Awaab&apos;s Law
                                </span>
                              )}
                            </div>

                            <span
                              className={cn(
                                "text-[10px] font-black uppercase px-2.5 py-0.5 rounded-full border",
                                ticket.urgency === "emergency"
                                  ? "bg-rose-100 text-rose-800 border-rose-300"
                                  : ticket.urgency === "urgent"
                                  ? "bg-amber-100 text-amber-800 border-amber-300"
                                  : "bg-indigo-100 text-indigo-800 border-indigo-300"
                              )}
                            >
                              {ticket.priorityLabel}
                            </span>
                          </div>

                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                            <div>
                              <p className="font-bold text-black">{ticket.category}</p>
                              {ticket.description && (
                                <p className="text-xs text-slate-700 mt-0.5 line-clamp-2">{ticket.description}</p>
                              )}
                              <p className="text-[11px] text-slate-600 mt-1">
                                Reported by: {ticket.tenantName} ({ticket.reportedLabel})
                              </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                              <div className="text-right mr-1">
                                <p className="text-[10px] font-bold text-slate-500 uppercase">SLA Status</p>
                                <p
                                  className={cn(
                                    "font-mono font-black text-xs",
                                    ticket.slaStatus === "breached"
                                      ? "text-rose-700"
                                      : ticket.slaStatus === "warning"
                                      ? "text-amber-700"
                                      : "text-emerald-700"
                                  )}
                                >
                                  {ticket.slaCountdownLabel}
                                </p>
                              </div>

                              {ticket.status === "resolved" ? (
                                <span className="bg-emerald-50 text-emerald-800 font-black text-[10px] px-3 py-1.5 rounded-xl border border-emerald-300 flex items-center gap-1">
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                  Resolved
                                </span>
                              ) : ticket.status === "dispatched" ? (
                                <div className="flex items-center gap-2">
                                  {ticket.linkedJobId && (
                                    <Link
                                      to={`/job/${ticket.linkedJobId}`}
                                      className="px-3 py-1.5 bg-white hover:bg-slate-100 text-black font-extrabold text-xs rounded-xl border border-black transition flex items-center gap-1"
                                    >
                                      View Job
                                      <ExternalLink className="w-3 h-3" />
                                    </Link>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleResolveTicket(ticket)}
                                    disabled={resolvingTicketId === ticket.id}
                                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl border border-black transition"
                                  >
                                    {resolvingTicketId === ticket.id ? "Saving..." : "Mark Resolved"}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleAutoDispatchTicket(ticket)}
                                  disabled={dispatchingTicketId === ticket.id}
                                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-xs rounded-xl border border-black transition active:scale-95 flex items-center gap-1 shadow-sm disabled:opacity-60"
                                >
                                  {dispatchingTicketId === ticket.id ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Zap className="w-3.5 h-3.5 text-amber-300" />
                                  )}
                                  1-Tap Auto Dispatch
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Compliance Matrix Side Column */}
                <div className="space-y-6">
                  <div className="bg-slate-900 text-white p-6 rounded-2xl border border-white/20 shadow-sm space-y-4">
                    <div className="flex items-center justify-between border-b border-white/15 pb-3">
                      <h3 className="text-base font-black text-white flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 text-emerald-400" />
                        Regulatory Compliance
                      </h3>
                      <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-black px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                        Live Portfolio
                      </span>
                    </div>

                    <div className="space-y-3">
                      <div className="p-3 bg-white/5 rounded-2xl border border-white/20 flex items-center justify-between">
                        <div>
                          <p className="text-xs font-bold text-slate-200">CP12 Gas Safety Compliance</p>
                          <p className="text-[10px] text-slate-400">Valid future expiry recorded</p>
                        </div>
                        <span className="text-lg font-black text-emerald-400">
                          {complianceMetrics.cp12Pct !== null ? `${complianceMetrics.cp12Pct}%` : "N/A"}
                        </span>
                      </div>

                      <div className="p-3 bg-white/5 rounded-2xl border border-white/20 flex items-center justify-between">
                        <div>
                          <p className="text-xs font-bold text-slate-200">EICR Electrical Safety</p>
                          <p className="text-[10px] text-slate-400">5-Year certification status</p>
                        </div>
                        <span className="text-lg font-black text-emerald-400">
                          {complianceMetrics.eicrPct !== null ? `${complianceMetrics.eicrPct}%` : "N/A"}
                        </span>
                      </div>

                      <div className="p-3 bg-white/5 rounded-2xl border border-white/20 flex items-center justify-between">
                        <div>
                          <p className="text-xs font-bold text-slate-200">Awaab Damp &amp; Mould SLA</p>
                          <p className="text-[10px] text-slate-400">Active cases within SLA window</p>
                        </div>
                        <span className="text-lg font-black text-amber-300">
                          {complianceMetrics.awaabPct !== null ? `${complianceMetrics.awaabPct}%` : "N/A"}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={handleExportRegulatorAudit}
                      className="w-full py-2.5 bg-white text-slate-950 font-black text-xs rounded-xl border border-black hover:bg-slate-100 transition flex items-center justify-center gap-2"
                    >
                      <Download className="w-4 h-4 text-slate-950" />
                      Export Regulator Audit Report
                    </button>
                  </div>

                  {/* Gotham B2B SaaS Summary Widget */}
                  <div className="bg-indigo-50 border border-black p-6 rounded-2xl space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "text-[10px] uppercase font-black tracking-wider px-2.5 py-0.5 rounded-full border",
                          isGothamActive
                            ? isGothamCanceling
                              ? "text-amber-800 bg-amber-100 border-amber-300"
                              : "text-emerald-800 bg-emerald-100 border-emerald-300"
                            : "text-amber-900 bg-amber-100 border-amber-300"
                        )}
                      >
                        {isGothamActive
                          ? isGothamCanceling
                            ? "Canceling at Renewal"
                            : "B2B SaaS Plan Active"
                          : "Plan Not Active — Preview"}
                      </span>
                      <span className="text-xs font-black text-black">
                        £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)}/door
                      </span>
                    </div>
                    <div>
                      <h4 className="text-lg font-black text-black">{currentSaasPlan.tierName}</h4>
                      <p className="text-xs text-black/80 font-medium mt-0.5">
                        {billingDoorCount.toLocaleString()} Managed {billingDoorCount === 1 ? "Door" : "Doors"} @ £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)} ={" "}
                        <strong>
                          £{currentSaasPlan.monthlyFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo
                        </strong>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab("billing")}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl border border-black transition flex items-center justify-center gap-1"
                    >
                      <span>{isGothamActive ? "Manage SaaS Plan & Billing" : "Activate Gotham SaaS Plan"}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* --- TAB 2: HOUSING ESTATES & BLOCKS --- */}
          {activeTab === "estates" && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search estates, housing associations, or postcodes..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-4 py-2.5 bg-white border border-black rounded-2xl text-xs font-bold text-black focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setIsOnboardingOpen(true)}
                  className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-2xl border border-black shadow-sm flex items-center gap-2 self-start sm:self-auto"
                >
                  <Plus className="w-4 h-4" />
                  Onboard New Estate Block
                </button>
              </div>

              {filteredEstates.length === 0 ? (
                <div className="bg-white p-10 rounded-2xl border border-black text-center space-y-3">
                  <Building2 className="w-9 h-9 text-indigo-600 mx-auto" />
                  <h3 className="text-base font-black text-black">
                    {estates.length === 0 ? "No housing estates onboarded yet" : "No estates match your search"}
                  </h3>
                  <p className="text-xs text-slate-600 max-w-md mx-auto">
                    {estates.length === 0
                      ? "Onboard your first housing block or portfolio property to track CP12/EICR compliance, Awaab's Law SLA tickets, and per-door SaaS licensing."
                      : "Try clearing your search query to view all registered blocks."}
                  </p>
                  {estates.length === 0 && (
                    <button
                      type="button"
                      onClick={() => setIsOnboardingOpen(true)}
                      className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl border border-black transition"
                    >
                      <Plus className="w-4 h-4" />
                      Onboard First Estate
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {filteredEstates.map((estate) => {
                    const estateSaasFee = estate.unitsCount * currentSaasPlan.effectiveRatePerDoor;
                    const estateOpenTickets = openTickets.filter((t) => t.propertyId === estate.id).length;
                    const estateAwaabAlerts = openTickets.filter((t) => t.propertyId === estate.id && t.isAwaabRisk).length;
                    return (
                      <div
                        key={estate.id}
                        className="bg-white p-6 rounded-2xl border border-black shadow-sm space-y-4 hover:shadow-md transition"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <span className="text-[10px] font-mono font-black text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                              {estate.postcode || estate.id.slice(-6).toUpperCase()}
                            </span>
                            <h3 className="text-lg font-black text-black mt-1">{estate.name}</h3>
                            <p className="text-xs text-slate-600 font-semibold">{estate.association}</p>
                          </div>

                          <span className="bg-slate-100 text-black font-black text-xs px-3 py-1 rounded-2xl border border-black shrink-0">
                            {estate.unitsCount} {estate.unitsCount === 1 ? "Unit" : "Units"}
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2 bg-slate-50 p-3 rounded-2xl border border-black text-center">
                          <div>
                            <p className="text-[9px] uppercase font-bold text-slate-600">Open Repairs</p>
                            <p className="text-sm font-black text-black">{estateOpenTickets}</p>
                          </div>
                          <div>
                            <p className="text-[9px] uppercase font-bold text-slate-600">CP12 Gas</p>
                            <p
                              className={cn(
                                "text-xs font-black uppercase mt-0.5",
                                estate.cp12Status === "valid"
                                  ? "text-emerald-700"
                                  : estate.cp12Status === "expired"
                                  ? "text-rose-700"
                                  : "text-amber-700"
                              )}
                            >
                              {estate.cp12Status}
                            </p>
                          </div>
                          <div>
                            <p className="text-[9px] uppercase font-bold text-slate-600">EICR Elec</p>
                            <p
                              className={cn(
                                "text-xs font-black uppercase mt-0.5",
                                estate.eicrStatus === "valid"
                                  ? "text-emerald-700"
                                  : estate.eicrStatus === "expired"
                                  ? "text-rose-700"
                                  : "text-amber-700"
                              )}
                            >
                              {estate.eicrStatus}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2 text-xs border-t border-slate-200">
                          <div className="text-slate-700 font-medium">
                            {estateAwaabAlerts > 0 ? (
                              <span className="text-rose-700 font-black">
                                {estateAwaabAlerts} Awaab Damp Alert{estateAwaabAlerts > 1 ? "s" : ""}
                              </span>
                            ) : (
                              <span>{estate.city || estate.addressLine1 || "Registered Property Passport"}</span>
                            )}
                          </div>

                          <div className="text-right">
                            <span className="text-[10px] text-slate-500 block font-bold uppercase">
                              SaaS License Share
                            </span>
                            <span className="font-black text-indigo-700">
                              £{estateSaasFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* --- TAB 3: SLA REPAIRS & AUTO DISPATCH --- */}
          {activeTab === "repairs" && (
            <div className="bg-white p-6 sm:p-8 rounded-2xl border border-black shadow-sm space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-5">
                <div>
                  <h3 className="text-xl font-black text-black">SLA Repair Ticket Command Center</h3>
                  <p className="text-xs text-slate-600 font-semibold mt-0.5">
                    Server-authoritative dispatching linking tenant Property Passport specs directly to verified AnyTrader jobs.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleRunSlaAudit}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs rounded-2xl border border-black shadow-sm flex items-center gap-2 self-start sm:self-auto"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Run SLA Audit
                </button>
              </div>

              {lastAuditSummary && (
                <div className="p-4 rounded-2xl bg-indigo-50 border border-black flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-black">
                  <span>
                    SLA Audit ({lastAuditSummary.runAt}):{" "}
                    <strong>{lastAuditSummary.breachedCount}</strong> overdue ticket(s),{" "}
                    <strong>{lastAuditSummary.awaabOpenCount}</strong> open Awaab damp/mould case(s),{" "}
                    <strong>{lastAuditSummary.expiredCertProperties}</strong> block(s) needing CP12/EICR update.
                  </span>
                  <button
                    type="button"
                    onClick={() => setLastAuditSummary(null)}
                    className="text-indigo-700 hover:underline font-black"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {tickets.length === 0 ? (
                <div className="p-8 rounded-2xl bg-slate-50 border border-black text-center space-y-2">
                  <p className="font-black text-sm text-black">No repair tickets in queue</p>
                  <p className="text-xs text-slate-600">
                    When tenants submit reports via their Property Passport link, they will appear here automatically.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {tickets.map((t) => (
                    <div key={t.id} className="p-5 rounded-2xl border border-black bg-slate-50 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-xs font-black text-black bg-white px-2.5 py-1 rounded-lg border border-black">
                            #{t.id.slice(-6).toUpperCase()}
                          </span>
                          <div>
                            <h4 className="font-black text-black text-sm">{t.category}</h4>
                            <p className="text-xs text-slate-600 font-medium">
                              {t.estateName} — <strong>{t.tenantName}</strong> ({t.reportedLabel})
                            </p>
                          </div>
                        </div>

                        <span
                          className={cn(
                            "text-xs font-black px-3 py-1 rounded-full border uppercase tracking-wider",
                            t.urgency === "emergency"
                              ? "bg-rose-100 text-rose-800 border-rose-300"
                              : t.urgency === "urgent"
                              ? "bg-amber-100 text-amber-800 border-amber-300"
                              : "bg-indigo-100 text-indigo-800 border-indigo-300"
                          )}
                        >
                          {t.priorityLabel}
                        </span>
                      </div>

                      {t.description && (
                        <p className="text-xs text-black/80 bg-white p-3 rounded-xl border border-slate-200">
                          {t.description}
                        </p>
                      )}

                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-black text-xs">
                        <div>
                          <span className="text-slate-500 font-bold uppercase text-[10px]">SLA Window:</span>
                          <p
                            className={cn(
                              "font-black mt-0.5",
                              t.slaStatus === "breached"
                                ? "text-rose-700"
                                : t.slaStatus === "warning"
                                ? "text-amber-700"
                                : "text-emerald-700"
                            )}
                          >
                            {t.slaCountdownLabel}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          <div>
                            <span className="text-slate-500 font-bold uppercase text-[10px] block">Status</span>
                            <span className="font-black text-indigo-700 uppercase">{t.status}</span>
                          </div>

                          {t.linkedJobId && (
                            <Link
                              to={`/job/${t.linkedJobId}`}
                              className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-black font-extrabold text-xs rounded-xl border border-black flex items-center gap-1.5 transition"
                            >
                              View Dispatched Job
                              <ExternalLink className="w-3.5 h-3.5" />
                            </Link>
                          )}

                          {t.status === "open" && (
                            <button
                              type="button"
                              onClick={() => handleAutoDispatchTicket(t)}
                              disabled={dispatchingTicketId === t.id}
                              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-xs rounded-xl border border-black shadow-sm transition active:scale-95 flex items-center gap-1.5 disabled:opacity-60"
                            >
                              {dispatchingTicketId === t.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Zap className="w-3.5 h-3.5 text-amber-300" />
                              )}
                              Dispatch Trade Job
                            </button>
                          )}

                          {t.status !== "resolved" && (
                            <button
                              type="button"
                              onClick={() => handleResolveTicket(t)}
                              disabled={resolvingTicketId === t.id}
                              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl border border-black transition flex items-center gap-1"
                            >
                              <Check className="w-3.5 h-3.5" />
                              {resolvingTicketId === t.id ? "Saving..." : "Mark Resolved"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* --- TAB 4: CONSOLIDATED ENTERPRISE BILLING & GOTHAM SAAS LICENSE --- */}
          {activeTab === "billing" && (
            <div className="space-y-6">
              {/* Gotham B2B Enterprise SaaS Banner */}
              <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-6 sm:p-8 rounded-2xl border border-white/20 shadow-lg relative overflow-hidden space-y-5">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-white/15 pb-5">
                  <div className="space-y-1">
                    <div
                      className={cn(
                        "inline-flex items-center gap-2 px-3 py-0.5 rounded-full font-black text-[10px] uppercase tracking-wider",
                        isGothamActive ? "bg-emerald-400 text-slate-950" : "bg-amber-400 text-slate-950"
                      )}
                    >
                      <Sparkles className="w-3 h-3 text-slate-950" />
                      {isGothamActive
                        ? isGothamCanceling
                          ? "Gotham B2B SaaS — Cancellation Scheduled"
                          : "Active Gotham B2B SaaS Licensing Plan"
                        : "Gotham B2B SaaS Preview — Not Yet Subscribed"}
                    </div>
                    <h3 className="text-2xl font-black text-white flex items-center gap-2">
                      <Building2 className="w-6 h-6 text-indigo-400" />
                      {currentSaasPlan.tierName}
                    </h3>
                    <p className="text-xs text-slate-300 font-medium">
                      Per-door SaaS licensing engine for automated repair dispatch, CP12/EICR compliance, and SLA tracking.
                    </p>
                  </div>

                  {/* Billing Cycle Toggle */}
                  <div className="flex items-center gap-2 bg-black/40 p-1.5 rounded-2xl border border-white/15 self-start md:self-auto">
                    <button
                      type="button"
                      onClick={() => setSaasBillingCycle("monthly")}
                      className={cn(
                        "px-3 py-1.5 text-xs font-black rounded-xl transition",
                        saasBillingCycle === "monthly"
                          ? "bg-white text-slate-950 shadow-sm"
                          : "text-slate-300 hover:text-white"
                      )}
                    >
                      Monthly (£{currentSaasPlan.ratePerDoor.toFixed(2)}/door)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSaasBillingCycle("annual")}
                      className={cn(
                        "px-3 py-1.5 text-xs font-black rounded-xl transition flex items-center gap-1",
                        saasBillingCycle === "annual"
                          ? "bg-amber-400 text-slate-950 shadow-sm"
                          : "text-slate-300 hover:text-white"
                      )}
                    >
                      <span>Annual</span>
                      <span className="bg-emerald-600 text-white text-[9px] px-1.5 py-0.5 rounded-md uppercase font-bold">
                        15% OFF
                      </span>
                    </button>
                  </div>
                </div>

                {/* SaaS Metrics Row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
                    <p className="text-[10px] uppercase font-bold text-slate-400">Managed Housing Doors</p>
                    <p className="text-2xl font-black text-white mt-0.5">
                      {billingDoorCount.toLocaleString()}{" "}
                      <span className="text-xs text-slate-400 font-normal">Units</span>
                    </p>
                    <p className="text-[10px] text-indigo-300 font-semibold mt-1">
                      Across {estates.length} {estates.length === 1 ? "Estate" : "Estates"}
                    </p>
                  </div>

                  <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
                    <p className="text-[10px] uppercase font-bold text-slate-400">Per-Door Monthly Rate</p>
                    <p className="text-2xl font-black text-amber-300 mt-0.5">
                      £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)}
                      <span className="text-xs text-slate-400 font-normal"> / door</span>
                    </p>
                    <p className="text-[10px] text-emerald-400 font-semibold mt-1">
                      {saasBillingCycle === "annual" ? "15% Annual Savings Applied" : "Volume Discount Tier"}
                    </p>
                  </div>

                  <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
                    <p className="text-[10px] uppercase font-bold text-slate-400">Monthly SaaS License Fee</p>
                    <p className="text-2xl font-black text-indigo-300 mt-0.5">
                      £{currentSaasPlan.monthlyFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-[10px] text-slate-300 font-semibold mt-1">
                      {isGothamActive ? `Billed ${currentSaasPlan.billingCycle} via Stripe` : "Estimated on current doors"}
                    </p>
                  </div>

                  <div className="bg-white/5 p-4 rounded-2xl border border-white/20">
                    <p className="text-[10px] uppercase font-bold text-slate-400">Est. Awaab Fine Savings</p>
                    <p className="text-2xl font-black text-emerald-400 mt-0.5">
                      £{currentSaasPlan.estimatedRegulatorFineSavings.toLocaleString()}
                    </p>
                    <p className="text-[10px] text-emerald-300 font-semibold mt-1">
                      In avoided damp/mould SLA penalties
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <div className="flex items-center gap-2 text-xs text-slate-300">
                    <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Includes Housing Regulator Compliance Audit Trail &amp; Unlimited Dispatch.</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {isGothamActive ? (
                      isGothamCanceling ? (
                        <button
                          type="button"
                          onClick={handleReactivateGothamSaaS}
                          disabled={isProcessing}
                          className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold text-xs rounded-xl border border-white/20 shadow-md flex items-center gap-1.5 transition"
                        >
                          {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                          Resume Renewal
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleCancelGothamSaaS}
                          disabled={isProcessing}
                          className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-extrabold text-xs rounded-xl border border-black shadow-md flex items-center gap-1.5 transition"
                        >
                          {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4 text-slate-950" />}
                          Cancel at Renewal
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSyncStripeB2BInvoice(Math.max(10, billingDoorCount || 100))}
                        disabled={isProcessing}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-xs rounded-xl border border-white/20 shadow-md flex items-center gap-1.5 transition"
                      >
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4 text-amber-300" />}
                        Subscribe to Gotham SaaS
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleOpenStripePortal}
                      disabled={isProcessing}
                      className="px-3.5 py-2 bg-white/10 hover:bg-white/20 text-white font-extrabold text-xs rounded-xl border border-white/20 flex items-center gap-1.5 transition"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-indigo-300" />
                      Stripe Portal
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setCalculatorDoors(Math.max(10, billingDoorCount || 100));
                        setIsSaaSCalculatorOpen(true);
                      }}
                      className="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-xs rounded-xl border border-black shadow-md flex items-center gap-1.5 transition active:scale-95"
                    >
                      <Calculator className="w-4 h-4" />
                      SaaS Calculator
                    </button>
                  </div>
                </div>
              </div>

              {/* Combined Invoicing & PO Overview Cards (100% live data) */}
              <div className="bg-white p-6 sm:p-8 rounded-2xl border border-black shadow-sm space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-5">
                  <div>
                    <h3 className="text-xl font-black text-black">Consolidated B2B Enterprise Outlays</h3>
                    <p className="text-xs text-slate-600 font-semibold mt-0.5">
                      Live breakdown between Gotham SaaS platform licensing and your month-to-date contractor maintenance jobs.
                    </p>
                  </div>
                  <div
                    className={cn(
                      "px-4 py-2 rounded-2xl font-black text-xs flex items-center gap-2 shrink-0 border",
                      isGothamActive
                        ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                        : "bg-amber-50 text-amber-900 border-amber-300"
                    )}
                  >
                    <CheckCircle2 className={cn("w-4 h-4", isGothamActive ? "text-emerald-600" : "text-amber-600")} />
                    {isGothamActive ? "Stripe Billing Active" : "Billing Preview (Not Active)"}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-slate-900 text-white p-5 rounded-2xl border border-white/20 space-y-1">
                    <p className="text-[10px] uppercase font-bold text-slate-400">1. Gotham SaaS License Fee</p>
                    <p className="text-3xl font-black text-amber-300">
                      £{currentSaasPlan.monthlyFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-[11px] text-slate-300">
                      {billingDoorCount.toLocaleString()} Doors @ £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)}/mo
                    </p>
                  </div>

                  <div className="bg-slate-50 p-5 rounded-2xl border border-black space-y-1">
                    <p className="text-[10px] uppercase font-bold text-slate-600">2. Contractor Maintenance Jobs (MTD)</p>
                    <p className="text-3xl font-black text-black">
                      £{mtdOutlays.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-[11px] text-slate-600">
                      {mtdOutlays.count} active/completed {mtdOutlays.count === 1 ? "job" : "jobs"} this month
                    </p>
                  </div>

                  <div className="bg-indigo-50 p-5 rounded-2xl border border-black space-y-1">
                    <p className="text-[10px] uppercase font-bold text-indigo-800">3. Total Estimated Outlay (MTD)</p>
                    <p className="text-3xl font-black text-black">
                      £{(mtdOutlays.total + currentSaasPlan.monthlyFee).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-[11px] text-indigo-800 font-semibold">
                      Combined SaaS license + month-to-date job value
                    </p>
                  </div>
                </div>
              </div>

              {/* Estate Per-Door License Fee Allocation Table */}
              <div className="bg-white border border-black rounded-2xl shadow-sm overflow-hidden">
                <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-black text-black">Per-Estate SaaS Licensing Allocation</h3>
                    <p className="text-xs text-slate-600 font-semibold">
                      Monthly SaaS licensing fee distribution across each registered housing estate block.
                    </p>
                  </div>
                  <span className="text-xs font-black text-indigo-700 bg-indigo-50 px-3 py-1 rounded-xl border border-indigo-200">
                    Volume Rate: £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)} / door
                  </span>
                </div>

                {estates.length === 0 ? (
                  <div className="p-8 text-center text-xs font-bold text-slate-600">
                    No estates registered yet. Onboard an estate block to see per-estate license allocation.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-black font-extrabold text-black uppercase">
                          <th className="px-6 py-4">Estate Block</th>
                          <th className="px-6 py-4">Association / Portfolio</th>
                          <th className="px-6 py-4 text-center">Managed Units</th>
                          <th className="px-6 py-4">Licensing Rate</th>
                          <th className="px-6 py-4 text-right">Monthly SaaS Contribution</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 font-semibold text-black">
                        {estates.map((est) => {
                          const estateSaasFee = est.unitsCount * currentSaasPlan.effectiveRatePerDoor;
                          return (
                            <tr key={est.id} className="hover:bg-slate-50 transition">
                              <td className="px-6 py-4">
                                <div className="font-black text-black text-sm">{est.name}</div>
                                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                                  {est.postcode || est.id}
                                </div>
                              </td>
                              <td className="px-6 py-4 text-slate-700">{est.association}</td>
                              <td className="px-6 py-4 text-center font-black text-indigo-700">
                                {est.unitsCount.toLocaleString()}
                              </td>
                              <td className="px-6 py-4 font-bold text-slate-700">
                                £{currentSaasPlan.effectiveRatePerDoor.toFixed(2)} / door / mo
                              </td>
                              <td className="px-6 py-4 text-right font-black text-black text-sm">
                                £{estateSaasFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* --- TAB 5: CONTRACTOR NETWORK MATRIX --- */}
          {activeTab === "contractors" && (
            <div className="bg-white p-6 sm:p-8 rounded-2xl border border-black shadow-sm space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-5">
                <div>
                  <h3 className="text-xl font-black text-black">Approved B2B Trade Contractor Network</h3>
                  <p className="text-xs text-slate-600 font-semibold mt-0.5">
                    Live directory of verified AnyTrader tradespeople available for housing SLA dispatch.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyPartnerInvite}
                    className="px-4 py-2 bg-white hover:bg-slate-50 text-black font-extrabold text-xs rounded-2xl border border-black shadow-sm transition flex items-center gap-1.5"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy Contractor Invite Link
                  </button>
                  <Link
                    to="/find-trades"
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-2xl border border-black shadow-sm transition flex items-center gap-1.5"
                  >
                    Browse All Trades
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>

              {contractors.length === 0 ? (
                <div className="p-8 rounded-2xl bg-slate-50 border border-black text-center space-y-2">
                  <p className="font-black text-sm text-black">No tradesperson profiles indexed yet</p>
                  <p className="text-xs text-slate-600">
                    Share your contractor onboarding link or search the live marketplace directory.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {contractors.map((c) => (
                    <Link
                      key={c.uid}
                      to={`/profile/${c.uid}`}
                      className="p-5 rounded-2xl border border-black bg-slate-50 hover:bg-white space-y-3 transition block"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white font-black flex items-center justify-center text-sm border border-black shrink-0">
                          {c.name.charAt(0).toUpperCase()}
                        </div>
                        <span
                          className={cn(
                            "text-[10px] font-black px-2.5 py-0.5 rounded-full border",
                            c.verified
                              ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                              : "bg-slate-200 text-slate-700 border-slate-300"
                          )}
                        >
                          {c.verified ? "Verified Pro" : "Registered"}
                        </span>
                      </div>

                      <div>
                        <h4 className="font-black text-black text-sm truncate">{c.name}</h4>
                        <p className="text-xs text-slate-700 font-semibold mt-0.5 truncate">{c.primaryTrade}</p>
                        <p className="text-xs text-slate-600 font-medium mt-0.5">
                          {c.reviewCount > 0 ? `Rating: ${c.rating.toFixed(1)} / 5.0 (${c.reviewCount})` : "New on AnyTrader"}
                        </p>
                      </div>

                      <div className="pt-2 border-t border-slate-200 text-xs flex justify-between text-slate-700">
                        <span>
                          Completed: <strong>{c.completedJobsCount} Jobs</strong>
                        </span>
                        <span>
                          {c.avgResponseMinutes ? (
                            <>
                              Avg Resp: <strong>{c.avgResponseMinutes}m</strong>
                            </>
                          ) : (
                            c.city || "UK Wide"
                          )}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* --- MODAL: ONBOARD NEW HOUSING ESTATE --- */}
      <AnimatePresence>
        {isOnboardingOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl border border-black shadow-2xl max-w-lg w-full p-6 space-y-5 overflow-y-auto max-h-[90vh] relative"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <h3 className="text-lg font-black text-black">Onboard New Housing Development</h3>
                <button
                  type="button"
                  onClick={() => setIsOnboardingOpen(false)}
                  className="p-2 text-slate-500 hover:text-black rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleAddEstate} className="space-y-4 text-xs font-bold">
                <div>
                  <label className="block text-black mb-1">Estate / Block Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. St. George Riverside Blocks"
                    value={newEstateName}
                    onChange={(e) => setNewEstateName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-black rounded-xl text-black focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-black mb-1">Housing Association Trust / Council Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Southwark Local Council"
                    value={newEstateAssoc}
                    onChange={(e) => setNewEstateAssoc(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-black rounded-xl text-black focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-black mb-1">Street Address / Development Location *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 14 Riverside Way"
                    value={newEstateAddress}
                    onChange={(e) => setNewEstateAddress(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-black rounded-xl text-black focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-black mb-1">UK Postcode *</label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        required
                        placeholder="e.g. SE1 2AA"
                        value={newEstatePostcode}
                        onChange={(e) => setNewEstatePostcode(e.target.value.toUpperCase())}
                        className="flex-1 min-w-0 px-3 py-2 bg-slate-50 border border-black rounded-xl text-black focus:outline-none uppercase"
                      />
                      <button
                        type="button"
                        onClick={handleVerifyNewEstatePostcode}
                        disabled={verifyingPostcode}
                        className="px-3 py-2 bg-slate-900 text-white rounded-xl border border-black text-[11px] font-black flex items-center gap-1 shrink-0"
                      >
                        {verifyingPostcode ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
                        Verify
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-black mb-1">Town / City</label>
                    <input
                      type="text"
                      placeholder="e.g. London"
                      value={newEstateCity}
                      onChange={(e) => setNewEstateCity(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-black rounded-xl text-black focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-black mb-1">Managed Property Units / Doors *</label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={newEstateUnits}
                    onChange={(e) => setNewEstateUnits(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-black rounded-xl text-black focus:outline-none"
                  />
                </div>

                <div className="bg-indigo-50 border border-black p-3 rounded-xl text-[11px] text-black space-y-1">
                  <p className="font-extrabold flex items-center gap-1">
                    <Zap className="w-3.5 h-3.5 text-indigo-600" /> Server-Authoritative Door Quota:
                  </p>
                  <p className="text-slate-700">
                    Onboarding this block persists a real Property Passport to your account and validates against your active Gotham door allowance.
                  </p>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={savingEstate}
                    className="flex-1 py-3 bg-indigo-600 text-white font-extrabold rounded-xl border border-black hover:bg-indigo-700 transition flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {savingEstate && <Loader2 className="w-4 h-4 animate-spin" />}
                    Onboard to Gotham Layer
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsOnboardingOpen(false)}
                    className="px-4 py-3 bg-slate-100 text-black font-extrabold rounded-xl border border-black"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODAL: GOTHAM SAAS LICENSING CALCULATOR & ROI SIMULATOR --- */}
      <AnimatePresence>
        {isSaaSCalculatorOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl border border-black shadow-2xl max-w-xl w-full p-6 space-y-6 overflow-hidden relative max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-2xl bg-amber-400 text-slate-950 flex items-center justify-center font-bold border border-black">
                    <Calculator className="w-5 h-5 text-slate-950" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-black">Gotham B2B SaaS Licensing Calculator</h3>
                    <p className="text-[11px] text-slate-600 font-semibold">
                      Simulate per-property licensing costs and regulatory compliance ROI
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsSaaSCalculatorOpen(false)}
                  className="p-2 text-slate-500 hover:text-black rounded-full hover:bg-slate-100 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Billing Cycle Toggle */}
              <div className="flex items-center justify-between bg-slate-100 p-2 rounded-2xl border border-black">
                <span className="text-xs font-bold text-black uppercase px-2">Billing Term:</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSaasBillingCycle("monthly")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-black rounded-xl transition",
                      saasBillingCycle === "monthly" ? "bg-slate-900 text-white shadow-sm" : "text-slate-700 hover:text-black"
                    )}
                  >
                    Monthly Billing
                  </button>
                  <button
                    type="button"
                    onClick={() => setSaasBillingCycle("annual")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-black rounded-xl transition flex items-center gap-1",
                      saasBillingCycle === "annual" ? "bg-amber-400 text-slate-950 shadow-sm" : "text-slate-700 hover:text-black"
                    )}
                  >
                    <span>Annual Billing</span>
                    <span className="bg-emerald-600 text-white text-[9px] px-1.5 py-0.5 rounded-md font-bold">15% OFF</span>
                  </button>
                </div>
              </div>

              {/* Slider & Input Controls */}
              <div className="space-y-3 bg-slate-50 p-4 rounded-2xl border border-black">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-black text-black uppercase">Simulated Housing Units / Doors:</label>
                  <div className="flex items-center gap-1 bg-white border border-black rounded-xl px-3 py-1">
                    <input
                      type="number"
                      min={10}
                      max={50000}
                      value={calculatorDoors}
                      onChange={(e) => setCalculatorDoors(Math.max(10, parseInt(e.target.value, 10) || 10))}
                      className="w-20 text-right text-sm font-black text-black focus:outline-none"
                    />
                    <span className="text-xs font-bold text-slate-600">Doors</span>
                  </div>
                </div>

                <input
                  type="range"
                  min={10}
                  max={10000}
                  step={10}
                  value={Math.min(10000, calculatorDoors)}
                  onChange={(e) => setCalculatorDoors(parseInt(e.target.value, 10))}
                  className="w-full accent-indigo-600 cursor-pointer"
                />

                {/* Preset Shortcuts */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {[
                    { label: "80 Doors (Starter)", count: 80 },
                    { label: "500 Doors (Growth)", count: 500 },
                    { label: "2,500 Doors (Enterprise)", count: 2500 },
                    { label: "10,000 Doors (Council)", count: 10000 },
                  ].map((preset) => (
                    <button
                      key={preset.count}
                      type="button"
                      onClick={() => setCalculatorDoors(preset.count)}
                      className={cn(
                        "px-2.5 py-1 text-[11px] font-bold rounded-lg border transition",
                        calculatorDoors === preset.count
                          ? "bg-indigo-600 text-white border-black"
                          : "bg-white text-black border-slate-300 hover:bg-slate-100"
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Real-time Calculated Plan Breakdown */}
              {(() => {
                const plan = calculateGothamSaaSPlan(calculatorDoors, saasBillingCycle);
                return (
                  <div className="bg-slate-900 text-white p-5 rounded-2xl border border-white/20 space-y-4">
                    <div className="flex items-center justify-between border-b border-white/15 pb-3">
                      <div>
                        <span className="text-[10px] font-black uppercase text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-md border border-amber-400/20">
                          {plan.tierName}
                        </span>
                        <p className="text-sm font-black text-white mt-1">
                          {calculatorDoors.toLocaleString()} Managed Properties
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-400 font-bold uppercase">Rate / Door / Month</p>
                        <p className="text-xl font-black text-amber-300">
                          £{plan.effectiveRatePerDoor.toFixed(2)}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="bg-white/5 p-3 rounded-xl border border-white/20">
                        <p className="text-[10px] text-slate-400 font-bold uppercase">Monthly SaaS License Fee</p>
                        <p className="text-2xl font-black text-indigo-300 mt-0.5">
                          £{plan.monthlyFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Billed {plan.billingCycle}</p>
                      </div>

                      <div className="bg-white/5 p-3 rounded-xl border border-white/20">
                        <p className="text-[10px] text-slate-400 font-bold uppercase">Annualized License Total</p>
                        <p className="text-2xl font-black text-white mt-0.5">
                          £{plan.annualTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                        <p className="text-[10px] text-emerald-400 font-semibold mt-0.5">
                          {saasBillingCycle === "annual"
                            ? `Saves £${plan.annualDiscountSavings.toLocaleString()}/yr`
                            : "Save 15% with Annual"}
                        </p>
                      </div>
                    </div>

                    <div className="bg-emerald-950/50 border border-emerald-500/30 p-3 rounded-xl space-y-1 text-xs">
                      <p className="font-extrabold text-emerald-300 flex items-center gap-1">
                        <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                        Estimated Regulatory &amp; Admin ROI:
                      </p>
                      <div className="flex flex-wrap justify-between gap-2 text-slate-300 text-[11px]">
                        <span>
                          • Admin Time Saved: <strong>~{plan.estimatedAdminHoursSaved} hrs / mo</strong>
                        </span>
                        <span>
                          • Damp SLA Penalty Mitigation: <strong>£{plan.estimatedRegulatorFineSavings.toLocaleString()} / mo</strong>
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1.5 pt-1">
                      <p className="text-[10px] font-bold text-slate-400 uppercase">Included SaaS Capabilities:</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] text-slate-300">
                        {plan.features.map((feat, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                            <span>{feat}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Modal Actions */}
              <div className="flex flex-col sm:flex-row gap-3 pt-1">
                {isGothamActive ? (
                  isGothamCanceling ? (
                    <button
                      type="button"
                      onClick={handleReactivateGothamSaaS}
                      disabled={isProcessing}
                      className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl border border-black shadow-md flex items-center justify-center gap-2 transition"
                    >
                      {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      Resume Auto-Renewal
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleCancelGothamSaaS}
                      disabled={isProcessing}
                      className="flex-1 py-3 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-xs rounded-xl border border-black shadow-md flex items-center justify-center gap-2 transition"
                    >
                      {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4 text-white" />}
                      Cancel at Renewal
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSyncStripeB2BInvoice(calculatorDoors)}
                    disabled={isProcessing}
                    className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl border border-black shadow-md flex items-center justify-center gap-2 transition"
                  >
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4 text-amber-300" />}
                    Confirm &amp; Activate Gotham SaaS
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleOpenStripePortal}
                  disabled={isProcessing}
                  className="px-4 py-3 bg-slate-800 hover:bg-slate-900 text-white font-extrabold text-xs rounded-xl border border-black transition flex items-center justify-center gap-1.5"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-indigo-300" />
                  Stripe Portal
                </button>

                <button
                  type="button"
                  onClick={() => setIsSaaSCalculatorOpen(false)}
                  className="px-4 py-3 bg-slate-100 hover:bg-slate-200 text-black font-extrabold text-xs rounded-xl border border-black transition"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
