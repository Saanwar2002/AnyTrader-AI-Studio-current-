import React, { useState, useEffect } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "./utils";

export async function shareDeal(e: React.MouseEvent | React.TouchEvent, deal: any) {
  e.preventDefault();
  e.stopPropagation();

  const traderName = deal.traderName || "Verified Trader";
  const service = deal.service || "Flash Discount";
  const discount = deal.discountPercentage || 15;
  const dealUrl = `${window.location.origin}/profile/${deal.traderId}`;

  const title = `⚡ ${discount}% OFF ${service} on AnyTrader`;
  const text = `🔥 Check out this ${discount}% OFF Flash Deal on AnyTrader!\n\n🛠️ Service: ${service}\n👤 Trader: ${traderName}\n${deal.description ? `💬 "${deal.description}"\n` : ""}`;

  if (navigator.share) {
    try {
      await navigator.share({
        title,
        text,
        url: dealUrl,
      });
      toast.success("Deal shared successfully!");
      return;
    } catch (err: any) {
      if (err.name === "AbortError") return; // User cancelled
    }
  }

  // Fallback: Copy to clipboard
  try {
    await navigator.clipboard.writeText(`${text}\n👉 Claim discount: ${dealUrl}`);
    toast.success("Deal link copied to clipboard!");
  } catch {
    toast.error("Unable to copy deal link on this browser. Please copy the profile URL directly.");
  }
}

export function DealCountdownBadge({ deal, className }: { deal: any; className?: string }) {
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  const hasValidExpiry = Boolean(deal?.expiresAt);

  useEffect(() => {
    if (!hasValidExpiry) {
      setTimeLeft(null);
      setIsExpired(false);
      return;
    }

    const rawExpiry = deal.expiresAt;
    const targetMs =
      typeof rawExpiry?.toMillis === "function"
        ? rawExpiry.toMillis()
        : typeof rawExpiry === "string"
        ? new Date(rawExpiry).getTime()
        : Number(rawExpiry);

    if (!Number.isFinite(targetMs)) {
      setTimeLeft(null);
      setIsExpired(false);
      return;
    }

    const calculateTime = () => {
      const diff = targetMs - Date.now();
      if (diff <= 0) {
        setIsExpired(true);
        setTimeLeft("Expired");
        return;
      }
      setIsExpired(false);
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

      if (hours > 0) {
        setTimeLeft(`${hours}h ${minutes}m`);
      } else {
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        setTimeLeft(`${minutes}m ${seconds}s`);
      }
    };

    calculateTime();
    const interval = setInterval(calculateTime, 1000);
    return () => clearInterval(interval);
  }, [deal?.expiresAt, hasValidExpiry]);

  return (
    <span className={cn("inline-flex items-center gap-1 text-[9px] sm:text-[9.5px] bg-amber-50 text-amber-900 border border-amber-300/80 px-2 py-0.5 rounded-md font-extrabold uppercase tracking-tight shrink-0 shadow-2xs", className)}>
      <Clock className="w-2.5 h-2.5 text-amber-600 shrink-0" />
      {!hasValidExpiry || timeLeft === null
        ? "Limited Offer"
        : isExpired
        ? "Offer Ended"
        : `Ends in ${timeLeft}`}
    </span>
  );
}
