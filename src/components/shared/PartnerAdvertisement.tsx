import React, { useState, useEffect, useRef } from "react";
import { 
  ChevronRight, ChevronLeft, Zap, Briefcase, ShieldCheck, Star, Gift, 
  ShieldAlert, Award, FileText, Copy, Check, ExternalLink, Sparkles, 
  Tag, Percent, Wrench, Flame, ShoppingBag, CreditCard, UserCheck, CheckCircle2,
  MapPin, Clock
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { 
  collection, query, where, limit, onSnapshot, doc 
} from "firebase/firestore";
import { db, auth } from "../../firebase";
import { cn, getOutwardPostcode } from "../../lib/utils";
import { openSafeExternalUrl } from "../../lib/safeExternalUrl";
import { FlexiPayMode, resolveFlexiPayMode } from "../../lib/marketplaceContracts";
import { useAuth } from "../AuthProvider";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { Tradesperson } from "../../services/seedService";
import { IllustratedAdTicker } from "./IllustratedAdTicker";

const iconMap: Record<string, any> = {
  Zap, Briefcase, ShieldCheck, Star, Gift, ShieldAlert, Award, 
  FileText, Tag, Percent, Wrench, Flame, ShoppingBag, CreditCard, UserCheck, Sparkles
};

export interface PartnerAdItem {
  id: string;
  title: string;
  description: string;
  url: string;
  bgColor?: string;
  gradient?: string;
  iconName?: string;
  targetRole?: string;
  targetCategories?: string[];
  type?: "partner" | "trader_promo" | "voucher" | "financing" | "verified_pro" | "business";
  isTraderAd?: boolean;
  voucherCode?: string;
  badgeLabel?: string;
  perkText?: string;
  advertiserName?: string;
  advertiserId?: string;
  advertiserUid?: string;
  targetProfileId?: string;
  imageUrl?: string;
  clicks?: number;
  bannerClicks?: number;
  costPerDisplay?: number;
  billingCycle?: string;
  prepaidBalance?: number;
  autoTopUpEnabled?: boolean;
  autoTopUpThreshold?: number;
  autoTopUpAmount?: number;
  totalBudget?: number;
  placement?: string;
  isActive?: boolean;
  approvalStatus?: string;
  endDate?: any;
}

// First-party fallback cards shown only when no live paid campaigns match (zero fictional profiles or fake promo codes)
const DEFAULT_HOMEOWNER_ADVERTS: PartnerAdItem[] = [
  {
    id: "homeowner-discover-1",
    title: "Browse Verified Local Tradespeople",
    description: "Compare verified UK trades across 96+ categories with transparent reviews, badges, and direct quote requests.",
    url: "/find-trades",
    bgColor: "bg-slate-900",
    gradient: "from-slate-950 via-blue-950 to-slate-900",
    iconName: "ShieldCheck",
    targetRole: "homeowner",
    targetCategories: ["all"],
    type: "verified_pro",
    badgeLabel: "ANYTRADER PROS",
    perkText: "Verified ID, Qualifications & Insurance",
    advertiserName: "AnyTrader Directory"
  },
  {
    id: "homeowner-postjob-2",
    title: "Post a Job Free & Get AI Price Guides",
    description: "Describe your project once to see UK benchmark cost ranges and receive structured quotes from local trades.",
    url: "/post-job",
    bgColor: "bg-slate-900",
    gradient: "from-slate-950 via-indigo-950 to-slate-900",
    iconName: "Sparkles",
    targetRole: "homeowner",
    targetCategories: ["all"],
    type: "partner",
    badgeLabel: "FREE TO POST",
    perkText: "Milestone Escrow Payment Protection",
    advertiserName: "AnyTrader"
  },
  {
    id: "homeowner-passport-3",
    title: "Digital Property Passport & Compliance",
    description: "Track EPC, CP12 Gas Safety & EICR certificates, maintenance history, and 1-tap trade dispatch in one place.",
    url: "/portfolio",
    bgColor: "bg-slate-900",
    gradient: "from-slate-950 via-emerald-950 to-slate-900",
    iconName: "FileText",
    targetRole: "homeowner",
    targetCategories: ["all"],
    type: "partner",
    badgeLabel: "HOME TOOLKIT",
    perkText: "Automated Renewal Alerts",
    advertiserName: "AnyTrader Passports"
  },
  {
    id: "homeowner-flexipay-4",
    title: "FlexiPay Major Repair Financing",
    description: "Spread eligible £1,000+ home repair costs over manageable monthly instalments.",
    url: "/billing",
    bgColor: "bg-emerald-950",
    gradient: "from-emerald-950 via-teal-950 to-slate-950",
    iconName: "CreditCard",
    targetRole: "homeowner",
    targetCategories: ["Roofing", "Electrical", "Heating & Gas", "Building & Construction", "all"],
    type: "financing",
    badgeLabel: "FLEXIPAY",
    perkText: "Monthly Instalment Plans",
    advertiserName: "AnyTrader FlexiPay"
  }
];

const DEFAULT_TRADESPERSON_ADVERTS: PartnerAdItem[] = [
  {
    id: "trade-zerolead-1",
    title: "Zero Upfront Lead Fees on AnyTrader",
    description: "Quote directly on local homeowner jobs without buying leads. Pay platform fees only when jobs complete.",
    url: "/job-feed",
    bgColor: "bg-blue-950",
    gradient: "from-blue-950 via-slate-900 to-sky-950",
    iconName: "Briefcase",
    targetRole: "tradesperson",
    targetCategories: ["all"],
    type: "partner",
    badgeLabel: "TRADEOS",
    perkText: "Direct Client Messaging & Escrow",
    advertiserName: "AnyTrader TradeOS"
  },
  {
    id: "trade-promote-2",
    title: "Feature Your Business at the Top",
    description: "Launch a flat-rate £2.00/day local banner promotion or CPC search campaign with full click analytics.",
    url: "/trader/banner-ads",
    bgColor: "bg-slate-900",
    gradient: "from-slate-950 via-amber-950 to-slate-900",
    iconName: "Zap",
    targetRole: "tradesperson",
    targetCategories: ["all"],
    type: "business",
    badgeLabel: "AD STUDIO",
    perkText: "Pause or Adjust Anytime",
    advertiserName: "AnyTrader Ad Studio"
  },
  {
    id: "trade-verify-3",
    title: "Boost Trust with Video Verification",
    description: "Upload a short credential intro video and verified compliance documents to stand out on homeowner quotes.",
    url: "/profile",
    bgColor: "bg-emerald-950",
    gradient: "from-emerald-950 via-slate-900 to-teal-950",
    iconName: "ShieldCheck",
    targetRole: "tradesperson",
    targetCategories: ["all"],
    type: "verified_pro",
    badgeLabel: "VERIFIED PRO",
    perkText: "Stand Out in Local Search",
    advertiserName: "AnyTrader Verification"
  }
];

export default function PartnerAdvertisement({ 
  role = "tradesperson", 
  category,
  activeCategories = [],
  className
}: { 
  role?: string; 
  category?: string; 
  activeCategories?: string[];
  className?: string;
}) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [adverts, setAdverts] = useState<PartnerAdItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [rotationSpeed, setRotationSpeed] = useState(7000); // 7s comfortable read time
  const [isBannerAdsEnabled, setIsBannerAdsEnabled] = useState(true);
  const [flexiPayMode, setFlexiPayMode] = useState<FlexiPayMode>("coming_soon");
  const [isPaused, setIsPaused] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [tradersMap, setTradersMap] = useState<Record<string, Tradesperson>>({});

  // Touch Swipe Handling
  const touchStartXRef = useRef<number | null>(null);
  const touchEndXRef = useRef<number | null>(null);

  useEffect(() => {
    let isMounted = true;

    // 0. Fetch bounded set of live tradespeople to enrich promoted trader profiles
    const unsubTraders = onSnapshot(query(collection(db, "public_profiles"), limit(150)), (snapshot) => {
      if (!isMounted) return;
      const map: Record<string, Tradesperson> = {};
      snapshot.docs.forEach(d => {
        map[d.id] = { uid: d.id, ...d.data() } as Tradesperson;
      });
      setTradersMap(map);
    }, (error) => {
      console.warn("Tradespeople query notice:", error);
    });

    // 1. Global config (ad rotation speed & launch flags)
    const unsubConfig = onSnapshot(doc(db, "platform_config", "global"), (docSnapshot) => {
      if (!isMounted) return;
      if (docSnapshot.exists()) {
        const config = docSnapshot.data();
        if (config.adRotationSpeedSeconds) {
          setRotationSpeed(Math.max(5, config.adRotationSpeedSeconds) * 1000);
        }
        setFlexiPayMode(resolveFlexiPayMode(config));
      }
    }, (error) => {
      console.warn("Platform Config Notice:", error);
    });

    // 2. Advertising master switch
    const unsubAdConfig = onSnapshot(doc(db, "platform_config", "advertising"), (docSnapshot) => {
      if (!isMounted) return;
      if (docSnapshot.exists()) {
        setIsBannerAdsEnabled(docSnapshot.data().isBannerAdsEnabled !== false);
      }
    }, (error) => {
      console.warn("Advertising Config Notice:", error);
    });

    // 3. Live public advertisements projection query (non-sensitive public fields only)
    const adsQuery = query(
      collection(db, "public_ads"),
      where("isActive", "==", true),
      limit(50)
    );
    const unsubs = onSnapshot(adsQuery, (snapshot) => {
      if (!isMounted) return;
      const activeAds: PartnerAdItem[] = snapshot.docs
        .map(d => {
          const data = d.data() as any;
          return { id: d.id, ...data } as PartnerAdItem;
        })
        .filter(ad => ad.isActive !== false)
        // Placement check: banner_ad, both, or backward-compatible undefined
        .filter(ad => !ad.placement || ad.placement === "banner_ad" || ad.placement === "both")
        // Expiration check for day-based campaigns
        .filter(ad => {
           if (ad.type === "trader_promo" && ad.endDate) {
              const endMillis = ad.endDate.toMillis ? ad.endDate.toMillis() : (ad.endDate.seconds ? ad.endDate.seconds * 1000 : new Date(ad.endDate).getTime());
              if (Date.now() > endMillis) return false;
           }
           return true;
        })
        // Sanitized budget availability flag from public_ads projection
        .filter(ad => (ad as any).hasAvailableBudget !== false)
        // Target role filtering
        .filter(ad => !ad.targetRole || ad.targetRole === "all" || ad.targetRole === role)
        // Specific category filter when browsing a single trade category
        .filter(ad => {
            if (!category || !ad.targetCategories || ad.targetCategories.length === 0) return true;
            return ad.targetCategories.includes(category) || ad.targetCategories.includes("all");
        });
      
      setAdverts(activeAds);
    }, (error) => {
      console.warn("Public advertisements query notice:", error);
    });

    return () => {
      isMounted = false;
      unsubTraders();
      unsubConfig();
      unsubAdConfig();
      unsubs();
    };
  }, [role, category]);

  // Combine live database ads with honest first-party defaults (respecting FlexiPay launch control)
  const defaultList = (role === "homeowner" ? DEFAULT_HOMEOWNER_ADVERTS : DEFAULT_TRADESPERSON_ADVERTS).filter(
    (ad) => ad.type !== "financing" || flexiPayMode === "live"
  );
  
  // Intelligent Job-Status & Category Targeting Engine:
  // Sorts ads so that offers matching the homeowner's active posted jobs or viewed categories appear first!
  const targetCategorySet = new Set(
    [category, ...(activeCategories || [])].filter(Boolean).map(c => (c || "").toLowerCase())
  );

  const rawCombinedList = [...adverts, ...defaultList];

  const sortedAdverts = [...rawCombinedList].sort((a, b) => {
    // 1. Prioritize live paid campaigns from traders & trade partners over defaults
    const aIsLiveDb = a.id && !String(a.id).startsWith("homeowner-") && !String(a.id).startsWith("trade-");
    const bIsLiveDb = b.id && !String(b.id).startsWith("homeowner-") && !String(b.id).startsWith("trade-");

    // 2. Check category relevance against homeowner's active posted jobs
    const aMatchesJob = (a.targetCategories || []).some(cat => 
      targetCategorySet.has(cat.toLowerCase()) || 
      Array.from(targetCategorySet).some(tc => cat.toLowerCase().includes(tc) || tc.includes(cat.toLowerCase()))
    );
    const bMatchesJob = (b.targetCategories || []).some(cat => 
      targetCategorySet.has(cat.toLowerCase()) || 
      Array.from(targetCategorySet).some(tc => cat.toLowerCase().includes(tc) || tc.includes(cat.toLowerCase()))
    );

    if (aMatchesJob && !bMatchesJob) return -1;
    if (!aMatchesJob && bMatchesJob) return 1;
    if (aIsLiveDb && !bIsLiveDb) return -1;
    if (!aIsLiveDb && bIsLiveDb) return 1;
    return 0;
  });

  // Deduplicate by ID
  const displayAdverts = Array.from(new Map(sortedAdverts.map(item => [item.id, item])).values());

  // Auto rotation timer with pause on hover/touch
  useEffect(() => {
    if (displayAdverts.length <= 1 || isPaused) return;

    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % displayAdverts.length);
    }, rotationSpeed);

    return () => clearInterval(timer);
  }, [displayAdverts.length, rotationSpeed, isPaused]);

  if (!isBannerAdsEnabled || displayAdverts.length === 0) return null;

  const currentAd = displayAdverts[currentIndex % displayAdverts.length];
  const linkedTraderUid = currentAd.targetProfileId || currentAd.advertiserUid || currentAd.advertiserId;
  const linkedTrader = linkedTraderUid ? tradersMap[linkedTraderUid] : undefined;
  const isPromotedTrader = !!linkedTrader || currentAd.isTraderAd || !!currentAd.targetProfileId || !!currentAd.advertiserUid;

  const displayTitle = currentAd.title || linkedTrader?.businessName || linkedTrader?.name || "Verified Trade Specialist";
  const displayTagline = currentAd.description || (currentAd as any).tagline || linkedTrader?.bio || (linkedTrader as any)?.miniProfileSettings?.extraInfo || "Top-rated local verified trade professional with upfront pricing and guaranteed workmanship.";
  const displayAvatar = linkedTrader?.avatarUrl || currentAd.imageUrl;
  const displayRating = linkedTrader?.rating || (currentAd as any).rating;
  const displayReviews = linkedTrader?.totalReviews || (currentAd as any).totalReviews;
  const displayPerk = currentAd.perkText || (linkedTrader?.isAvailableForEmergency ? "⚡ 24/7 Response Guaranteed" : linkedTrader?.trades?.[0] ? `${linkedTrader.trades[0]} Specialist` : undefined);

  const mainTradeCategory = 
    (linkedTrader as any)?.trade || 
    linkedTrader?.trades?.[0] || 
    (linkedTrader as any)?.tradeCategory ||
    (currentAd.targetCategories?.find((c: string) => c && c.toLowerCase() !== "all") || (currentAd.targetCategories?.[0] !== "all" ? currentAd.targetCategories?.[0] : undefined)) ||
    (currentAd as any).tradeCategory ||
    (currentAd as any).category;

  const AdIcon = iconMap[currentAd.iconName || ""] || (isPromotedTrader ? Star : Zap);

  // Handle ad clicks (external vs internal routes with billing deductions)
  const handleAdClick = (clickedAd: PartnerAdItem, e?: React.MouseEvent) => {
    if (e) e.preventDefault();

    // Track engagement & transactional CPC billing via server endpoint (non-blocking)
    if (clickedAd.id && !String(clickedAd.id).startsWith("homeowner-") && !String(clickedAd.id).startsWith("trade-") && !String(clickedAd.id).startsWith("default-") && !String(clickedAd.id).startsWith("seed-")) {
      (async () => {
        try {
          const token = await auth.currentUser?.getIdToken().catch(() => null);
          await fetch(`/api/ads/${encodeURIComponent(clickedAd.id)}/track`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              eventType: "click",
              placement: "banner_ad",
            }),
          });
        } catch (err) {
          console.warn("Failed to track ad click:", err);
        }
      })();
    }

    // Instant zero-latency navigation logic: internal app routes vs external websites
    const traderUid = clickedAd.targetProfileId || clickedAd.advertiserUid || (clickedAd as any).advertiserId;
    const isTraderAd = !!traderUid || clickedAd.isTraderAd || clickedAd.type === "trader_promo";
    const resolvedTrader = traderUid ? tradersMap[traderUid] : linkedTrader;

    // 1. If it's a trader ad or has a traderUid, navigate directly to their public profile with pre-hydrated profile!
    if (isTraderAd && traderUid) {
      navigate(`/profile/${traderUid}`, { state: { initialProfile: resolvedTrader } });
      return;
    }

    let targetUrl = clickedAd.url || "";
    if (targetUrl.includes("/profile/")) {
      const profilePart = targetUrl.substring(targetUrl.indexOf("/profile/"));
      const extractedUid = profilePart.replace("/profile/", "").split("?")[0].split("#")[0];
      const extractedTrader = extractedUid ? tradersMap[extractedUid] : resolvedTrader;
      navigate(profilePart, { state: { initialProfile: extractedTrader } });
      return;
    }

    if (!targetUrl) {
      targetUrl = traderUid ? `/profile/${traderUid}` : "/find-trades";
    }

    if (targetUrl.startsWith("/")) {
      navigate(targetUrl, { state: { initialProfile: resolvedTrader } });
    } else {
      openSafeExternalUrl(targetUrl);
    }
  };

  // Copy promo/voucher code
  const handleCopyCode = (code: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    toast.success(`Promo code ${code} copied!`, {
      description: "Apply this discount at checkout for instant savings."
    });
    setTimeout(() => setCopiedCode(null), 3000);
  };

  // Manual carousel navigation
  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setCurrentIndex((prev) => (prev - 1 + displayAdverts.length) % displayAdverts.length);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setCurrentIndex((prev) => (prev + 1) % displayAdverts.length);
  };

  // Swipe handlers for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    setIsPaused(true);
    touchStartXRef.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndXRef.current = e.touches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (touchStartXRef.current !== null && touchEndXRef.current !== null) {
      const deltaX = touchStartXRef.current - touchEndXRef.current;
      if (deltaX > 45) {
        // Swiped left -> Next
        setCurrentIndex((prev) => (prev + 1) % displayAdverts.length);
      } else if (deltaX < -45) {
        // Swiped right -> Prev
        setCurrentIndex((prev) => (prev - 1 + displayAdverts.length) % displayAdverts.length);
      }
    }
    touchStartXRef.current = null;
    touchEndXRef.current = null;
    setTimeout(() => setIsPaused(false), 2500);
  };

  return (
    <div className={cn("-mt-5 sm:-mt-4 mb-5 select-none", className)}>
      {/* Illustrated Marquee Ticker directly above advertising container - No boxes or containers */}
      <IllustratedAdTicker role={role} />

      {/* Main Banner Card Container with Natural Height & High-Contrast Black Border */}
      <div 
        className="mt-1.5 relative group/banner select-none"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="relative overflow-hidden rounded-2xl w-full min-h-[150px] sm:min-h-[140px] bg-slate-900 border border-black shadow-md z-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentAd.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            onClick={(e) => handleAdClick(currentAd, e)}
            className={cn(
              "relative w-full h-full min-h-[150px] sm:min-h-[140px] text-white cursor-pointer overflow-hidden flex flex-col justify-between p-3.5 sm:p-4 bg-gradient-to-r",
              currentAd.gradient || "from-slate-950 via-slate-900 to-slate-950"
            )}
            style={{ 
              backgroundColor: currentAd.bgColor && !currentAd.bgColor.startsWith("bg-") ? currentAd.bgColor : undefined 
            }}
          >
            {/* Golden Ribbon Badge tucked away in the top right corner (Matches exact reference design) */}
            <div className="absolute top-0 right-3.5 sm:right-4 z-20 shrink-0 pointer-events-none drop-shadow-md">
              <div 
                className="w-12 sm:w-13 pt-2 pb-3.5 bg-gradient-to-b from-[#FDE68A] via-[#F59E0B] to-[#D97706] text-[#3B2500] flex flex-col items-center justify-center text-center shadow-lg font-black rounded-b-xs border-x border-b border-amber-300/40"
                style={{
                  clipPath: "polygon(0 0, 100% 0, 100% 100%, 50% 85%, 0 100%)",
                }}
              >
                {(() => {
                  const fullBadgeText = currentAd.badgeLabel || (isPromotedTrader ? "FEATURED PRO" : "PARTNER OFFER");
                  const badgeParts = fullBadgeText.trim().split(/\s+/);
                  const badgeTop = badgeParts[0] || "FEATURED";
                  const badgeBottom = badgeParts.slice(1).join(" ") || "PRO";
                  return (
                    <>
                      <span className="text-[7.5px] sm:text-[8px] font-black tracking-wider leading-none uppercase drop-shadow-[0_0.5px_0_rgba(255,255,255,0.4)]">
                        {badgeTop}
                      </span>
                      <span className="text-[10px] sm:text-[11px] font-black tracking-tight leading-none mt-0.5 uppercase drop-shadow-[0_0.5px_0_rgba(255,255,255,0.4)]">
                        {badgeBottom}
                      </span>
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Top Bar: Icon/Avatar + Trader/Brand Header */}
            <div className="flex items-start justify-between gap-2.5 pr-16 sm:pr-20">
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                {/* Brand / Trader Avatar Container */}
                <div className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-white/10 border border-white/20 flex items-center justify-center shrink-0 shadow-inner overflow-hidden mt-0.5">
                  {displayAvatar ? (
                    <img 
                      src={displayAvatar} 
                      alt={displayTitle} 
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <AdIcon className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]" />
                  )}
                  {isPromotedTrader && (
                    <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 rounded-full border border-black flex items-center justify-center shadow-xs">
                      <Check className="w-2 h-2 text-white stroke-[3]" />
                    </div>
                  )}
                </div>

                {/* Title & Hierarchy: Personal Name -> Business Name -> Rating + Prominent Trade Category Badge */}
                <div className="min-w-0 flex-1">
                  {isPromotedTrader ? (
                    <>
                      {/* 1. Personal Name (or Business name if business-only) */}
                      <h4 className="text-xs sm:text-sm font-black text-white leading-tight truncate">
                        {(linkedTrader as any)?.displayNamePreference === "business_only" 
                          ? (linkedTrader?.businessName || currentAd.title || "Verified Business")
                          : (linkedTrader?.name || currentAd.advertiserName || displayTitle)}
                      </h4>

                      {/* 2. Business Name */}
                      {(() => {
                        const bName = linkedTrader?.businessName || (currentAd.title !== linkedTrader?.name ? currentAd.title : "");
                        if (bName && (linkedTrader as any)?.displayNamePreference !== "business_only") {
                          return (
                            <p className="text-[10px] sm:text-[11px] font-bold text-slate-300 truncate mt-0.5">
                              {bName}
                            </p>
                          );
                        }
                        return null;
                      })()}

                      {/* 3. Star Rating & Prominent Main Trade Category Badge */}
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {displayRating && (
                          <span className="inline-flex items-center gap-1 bg-amber-400/20 border border-amber-400/40 text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-black shrink-0">
                            <Star className="w-2.5 h-2.5 fill-amber-300 text-amber-300" />
                            {Number(displayRating).toFixed(1)}
                            {displayReviews ? <span className="text-[9px] opacity-80">({displayReviews})</span> : null}
                          </span>
                        )}

                        {/* Highlighted Main Trade Category Pill */}
                        {mainTradeCategory && mainTradeCategory.toLowerCase() !== "all" && (
                          <span className="inline-flex items-center gap-1 bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 text-white border border-blue-400/60 px-2 py-0.5 rounded-md text-[9.5px] sm:text-[10px] font-black tracking-wide uppercase shadow-xs shrink-0 max-w-[170px] sm:max-w-[210px] truncate">
                            <Wrench className="w-2.5 h-2.5 text-sky-200 shrink-0" />
                            <span className="truncate">{mainTradeCategory}</span>
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Non-trader partner banner */}
                      <h4 className="text-xs sm:text-sm font-black text-white leading-tight truncate">
                        {displayTitle}
                      </h4>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {displayRating && (
                          <span className="inline-flex items-center gap-1 bg-amber-400/20 border border-amber-400/40 text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-black shrink-0">
                            <Star className="w-2.5 h-2.5 fill-amber-300 text-amber-300" />
                            {Number(displayRating).toFixed(1)}
                            {displayReviews ? <span className="text-[9px] opacity-80">({displayReviews})</span> : null}
                          </span>
                        )}

                        {mainTradeCategory && mainTradeCategory.toLowerCase() !== "all" && (
                          <span className="inline-flex items-center gap-1 bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 text-white border border-blue-400/60 px-2 py-0.5 rounded-md text-[9.5px] sm:text-[10px] font-black tracking-wide uppercase shadow-xs shrink-0 max-w-[170px] sm:max-w-[210px] truncate">
                            <Tag className="w-2.5 h-2.5 text-sky-200 shrink-0" />
                            <span className="truncate">{mainTradeCategory}</span>
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Middle: Full-Width Promoted Perk Highlight & Description (No text cutoff) */}
            <div className="my-2 flex-1 flex flex-col justify-center gap-1 min-w-0">
              {displayPerk && (
                <div className="flex items-center gap-1.5 text-[11px] sm:text-xs font-black text-amber-300 tracking-wide">
                  <Sparkles className="w-3 h-3 fill-amber-300 shrink-0" />
                  <span className="leading-snug line-clamp-1">{displayPerk}</span>
                </div>
              )}
              <p className="text-xs sm:text-[13px] text-slate-200 font-medium leading-snug line-clamp-2">
                {displayTagline}
              </p>
            </div>

            {/* Bottom Row: Voucher Code / Perk + Action CTA (Guaranteed non-overlapping layout) */}
            <div className="flex items-center justify-between gap-2.5 pt-2 border-t border-white/10 mt-auto">
              {/* Voucher Code Chip or Verified Partner Badge */}
              <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
                {currentAd.voucherCode ? (
                  <button
                    type="button"
                    onClick={(e) => handleCopyCode(currentAd.voucherCode!, e)}
                    className="inline-flex items-center gap-1.5 bg-amber-400/20 hover:bg-amber-400/30 active:scale-95 border border-amber-400/40 text-amber-200 hover:text-amber-100 text-[10px] sm:text-xs font-mono font-black px-2 py-0.5 rounded-md transition-all cursor-pointer shadow-2xs shrink-0"
                    title="Click to copy promo code"
                  >
                    {copiedCode === currentAd.voucherCode ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400 stroke-[3]" />
                        <span className="text-emerald-300 font-sans font-bold">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Tag className="w-3 h-3 text-amber-300 shrink-0" />
                        <span>CODE: {currentAd.voucherCode}</span>
                        <Copy className="w-2.5 h-2.5 text-amber-300 opacity-70 ml-0.5 shrink-0" />
                      </>
                    )}
                  </button>
                ) : isPromotedTrader && (linkedTrader || currentAd.advertiserName) ? (
                  <span className="text-[10px] sm:text-xs font-bold text-slate-300 flex items-center gap-1 truncate">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> 
                    <span className="truncate">
                      Verified Pro
                      {linkedTrader?.postcode ? ` · ${getOutwardPostcode(linkedTrader.postcode)}` : ""}
                      {(linkedTrader as any)?.miniProfileSettings?.callOutFee ? ` · £${(linkedTrader as any).miniProfileSettings.callOutFee} Callout` : " · Free Quote"}
                    </span>
                  </span>
                ) : (
                  <span className="text-[10px] sm:text-xs font-bold text-slate-300 flex items-center gap-1 truncate">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> 
                    <span className="truncate">{currentAd.advertiserName || "Verified Partner"}</span>
                  </span>
                )}
              </div>

              {/* Action Button CTA */}
              <div className="flex items-center gap-1 text-white group-hover:text-amber-300 transition-colors shrink-0 bg-white/10 hover:bg-white/20 border border-white/20 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md text-[10px] sm:text-xs font-bold">
                <span>
                  {isPromotedTrader ? "View Profile" : currentAd.url?.startsWith("http") ? "Claim Deal" : "Explore"}
                </span>
                {currentAd.url?.startsWith("http") ? (
                  <ExternalLink className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 stroke-[2.5] group-hover:translate-x-0.5 transition-transform" />
                )}
              </div>
            </div>

            {/* Background Image if uploaded by advertiser */}
            {currentAd.imageUrl && (
              <img 
                src={currentAd.imageUrl} 
                alt={currentAd.title} 
                className="absolute inset-0 w-full h-full object-cover -z-10 opacity-20 group-hover:scale-105 transition-transform duration-700 pointer-events-none" 
              />
            )}
          </motion.div>
        </AnimatePresence>

        {/* Carousel Navigation Arrow Controls (Desktop/Hover only) */}
        {displayAdverts.length > 1 && (
          <>
            <button
              type="button"
              onClick={handlePrev}
              className="absolute left-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/60 hover:bg-black/90 border border-white/20 text-white hidden md:flex items-center justify-center opacity-0 group-hover/banner:opacity-100 transition-opacity z-20 cursor-pointer shadow-md"
              title="Previous promotion"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/60 hover:bg-black/90 border border-white/20 text-white hidden md:flex items-center justify-center opacity-0 group-hover/banner:opacity-100 transition-opacity z-20 cursor-pointer shadow-md"
              title="Next promotion"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Sleek, Micro 3px Pagination Indicators (Placed cleanly underneath container) */}
      {displayAdverts.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-2 select-none">
          {displayAdverts.map((_, idx) => (
            <div
              key={idx}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setCurrentIndex(idx);
              }}
              role="button"
              tabIndex={0}
              aria-label={`Go to slide ${idx + 1}`}
              className={cn(
                "h-[3px] rounded-full transition-all duration-300 cursor-pointer p-0 m-0 border-0 outline-none block min-w-0 min-h-0",
                idx === currentIndex % displayAdverts.length 
                  ? "w-6 bg-amber-500 shadow-xs" 
                  : "w-2 bg-slate-300 hover:bg-slate-400"
              )}
            />
          ))}
        </div>
      )}

      {/* Advertiser Quick Link for Tradespeople & Business Accounts */}
      {(role === "tradesperson" || profile?.role === "tradesperson" || profile?.subscriptionType === "business" || profile?.role === "business") && (
        <div className="flex justify-center mt-2">
          <Link 
            to="/trader/banner-ads" 
            className="inline-flex items-center gap-1 bg-amber-300 hover:bg-amber-400 text-black border border-black px-3 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider shadow-xs hover:shadow-none transition-all cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <Sparkles className="w-2.5 h-2.5" />
            Promote your trade or business here
          </Link>
        </div>
      )}
      </div>
    </div>
  );
}
