import React, { useState, useEffect } from "react";
import { Mail, RefreshCw, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../AuthProvider";
import { sendVerificationEmail } from "@/src/firebase";
import { shouldShowEmailVerificationBanner } from "@/src/lib/authHelpers";
import { isAdminAccount } from "@/src/lib/accountRoles";
import { cn } from "@/src/lib/utils";

const RESEND_COOLDOWN_SECONDS = 60;

interface EmailVerificationBannerProps {
  hasTopOffset?: boolean;
}

export const EmailVerificationBanner: React.FC<EmailVerificationBannerProps> = ({
  hasTopOffset = false,
}) => {
  const { user, profile, isAnonymous, emailVerified, refreshEmailVerification } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  useEffect(() => {
    setDismissed(false);
    setCooldownSeconds(0);
  }, [user?.uid]);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  const shouldShow =
    !dismissed &&
    shouldShowEmailVerificationBanner({
      user: user
        ? {
            email: user.email,
            emailVerified,
            isAnonymous: user.isAnonymous,
            providerData: user.providerData,
          }
        : null,
      isAnonymous,
      isAdmin: isAdminAccount(profile),
    });

  if (!shouldShow || !user) return null;

  const handleResend = async () => {
    if (sending || cooldownSeconds > 0) return;
    setSending(true);
    try {
      await sendVerificationEmail(user);
      setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
      toast.success(`Verification email sent to ${user.email}. Please check your inbox and spam folder.`);
    } catch (err: any) {
      const code = err?.code || "";
      if (code === "auth/too-many-requests") {
        setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
        toast.error("Too many emails sent recently. Please wait a minute before requesting another link.");
      } else {
        toast.error("Could not send verification email right now. Please try again shortly.");
      }
    } finally {
      setSending(false);
    }
  };

  const handleCheckVerified = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const verified = await refreshEmailVerification();
      if (verified) {
        toast.success("Your email address is now verified.");
      } else {
        toast.info("Not verified yet. Open the verification link in your inbox, then tap Refresh again.");
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      role="status"
      className={cn(
        "bg-amber-50 border-b border-black px-3 sm:px-4 py-2 text-black text-xs",
        hasTopOffset && "pt-[calc(0.5rem+env(safe-area-inset-top,0px))]"
      )}
    >
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Mail className="w-4 h-4 text-amber-800 shrink-0" />
          <p className="font-medium text-black leading-snug">
            Please verify your email address{" "}
            <strong className="font-bold text-black break-all">{user.email}</strong> to secure your account and receive quote alerts.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleResend}
            disabled={sending || cooldownSeconds > 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black text-white font-bold text-[11px] hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            {sending && <Loader2 className="w-3 h-3 animate-spin" />}
            {cooldownSeconds > 0 ? `Resend in ${cooldownSeconds}s` : "Resend Verification Email"}
          </button>

          <button
            type="button"
            onClick={handleCheckVerified}
            disabled={checking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-black border border-black font-bold text-[11px] hover:bg-slate-100 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={cn("w-3 h-3", checking && "animate-spin")} />
            <span>I&apos;ve Verified</span>
          </button>

          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss email verification reminder"
            className="p-1 rounded-lg text-black hover:bg-amber-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
