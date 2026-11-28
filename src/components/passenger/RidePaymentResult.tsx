import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, XCircle, Loader2, ArrowLeft, ShieldCheck, Receipt } from "lucide-react";
import { useAuth } from "../AuthProvider";

interface RidePaymentResultProps {
  mode: "success" | "failed";
}

interface ReceiptSummary {
  paid: boolean;
  status: string;
  rideId: string;
  baseFareGbp: number;
  tipGbp: number;
  totalFarePaidGbp: number;
  paymentMethod?: string;
}

export default function RidePaymentResult({ mode }: RidePaymentResultProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const rideId = searchParams.get("rideId") || "";
  const sessionId = searchParams.get("session_id") || "";

  const [checking, setChecking] = useState(mode === "success" && Boolean(rideId && sessionId));
  const [receipt, setReceipt] = useState<ReceiptSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "success") return;
    if (!rideId || !sessionId) {
      setChecking(false);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 6;

    const verifyPayment = async () => {
      try {
        const res = await fetch(
          `/api/rides/payment-session-status?rideId=${encodeURIComponent(rideId)}&session_id=${encodeURIComponent(sessionId)}`
        );
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (res.ok && data.success) {
          setReceipt({
            paid: data.paid === true,
            status: String(data.status || "pending"),
            rideId: data.rideId || rideId,
            baseFareGbp: Number(data.baseFareGbp || 0),
            tipGbp: Number(data.tipGbp || 0),
            totalFarePaidGbp: Number(data.totalFarePaidGbp || 0),
            paymentMethod: data.paymentMethod,
          });
          if (data.paid === true) {
            setChecking(false);
            return;
          }
        } else if (!res.ok) {
          setErrorMessage(data?.error || "We could not verify this payment session yet.");
        }
      } catch {
        if (!cancelled) {
          setErrorMessage("Network hiccup while verifying payment. Please check again.");
        }
      }

      attempts += 1;
      if (!cancelled && attempts < maxAttempts) {
        setTimeout(verifyPayment, 2000);
      } else if (!cancelled) {
        setChecking(false);
      }
    };

    verifyPayment();
    return () => {
      cancelled = true;
    };
  }, [mode, rideId, sessionId]);

  const handleReturn = () => {
    if (user) {
      navigate("/book-ride", { replace: true });
    } else {
      navigate("/", { replace: true });
    }
  };

  const isConfirmedPaid = mode === "success" && receipt?.paid === true;

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-black rounded-2xl p-6 shadow-sm space-y-5">
        {mode === "failed" ? (
          <>
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-red-50 border border-black flex items-center justify-center">
                <XCircle className="w-8 h-8 text-red-600" />
              </div>
              <h1 className="text-xl font-black text-black tracking-tight">Payment Not Completed</h1>
              <p className="text-sm text-black font-medium leading-relaxed">
                Your trip checkout was cancelled before payment completed. No charge was taken.
              </p>
            </div>

            <div className="bg-slate-50 border border-black rounded-xl p-3.5 text-xs text-black font-semibold">
              Return to your active ride or re-scan your driver&apos;s QR code to finish paying by card, Apple Pay, Google Pay, or cash.
            </div>

            <button
              type="button"
              onClick={handleReturn}
              className="w-full py-3 px-4 bg-black text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:bg-slate-800 active:scale-[0.99] transition-all"
            >
              <ArrowLeft className="w-4 h-4" />
              {user ? "Return to AnyRoller" : "Done"}
            </button>
          </>
        ) : checking ? (
          <div className="flex flex-col items-center text-center py-6 space-y-3">
            <Loader2 className="w-10 h-10 text-black animate-spin" />
            <h1 className="text-lg font-black text-black">Confirming Your Payment...</h1>
            <p className="text-sm text-black font-medium">
              Verifying your Stripe receipt and updating your driver&apos;s terminal.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-black flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-600" />
              </div>
              <h1 className="text-xl font-black text-black tracking-tight">
                {isConfirmedPaid ? "Trip Payment Confirmed" : "Payment Received"}
              </h1>
              <p className="text-sm text-black font-medium leading-relaxed">
                {isConfirmedPaid
                  ? "Thank you for riding with AnyRoller. Your driver's terminal has been updated automatically."
                  : errorMessage || "Your payment was submitted to Stripe. Your driver's screen will update momentarily."}
              </p>
            </div>

            {receipt && receipt.totalFarePaidGbp > 0 && (
              <div className="bg-slate-50 border border-black rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-black border-b border-black/15 pb-2">
                  <Receipt className="w-4 h-4" />
                  Trip Receipt {rideId ? `#${rideId.slice(0, 8)}` : ""}
                </div>
                <div className="flex justify-between text-sm text-black font-medium">
                  <span>Trip Fare</span>
                  <span className="font-bold">£{receipt.baseFareGbp.toFixed(2)}</span>
                </div>
                {receipt.tipGbp > 0 && (
                  <div className="flex justify-between text-sm text-black font-medium">
                    <span>Driver Tip (100% to driver)</span>
                    <span className="font-bold">£{receipt.tipGbp.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-black text-black border-t border-black/15 pt-2">
                  <span>Total Paid</span>
                  <span>£{receipt.totalFarePaidGbp.toFixed(2)}</span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-center gap-1.5 text-xs font-bold text-black">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              Secured directly via Stripe Connect
            </div>

            {user ? (
              <button
                type="button"
                onClick={handleReturn}
                className="w-full py-3 px-4 bg-black text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:bg-slate-800 active:scale-[0.99] transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                Return to AnyRoller
              </button>
            ) : (
              <p className="text-center text-xs font-semibold text-black">
                You may safely close this browser window.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
