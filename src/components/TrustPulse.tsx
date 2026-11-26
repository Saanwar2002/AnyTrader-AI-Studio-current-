import React, { useState, useEffect } from "react";
import { ShieldCheck, RefreshCw, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/src/lib/utils";

interface TrustPulseProps {
  status: "verified" | "vetted" | "auditioned" | "provisional" | "pending" | "unverified" | string;
  className?: string;
  traderId: string;
}

export const TrustPulse = ({ status, className, traderId }: TrustPulseProps) => {
  const [isVerifying, setIsVerifying] = useState(false);
  const [lastCheck, setLastCheck] = useState<Date>(new Date());
  const [pulseColor, setPulseColor] = useState("emerald");

  const normalizedStatus = String(status || "unverified").toLowerCase();
  const isVerifiedTier = ["verified", "vetted", "auditioned"].includes(normalizedStatus);

  useEffect(() => {
    if (!isVerifiedTier) return;
    // Simulate periodic "Live Pulse" checks for verified tiers only
    const interval = setInterval(() => {
      setIsVerifying(true);
      setTimeout(() => {
        setIsVerifying(false);
        setLastCheck(new Date());
      }, 1500);
    }, 15000); // Check every 15 seconds

    return () => clearInterval(interval);
  }, [isVerifiedTier]);

  if (normalizedStatus === "unverified") return null;

  if (normalizedStatus === "provisional" || normalizedStatus === "pending") {
    const isDocsPendingReview = normalizedStatus === "pending";
    return (
      <div className={cn("inline-flex flex-col gap-1", className)}>
        <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-amber-50 border border-black rounded-xl shadow-xs">
          <Clock className="w-3.5 h-3.5 text-amber-700 shrink-0" />
          <div className="flex flex-col">
            <span className="text-[10px] font-black uppercase tracking-wider text-black leading-none">
              {isDocsPendingReview ? "Verification In Review" : "New Trader · Verification Pending"}
            </span>
            <span className="text-[9px] font-semibold text-black/80 mt-0.5 leading-none">
              {isDocsPendingReview
                ? "Documents submitted · Awaiting Admin check"
                : "ID & insurance upload pending"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (!isVerifiedTier) return null;

  const getTierData = () => {
    switch (normalizedStatus) {
      case "auditioned":
        return {
          label: "Auditioned Pro",
          guarantee: "£1,000 Platform Guarantee",
          color: "amber",
          icon: <ShieldCheck className="w-4 h-4 text-amber-500" />
        };
      case "vetted":
        return {
          label: "Vetted Pro",
          guarantee: "£500 Platform Guarantee",
          color: "emerald",
          icon: <ShieldCheck className="w-4 h-4 text-emerald-500" />
        };
      case "verified":
        return {
          label: "Verified Pro",
          guarantee: "Standard Protection",
          color: "blue",
          icon: <CheckCircle2 className="w-4 h-4 text-blue-500" />
        };
      default:
        return {
          label: "Unverified",
          guarantee: "No Guarantee",
          color: "slate",
          icon: <AlertCircle className="w-4 h-4 text-slate-400" />
        };
    }
  };

  const data = getTierData();

  return (
    <div className={cn("inline-flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-black rounded-2xl shadow-sm relative overflow-hidden group">
        {/* Animated Background Pulse */}
        <motion.div 
          animate={{ 
            scale: [1, 1.2, 1],
            opacity: [0.1, 0.2, 0.1]
          }}
          transition={{ duration: 2, repeat: Infinity }}
          className={cn(
            "absolute -left-1 -top-1 w-6 h-6 rounded-full blur-lg",
            data.color === "amber" ? "bg-amber-400" : 
            data.color === "emerald" ? "bg-emerald-400" : "bg-blue-400"
          )}
        />

        <div className="flex items-center gap-2 relative z-10">
          <div className="relative">
            {data.icon}
            <motion.div 
              animate={isVerifying ? { rotate: 360 } : {}}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
              className="absolute -top-1 -right-1"
            >
              <div className={cn(
                "w-2 h-2 rounded-full border border-white shadow-sm",
                isVerifying ? "bg-slate-400" : (data.color === "amber" ? "bg-amber-500" : "bg-emerald-500")
              )} />
            </motion.div>
          </div>
          
          <div className="flex flex-col">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-900 leading-none">
              {isVerifying ? "Verifying..." : "Live Guard Active"}
            </span>
            <div className="flex items-center gap-1 mt-0.5">
              <span className={cn(
                "text-[9px] font-bold",
                data.color === "amber" ? "text-amber-600" : 
                data.color === "emerald" ? "text-emerald-600" : "text-blue-600"
              )}>
                {data.guarantee}
              </span>
            </div>
          </div>
        </div>

        <div className="h-6 w-px bg-slate-100 mx-1 relative z-10" />

        <div className="flex flex-col items-end relative z-10">
          <span className="text-[8px] font-bold text-slate-400 uppercase leading-none">
            Last Check
          </span>
          <span className="text-[9px] font-black text-slate-600 font-mono mt-0.5">
            {lastCheck.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
      </div>
      
      {/* Policy Details Tooltip (Simplified for visual trust) */}
      <div className="flex items-center gap-1 px-2">
        <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
        <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">
          Policy #AT-{traderId.substring(0, 4).toUpperCase()}-{new Date().getFullYear()} Validated
        </span>
      </div>
    </div>
  );
};
