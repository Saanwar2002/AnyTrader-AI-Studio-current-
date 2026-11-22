import React, { useEffect, useState } from "react";
import { Bell, MessageSquare, Check, ExternalLink, Loader2, X, Smartphone, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../AuthProvider";
import {
  enableWebPushNotifications,
  fetchNotificationPreferences,
  getWebPushStatus,
  requestWhatsAppActivationLink,
  updateNotificationPreferences,
  type NotificationPreferencesDTO,
  type WebPushPermissionState,
} from "@/src/lib/pushNotifications";
import { openSafeExternalUrl } from "@/src/lib/safeExternalUrl";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface OfflineAlertsCardProps {
  variant?: "full" | "compact";
  contextLabel?: string;
  className?: string;
}

export const OfflineAlertsCard: React.FC<OfflineAlertsCardProps> = ({
  variant = "full",
  contextLabel,
  className = "",
}) => {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<NotificationPreferencesDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enablingPush, setEnablingPush] = useState(false);
  const [activatingWa, setActivatingWa] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [pushState, setPushState] = useState<WebPushPermissionState>(() => getWebPushStatus());
  const [dismissed, setDismissed] = useState(() => {
    if (variant !== "compact" || typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem("anytrader_offline_alerts_banner_dismissed") === "true";
  });
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [lastActivationCode, setLastActivationCode] = useState<string | null>(null);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalledPwa, setIsInstalledPwa] = useState(() => {
    if (typeof window === "undefined") return false;
    return (
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as any)?.standalone === true
    );
  });

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setIsInstalledPwa(true);
      setDeferredInstallPrompt(null);
      setPushState(getWebPushStatus());
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const data = await fetchNotificationPreferences();
      if (!cancelled) {
        setPrefs(data);
        setPushState(getWebPushStatus());
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  if (!user) return null;

  // Compact contextual prompt automatically hides once user has opted in or dismissed for this session
  if (variant === "compact") {
    if (dismissed || loading) return null;
    if (prefs?.whatsappOptIn && pushState === "granted") return null;
  }

  const handleDismissCompact = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem("anytrader_offline_alerts_banner_dismissed", "true");
    } catch {
      // Ignore storage errors
    }
  };

  const handleInstallPwa = async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === "accepted") {
      setIsInstalledPwa(true);
      setDeferredInstallPrompt(null);
      toast.success("AnyTrader installed to your home screen.");
    }
  };

  const handleEnableBrowserPush = async () => {
    if (!user) return;
    if (pushState === "ios_needs_install") {
      setShowIosGuide(true);
      return;
    }
    setEnablingPush(true);
    try {
      const result = await enableWebPushNotifications(user.uid);
      setPushState(result.status);
      if (result.enabled) {
        toast.success("Free browser push alerts enabled on this device.");
        const updated = await fetchNotificationPreferences();
        if (updated) setPrefs(updated);
      } else if (result.status === "denied") {
        toast.error("Browser notifications are blocked. Allow them in your browser site settings.");
      } else if (result.status === "unconfigured") {
        toast.info("Browser push key is not configured yet in this environment.");
      } else {
        toast.error("Could not enable browser notifications on this device.");
      }
    } finally {
      setEnablingPush(false);
    }
  };

  const handleSaveWhatsAppPreferences = async (nextOptIn: boolean) => {
    setSaving(true);
    try {
      const payload: { whatsappOptIn: boolean; whatsappPhone?: string } = {
        whatsappOptIn: nextOptIn,
      };
      if (phoneInput.trim().length > 0) {
        payload.whatsappPhone = phoneInput.trim();
      }
      const { preferences, error } = await updateNotificationPreferences(payload);
      if (error) {
        toast.error(error);
        return;
      }
      if (preferences) {
        setPrefs(preferences);
        setPhoneInput("");
      }
      toast.success(
        nextOptIn
          ? "WhatsApp offline nudges enabled (max 1 alert per 5 mins)."
          : "WhatsApp offline nudges paused."
      );
    } finally {
      setSaving(false);
    }
  };

  const handleActivateOnWhatsApp = async () => {
    setActivatingWa(true);
    try {
      const { data, error } = await requestWhatsAppActivationLink(contextLabel);
      if (error || !data) {
        toast.error(error || "Unable to generate WhatsApp activation code.");
        return;
      }
      setLastActivationCode(data.activationCode);
      if (data.waMeUrl) {
        openSafeExternalUrl(data.waMeUrl);
        toast.success("Opening WhatsApp — tap Send to activate offline alerts.");
      } else {
        toast.info(
          `Activation code ${data.activationCode} generated. Configure the official WhatsApp business number in server settings to enable 1-tap launch.`
        );
      }
    } finally {
      setActivatingWa(false);
    }
  };

  if (variant === "compact") {
    return (
      <div
        className={`bg-white border border-black rounded-xl p-3.5 text-black space-y-2.5 ${className}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5 min-w-0">
            <h3 className="text-sm font-bold text-black">
              Never miss a quote or reply
            </h3>
            <p className="text-xs text-black/80 leading-relaxed">
              Get free browser alerts or a 1-off WhatsApp nudge if you are offline (max 1 every 5 mins · your number stays private).
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismissCompact}
            aria-label="Dismiss alert prompt"
            className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-lg text-black hover:bg-slate-100 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!prefs?.whatsappOptIn && (
            <button
              type="button"
              onClick={handleActivateOnWhatsApp}
              disabled={activatingWa}
              className="min-h-[44px] px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              {activatingWa ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <MessageSquare className="w-4 h-4" />
              )}
              Activate on WhatsApp
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}

          {pushState !== "granted" && pushState !== "unsupported" && (
            <button
              type="button"
              onClick={handleEnableBrowserPush}
              disabled={enablingPush}
              className="min-h-[44px] px-3.5 py-2 rounded-lg bg-white hover:bg-slate-100 text-black border border-black text-xs font-bold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              {enablingPush ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Bell className="w-4 h-4" />
              )}
              {pushState === "ios_needs_install" ? "Install for iPhone Alerts" : "Enable Free Push"}
            </button>
          )}
        </div>

        {lastActivationCode && !prefs?.businessWhatsAppConfigured && (
          <p className="text-xs text-black/80">
            Activation code: <span className="font-mono font-bold">{lastActivationCode}</span> (expires in 15 mins)
          </p>
        )}

        {showIosGuide && (
          <div className="p-3 rounded-lg bg-slate-50 border border-black text-xs text-black space-y-1">
            <p className="font-bold">Enable lock-screen alerts on iPhone / iPad</p>
            <p>1. Tap the <strong>Share</strong> icon in Safari.</p>
            <p>2. Tap <strong>Add to Home Screen</strong>, then open AnyTrader from your home screen.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <section
      id="offline-alerts-settings"
      className={`bg-white border border-black rounded-xl p-5 text-black space-y-5 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/15 pb-3.5">
        <div className="space-y-1">
          <h2 className="text-base font-extrabold text-black">
            Offline Alerts & Messaging Channels
          </h2>
          <p className="text-xs text-black/80 leading-relaxed">
            In-app chat and browser push run first for free. WhatsApp triggers only if you miss a message for 45 seconds (max 1 alert per 5 mins).
          </p>
        </div>
        {!isInstalledPwa && deferredInstallPrompt && (
          <button
            type="button"
            onClick={handleInstallPwa}
            className="min-h-[44px] px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Smartphone className="w-4 h-4" />
            Install App
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-black py-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading notification preferences...
        </div>
      ) : (
        <div className="space-y-5">
          {/* Tier 2: Free Browser / PWA Push */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-black/10">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-black shrink-0" />
                <span className="text-sm font-bold text-black">Free Browser & PWA Push</span>
              </div>
              <div className="text-xs text-black/75 flex flex-wrap items-center gap-1.5">
                <span>
                  Status:{" "}
                  <strong className="text-black">
                    {pushState === "granted"
                      ? "Active"
                      : pushState === "denied"
                        ? "Blocked in browser"
                        : pushState === "ios_needs_install"
                          ? "Install to Home Screen required"
                          : pushState === "unconfigured"
                            ? "Pending VAPID setup"
                            : pushState === "unsupported"
                              ? "Not supported in this browser"
                              : "Not enabled"}
                  </strong>
                </span>
                {prefs && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      {prefs.activePushDevicesCount} active device{prefs.activePushDevicesCount === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </div>
            </div>

            {pushState !== "granted" && pushState !== "unsupported" && (
              <button
                type="button"
                onClick={handleEnableBrowserPush}
                disabled={enablingPush}
                className="min-h-[44px] px-4 py-2 rounded-lg bg-black hover:bg-slate-800 text-white text-xs font-bold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                {enablingPush ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Bell className="w-4 h-4" />
                )}
                {pushState === "ios_needs_install" ? "How to Enable on iOS" : "Enable Browser Alerts"}
              </button>
            )}

            {pushState === "granted" && (
              <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                <Check className="w-4 h-4" />
                Connected
              </div>
            )}
          </div>

          {showIosGuide && (
            <div className="p-3.5 rounded-xl bg-slate-50 border border-black text-xs text-black space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold">Install AnyTrader on iPhone / iPad</span>
                <button
                  type="button"
                  onClick={() => setShowIosGuide(false)}
                  className="text-xs font-bold underline"
                >
                  Close
                </button>
              </div>
              <p>1. Tap the <strong>Share</strong> icon in Safari.</p>
              <p>2. Select <strong>Add to Home Screen</strong>, then launch AnyTrader from the new icon to turn on push alerts.</p>
            </div>
          )}

          {/* Tier 4: Direct Meta WhatsApp Offline Fallback */}
          <div className="space-y-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span className="text-sm font-bold text-black">WhatsApp Offline Wake-Up Alerts</span>
                </div>
                <div className="text-xs text-black/75 flex flex-wrap items-center gap-1.5">
                  <span>
                    {prefs?.whatsappOptIn ? "Enabled" : "Paused"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {prefs?.whatsappVerified ? "Verified via WhatsApp" : "Not verified yet"}
                  </span>
                  {prefs?.whatsappPhoneMasked && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{prefs.whatsappPhoneMasked}</span>
                    </>
                  )}
                  {prefs?.whatsappWindowActive && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>24h window open</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="flex-1">
                <label htmlFor="wa-phone-input" className="sr-only">
                  UK Mobile Number for WhatsApp Alerts
                </label>
                <input
                  id="wa-phone-input"
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder={
                    prefs?.whatsappPhoneMasked
                      ? `Update mobile (${prefs.whatsappPhoneMasked})`
                      : "UK mobile e.g. 07700 900123"
                  }
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-black bg-white text-sm text-black placeholder:text-black/45 focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <button
                type="button"
                disabled={saving}
                onClick={() => handleSaveWhatsAppPreferences(!prefs?.whatsappOptIn)}
                className={`min-h-[44px] px-4 py-2 rounded-lg text-xs font-bold border border-black transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center gap-2 disabled:opacity-60 ${
                  prefs?.whatsappOptIn
                    ? "bg-white hover:bg-slate-100 text-black"
                    : "bg-black hover:bg-slate-800 text-white"
                }`}
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {prefs?.whatsappOptIn ? "Pause WhatsApp" : "Save & Enable"}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <button
                type="button"
                onClick={handleActivateOnWhatsApp}
                disabled={activatingWa}
                className="min-h-[44px] px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                {activatingWa ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <MessageSquare className="w-4 h-4" />
                )}
                1-Tap Activate on WhatsApp
                <ExternalLink className="w-3.5 h-3.5" />
              </button>

              <div className="flex items-center gap-1.5 text-xs text-black/75">
                <ShieldCheck className="w-4 h-4 text-black shrink-0" />
                <span>Your phone number is never shared with trades or drivers. Reply STOP anytime.</span>
              </div>
            </div>

            {lastActivationCode && (
              <p className="text-xs text-black bg-slate-50 border border-black rounded-lg px-3 py-2">
                Single-use activation code: <strong className="font-mono">{lastActivationCode}</strong> (valid for 15 minutes).
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
