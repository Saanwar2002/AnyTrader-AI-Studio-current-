import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { CreditCard, ShieldCheck, ArrowRight, RefreshCw, Clock } from "lucide-react";
import { useAuth } from "../AuthProvider";
import { toast } from "sonner";

export default function PlatformFeeSuccess() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [status, setStatus] = useState<"checking" | "settled" | "pending" | "missing_session">("checking");
  const [settledAmount, setSettledAmount] = useState<number | null>(null);
  const [pendingBalance, setPendingBalance] = useState<number | null>(null);
  const [checkedAt] = useState<string>(() => new Date().toLocaleString());

  const fetchSettlementStatus = useCallback(async (): Promise<"settled" | "pending" | "missing_session"> => {
    if (!user) return "pending";
    const searchParams = new URLSearchParams(window.location.search);
    const sessionId = (searchParams.get("session_id") || "").trim();
    if (!sessionId) {
      setStatus("missing_session");
      return "missing_session";
    }

    try {
      const token = await user.getIdToken();
      const response = await fetch(
        `/api/driver/fee-settlement-status?session_id=${encodeURIComponent(sessionId)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      const data = await response.json();
      if (response.ok && data.settled === true) {
        setSettledAmount(Number(data.settledAmount || 0));
        setPendingBalance(0);
        setStatus("settled");
        toast.success("Platform fees balance successfully settled!");
        return "settled";
      }
      if (data.pendingPlatformFees !== undefined && data.pendingPlatformFees !== null) {
        setPendingBalance(Number(data.pendingPlatformFees));
      }
      setStatus("pending");
      return "pending";
    } catch (err) {
      console.error("Error verifying fee settlement status:", err);
      setStatus("pending");
      return "pending";
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const pollStatus = async () => {
      const outcome = await fetchSettlementStatus();
      if (cancelled || outcome !== "pending" || attempts >= 5) {
        return;
      }
      attempts += 1;
      timer = setTimeout(pollStatus, 1500);
    };

    pollStatus();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user, fetchSettlementStatus]);

  const displayAmount =
    status === "settled"
      ? Number(settledAmount ?? 0)
      : Number(pendingBalance ?? profile?.pendingPlatformFees ?? 0);

  return (
    <div className="min-h-screen bg-[#0D0D0F] text-white flex flex-col justify-center items-center px-4 py-12 relative overflow-hidden">
      {/* Background Ambience decoration */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-emerald-500/5 blur-3xl pointer-events-none"></div>

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md bg-[#1A1A1E] border border-white/20 rounded-2xl p-6 relative z-10 flex flex-col items-center shadow-2xl"
      >
        <div
          className={`w-16 h-16 rounded-full flex items-center justify-center mb-6 border ${
            status === "settled"
              ? "bg-emerald-500/10 border-emerald-500/20 text-[#00D26A]"
              : "bg-amber-500/10 border-amber-500/20 text-amber-400"
          }`}
        >
          {status === "settled" ? <ShieldCheck className="w-8 h-8" /> : <Clock className="w-8 h-8" />}
        </div>

        <h1 className="text-xl font-black text-white text-center uppercase tracking-wider mb-2">
          {status === "settled"
            ? "Settlement Complete"
            : status === "missing_session"
              ? "Verification Required"
              : "Confirming Settlement"}
        </h1>
        <p className="text-xs text-zinc-400 text-center uppercase font-bold tracking-widest mb-6">
          Platform Owed Fees Ledger
        </p>

        {/* Compact square with rounded edges & thin white border for dark bg */}
        <div className="w-full bg-[#151518] rounded-xl border border-white/10 p-5 space-y-4 mb-6">
          <div className="flex justify-between items-center pb-3 border-b border-white/5">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
              {status === "settled" ? "Amount Settled" : "Pending Balance"}
            </span>
            <span className={`text-lg font-black ${status === "settled" ? "text-[#00D26A]" : "text-amber-400"}`}>
              £{displayAmount.toFixed(2)}
            </span>
          </div>

          <div className="flex justify-between items-center text-xs">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Payment Method</span>
            <span className="font-bold flex items-center gap-1.5 text-zinc-200">
              <CreditCard className="w-3.5 h-3.5 text-emerald-400" /> Stripe Card Payment
            </span>
          </div>

          <div className="flex justify-between items-center text-xs">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Webhook Status</span>
            {status === "checking" ? (
              <span className="font-bold text-yellow-400 animate-pulse flex items-center gap-1">
                Verifying...
              </span>
            ) : status === "settled" ? (
              <span className="font-bold text-[#00D26A] flex items-center gap-1">
                Settled
              </span>
            ) : status === "missing_session" ? (
              <span className="font-bold text-rose-400 flex items-center gap-1">
                Session Missing
              </span>
            ) : (
              <span className="font-bold text-amber-400 flex items-center gap-1">
                Confirming with Stripe webhook...
              </span>
            )}
          </div>

          <div className="flex justify-between items-center text-xs pt-1">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Checked At</span>
            <span className="font-mono text-[10px] font-bold text-zinc-400">
              {checkedAt}
            </span>
          </div>
        </div>

        <div className="w-full text-center mb-8 px-4">
          <p className="text-[11px] font-medium text-zinc-400 leading-relaxed">
            {status === "settled"
              ? "Your cash job platform commissions have been verified by Stripe and reconciled in the ledger."
              : status === "missing_session"
                ? "No Stripe checkout session reference was provided in this URL. Check your Earnings dashboard to verify your fee balance."
                : "We are waiting for Stripe's signed webhook confirmation. If this takes more than a few seconds, tap Refresh Status below."}
          </p>
        </div>

        <div className="w-full space-y-3">
          {status !== "settled" && status !== "missing_session" && (
            <button
              onClick={() => fetchSettlementStatus()}
              className="w-full h-11 bg-amber-400 text-black rounded-xl font-black text-xs flex items-center justify-center gap-2 uppercase tracking-widest active:scale-[0.98] transition-all border border-amber-300 hover:bg-amber-300"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh Status
            </button>
          )}

          <button
            onClick={() => navigate("/driver-terminal")}
            className="w-full h-12 bg-white text-[#0D0D0F] rounded-xl font-black text-xs flex items-center justify-center gap-2 uppercase tracking-widest active:scale-[0.98] transition-all shadow-xl shadow-white/5 border border-white hover:bg-zinc-200"
          >
            Go To Driver Terminal
            <ArrowRight className="w-4 h-4 text-black" />
          </button>

          <button
            onClick={() => navigate("/billing")}
            className="w-full h-11 bg-transparent hover:bg-white/5 text-zinc-400 hover:text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 uppercase tracking-widest active:scale-[0.98] transition-all border border-white/10"
          >
            Review Earnings & Invoices
          </button>
        </div>
      </motion.div>
    </div>
  );
}

