import React, { useState, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import { auth, db, doc, onSnapshot, updateDoc, collection, addDoc, serverTimestamp } from "@/src/firebase";
import { motion, AnimatePresence } from "motion/react";
import { 
  Check, CreditCard, ShieldCheck, Zap, Star, Award, 
  ArrowRight, Info, Loader2, Sparkles, TrendingUp, 
  PoundSterling, Package, Plus, Trash2, Wallet, Video, BellRing, Clock,
  Calendar, AlertTriangle, RefreshCw, ExternalLink, Car
} from "lucide-react";
import { cn } from "@/src/lib/utils";
import { useNavigate, useLocation } from "react-router-dom";
import {
  normalizeTraderTier,
  getStripeOnboardingLink,
  getStripeAccountStatus,
  getStripeLoginLink,
} from "@/src/services/stripeIntegrationService";
import {
  isPropertyOnlyBusinessAccount,
  isAnyRollerDriverAccount,
  isPayoutEligibleAccount,
} from "@/src/lib/accountRoles";
import SavedPaymentCardsPanel from "./shared/SavedPaymentCardsPanel";
import { toast } from "sonner";

interface SubscriptionTier {
  id: string;
  name: string;
  rawKey?: string;
  price: number;
  commission: number;
  description: string;
  features: string[];
  isPopular?: boolean;
}

export default function BillingManager() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [platformConfig, setPlatformConfig] = useState<any>(null);
  const [globalTiers, setGlobalTiers] = useState<any>(null);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAddingCard, setIsAddingCard] = useState(false);
  const [savedCards, setSavedCards] = useState<any[]>([]);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [busyCardAction, setBusyCardAction] = useState<"default" | "delete" | null>(null);
  const [stripeConnectStatus, setStripeConnectStatus] = useState<{
    loading: boolean;
    connected: boolean;
    stripeAccountId?: string;
    payoutsEnabled: boolean;
    chargesEnabled: boolean;
    detailsSubmitted: boolean;
    error?: string;
  }>({
    loading: false,
    connected: Boolean(profile?.stripeAccountId),
    stripeAccountId: profile?.stripeAccountId,
    payoutsEnabled: Boolean(profile?.payoutsEnabled),
    chargesEnabled: Boolean(profile?.chargesEnabled),
    detailsSubmitted: Boolean(profile?.stripeOnboardingComplete),
  });
  const [isLaunchingConnect, setIsLaunchingConnect] = useState(false);
  const [isOpeningStripeDashboard, setIsOpeningStripeDashboard] = useState(false);

  const isDriverAccount = isAnyRollerDriverAccount(profile);
  const isPayoutEligible = isPayoutEligibleAccount(profile) || Boolean(profile?.stripeAccountId);

  const fetchStripeConnectStatus = async (showFeedback?: "return" | "refresh") => {
    if (!user?.uid || !isPayoutEligible) return;
    setStripeConnectStatus((prev) => ({ ...prev, loading: true, error: undefined }));
    try {
      const status = await getStripeAccountStatus();
      setStripeConnectStatus({
        loading: false,
        connected: Boolean(status.connected || profile?.stripeAccountId),
        stripeAccountId: status.stripeAccountId || profile?.stripeAccountId,
        payoutsEnabled: Boolean(status.payoutsEnabled),
        chargesEnabled: Boolean(status.chargesEnabled),
        detailsSubmitted: Boolean(status.detailsSubmitted),
        error: status.error,
      });

      if (showFeedback === "return") {
        if (status.payoutsEnabled) {
          toast.success("Stripe Connect payouts are active and ready.");
        } else if (status.detailsSubmitted) {
          toast.info("Stripe has received your details and is verifying your payout account.");
        } else {
          toast.info("Your Stripe Connect setup is not yet complete. Tap Continue Verification to finish.");
        }
      } else if (showFeedback === "refresh") {
        toast.info("Your Stripe onboarding link expired. Tap Continue Verification to resume.");
      }
    } catch (err: any) {
      console.error("Failed to fetch Stripe Connect status:", err);
      setStripeConnectStatus((prev) => ({
        ...prev,
        loading: false,
        error: err?.message || "Unable to verify Stripe Connect status right now.",
      }));
    }
  };

  const handleStartStripeConnect = async () => {
    if (!user?.uid) return;
    setIsLaunchingConnect(true);
    try {
      const onboardingUrl = await getStripeOnboardingLink(user.uid, "billing");
      window.location.href = onboardingUrl;
    } catch (err: any) {
      console.error("Stripe Connect onboarding error:", err);
      toast.error(err?.message || "Unable to start Stripe Connect onboarding right now.");
      setIsLaunchingConnect(false);
    }
  };

  const handleOpenStripeDashboard = async () => {
    if (!user?.uid) return;
    setIsOpeningStripeDashboard(true);
    try {
      const dashboardUrl = await getStripeLoginLink();
      if (!dashboardUrl) {
        toast.error("Unable to open the Stripe Express Dashboard right now. Ensure Stripe onboarding is completed.");
        return;
      }
      window.location.href = dashboardUrl;
    } catch (err: any) {
      console.error("Stripe Express Dashboard error:", err);
      toast.error(err?.message || "Failed to open Stripe Express Dashboard.");
    } finally {
      setIsOpeningStripeDashboard(false);
    }
  };

  useEffect(() => {
    const unsubGlobal = onSnapshot(doc(db, "platform_config", "global"), (doc) => {
      if (doc.exists()) {
        setPlatformConfig(doc.data());
      }
    });
    const unsubTiers = onSnapshot(doc(db, "platform_config", "global_tiers"), (doc) => {
      if (doc.exists()) {
        setGlobalTiers(doc.data());
      }
      setLoading(false);
    });

    return () => {
      unsubGlobal();
      unsubTiers();
    };
  }, []);

  useEffect(() => {
    if (!user?.uid) return;
    fetchPaymentMethods(user.uid);
    const params = new URLSearchParams(location.search);
    const setupParam = params.get("setup");
    if (setupParam === "success") {
      toast.success("Payment card saved securely via Stripe.");
      navigate("/billing", { replace: true });
    }
    if (isPayoutEligible) {
      const connectParam = params.get("stripe_connect");
      if (connectParam === "success" || connectParam === "return") {
        fetchStripeConnectStatus("return");
        navigate("/billing", { replace: true });
      } else if (connectParam === "refresh") {
        fetchStripeConnectStatus("refresh");
        navigate("/billing", { replace: true });
      } else {
        fetchStripeConnectStatus();
      }
    }
  }, [user?.uid, profile?.role, profile?.businessLayer, profile?.stripeAccountId, isPayoutEligible, location.search]);

  const fetchPaymentMethods = async (userId: string) => {
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch(`/api/payment-methods/${userId}`, {
        headers: {
           ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        }
      });
      if (!res.ok) {
        console.warn(`Fetch payment methods failed with status ${res.status}`);
        return;
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("Fetch payment methods response was not JSON:", await res.text());
        return;
      }
      const data = await res.json();
      if (data && Array.isArray(data.paymentMethods)) {
        const defaultId = typeof data.defaultPaymentMethodId === "string" ? data.defaultPaymentMethodId : null;
        setSavedCards(
          data.paymentMethods.map((pm: any) => ({
            ...pm,
            isDefault: Boolean(pm.isDefault || (defaultId && pm.id === defaultId)),
          }))
        );
      }
    } catch (err) {
      console.error("Error fetching payment methods:", err);
    }
  };

  const handleSelectPlan = async (tier: SubscriptionTier) => {
    if (!user) return;
    setIsProcessing(true);

    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        toast.error("Please sign in again to manage your subscription.");
        return;
      }

      const canonicalTier = normalizeTraderTier(tier.rawKey || tier.name);
      const isFreeTier = Number(tier.price || 0) <= 0 || canonicalTier === "payg" || tier.id === "price_payg";

      if (isFreeTier) {
        const response = await fetch("/api/select-free-tier", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ tierName: canonicalTier || "payg" })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
          toast.error(data.error || "Unable to switch to the free plan right now.");
          return;
        }
        toast.success(`Switched to ${tier.name}!`);
        return;
      }

      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          userId: user.uid,
          tierName: tier.name,
          mode: "subscription",
          price_data: {
            currency: 'gbp',
            unit_amount: Math.round(tier.price * 100),
            recurring: { interval: 'month' },
            product_data: {
              name: `${tier.name} Membership`,
              description: tier.description || `Platform tier ${tier.name}`
            }
          },
          priceId: `price_${canonicalTier}`,
          successUrl: `${window.location.origin}/dashboard?subscription=success`,
          cancelUrl: `${window.location.origin}/billing`,
          metadata: {
            tierName: tier.name,
            userId: user.uid
          }
        })
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok && data.url) {
        window.location.href = data.url;
      } else if (response.ok && data.upgraded) {
        toast.success(data.message || `Successfully switched to ${tier.name}!`);
      } else if (response.ok && data.mock) {
        toast.success(`Successfully activated ${tier.name}!`);
        navigate("/dashboard");
      } else {
        toast.error(data.error || "Unable to start Stripe Checkout. Your plan was not changed.");
      }
    } catch (err) {
      console.error("Billing Error:", err);
      toast.error("Failed to start checkout session.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddPaymentMethod = async () => {
    if (!user) return;
    setIsAddingCard(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        toast.error("Please sign in again to add a payment method.");
        return;
      }
      const response = await fetch("/api/create-setup-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          userId: user.uid,
          successUrl: `${window.location.origin}/billing?setup=success`,
          cancelUrl: `${window.location.origin}/billing`
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(data.error || "Unable to open card setup right now.");
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error("Card setup URL was not returned by payment provider.");
      }
    } catch (err) {
      console.error("Setup Error:", err);
      toast.error("Failed to start payment method setup.");
    } finally {
      setIsAddingCard(false);
    }
  };

  const handleSetDefaultPaymentMethod = async (paymentMethodId: string) => {
    if (!user) return;
    setBusyCardId(paymentMethodId);
    setBusyCardAction("default");
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        toast.error("Please sign in again to update your default card.");
        return;
      }
      const res = await fetch(`/api/payment-methods/${user.uid}/${paymentMethodId}/default`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Unable to set default payment card right now.");
        return;
      }
      const nextDefaultId = data.defaultPaymentMethodId || paymentMethodId;
      setSavedCards((cards) =>
        cards
          .map((c) => ({ ...c, isDefault: c.id === nextDefaultId }))
          .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
      );
      toast.success("Default payment card updated.");
    } catch (err) {
      console.error("Set Default Card Error:", err);
      toast.error("Failed to update default payment card.");
    } finally {
      setBusyCardId(null);
      setBusyCardAction(null);
    }
  };

  const handleDeletePaymentMethod = async (paymentMethodId: string) => {
    if (!user) return;
    setBusyCardId(paymentMethodId);
    setBusyCardAction("delete");
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        toast.error("Please sign in again to remove a payment card.");
        return;
      }
      const res = await fetch(`/api/payment-methods/${user.uid}/${paymentMethodId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Unable to remove payment card right now.");
        return;
      }
      const nextDefaultId = data.defaultPaymentMethodId ?? null;
      setSavedCards((cards) =>
        cards
          .filter((c) => c.id !== paymentMethodId)
          .map((c) => ({
            ...c,
            isDefault: nextDefaultId !== null ? c.id === nextDefaultId : Boolean(c.isDefault),
          }))
          .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
      );
      toast.success("Payment card removed.");
    } catch (err) {
      console.error("Delete Error:", err);
      toast.error("Failed to remove payment card.");
    } finally {
      setBusyCardId(null);
      setBusyCardAction(null);
    }
  };

  const formatPeriodDate = (isoString?: string) => {
    if (!isoString) return "End of current period";
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return "End of current period";
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return "End of current period";
    }
  };

  const handleOpenCustomerPortal = async () => {
    if (!user) return;
    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/create-customer-portal-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          returnUrl: `${window.location.origin}/billing`
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(data.error || "Failed to open billing portal.");
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      } else if (data.error) {
        toast.error(data.error);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to open billing portal");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelSubscription = async (subscriptionType: 'tier' | 'exclusive_leads' | 'video_pro' | 'driver_gold' | 'landlord' | 'appointments' | string) => {
    if (!user) return;
    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/cancel-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ subscriptionType })
      });
      const data = await response.json();
      if (data.success) {
        const formattedDate = formatPeriodDate(data.currentPeriodEnd);
        toast.success("Subscription scheduled to cancel", {
          description: `Your subscription will cancel on ${formattedDate}. You will keep all benefits until then with no further charges.`
        });
      } else if (data.error) {
        toast.error(data.error);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to cancel subscription");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReactivateSubscription = async (subscriptionType: 'tier' | 'exclusive_leads' | 'video_pro' | 'driver_gold' | 'landlord' | 'appointments' | string) => {
    if (!user) return;
    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/reactivate-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ subscriptionType })
      });
      const data = await response.json();
      if (data.success) {
        toast.success("Subscription reactivated!", {
          description: "Your subscription has been renewed and will continue auto-renewing normally."
        });
      } else if (data.error) {
        toast.error(data.error);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to reactivate subscription");
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
    </div>
  );

  // -------------------------------------------------------------
  // CUSTOMER / LANDLORD / PROPERTY BUSINESS BILLING UI
  // -------------------------------------------------------------
  if (
    (profile?.role as string) === "homeowner" ||
    (profile?.role as string) === "customer" ||
    isPropertyOnlyBusinessAccount(profile)
  ) {
    const landlordPrice = Number(globalTiers?.providerModels?.homeowners?.tiers?.landlord?.price ?? platformConfig?.landlordProPrice ?? 19);
    const homeownerSubStatus = String(profile?.homeownerSubscriptionStatus || "").toLowerCase();
    const isLandlordTerminal = ["canceled", "cancelled", "unpaid", "incomplete_expired", "free"].includes(homeownerSubStatus);
    const isLandlordPro = Boolean(
      (profile?.isLandlord || profile?.homeownerTierId === "landlord" || profile?.tier === "landlord") &&
      !isLandlordTerminal
    );
    const isCanceling = Boolean(profile?.homeownerCancelAtPeriodEnd ?? (profile?.subscriptionType === "landlord" && profile?.cancelAtPeriodEnd));
    const renewalDate = formatPeriodDate(profile?.homeownerCurrentPeriodEnd || (profile?.subscriptionType === "landlord" ? profile?.currentPeriodEnd : undefined));

    return (
      <div className="min-h-screen bg-slate-50 pb-20">
        <div className="max-w-3xl mx-auto px-6 pt-8 space-y-8">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight mb-2">Billing & Subscriptions</h1>
            <p className="text-slate-500 font-medium">Manage your membership plan, payment methods, and invoice history.</p>
          </div>

          {/* Landlord Pro Subscription Card */}
          <div className="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white rounded-[2rem] border border-black shadow-2xl p-6 sm:p-8 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
            
            <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6 mb-6 pb-6 border-b border-white/10">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/20 text-xs font-bold uppercase tracking-wider mb-3">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Landlord Portfolio Plan
                </div>
                <h2 className="text-2xl font-black tracking-tight text-white flex items-center gap-2">
                  Premium Landlord Membership
                </h2>
                <p className="text-xs text-slate-300 font-medium mt-1 max-w-lg leading-relaxed">
                  Full multi-property automated passport management, CP12 & EICR compliance expiration alerts, tenant repair bridge, and 1-tap bulk trade dispatch.
                </p>
              </div>

              <div className="text-right shrink-0">
                <span className="text-3xl font-black text-white">£{landlordPrice.toFixed(2)}</span>
                <span className="text-xs text-slate-400 font-bold"> / month</span>
              </div>
            </div>

            {/* Current Status Badge & Action Controls */}
            {isLandlordPro ? (
              <div className="bg-white/10 rounded-2xl p-5 border border-white/15 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-extrabold uppercase tracking-wider border border-emerald-500/30 flex items-center gap-1.5">
                        <Check className="w-3.5 h-3.5" /> Active Subscription
                      </span>
                      {isCanceling && (
                        <span className="px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-300 text-xs font-extrabold uppercase tracking-wider border border-rose-500/30">
                          Cancels {renewalDate}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-300 font-semibold mt-2">
                      {isCanceling 
                        ? `Your subscription will remain fully active until ${renewalDate}. You won't be charged again.`
                        : `Your subscription auto-renews on ${renewalDate} for £${landlordPrice.toFixed(2)}/mo.`}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {isCanceling ? (
                      <button
                        onClick={() => handleReactivateSubscription('landlord')}
                        disabled={isProcessing}
                        className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition shadow-sm"
                      >
                        {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        Resume Auto-Renewal
                      </button>
                    ) : (
                      <button
                        onClick={() => handleCancelSubscription('landlord')}
                        disabled={isProcessing}
                        className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-rose-500/30 text-rose-200 border border-rose-300/30 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition"
                      >
                        {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                        Cancel at Renewal
                      </button>
                    )}

                    <button
                      onClick={handleOpenCustomerPortal}
                      disabled={isProcessing}
                      className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/20 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-blue-200" />
                      Stripe Portal
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    "Unlimited Property Passports & Digital Twins",
                    "Automated CP12 Gas & EICR Compliance Expiration Alerts",
                    "Tenant Repair Portal & In-App WhatsApp Sharing Bridge",
                    "⚡ 1-Tap Bulk Compliance & Emergency Trade Dispatch",
                    "Dedicated Portfolio Analytics & Insurance Risk Reports"
                  ].map((feature, idx) => (
                    <div key={idx} className="flex items-center gap-2.5 text-xs font-semibold text-slate-200">
                      <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3 text-emerald-400" />
                      </div>
                      <span>{feature}</span>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2">
                  <p className="text-[11px] text-slate-400 font-medium">Cancel anytime in 1-click. Instant activation.</p>
                  <button
                    onClick={async () => {
                      if (!user) return;
                      setIsProcessing(true);
                      try {
                        const token = await auth.currentUser?.getIdToken();
                        const response = await fetch("/api/create-checkout-session", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            ...(token ? { "Authorization": `Bearer ${token}` } : {}),
                            "Idempotency-Key": crypto.randomUUID()
                          },
                          body: JSON.stringify({
                            userId: user.uid,
                            priceId: "price_landlord",
                            tierName: "Premium Landlord",
                            price_data: {
                              currency: 'gbp',
                              unit_amount: Math.round(landlordPrice * 100),
                              product_data: {
                                name: 'Landlord Pro Portfolio Membership',
                                description: 'Multi-property passport digital twins, automated CP12/EICR compliance alerts & bulk trade dispatch'
                              },
                              recurring: { interval: 'month' }
                            },
                            mode: 'subscription',
                            metadata: {
                              tier: 'landlord',
                              tierName: 'Premium Landlord',
                              subscriptionType: 'landlord'
                            },
                            successUrl: `${window.location.origin}/portfolio?subscription_success=true`,
                            cancelUrl: `${window.location.origin}/billing`
                          })
                        });
                        const data = await response.json();
                        if (data.url) {
                          window.location.href = data.url;
                        } else {
                          toast.error(data.error || "Failed to start checkout session");
                        }
                      } catch (e: any) {
                        console.error(e);
                        toast.error("Failed to initiate Landlord Pro upgrade");
                      } finally {
                        setIsProcessing(false);
                      }
                    }}
                    disabled={isProcessing}
                    className="px-6 py-3 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-black text-xs uppercase tracking-wider flex items-center gap-2 shadow-lg transition"
                  >
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4 text-amber-300" />}
                    Upgrade to Landlord Pro (£{landlordPrice.toFixed(2)}/mo)
                  </button>
                </div>
              </div>
            )}
          </div>

          <SavedPaymentCardsPanel
            savedCards={savedCards}
            isAddingCard={isAddingCard}
            busyCardId={busyCardId}
            busyAction={busyCardAction}
            onAddCard={handleAddPaymentMethod}
            onSetDefault={handleSetDefaultPaymentMethod}
            onDeleteCard={handleDeletePaymentMethod}
            title="Saved Payment Cards (Spending)"
            subtitle="Used for hiring tradespeople, Landlord Pro plans, and AnyRoller rides."
            emptyDescription="No payment methods saved yet. Link a card inside Stripe's PCI-DSS Level 1 Vault to pay for home repairs, property management subscriptions, or rides."
          />
        </div>
      </div>
    );
  }

  const terminalSubStatuses = ["canceled", "cancelled", "unpaid", "incomplete_expired", "free"];
  const isTraderSubTerminal = terminalSubStatuses.includes(String(profile?.subscriptionStatus || "").toLowerCase());
  const effectiveTraderTierCanonical = isTraderSubTerminal ? "payg" : normalizeTraderTier(profile?.tierId || profile?.tier);

  const isCurrentPlan = (tier: SubscriptionTier) => {
    const tierCanonical = normalizeTraderTier(tier.rawKey || tier.name);
    return effectiveTraderTierCanonical === tierCanonical;
  };

  const handleToggleExclusiveLeads = async () => {
    if (!user || !profile) return;
    const isCurrentlyActive = Boolean(
      profile?.hasExclusiveAddon &&
      profile?.isExclusiveActive !== false &&
      !terminalSubStatuses.includes(String(profile?.exclusiveSubscriptionStatus || "").toLowerCase())
    );
    const isCanceling = Boolean(profile?.exclusiveCancelAtPeriodEnd);

    if (isCurrentlyActive && isCanceling) {
      await handleReactivateSubscription('exclusive_leads');
      return;
    }

    if (isCurrentlyActive) {
      await handleCancelSubscription('exclusive_leads');
      return;
    }

    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          userId: user.uid,
          priceId: "price_exclusive_leads",
          tierName: "Exclusive Leads Add-on",
          mode: "subscription",
          price_data: {
            currency: 'gbp',
            unit_amount: Math.round(exclusivePrice * 100),
            recurring: { interval: 'month' },
            product_data: {
              name: "Exclusive Leads Add-on",
              description: "30-minute head start on incoming quotes with priority matching."
            }
          },
          successUrl: `${window.location.origin}/billing?exclusive=success`,
          cancelUrl: `${window.location.origin}/billing`,
          metadata: {
            isExclusiveAddon: "true",
            type: "exclusive_leads",
            userId: user.uid
          }
        })
      });

      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.error) {
        toast.error(data.error);
      } else {
        toast.success(`⚡ Priority Exclusive Offers Active! (£${exclusivePrice.toFixed(2)}/mo)`);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to start checkout for Exclusive Leads add-on");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleVideoPro = async () => {
    if (!user || !profile) return;
    const isCurrentlyActive = Boolean(
      profile?.hasVerifiedVideoProSubscription &&
      !terminalSubStatuses.includes(String(profile?.videoProSubscriptionStatus || "").toLowerCase())
    );
    const isCanceling = Boolean(profile?.videoProCancelAtPeriodEnd);

    if (isCurrentlyActive && isCanceling) {
      await handleReactivateSubscription('video_pro');
      return;
    }

    if (isCurrentlyActive) {
      await handleCancelSubscription('video_pro');
      return;
    }

    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          userId: user.uid,
          priceId: "price_video_pro",
          tierName: "Verified Video Pro",
          mode: "subscription",
          price_data: {
            currency: 'gbp',
            unit_amount: Math.round(videoProMonthly * 100),
            recurring: { interval: 'month' },
            product_data: {
              name: "Verified Video Pro Add-on",
              description: "Verified video intro badge, priority placement, and +35 AI match score boost."
            }
          },
          successUrl: `${window.location.origin}/billing?video_pro=success`,
          cancelUrl: `${window.location.origin}/billing`,
          metadata: {
            isVideoPro: "true",
            type: "video_pro_subscription",
            userId: user.uid
          }
        })
      });

      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.error) {
        toast.error(data.error);
      } else {
        toast.success(`⚡ Verified Video Pro Active! (£${videoProMonthly.toFixed(2)}/mo)`);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to start checkout for Verified Video Pro subscription");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleAppointments = async () => {
    if (!user || !profile) return;
    const isCurrentlyActive = Boolean(
      (profile?.hasAppointmentsAddon || profile?.appointmentSettings?.enabled) &&
      !terminalSubStatuses.includes(String(profile?.appointmentsSubscriptionStatus || "").toLowerCase())
    );
    const isCanceling = Boolean(profile?.appointmentsCancelAtPeriodEnd);

    if (isCurrentlyActive && isCanceling) {
      await handleReactivateSubscription('appointments');
      return;
    }

    if (isCurrentlyActive) {
      await handleCancelSubscription('appointments');
      return;
    }

    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          userId: user.uid,
          priceId: "price_appointments",
          tierName: "Appointment System Add-on",
          mode: "subscription",
          price_data: {
            currency: 'gbp',
            unit_amount: Math.round(appointmentsPrice * 100),
            recurring: { interval: 'month' },
            product_data: {
              name: "Appointment System Add-on",
              description: "Allow customers to book real-time appointments directly from your profile."
            }
          },
          successUrl: `${window.location.origin}/billing?appointments=success`,
          cancelUrl: `${window.location.origin}/billing`,
          metadata: {
            type: "appointments",
            subscriptionType: "appointments",
            userId: user.uid
          }
        })
      });

      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.error) {
        toast.error(data.error);
      } else {
        toast.success(`Appointment System Active! (£${appointmentsPrice.toFixed(2)}/mo)`);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to start checkout for Appointment System add-on");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleGoldDriver = async () => {
    if (!user || !profile) return;
    const isCurrentlyActive = Boolean(profile?.isGoldDriver || profile?.driverTier === "gold");
    const isCanceling = Boolean(profile?.driverCancelAtPeriodEnd);

    if (!isDriverAccount && !isCurrentlyActive) {
      toast.error("Gold Driver Tier is only available for registered driver accounts.");
      return;
    }

    if (isCurrentlyActive && isCanceling) {
      await handleReactivateSubscription('driver_gold');
      return;
    }

    if (isCurrentlyActive) {
      await handleCancelSubscription('driver_gold');
      return;
    }

    setIsProcessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          userId: user.uid,
          priceId: "price_driver_gold",
          tierName: "Gold Driver Subscription",
          mode: "subscription",
          price_data: {
            currency: 'gbp',
            unit_amount: 4999, // £49.99
            recurring: { interval: 'month' },
            product_data: {
              name: "Gold Driver Subscription",
              description: "10% commission rate, 4 destination filters, 14-day advance booking, and priority dispatch."
            }
          },
          successUrl: `${window.location.origin}/billing?driver_gold=success`,
          cancelUrl: `${window.location.origin}/billing`,
          metadata: {
            subscriptionType: "driver_gold",
            type: "driver_gold",
            userId: user.uid
          }
        })
      });

      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.error) {
        toast.error(data.error);
      } else {
        toast.error("Checkout did not return a payment URL. Gold Driver has not been activated.");
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to start checkout for Gold Driver subscription");
    } finally {
      setIsProcessing(false);
    }
  };

  // -------------------------------------------------------------
  // TRADESPERSON / BUSINESS BILLING UI (SUBSCRIPTIONS)
  // -------------------------------------------------------------

  const isFounding = profile?.isFoundingMember;

  // Phase 2 Tiers directly mapped from Firestore
  let standardTiers: SubscriptionTier[] = [];
  
  if (globalTiers?.providerModels?.one_off_trades?.tiers) {
    const rawTiers = globalTiers.providerModels.one_off_trades.tiers;
    standardTiers = Object.entries(rawTiers).map(([tierKey, tier]: [string, any]) => {
      let displayName = tierKey;
      const lower = tierKey.toLowerCase();
      if (lower === 'payg' || lower.includes('free')) displayName = "Free Explorer";
      else if (lower === 'pro' || lower.includes('silver')) displayName = "Silver Professional";
      else if (lower === 'premium' || lower === 'gold' || lower.includes('elite')) displayName = "Gold Elite";
      else if (lower === 'platinum' || lower.includes('enterprise')) displayName = "Platinum Enterprise";
      else displayName = tierKey.charAt(0).toUpperCase() + tierKey.slice(1);

      const rawComm = Number(tier.commission) || 0;
      const pctComm = Number((rawComm > 1 ? rawComm : rawComm * 100).toFixed(2));
      return {
        id: `price_${tierKey.toLowerCase()}`,
        name: displayName,
        rawKey: tierKey,
        price: Number(tier.price) || 0,
        commission: pctComm, // DB stores as 0.05, UI displays clean 5
        description: tier.description || "",
        features: Array.isArray(tier.features) ? tier.features : [],
        isPopular: lower === "pro" || lower.includes("silver")
      };
    }).sort((a, b) => a.price - b.price);
  } else if (platformConfig?.feeTiers && Array.isArray(platformConfig.feeTiers) && platformConfig.feeTiers.length > 0) {
    standardTiers = platformConfig.feeTiers.map((ft: any) => ({
      id: `price_${normalizeTraderTier(ft.name)}`,
      name: ft.name,
      rawKey: normalizeTraderTier(ft.name),
      price: Number(ft.price) || 0,
      commission: Number((Number(ft.commission) || 0).toFixed(2)),
      description: ft.description || "",
      features: Array.isArray(ft.features) ? ft.features : (ft.description ? [ft.description] : []),
      isPopular: normalizeTraderTier(ft.name) === "pro"
    })).sort((a: any, b: any) => a.price - b.price);
  } else {
    // Fallback canonical tiers
    standardTiers = [
      {
        id: "price_payg",
        name: "Free Explorer",
        rawKey: "payg",
        price: 0,
        commission: 5,
        description: "Start risk-free. 5% Platform Commission.",
        features: [
          "Unlimited Lead Browsing",
          "5% Platform Commission",
          "Standard Profile Visibility",
          "Digital Quotes & Invoicing"
        ]
      },
      {
        id: "price_pro",
        name: "Silver Professional",
        rawKey: "pro",
        price: 19.99,
        commission: 3.5,
        description: "Built for active independent tradespeople.",
        isPopular: true,
        features: [
          "Priority Lead Alerts",
          "Reduced 3.5% Commission",
          "Enhanced Verification Badge",
          "AI Material Sourcing Assistant",
          "Priority Search Ranking"
        ]
      },
      {
        id: "price_premium",
        name: "Gold Elite",
        rawKey: "premium",
        price: 49.99,
        commission: 2.5,
        description: "Top professional tier for high-volume trades.",
        features: [
          "Ultra-low 2.5% Commission",
          "Unlimited Open Quotes",
          "Verified Video Pro Placement",
          "Client SMS Notifications",
          "Dedicated Phone Support"
        ]
      },
      {
        id: "price_platinum",
        name: "Platinum Enterprise",
        rawKey: "platinum",
        price: 99.99,
        commission: 1.5,
        description: "Scale your business with the lowest commission.",
        features: [
          "Lowest 1.5% Commission",
          "Multi-seat Team Management",
          "Automated CP12/EICR Dispatch",
          "Custom API & Accounting Integration",
          "24/7 Priority Emergency Support"
        ]
      }
    ];
  }

  const rawCapVal =
    globalTiers?.providerModels?.one_off_trades?.commissionCapGbp ??
    globalTiers?.commissionCapGbp ??
    platformConfig?.commissionCapGbp;
  const parsedCapVal = rawCapVal === undefined || rawCapVal === null || rawCapVal === "" ? 250 : Number(rawCapVal);
  const activeCommissionCapGbp = Number.isFinite(parsedCapVal) && parsedCapVal >= 0 ? parsedCapVal : 250;

  // Modified Tiers for Founding Members
  const foundingTiers = standardTiers.map(t => {
    if (t.rawKey === "pro" || t.name.includes("Professional") || t.name === "PRO Trader") {
      return {
        ...t,
        name: "Founding PRO",
        price: 9.99,
        description: "Your exclusive founding reward. Lifetime price locked.",
        features: [...t.features, "Lifetime Discount Locked"]
      };
    }
    return t;
  });

  const activeTiers = isFounding ? foundingTiers : standardTiers;

  const exclusivePrice = Number(platformConfig?.paidAddons?.exclusiveLeads?.price ?? 29.00);
  const videoProMonthly = Number(platformConfig?.paidAddons?.verifiedVideoPro?.monthlyPrice ?? 15.00);
  const appointmentsPrice = Number(platformConfig?.paidAddons?.appointments?.price ?? 9.99);
  const isExclusiveActive = Boolean(
    profile?.hasExclusiveAddon &&
    profile?.isExclusiveActive !== false &&
    !terminalSubStatuses.includes(String(profile?.exclusiveSubscriptionStatus || "").toLowerCase())
  );
  const isVideoProActive = Boolean(
    profile?.hasVerifiedVideoProSubscription &&
    !terminalSubStatuses.includes(String(profile?.videoProSubscriptionStatus || "").toLowerCase())
  );
  const isAppointmentsActive = Boolean(
    (profile?.hasAppointmentsAddon || profile?.appointmentSettings?.enabled) &&
    !terminalSubStatuses.includes(String(profile?.appointmentsSubscriptionStatus || "").toLowerCase())
  );
  const isGoldDriverActive = Boolean(profile?.isGoldDriver || profile?.driverTier === "gold");
  const showGoldDriverCard = isDriverAccount || isGoldDriverActive;

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      <div className="max-w-6xl mx-auto px-6 pt-12">
        {/* Header */}
        <div className="text-center space-y-4 mb-16">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex items-center justify-center gap-2 mb-2"
          >
            <span className="bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full shadow-lg shadow-blue-200">
              Subscription Management
            </span>
            {isFounding && (
                <span className="bg-orange-500 text-white text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full shadow-lg shadow-orange-200 flex items-center gap-1">
                    <Award className="w-3 h-3" />
                    Founding Reward Active
                </span>
            )}
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl md:text-5xl font-black text-slate-900 tracking-tight"
          >
            Scale your <span className="text-blue-600">business</span> today.
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-slate-500 font-medium max-w-xl mx-auto"
          >
            Choose the plan that fits your volume. All plans include 24/7 support and our AI-powered toolkit.
          </motion.p>
        </div>

        {/* Current Plan Overview */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-[#1e3a5f] p-8 rounded-[2.5rem] text-white mb-12 shadow-xl shadow-blue-900/10 flex flex-col md:flex-row items-start md:items-center justify-between gap-8 relative overflow-hidden"
        >
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -mr-32 -mt-32" />
          
          <div className="relative z-10 flex items-center gap-6">
            <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur-md flex items-center justify-center border border-black/20 shrink-0">
              <Package className="w-8 h-8 text-blue-300" />
            </div>
            <div>
              <p className="text-[10px] font-black text-blue-200 uppercase tracking-widest">Your Current Plan</p>
              <h2 className="text-3xl font-black">{isTraderSubTerminal ? "Free Explorer" : (profile?.tierId || "Free Explorer")}</h2>
              <div className="flex flex-wrap items-center gap-3 mt-1.5">
                <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  {profile?.subscriptionStatus === "active" && effectiveTraderTierCanonical !== "payg" ? "Active Subscription" : "Pay-As-You-Go"}
                </span>

                {profile?.cancelAtPeriodEnd && !isTraderSubTerminal ? (
                  <span className="flex items-center gap-1 text-xs font-bold text-amber-300 bg-amber-500/20 px-2.5 py-0.5 rounded-full border border-amber-400/30">
                    <AlertTriangle className="w-3 h-3 text-amber-300" />
                    Cancels on {formatPeriodDate(profile?.currentPeriodEnd)} (Benefits Active)
                  </span>
                ) : profile?.currentPeriodEnd && profile?.subscriptionStatus === "active" && effectiveTraderTierCanonical !== "payg" ? (
                  <span className="flex items-center gap-1 text-xs text-blue-200 font-medium">
                    <Calendar className="w-3 h-3 text-blue-300" />
                    Renews on {formatPeriodDate(profile?.currentPeriodEnd)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="relative z-10 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full md:w-auto">
            {profile?.subscriptionStatus === "active" && effectiveTraderTierCanonical !== "payg" && (
              <>
                {profile?.cancelAtPeriodEnd ? (
                  <button
                    onClick={() => handleReactivateSubscription('tier')}
                    disabled={isProcessing}
                    className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition shadow-sm"
                  >
                    {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Resume Auto-Renewal
                  </button>
                ) : (
                  <button
                    onClick={() => handleCancelSubscription('tier')}
                    disabled={isProcessing}
                    className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-rose-500/30 text-rose-200 border border-rose-300/30 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition"
                  >
                    {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                    Cancel at Renewal
                  </button>
                )}

                <button
                  onClick={handleOpenCustomerPortal}
                  disabled={isProcessing}
                  className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/20 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-blue-200" />
                  Stripe Portal
                </button>
              </>
            )}

            <div className="bg-white/5 p-3 px-4 rounded-2xl border border-black/10 text-right">
              <p className="text-[9px] font-black text-blue-200 uppercase tracking-widest mb-0.5">Credits Saved</p>
              <p className="text-lg font-black">£{(profile?.phantomFeesSaved || 0).toFixed(2)}</p>
            </div>
          </div>
        </motion.div>

        {/* Tier Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
          {activeTiers.map((tier, idx) => {
            const currentPlan = isCurrentPlan(tier);
            return (
              <motion.div
                key={tier.name}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.3 + (idx * 0.1) }}
                className={cn(
                  "relative bg-white p-6 rounded-2xl border transition-all duration-300 flex flex-col justify-between",
                  tier.isPopular 
                    ? "border-blue-600 shadow-xl shadow-blue-600/10 ring-2 ring-blue-600/20" 
                    : "border-black shadow-md hover:shadow-lg"
                )}
              >
                {tier.isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full shadow-md">
                    Most Popular
                  </div>
                )}

                <div className="space-y-5">
                  <div>
                    <h3 className="text-xl font-black text-slate-900 leading-tight">{tier.name}</h3>
                    <p className="text-xs text-slate-500 mt-1 font-medium min-h-[32px]">{tier.description}</p>
                  </div>

                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-black text-slate-900 tracking-tight">£{tier.price}</span>
                    <span className="text-slate-400 font-bold text-xs">/mo</span>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-black/10">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Platform Fee</span>
                      <span className="text-sm font-black text-blue-600">{tier.commission}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 rounded-full mt-2 overflow-hidden">
                      <div className="h-full bg-blue-600 rounded-full" style={{ width: `${Math.max(5, 100 - (tier.commission * 5))}%` }} />
                    </div>
                    <p className="text-[10px] font-bold text-black mt-1.5">
                      {activeCommissionCapGbp > 0
                        ? `Capped at £${activeCommissionCapGbp.toFixed(0)} max per job`
                        : "No maximum commission cap"}
                    </p>
                  </div>

                  <div className="space-y-3 pt-3 border-t border-slate-100">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Included Features</p>
                    <ul className="space-y-2">
                      {tier.features.map(feature => (
                        <li key={feature} className="flex items-start gap-2 text-xs text-slate-600 font-medium">
                          <div className="w-4 h-4 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Check className="w-2.5 h-2.5 text-emerald-600 stroke-[3]" />
                          </div>
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <button 
                  onClick={() => handleSelectPlan(tier)}
                  disabled={isProcessing || currentPlan}
                  className={cn(
                    "w-full py-3.5 rounded-xl font-black text-xs uppercase tracking-wider transition-all duration-300 flex items-center justify-center gap-2 mt-6 shadow-md",
                    currentPlan 
                      ? "bg-slate-100 text-slate-400 cursor-not-allowed shadow-none border border-slate-200" 
                      : tier.isPopular 
                        ? "bg-blue-600 text-white hover:bg-blue-700 shadow-blue-200 active:scale-[0.98]" 
                        : "bg-slate-900 text-white hover:bg-slate-800 active:scale-[0.98]"
                  )}
                >
                  {isProcessing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : currentPlan ? (
                    "Current Plan"
                  ) : (
                    <>Select {tier.name} <ArrowRight className="w-3.5 h-3.5" /></>
                  )}
                </button>
              </motion.div>
            );
          })}
        </div>

        {/* Paid Add-on Features & Performance Boosts */}
        <div className="mt-16 max-w-7xl mx-auto space-y-6">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-black">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-5 h-5 text-amber-500" />
                <h3 className="text-xl font-black text-slate-900 tracking-tight">Paid Add-on Features & Performance Boosts</h3>
              </div>
              <p className="text-xs text-slate-500">Live platform add-ons and monetization controls synchronized with admin control settings.</p>
            </div>
            <span className="text-[11px] font-black uppercase tracking-wider px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              Admin Synced
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Exclusive Leads Add-on */}
            <div className="bg-white p-6 rounded-2xl border border-black shadow-sm flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-amber-600" />
                  </div>
                  <span className={cn(
                    "text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full",
                    profile?.exclusiveCancelAtPeriodEnd 
                      ? "bg-amber-100 text-amber-900 border border-amber-300"
                      : isExclusiveActive 
                      ? "bg-emerald-100 text-emerald-800" 
                      : "bg-slate-100 text-slate-600"
                  )}>
                    {profile?.exclusiveCancelAtPeriodEnd 
                      ? "Canceling" 
                      : isExclusiveActive 
                      ? "Active" 
                      : "Optional Add-On"}
                  </span>
                </div>
                <div>
                  <h4 className="text-base font-black text-slate-900">Priority Exclusive Leads</h4>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-black text-slate-900">£{exclusivePrice.toFixed(2)}</span>
                    <span className="text-xs text-slate-400 font-bold">/mo</span>
                  </div>
                  {isExclusiveActive && (
                    <div className="mt-1">
                      {profile?.exclusiveCancelAtPeriodEnd ? (
                        <p className="text-[11px] text-amber-700 font-bold flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                          Cancels on {formatPeriodDate(profile?.exclusiveCurrentPeriodEnd)} (Benefits active until then)
                        </p>
                      ) : profile?.exclusiveCurrentPeriodEnd ? (
                        <p className="text-[11px] text-slate-500 font-medium flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-slate-400 shrink-0" />
                          Renews on {formatPeriodDate(profile?.exclusiveCurrentPeriodEnd)}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Get 30-minute advance notifications on newly posted leads before they enter the open public feed. Maximum 3 exclusive leads matched daily.
                </p>
                <div className="text-[11px] font-bold text-slate-700 space-y-1 pt-2">
                  <div className="flex items-center gap-1.5 text-emerald-700">
                    <Check className="w-3.5 h-3.5" /> 30-Minute Head Start on Quotes
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-700">
                    <Check className="w-3.5 h-3.5" /> 4x Higher Win Probability
                  </div>
                </div>
              </div>

              <button
                onClick={handleToggleExclusiveLeads}
                disabled={isProcessing}
                className={cn(
                  "w-full mt-6 py-3 rounded-xl font-black text-xs uppercase tracking-wider transition-all duration-200 flex items-center justify-center gap-2",
                  profile?.exclusiveCancelAtPeriodEnd
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : isExclusiveActive 
                    ? "bg-amber-50 text-amber-900 border border-amber-300 hover:bg-rose-50 hover:text-rose-900 hover:border-rose-300" 
                    : "bg-slate-900 text-white hover:bg-slate-800"
                )}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : profile?.exclusiveCancelAtPeriodEnd ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    Resume Auto-Renewal
                  </>
                ) : isExclusiveActive ? (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    Cancel at Renewal
                  </>
                ) : (
                  `Subscribe (£${exclusivePrice.toFixed(2)}/mo)`
                )}
              </button>
            </div>

            {/* Verified Video Pro */}
            <div className="bg-white p-6 rounded-2xl border border-black shadow-sm flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-xl bg-purple-50 border border-purple-200 flex items-center justify-center">
                    <Video className="w-5 h-5 text-purple-600" />
                  </div>
                  <span className={cn(
                    "text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full",
                    profile?.videoProCancelAtPeriodEnd
                      ? "bg-purple-100 text-purple-900 border border-purple-300"
                      : isVideoProActive 
                      ? "bg-emerald-100 text-emerald-800" 
                      : "bg-slate-100 text-slate-600"
                  )}>
                    {profile?.videoProCancelAtPeriodEnd
                      ? "Canceling"
                      : isVideoProActive 
                      ? "Active" 
                      : "Optional Add-On"}
                  </span>
                </div>
                <div>
                  <h4 className="text-base font-black text-slate-900">Verified Video Pro</h4>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-black text-slate-900">£{videoProMonthly.toFixed(2)}</span>
                    <span className="text-xs text-slate-400 font-bold">/mo</span>
                  </div>
                  {isVideoProActive && (
                    <div className="mt-1">
                      {profile?.videoProCancelAtPeriodEnd ? (
                        <p className="text-[11px] text-purple-700 font-bold flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 text-purple-600 shrink-0" />
                          Cancels on {formatPeriodDate(profile?.videoProCurrentPeriodEnd)} (Benefits active until then)
                        </p>
                      ) : profile?.videoProCurrentPeriodEnd ? (
                        <p className="text-[11px] text-slate-500 font-medium flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-slate-400 shrink-0" />
                          Renews on {formatPeriodDate(profile?.videoProCurrentPeriodEnd)}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Host an authentic 15-30s video intro showcasing your skills, vehicle, and credentials. Includes our gold verification shield.
                </p>
                <div className="text-[11px] font-bold text-slate-700 space-y-1 pt-2">
                  <div className="flex items-center gap-1.5 text-purple-700">
                    <Award className="w-3.5 h-3.5" /> +35 AI Match Score Boost
                  </div>
                  <div className="flex items-center gap-1.5 text-purple-700">
                    <Check className="w-3.5 h-3.5" /> Priority Quote Box Placement
                  </div>
                </div>
              </div>

              <button
                onClick={handleToggleVideoPro}
                disabled={isProcessing}
                className={cn(
                  "w-full mt-6 py-3 rounded-xl font-black text-xs uppercase tracking-wider transition-all duration-200 flex items-center justify-center gap-2",
                  profile?.videoProCancelAtPeriodEnd
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : isVideoProActive 
                    ? "bg-purple-50 text-purple-900 border border-purple-300 hover:bg-rose-50 hover:text-rose-900 hover:border-rose-300" 
                    : "bg-purple-600 text-white hover:bg-purple-700"
                )}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : profile?.videoProCancelAtPeriodEnd ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    Resume Auto-Renewal
                  </>
                ) : isVideoProActive ? (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-purple-600" />
                    Cancel at Renewal
                  </>
                ) : (
                  `Subscribe (£${videoProMonthly.toFixed(2)}/mo)`
                )}
              </button>
            </div>

            {/* Gold Driver Subscription Tier (Driver Accounts Only) */}
            {showGoldDriverCard && (
            <div className="bg-white p-6 rounded-2xl border border-black shadow-sm flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center">
                    <Car className="w-5 h-5 text-amber-600" />
                  </div>
                  <span className={cn(
                    "text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full",
                    profile?.driverCancelAtPeriodEnd
                      ? "bg-amber-100 text-amber-900 border border-amber-300"
                      : isGoldDriverActive 
                      ? "bg-emerald-100 text-emerald-800" 
                      : "bg-slate-100 text-slate-600"
                  )}>
                    {profile?.driverCancelAtPeriodEnd
                      ? "Canceling"
                      : isGoldDriverActive 
                      ? "Active Gold" 
                      : "Driver Tier"}
                  </span>
                </div>
                <div>
                  <h4 className="text-base font-black text-slate-900">Gold Driver Tier</h4>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-black text-slate-900">£49.99</span>
                    <span className="text-xs text-slate-400 font-bold">/mo</span>
                  </div>
                  {isGoldDriverActive && (
                    <div className="mt-1">
                      {profile?.driverCancelAtPeriodEnd ? (
                        <p className="text-[11px] text-amber-700 font-bold flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                          Cancels on {formatPeriodDate(profile?.driverCurrentPeriodEnd)} (Gold benefits active until then)
                        </p>
                      ) : (profile?.driverCurrentPeriodEnd) ? (
                        <p className="text-[11px] text-slate-500 font-medium flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-slate-400 shrink-0" />
                          Renews on {formatPeriodDate(profile?.driverCurrentPeriodEnd)}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Top tier driver subscription with reduced 10% commission rate, 4 daily destination filters, 14-day advance booking window, and priority ride dispatch (+50 score).
                </p>
                <div className="text-[11px] font-bold text-slate-700 space-y-1 pt-2">
                  <div className="flex items-center gap-1.5 text-amber-700">
                    <Check className="w-3.5 h-3.5" /> Low 10% Platform Commission
                  </div>
                  <div className="flex items-center gap-1.5 text-amber-700">
                    <Check className="w-3.5 h-3.5" /> 4 Daily Destination Filters
                  </div>
                </div>
              </div>

              <button
                onClick={handleToggleGoldDriver}
                disabled={isProcessing}
                className={cn(
                  "w-full mt-6 py-3 rounded-xl font-black text-xs uppercase tracking-wider transition-all duration-200 flex items-center justify-center gap-2",
                  profile?.driverCancelAtPeriodEnd
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : isGoldDriverActive 
                    ? "bg-amber-50 text-amber-900 border border-amber-300 hover:bg-rose-50 hover:text-rose-900 hover:border-rose-300" 
                    : "bg-amber-500 text-slate-950 hover:bg-amber-400"
                )}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : profile?.driverCancelAtPeriodEnd ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    Resume Auto-Renewal
                  </>
                ) : isGoldDriverActive ? (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    Cancel at Renewal
                  </>
                ) : (
                  "Subscribe (£49.99/mo)"
                )}
              </button>
            </div>
            )}

            {/* Automated Appointments Add-on */}
            <div className="bg-white p-6 rounded-2xl border border-black shadow-sm flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 border border-black/15 flex items-center justify-center">
                    <Calendar className="w-5 h-5 text-blue-600" />
                  </div>
                  <span className={cn(
                    "text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full",
                    profile?.appointmentsCancelAtPeriodEnd
                      ? "bg-amber-100 text-black border border-amber-300"
                      : isAppointmentsActive
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-100 text-black"
                  )}>
                    {profile?.appointmentsCancelAtPeriodEnd
                      ? "Canceling"
                      : isAppointmentsActive
                      ? "Active"
                      : "Optional Add-On"}
                  </span>
                </div>
                <div>
                  <h4 className="text-base font-black text-black">Automated Appointments</h4>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-black text-black">£{appointmentsPrice.toFixed(2)}</span>
                    <span className="text-xs text-slate-500 font-bold">/mo</span>
                  </div>
                  {isAppointmentsActive && (
                    <div className="mt-1">
                      {profile?.appointmentsCancelAtPeriodEnd ? (
                        <p className="text-[11px] text-amber-800 font-bold flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                          Cancels on {formatPeriodDate(profile?.appointmentsCurrentPeriodEnd)} (Active until then)
                        </p>
                      ) : profile?.appointmentsCurrentPeriodEnd ? (
                        <p className="text-[11px] text-black font-medium flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-slate-500 shrink-0" />
                          Renews on {formatPeriodDate(profile?.appointmentsCurrentPeriodEnd)}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
                <p className="text-xs text-black leading-relaxed">
                  Let customers view your live availability and request booked appointment slots directly from your public trader profile.
                </p>
                <div className="text-[11px] font-bold text-black space-y-1 pt-2">
                  <div className="flex items-center gap-1.5 text-emerald-700">
                    <Check className="w-3.5 h-3.5" /> Live Availability Calendar Booking
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-700">
                    <Check className="w-3.5 h-3.5" /> Automated Slot Confirmations
                  </div>
                </div>
              </div>

              <button
                onClick={handleToggleAppointments}
                disabled={isProcessing}
                className={cn(
                  "w-full mt-6 py-3 rounded-xl font-black text-xs uppercase tracking-wider transition-all duration-200 flex items-center justify-center gap-2",
                  profile?.appointmentsCancelAtPeriodEnd
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : isAppointmentsActive
                    ? "bg-blue-50 text-black border border-black hover:bg-rose-50 hover:text-rose-900"
                    : "bg-slate-900 text-white hover:bg-slate-800"
                )}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : profile?.appointmentsCancelAtPeriodEnd ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    Resume Auto-Renewal
                  </>
                ) : isAppointmentsActive ? (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    Cancel at Renewal
                  </>
                ) : (
                  `Subscribe (£${appointmentsPrice.toFixed(2)}/mo)`
                )}
              </button>
            </div>

            {/* Instant Match & Emergency Dispatch SLA */}
            <div className="bg-white p-6 rounded-2xl border border-black shadow-sm flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center">
                    <BellRing className="w-5 h-5 text-red-600" />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full bg-blue-50 text-blue-800">
                    Platform SLA
                  </span>
                </div>
                <div>
                  <h4 className="text-base font-black text-slate-900">Emergency & Instant SLA</h4>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-black text-slate-900">{platformConfig?.paidAddons?.instantMatch?.slaMinutes ?? 15}m</span>
                    <span className="text-xs text-slate-400 font-bold">Guaranteed Response</span>
                  </div>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Emergency jobs trigger direct SMS alerts to top-ranked nearby tradespeople with a £{platformConfig?.paidAddons?.emergencyBoost?.price ?? 5.00} urgency stipend paid by homeowners.
                </p>
                <div className="text-[11px] font-bold text-slate-700 space-y-1 pt-2">
                  <div className="flex items-center gap-1.5 text-slate-800">
                    <Clock className="w-3.5 h-3.5 text-blue-600" /> {platformConfig?.paidAddons?.instantMatch?.slaMinutes ?? 15}-Min Match Threshold
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-800">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> £{platformConfig?.paidAddons?.milestoneEscrow?.homeownerMediationStake ?? 25.00} Protected Stake
                  </div>
                </div>
              </div>

              <div className="mt-6 p-3 bg-slate-50 rounded-xl border border-black/10 text-center">
                <p className="text-[11px] font-semibold text-slate-600">Auto-enabled for all verified responders</p>
              </div>
            </div>
          </div>
        </div>

        {/* Dual-Role Payment Methods: Receiving Payouts (Stripe Connect) + Saved Cards (Spending) */}
        <div className="mt-16 max-w-7xl mx-auto space-y-6">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-black">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Wallet className="w-5 h-5 text-blue-700" />
                <h3 className="text-xl font-black text-black tracking-tight">Payment Methods & Payouts</h3>
              </div>
              <p className="text-xs text-black font-medium">
                Manage both how you receive job payouts (Stripe Connect) and how you pay for subscriptions, hired trades, or rides (Saved Cards).
              </p>
            </div>
          </div>

          <div className={cn("grid grid-cols-1 gap-6", isPayoutEligible ? "lg:grid-cols-2" : "lg:grid-cols-1")}>
            {isPayoutEligible && (
              <div className="bg-white rounded-2xl border border-black p-5 sm:p-6 shadow-sm flex flex-col justify-between space-y-5">
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-black flex items-center justify-center shrink-0">
                        <PoundSterling className="w-5 h-5 text-emerald-700" />
                      </div>
                      <div>
                        <h4 className="text-base font-black text-black leading-tight">Receiving Payouts (Stripe Connect)</h4>
                        <p className="text-xs font-medium text-black mt-0.5">
                          Single payout account for completed AnyTrader milestones and AnyRoller earnings.
                        </p>
                      </div>
                    </div>
                    {stripeConnectStatus.loading ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg bg-slate-100 border border-black text-black shrink-0">
                        <Loader2 className="w-3 h-3 animate-spin" /> Checking
                      </span>
                    ) : stripeConnectStatus.payoutsEnabled ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg bg-emerald-100 border border-black text-emerald-900 shrink-0">
                        <Check className="w-3 h-3" /> Active
                      </span>
                    ) : stripeConnectStatus.connected ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg bg-amber-100 border border-black text-black shrink-0">
                        Verification Needed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg bg-slate-100 border border-black text-black shrink-0">
                        Not Connected
                      </span>
                    )}
                  </div>

                  {stripeConnectStatus.error && (
                    <div className="p-3 rounded-xl bg-amber-50 border border-black text-xs font-medium text-black">
                      {stripeConnectStatus.error}
                    </div>
                  )}

                  {stripeConnectStatus.payoutsEnabled ? (
                    <div className="p-4 rounded-xl bg-emerald-50 border border-black space-y-1.5">
                      <p className="text-xs font-black text-black">Your bank account is verified and ready for payouts.</p>
                      <p className="text-xs text-black font-medium leading-relaxed">
                        Open your Stripe Express Dashboard to review bank details, transfer history, and tax documents.
                      </p>
                    </div>
                  ) : stripeConnectStatus.connected ? (
                    <div className="p-4 rounded-xl bg-amber-50 border border-black space-y-1.5">
                      <p className="text-xs font-black text-black">
                        {stripeConnectStatus.detailsSubmitted
                          ? "Stripe is reviewing your verification details."
                          : "Finish Stripe verification to enable bank payouts."}
                      </p>
                      <p className="text-xs text-black font-medium leading-relaxed">
                        Continue onboarding with Stripe to submit any remaining ID or bank account checks.
                      </p>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-slate-50 border border-black space-y-1.5">
                      <p className="text-xs font-black text-black">Connect your bank account via Stripe Express</p>
                      <p className="text-xs text-black font-medium leading-relaxed">
                        Required to receive direct payouts from escrow-protected jobs and completed work without holding funds on-platform.
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2.5 pt-2">
                  {stripeConnectStatus.payoutsEnabled ? (
                    <button
                      type="button"
                      onClick={handleOpenStripeDashboard}
                      disabled={isOpeningStripeDashboard}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-black border border-black transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {isOpeningStripeDashboard ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ExternalLink className="w-3.5 h-3.5" />
                      )}
                      <span>Open Stripe Express Dashboard</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStartStripeConnect}
                      disabled={isLaunchingConnect}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black border border-black transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {isLaunchingConnect ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <PoundSterling className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {stripeConnectStatus.connected ? "Continue Stripe Verification" : "Set Up Payouts with Stripe"}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => fetchStripeConnectStatus()}
                    disabled={stripeConnectStatus.loading}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-white hover:bg-slate-50 text-black text-xs font-bold border border-black transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", stripeConnectStatus.loading && "animate-spin")} />
                    <span>Refresh Status</span>
                  </button>
                </div>
              </div>
            )}

            <SavedPaymentCardsPanel
              savedCards={savedCards}
              isAddingCard={isAddingCard}
              busyCardId={busyCardId}
              busyAction={busyCardAction}
              onAddCard={handleAddPaymentMethod}
              onSetDefault={handleSetDefaultPaymentMethod}
              onDeleteCard={handleDeletePaymentMethod}
              title="Saved Payment Cards (Spending)"
              subtitle="Used for platform subscriptions, add-ons, hiring other tradespeople, or AnyRoller rides."
              emptyDescription="Link a card inside Stripe's PCI-DSS Level 1 Vault to pay for subscriptions, hire other tradespeople, or pay for AnyRoller journeys."
            />
          </div>
        </div>

        {/* Footer info */}
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="mt-16 text-center"
        >
            <div className="inline-flex items-center gap-2 text-slate-500 text-xs bg-white px-6 py-3 rounded-2xl border border-black shadow-sm">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                Payments secured by <span className="font-bold text-slate-900">Stripe</span>. Cancel anytime.
            </div>
            <p className="text-[10px] text-slate-400 mt-6 max-w-md mx-auto italic">
              * Success fees are automatically deducted from job payouts or calculated at job completion. 
              Founding rewards are valid as long as the subscription remains active.
            </p>
        </motion.div>
      </div>
    </div>
  );
}
