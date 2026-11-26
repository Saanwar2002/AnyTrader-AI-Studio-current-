import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { useNavigate } from "react-router-dom";
import { 
  Shield, 
  Truck, 
  Wrench, 
  PoundSterling, 
  HeartPulse, 
  ChevronRight,
  ExternalLink,
  Zap,
  Award
} from "lucide-react";
import { cn } from "@/src/lib/utils";
import { openSafeExternalUrl } from "@/src/lib/safeExternalUrl";
import { db, collection, query, where, limit as fsLimit, onSnapshot } from "@/src/firebase";
import { useAuth } from "./AuthProvider";
import { trackClick, generateLead } from "@/src/services/leadService";

interface Perk {
  id: string;
  title: string;
  description: string;
  icon: any;
  color: string;
  category: string;
  cta: string;
  link: string;
  badge?: string;
  isCampaign?: boolean;
  partnerId?: string;
}

const DEFAULT_TRADER_PERKS: Perk[] = [
  {
    id: "trader-compliance-docs",
    title: "Verify Insurance & Credentials",
    description: "Upload your Public Liability Insurance and trade accreditations to earn Verified Pro badges on every quote.",
    icon: Shield,
    color: "blue",
    category: "Verification",
    cta: "Verify Profile",
    link: "/profile",
    badge: "Most Popular"
  },
  {
    id: "trader-banner-ads",
    title: "Local Banner & Search Promotions",
    description: "Feature your business at the top of local homeowner dashboards and directory results.",
    icon: Zap,
    color: "orange",
    category: "Growth",
    cta: "Open Ad Studio",
    link: "/trader/banner-ads"
  },
  {
    id: "trader-tradeos-billing",
    title: "Zero-Lead-Fee Billing & Invoices",
    description: "Manage subscription tiers, Stripe Connect payouts, and automated UK sole trader tax reserves.",
    icon: PoundSterling,
    color: "green",
    category: "TradeOS",
    cta: "Open Billing",
    link: "/billing"
  },
  {
    id: "trader-outreach",
    title: "Availability & Smart Calendar",
    description: "Keep your working schedule synced so homeowners only send requests on dates you are free.",
    icon: Wrench,
    color: "rose",
    category: "Scheduling",
    cta: "Manage Calendar",
    link: "/trader/calendar"
  }
];

export default function PartnerPerks({ limit }: { limit?: number }) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [activeCampaigns, setActiveCampaigns] = useState<any[]>([]);

  useEffect(() => {
    const q = query(
      collection(db, "campaigns"),
      where("status", "==", "active"),
      where("targetRole", "in", ["tradesperson", "both"]),
      fsLimit(25)
    );

    const unsub = onSnapshot(q, (snap) => {
      setActiveCampaigns(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    }, (error) => {
      console.error("Campaigns listing error:", error);
    });

    return () => unsub();
  }, []);

  const handlePerkClick = async (perk: Perk, e: React.MouseEvent) => {
    e.preventDefault();
    if (perk.isCampaign && user && perk.partnerId) {
      await trackClick(perk.id);
      await generateLead(perk.partnerId, perk.id, user.uid, profile?.role || "tradesperson");
    }
    if (!perk.link || perk.link === "#") return;
    if (perk.link.startsWith("/")) {
      navigate(perk.link);
    } else {
      openSafeExternalUrl(perk.link);
    }
  };

  const mappedCampaigns: Perk[] = activeCampaigns
    .filter((c) => typeof (c.url || c.targetUrl || c.trackingUrl) === "string" && (c.url || c.targetUrl || c.trackingUrl).trim().length > 0)
    .map(c => ({
      id: c.id,
      partnerId: c.partnerId,
      title: c.title,
      description: c.content || c.description || "",
      icon: Shield,
      color: "blue",
      category: "Partner Offer",
      cta: "Learn More",
      link: String(c.url || c.targetUrl || c.trackingUrl).trim(),
      isCampaign: true
    }));

  const combinedPerks = [...mappedCampaigns, ...DEFAULT_TRADER_PERKS];
  const displayPerks = limit ? combinedPerks.slice(0, limit) : combinedPerks;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 opacity-75">
          <Award className="w-4 h-4 text-slate-600" />
          <h2 className="text-xs font-bold text-black uppercase tracking-wider">Partner Perks & Pro Tools</h2>
        </div>
        {!limit && (
          <p className="text-xs text-slate-600 font-medium">Exclusive tools & offers for AnyTrader Pros</p>
        )}
      </div>

      <div className={cn(
        "grid gap-3",
        limit ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
      )}>
        {displayPerks.map((perk, idx) => {
          const isExternal = perk.link.startsWith("http");
          return (
            <motion.a
              key={perk.id}
              href={perk.link}
              target={isExternal ? "_blank" : undefined}
              rel={isExternal ? "noopener noreferrer" : undefined}
              onClick={(e) => handlePerkClick(perk, e)}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              className="group block bg-white hover:bg-slate-50 border border-black p-3 rounded-2xl transition-all relative overflow-hidden cursor-pointer"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[8px] font-bold uppercase tracking-wider text-slate-600 bg-slate-200/70 px-1.5 py-0.5 rounded flex items-center leading-none">
                      {perk.isCampaign ? "Ad" : "Pro Tool"}
                    </span>
                    {perk.badge && (
                      <span className="text-[9px] font-semibold text-slate-600 truncate leading-none">
                        • {perk.badge}
                      </span>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold text-black truncate">{perk.category}: {perk.title}</h3>
                  <p className="text-[11px] text-slate-700 line-clamp-1 mt-0.5">{perk.description}</p>
                </div>
                <div className="shrink-0 flex items-center">
                  {isExternal ? (
                    <ExternalLink className="w-4 h-4 text-slate-500 group-hover:text-black transition-colors" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-black transition-colors" />
                  )}
                </div>
              </div>
            </motion.a>
          );
        })}
      </div>

      {limit && (
        <div className="bg-primary/5 rounded-[2rem] p-6 border border-black flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-primary text-white flex items-center justify-center shadow-lg shadow-primary/20">
              <Zap className="w-6 h-6 fill-current" />
            </div>
            <div>
              <h4 className="font-black text-black">Grow Your Trade Business</h4>
              <p className="text-sm text-black/80">Promote your profile locally or manage your Verified Pro tools and membership.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate("/trader/banner-ads")}
            className="bg-primary text-white px-6 py-3 rounded-2xl font-black text-sm hover:bg-primary-hover transition-all shadow-lg shadow-primary/20 active:scale-95 cursor-pointer"
          >
            Open Ad Studio
          </button>
        </div>
      )}
    </div>
  );
}
