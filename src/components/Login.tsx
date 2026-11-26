import React, { useState, useEffect, useRef } from "react";
import {
  signInWithGoogle,
  signUpWithEmail,
  signInWithEmail,
  sendVerificationEmail,
  resetPassword,
  handleRedirectResult,
} from "@/src/firebase";
import { motion } from "motion/react";
import {
  Loader2,
  Mail,
  Lock,
  Eye,
  EyeOff,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  KeyRound,
  X,
} from "lucide-react";
import { BiometricService } from "@/src/services/biometricService";
import { isTemporaryEmail } from "@/src/lib/utils";
import {
  evaluatePasswordRequirements,
  formatAuthErrorMessage,
  isRunningInEmbeddedIframe,
  validateEmailPasswordInput,
} from "@/src/lib/authHelpers";
import { Logo } from "./Logo";
import { TermsModal } from "./TermsModal";
import { extractRedirectFromSearch, savePendingLoginRedirect } from "@/src/lib/authRedirect";

function GoogleMark({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.08 3.56-5.15 3.56-8.65z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3c-1.07.72-2.45 1.14-4.06 1.14-3.12 0-5.77-2.11-6.72-4.96H1.28v3.1A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.27A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.38-2.27v-3.1H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.37l4-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.63l4 3.1C6.23 6.88 8.88 4.77 12 4.77z"
      />
    </svg>
  );
}

export default function Login() {
  const [emailLoading, setEmailLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<
    "standard" | "iframe_blocked" | "third_party_cookies" | "account_exists_different_provider" | "cancelled" | null
  >(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignup, setIsSignup] = useState(false);
  const [isResetPassword, setIsResetPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Honest saved-email convenience (never simulates biometric auth bypass)
  const [savedEmail, setSavedEmail] = useState<string | null>(null);
  const [rememberEmail, setRememberEmail] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  // Terms & Privacy Modal state
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const [termsModalTab, setTermsModalTab] = useState<"general" | "privacy">("general");

  const isEmbeddedIframe = isRunningInEmbeddedIframe();
  const isBusy = emailLoading || googleLoading;
  const passwordChecks = evaluatePasswordRequirements(password);

  useEffect(() => {
    const stored = BiometricService.getCredentials();
    if (stored?.email) {
      setSavedEmail(stored.email);
      setRememberEmail(true);
    }
    if (typeof window !== "undefined") {
      const safeRedirect = extractRedirectFromSearch(window.location.search);
      if (safeRedirect) {
        savePendingLoginRedirect(safeRedirect);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || isEmbeddedIframe) return;
    let mounted = true;
    handleRedirectResult()
      .then((result) => {
        if (mounted && result?.user) {
          setInfoMessage(`Signed in as ${result.user.email || "your Google account"}. Loading workspace...`);
        }
      })
      .catch((err: any) => {
        if (!mounted) return;
        const formatted = formatAuthErrorMessage(err, {
          provider: "google",
          isEmbeddedIframe: false,
        });
        setError(formatted.message);
        setErrorKind(formatted.kind);
      });
    return () => {
      mounted = false;
    };
  }, [isEmbeddedIframe]);

  const clearFeedback = () => {
    setError(null);
    setErrorKind(null);
    setInfoMessage(null);
  };

  const handleUseSavedEmail = () => {
    if (!savedEmail) return;
    clearFeedback();
    setEmail(savedEmail);
    setInfoMessage(`Filled ${savedEmail}. Enter your password below to sign in.`);
    window.setTimeout(() => {
      passwordInputRef.current?.focus();
    }, 50);
  };

  const handleForgetSavedEmail = () => {
    BiometricService.disable();
    setSavedEmail(null);
    setRememberEmail(false);
    clearFeedback();
  };

  const handleEmailAuth = async () => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();

    clearFeedback();

    const mode = isResetPassword ? "reset" : isSignup ? "signup" : "signin";
    const validationError = validateEmailPasswordInput({
      email: trimmedEmail,
      password: trimmedPassword,
      mode,
    });
    if (validationError) {
      setError(validationError);
      setErrorKind("standard");
      return;
    }

    setEmailLoading(true);
    try {
      if (isResetPassword) {
        await resetPassword(trimmedEmail);
        setInfoMessage("Password reset link sent. Please check your inbox and spam folder.");
        setIsResetPassword(false);
      } else if (isSignup) {
        if (isTemporaryEmail(trimmedEmail)) {
          throw new Error("Temporary or disposable email addresses are not allowed. Please use a permanent email.");
        }
        const { user } = await signUpWithEmail(trimmedEmail, trimmedPassword);
        try {
          await sendVerificationEmail(user);
          setInfoMessage(`Account created. We sent a verification link to ${trimmedEmail}.`);
        } catch (emailErr) {
          console.warn("Failed to send initial verification email:", emailErr);
          setInfoMessage("Account created. You can request a verification link from the top banner once inside.");
        }
        if (rememberEmail) {
          await BiometricService.enroll(trimmedEmail);
          setSavedEmail(trimmedEmail.toLowerCase());
        }
        setIsSignup(false);
      } else {
        await signInWithEmail(trimmedEmail, trimmedPassword);
        if (rememberEmail) {
          await BiometricService.enroll(trimmedEmail);
          setSavedEmail(trimmedEmail.toLowerCase());
        } else {
          BiometricService.disable();
          setSavedEmail(null);
        }
      }
    } catch (err: any) {
      console.error("Email auth error:", err);
      const formatted = formatAuthErrorMessage(err, {
        provider: "email",
        isEmbeddedIframe,
      });
      setError(formatted.message);
      setErrorKind(formatted.kind);
    } finally {
      setEmailLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    if (isBusy) return;
    clearFeedback();
    setGoogleLoading(true);
    try {
      const result = await signInWithGoogle();
      if (result?.user) {
        setInfoMessage(`Signed in with Google as ${result.user.email || "your account"}. Opening workspace...`);
      }
    } catch (err: any) {
      console.warn("Google Auth handled error:", err);
      const formatted = formatAuthErrorMessage(err, {
        provider: "google",
        isEmbeddedIframe,
      });
      if (formatted.kind === "cancelled") {
        setInfoMessage(formatted.message);
      } else {
        setError(formatted.message);
        setErrorKind(formatted.kind);
      }
    } finally {
      setGoogleLoading(false);
    }
  };

  const openLegalModal = (tab: "general" | "privacy") => {
    setTermsModalTab(tab);
    setTermsModalOpen(true);
  };

  return (
    <div className="min-h-[100dvh] flex flex-col bg-slate-100 text-black selection:bg-primary selection:text-white">
      <div className="flex-1 flex items-center justify-center px-4 py-6 sm:px-6 sm:py-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch"
        >
          {/* Left Brand & Value Panel (Desktop) */}
          <aside className="hidden lg:flex lg:col-span-5 flex-col justify-between bg-slate-950 text-white border border-white/20 rounded-2xl p-8">
            <div className="space-y-8">
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center shrink-0">
                  <Logo size={28} className="text-white" />
                </div>
                <div>
                  <span className="font-display font-bold text-xl tracking-tight text-white block leading-none">
                    AnyTrader
                  </span>
                  <span className="text-xs text-slate-300 mt-1 block">
                    Verified UK Marketplace · TradeOS
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                <h1 className="font-display font-bold text-3xl leading-tight tracking-tight text-white [text-wrap:balance]">
                  Hire vetted UK trades or grow your business with zero lead fees.
                </h1>
                <p className="text-sm text-slate-300 leading-relaxed">
                  One account connects homeowners, sole traders, property portfolios, and TradeOS workflow tools.
                </p>
              </div>

              <div className="divide-y divide-white/10 border-t border-white/10 pt-2">
                <div className="py-4 space-y-1">
                  <p className="text-sm font-semibold text-white">Protected Milestone Payments</p>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Escrow-backed stage releases with clear fee transparency before work begins.
                  </p>
                </div>
                <div className="py-4 space-y-1">
                  <p className="text-sm font-semibold text-white">Verified UK Trade Credentials</p>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Gas Safe, NICEIC, and public liability checks enforced for regulated categories.
                  </p>
                </div>
                <div className="py-4 space-y-1">
                  <p className="text-sm font-semibold text-white">Built for Dual-Role Flexibility</p>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Post home jobs, quote local work, manage property compliance, and switch portals seamlessly.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-6 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
              <span>UK Marketplace · GDPR Ready</span>
              <span>PCI-DSS Stripe Payments</span>
            </div>
          </aside>

          {/* Right Authentication Card */}
          <main className="lg:col-span-7 bg-white border border-black rounded-2xl p-6 sm:p-8 flex flex-col justify-between space-y-6">
            <div className="space-y-5">
              {/* Mobile Brand Header */}
              <div className="flex items-center justify-between lg:hidden pb-4 border-b border-black/10">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-primary flex items-center justify-center shrink-0">
                    <Logo size={26} className="text-white" />
                  </div>
                  <div>
                    <h1 className="font-display font-bold text-xl text-black leading-none tracking-tight">
                      AnyTrader
                    </h1>
                    <p className="text-xs text-slate-600 mt-1">
                      Verified UK Marketplace · TradeOS
                    </p>
                  </div>
                </div>
              </div>

              {/* Heading + Segmented Mode Switch */}
              {!isResetPassword ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="font-display font-bold text-2xl sm:text-[26px] text-black tracking-tight [text-wrap:balance]">
                      {isSignup ? "Create your AnyTrader account" : "Sign in to AnyTrader"}
                    </h2>
                    <p className="text-sm text-slate-600">
                      {isSignup
                        ? "Start as a homeowner, tradesperson, driver, or business in under two minutes."
                        : "Access your dashboard, active quotes, messages, and bookings."}
                    </p>
                  </div>

                  <div
                    role="tablist"
                    aria-label="Authentication mode"
                    className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl border border-black"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!isSignup}
                      onClick={() => {
                        setIsSignup(false);
                        clearFeedback();
                      }}
                      className={`py-2.5 px-3 rounded-lg text-sm font-bold transition-colors cursor-pointer whitespace-nowrap ${
                        !isSignup
                          ? "bg-white text-black border border-black"
                          : "text-slate-600 hover:text-black border border-transparent"
                      }`}
                    >
                      Sign In
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isSignup}
                      onClick={() => {
                        setIsSignup(true);
                        clearFeedback();
                      }}
                      className={`py-2.5 px-3 rounded-lg text-sm font-bold transition-colors cursor-pointer whitespace-nowrap ${
                        isSignup
                          ? "bg-white text-black border border-black"
                          : "text-slate-600 hover:text-black border border-transparent"
                      }`}
                    >
                      Create Account
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 pb-3 border-b border-black/10">
                  <button
                    type="button"
                    onClick={() => {
                      setIsResetPassword(false);
                      clearFeedback();
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-black hover:text-primary transition-colors cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>Back to Sign In</span>
                  </button>
                  <h2 className="font-display font-bold text-2xl text-black tracking-tight">
                    Reset your password
                  </h2>
                  <p className="text-sm text-slate-600">
                    Enter your account email and we will send you a secure reset link.
                  </p>
                </div>
              )}

              {/* Feedback Banners */}
              {infoMessage && (
                <div
                  role="status"
                  className="p-3.5 bg-emerald-50 border border-black rounded-xl text-black text-xs font-semibold flex items-start gap-2.5"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{infoMessage}</span>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="p-3.5 bg-red-50 border border-black rounded-xl text-black text-xs font-semibold space-y-2.5"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                    <span className="leading-relaxed">{error}</span>
                  </div>
                  {(errorKind === "iframe_blocked" || errorKind === "third_party_cookies") &&
                    typeof window !== "undefined" && (
                      <div className="pl-6">
                        <a
                          href={window.location.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black text-white text-xs font-bold hover:bg-slate-800 transition-colors"
                        >
                          <span>Open in Full Browser Tab</span>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    )}
                </div>
              )}

              {/* Google Sign-In Section (hidden during password reset) */}
              {!isResetPassword && (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={handleGoogleAuth}
                    disabled={isBusy}
                    className="w-full min-h-[46px] flex items-center justify-center gap-2.5 bg-white border border-black py-3 px-4 rounded-xl font-bold text-black hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors disabled:opacity-50 cursor-pointer text-sm whitespace-nowrap"
                  >
                    {googleLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-black" />
                        <span>Connecting to Google...</span>
                      </>
                    ) : (
                      <>
                        <GoogleMark className="w-4 h-4 shrink-0" />
                        <span>Continue with Google</span>
                      </>
                    )}
                  </button>

                  {isEmbeddedIframe && typeof window !== "undefined" && (
                    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-slate-50 border border-black/20 text-xs text-black">
                      <span className="leading-snug">
                        Embedded preview detected. If Google blocks pop-ups, open in a full tab.
                      </span>
                      <a
                        href={window.location.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-bold text-primary hover:underline shrink-0 whitespace-nowrap"
                      >
                        <span>Open Tab</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  )}

                  {/* Divider */}
                  <div className="relative py-1">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-black/15" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-white px-3 text-xs font-medium text-slate-600">
                        or continue with email
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Saved Device Email Convenience Strip (Sign In only — honest email pre-fill, never fake biometric auth) */}
              {!isSignup && !isResetPassword && savedEmail && email.trim().toLowerCase() !== savedEmail && (
                <div className="p-3 bg-slate-50 border border-black rounded-xl flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <KeyRound className="w-4 h-4 text-black shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-black truncate">{savedEmail}</p>
                      <p className="text-[11px] text-slate-600">Saved on this device · pre-fills your email</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleUseSavedEmail}
                      disabled={isBusy}
                      className="px-3 py-1.5 rounded-lg bg-black text-white text-xs font-bold hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      Use Email
                    </button>
                    <button
                      type="button"
                      onClick={handleForgetSavedEmail}
                      aria-label="Forget saved email on this device"
                      className="p-1.5 rounded-lg text-slate-600 hover:text-black hover:bg-slate-200 transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Email / Password Form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleEmailAuth();
                }}
                className="space-y-4"
                noValidate
              >
                <div className="space-y-1.5">
                  <label htmlFor="login-email" className="block text-xs font-bold text-black">
                    Email address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                    <input
                      id="login-email"
                      type="email"
                      required
                      autoComplete="email"
                      inputMode="email"
                      placeholder="name@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 rounded-xl border border-black bg-white text-black text-sm font-medium placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary transition-colors"
                    />
                  </div>
                </div>

                {!isResetPassword && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="login-password" className="block text-xs font-bold text-black">
                        Password
                      </label>
                      {!isSignup && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsResetPassword(true);
                            clearFeedback();
                          }}
                          className="text-xs font-bold text-primary hover:underline cursor-pointer"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                      <input
                        ref={passwordInputRef}
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        required
                        autoComplete={isSignup ? "new-password" : "current-password"}
                        placeholder={isSignup ? "At least 8 characters with letters & numbers" : "Enter your password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full pl-10 pr-11 py-3 rounded-xl border border-black bg-white text-black text-sm font-medium placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 text-slate-600 hover:text-black transition-colors cursor-pointer"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>

                    {isSignup && (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs">
                        <span className={passwordChecks.hasMinLength ? "text-emerald-700 font-semibold" : "text-slate-600"}>
                          {passwordChecks.hasMinLength ? "✓" : "•"} 8+ characters
                        </span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className={passwordChecks.hasLetter ? "text-emerald-700 font-semibold" : "text-slate-600"}>
                          {passwordChecks.hasLetter ? "✓" : "•"} Letters
                        </span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className={passwordChecks.hasNumber ? "text-emerald-700 font-semibold" : "text-slate-600"}>
                          {passwordChecks.hasNumber ? "✓" : "•"} Numbers
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {!isResetPassword && (
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={rememberEmail}
                      onChange={(e) => setRememberEmail(e.target.checked)}
                      className="w-4 h-4 rounded border border-black accent-primary cursor-pointer shrink-0"
                    />
                    <span className="text-xs font-medium text-black">
                      Remember my email on this device
                    </span>
                  </label>
                )}

                <button
                  type="submit"
                  disabled={isBusy}
                  className="w-full min-h-[46px] bg-primary text-white py-3 px-5 rounded-xl font-bold text-sm hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2 whitespace-nowrap"
                >
                  {emailLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Please wait...</span>
                    </>
                  ) : isResetPassword ? (
                    "Send Password Reset Link"
                  ) : isSignup ? (
                    "Create Account"
                  ) : (
                    "Sign In"
                  )}
                </button>
              </form>
            </div>

            {/* Footer with Clickable Terms & Privacy Modals */}
            <footer className="pt-4 border-t border-black/10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-600">
              <p className="leading-snug">
                By continuing, you agree to our{" "}
                <button
                  type="button"
                  onClick={() => openLegalModal("general")}
                  className="font-bold text-black underline hover:text-primary transition-colors cursor-pointer"
                >
                  Terms of Service
                </button>{" "}
                and{" "}
                <button
                  type="button"
                  onClick={() => openLegalModal("privacy")}
                  className="font-bold text-black underline hover:text-primary transition-colors cursor-pointer"
                >
                  Privacy Policy
                </button>
                .
              </p>
              <span className="inline-flex items-center gap-1 text-black font-semibold shrink-0">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" />
                <span>Encrypted Auth</span>
              </span>
            </footer>
          </main>
        </motion.div>
      </div>

      <TermsModal
        isOpen={termsModalOpen}
        onClose={() => setTermsModalOpen(false)}
        initialTab={termsModalTab}
      />
    </div>
  );
}
