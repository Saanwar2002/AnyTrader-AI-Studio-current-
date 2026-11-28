import React, { useState, useEffect } from "react";
import { useAuth } from "../AuthProvider";
import { usePortal } from "@/src/lib/PortalContext";
import { useNavigate } from "react-router-dom";
import { logout, db, doc, updateDoc } from "@/src/firebase";
import { deleteField } from "firebase/firestore";
import {
  ChevronRight,
  User,
  Car,
  BarChart3,
  Clock,
  CreditCard,
  Zap,
  Share2,
  Settings,
  HelpCircle,
  ShieldCheck,
  MapPin,
  X,
  Repeat,
  Power,
  Search,
  Loader2,
  Edit2,
  Trash2,
  VolumeX,
  Navigation,
  ToggleRight,
  Coffee,
  Sun,
  Moon,
  Gauge,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/src/lib/utils";
import { toast } from "sonner";
import {
  DEFAULT_DRIVER_COCKPIT_PREFS,
  DriverCockpitPrefs,
  DriverMapTheme,
} from "@/src/lib/driverCockpitPrefs";

export interface DriverShiftSummary {
  durationText: string;
  trips: number;
  earnings: number;
  gbpPerHour: number;
  paidMiles: number;
  deadheadMiles: number;
}

export default function DriverMenu({
  onNavigate,
  commissionRate = 0.12,
  isOnline = false,
  isIdle = true,
  isOnBreak = false,
  breakRemainingSeconds = null,
  onStartBreak,
  onResumeFromBreak,
  cockpitPrefs = DEFAULT_DRIVER_COCKPIT_PREFS,
  onUpdateCockpitPrefs,
  shiftSummary,
  onToggleOnline,
  onClose,
}: {
  onNavigate: (tab: string) => void;
  commissionRate?: number;
  isOnline?: boolean;
  isIdle?: boolean;
  isOnBreak?: boolean;
  breakRemainingSeconds?: number | null;
  onStartBreak?: (minutes: number | null) => void;
  onResumeFromBreak?: () => void;
  cockpitPrefs?: DriverCockpitPrefs;
  onUpdateCockpitPrefs?: (patch: Partial<DriverCockpitPrefs>) => void;
  shiftSummary?: DriverShiftSummary;
  onToggleOnline?: () => void;
  onClose?: () => void;
}) {
  const { profile, user } = useAuth();
  const { switchPortal } = usePortal();
  const navigate = useNavigate();
  const [showHomeModal, setShowHomeModal] = useState(false);
  const [confirmToggle, setConfirmToggle] = useState<{
    id: string;
    newState: boolean;
    label: string;
  } | null>(null);
  const [showNavAppModal, setShowNavAppModal] = useState(false);
  const [showAutoAcceptModal, setShowAutoAcceptModal] = useState(false);
  const [showSpeedAlertModal, setShowSpeedAlertModal] = useState(false);
  const [showFatigueModal, setShowFatigueModal] = useState(false);
  const [showMapThemeModal, setShowMapThemeModal] = useState(false);
  const [homeInput, setHomeInput] = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [isGeocoding, setIsGeocoding] = useState(false);

  useEffect(() => {
    if (!homeInput || homeInput.length < 3) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        if (!window.google) return;
        let predictions: any[] = [];
        try {
          const { AutocompleteSuggestion } = (await window.google.maps.importLibrary(
            "places"
          )) as any;
          const request = {
            input: homeInput,
            includedRegionCodes: ["gb"],
          };
          const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
          predictions = res.suggestions || [];
        } catch (newApiError: any) {
          console.warn(
            "New Places API fetch failed in DriverMenu, trying classic AutocompleteService:",
            newApiError
          );
          const classicService = new google.maps.places.AutocompleteService();
          const request = {
            input: homeInput,
            componentRestrictions: { country: "gb" },
          };
          predictions = await new Promise<any[]>((resolve) => {
            classicService.getPlacePredictions(request, (classicPredictions, status) => {
              if (
                status === google.maps.places.PlacesServiceStatus.OK &&
                classicPredictions
              ) {
                resolve(
                  classicPredictions.map((cp: any) => ({
                    placePrediction: {
                      text: { text: cp.description },
                      placeId: cp.place_id,
                    },
                  }))
                );
              } else {
                resolve([]);
              }
            });
          });
        }

        if (predictions && predictions.length > 0) {
          const cleaned = predictions.map((p: any) => ({
            description: p.placePrediction.text.text,
            place_id: p.placePrediction.placeId,
          }));
          setSuggestions(cleaned);
        } else {
          setSuggestions([]);
        }
      } catch (err) {
        console.error(err);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [homeInput]);

  const handleSelectHome = async (placeId: string, description: string) => {
    if (!user || !window.google) return;
    setIsGeocoding(true);
    try {
      const geocoder = new window.google.maps.Geocoder();
      const result = await geocoder.geocode({ placeId });
      if (result.results[0]) {
        const { lat, lng } = result.results[0].geometry.location;
        await updateDoc(doc(db, "users", user.uid), {
          homeAddress: description,
          homeLat: lat(),
          homeLng: lng(),
          destinationModeActive: true,
        });
        toast.success("Home address set & Destination Mode ON");
        setShowHomeModal(false);
      }
    } catch (err) {
      toast.error("Failed to find location");
    } finally {
      setIsGeocoding(false);
    }
  };

  const [confirmLastJob, setConfirmLastJob] = React.useState(false);

  const handleLastJobToggle = () => {
    if (!user?.uid) return;
    if (profile?.isLastJob) {
      updateDoc(doc(db, "users", user.uid), { isLastJob: false });
      setConfirmLastJob(false);
    } else {
      if (confirmLastJob) {
        updateDoc(doc(db, "users", user.uid), { isLastJob: true });
        setConfirmLastJob(false);
      } else {
        setConfirmLastJob(true);
        setTimeout(() => setConfirmLastJob(false), 3000);
      }
    }
  };

  const mapThemeLabel: Record<DriverMapTheme, string> = {
    auto: "Auto-Night (Time Based)",
    dark: "Dark High-Contrast",
    daylight: "Daylight Crisp",
  };

  // 6 logical operational sections mirroring the native Android Driver App
  const sections = [
    {
      title: "1. Shift & Dispatch Controls",
      items: [
        {
          icon: Repeat,
          label: "Ride Stacking",
          desc: "Receive next offer while completing current trip",
          color: "text-[#00D26A]",
          bg: "bg-white/5",
          type: "toggle",
          action: "toggle-stacking",
          active: profile?.isStackingEnabled !== false,
        },
        {
          icon: MapPin,
          label: "Destination Mode",
          desc: profile?.destinationModeActive
            ? `Active: ${profile?.homeAddress || "Toward Home"}`
            : "Off",
          color: "text-[#AF52DE]",
          bg: "bg-white/5",
          type: "toggle",
          action: "toggle-destination-mode",
          active: profile?.destinationModeActive === true,
        },
        {
          icon: Sparkles,
          label: "Auto-Accept Mode",
          desc: cockpitPrefs.autoAcceptEnabled
            ? `ON • Min £${cockpitPrefs.autoAcceptMinFare} • ≤ ${cockpitPrefs.autoAcceptMaxPickupMiles} mi pickup`
            : "Off (Opt-in filter rules)",
          color: "text-[#FF9500]",
          bg: "bg-[#FF9500]/10",
          type: "action",
          action: "configure-auto-accept",
        },
      ],
    },
    {
      title: "2. Navigation & Cockpit Display",
      items: [
        {
          icon: Navigation,
          label: "Navigation App",
          desc: profile?.defaultNavApp || "Google Maps",
          color: "text-[#007AFF]",
          bg: "bg-white/5",
          type: "action",
          action: "choose-nav-app",
        },
        {
          icon: cockpitPrefs.mapTheme === "daylight" ? Sun : Moon,
          label: "Cockpit Map Theme",
          desc: mapThemeLabel[cockpitPrefs.mapTheme],
          color: "text-[#38BDF8]",
          bg: "bg-[#38BDF8]/10",
          type: "action",
          action: "choose-map-theme",
        },
        {
          icon: Sun,
          label: "Keep Screen Awake",
          desc: cockpitPrefs.keepScreenAwake
            ? "Screen stays lit while online"
            : "Standard device sleep",
          color: "text-[#00D26A]",
          bg: "bg-white/5",
          type: "toggle",
          action: "toggle-keep-awake",
          active: cockpitPrefs.keepScreenAwake,
        },
      ],
    },
    {
      title: "3. Safety, Audio & Alerts",
      items: [
        {
          icon: ShieldCheck,
          label: "Passcode Verification",
          desc:
            profile?.requirePasscode === true
              ? "Passenger must provide PIN (Last 4 of phone)"
              : "Off",
          color: "text-[#00D26A]",
          bg: "bg-white/5",
          type: "toggle",
          action: "toggle-passcode",
          active: profile?.requirePasscode === true,
        },
        {
          icon: Gauge,
          label: "Speed Alert Limit",
          desc:
            cockpitPrefs.speedAlertMph > 0
              ? `Alert above ${cockpitPrefs.speedAlertMph} mph`
              : "Off",
          color: "text-[#FF9500]",
          bg: "bg-[#FF9500]/10",
          type: "action",
          action: "choose-speed-alert",
        },
        {
          icon: AlertTriangle,
          label: "Fatigue Break Reminder",
          desc:
            cockpitPrefs.fatigueReminderHours > 0
              ? `Remind after ${cockpitPrefs.fatigueReminderHours}h continuous driving`
              : "Off",
          color: "text-[#FACC15]",
          bg: "bg-[#FACC15]/10",
          type: "action",
          action: "choose-fatigue-reminder",
        },
        {
          icon: VolumeX,
          label: "Mute Offer Alerts",
          desc: "Disable 3-sec sound ping",
          color: "text-[#FF9500]",
          bg: "bg-white/5",
          type: "toggle",
          action: "toggle-mute-alerts",
          active: profile?.muteRideOfferAlerts === true,
        },
        {
          icon: VolumeX,
          label: "Mute Heads-Up Volume",
          desc:
            profile?.muteHeadsUpVolume === true
              ? "Navigation voice disabled"
              : "Navigation voice enabled",
          color: "text-[#FF453A]",
          bg: "bg-white/5",
          type: "toggle",
          action: "toggle-mute-heads-up",
          active: profile?.muteHeadsUpVolume === true,
        },
      ],
    },
    {
      title: "4. Vehicle & Service Tiers",
      items: [
        {
          icon: User,
          label: "Driver Profile",
          desc: `⭐ ${profile?.rating?.toFixed(1) || "4.9"} • Active Driver`,
          color: "text-white",
          bg: "bg-white/10",
          id: "profile",
        },
        {
          icon: Car,
          label: "Vehicle & Documents",
          desc: profile?.documentsComplete ? "All clear" : "1 action required",
          color: profile?.documentsComplete
            ? "text-[#00D26A]"
            : "text-[#FF3B30]",
          bg: profile?.documentsComplete
            ? "bg-[#00D26A]/10"
            : "bg-[#FF3B30]/10",
          alert: !profile?.documentsComplete,
          id: "documents",
        },
      ],
    },
    {
      title: "5. Operations & Business",
      items: [
        {
          id: "analytics",
          icon: BarChart3,
          label: "Analytics",
          desc: "Performance & trends",
          color: "text-[#00D26A]",
          bg: "bg-[#00D26A]/10",
        },
        {
          id: "availability",
          icon: Clock,
          label: "Availability Hours",
          desc: "Set schedule & see demand",
          color: "text-[#007AFF]",
          bg: "bg-[#007AFF]/10",
        },
        {
          id: "zones",
          icon: MapPin,
          label: "My Zones",
          desc: "Preferred driving areas",
          color: "text-[#E4E4E7]",
          bg: "bg-white/5",
        },
        {
          icon: CreditCard,
          label: "Platform Fee",
          desc: `Fixed at ${(commissionRate * 100).toFixed(0)}%`,
          color: "text-[#E4E4E7]",
          bg: "bg-white/5",
          type: "text",
        },
      ],
    },
    {
      title: "6. AnyTrader Ecosystem & Account",
      items: [
        {
          icon: Zap,
          label: "Switch To AnyTrader",
          desc: "View leads & manage quotes",
          color: "text-[#AF52DE]",
          bg: "bg-[#AF52DE]/10",
          type: "button",
          action: "switch-to-anytrader",
        },
        {
          icon: ShieldCheck,
          label: "Mechanic Quotes",
          desc: "Fix your vehicle",
          color: "text-[#FF9500]",
          bg: "bg-[#FF9500]/10",
          type: "button",
        },
        {
          icon: Settings,
          label: "Settings",
          desc: "App & privacy",
          color: "text-[#E4E4E7]",
          bg: "bg-white/5",
          id: "settings",
          type: "button",
        },
        {
          icon: HelpCircle,
          label: "Help Center",
          desc: "Support",
          color: "text-[#E4E4E7]",
          bg: "bg-white/5",
          type: "button",
        },
      ],
    },
  ];

  const handleSelectNavApp = async (app: string) => {
    if (!user?.uid) return;
    try {
      await updateDoc(doc(db, "users", user.uid), { defaultNavApp: app });
      toast.success(`${app} set as default navigation app`);
      setShowNavAppModal(false);
    } catch (err) {
      console.error(err);
      toast.error("Failed to update navigation app");
    }
  };

  const formatBreakTimer = (secs: number | null) => {
    if (secs === null) return "Open Break";
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${mins}:${rem.toString().padStart(2, "0")} left`;
  };

  return (
    <div className="flex-1 bg-[#0D0D0F] text-white overflow-y-auto px-4 py-8 font-sans pb-24 min-h-0">
      {/* Header / Profile Summary */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 bg-[#252529] rounded-full flex items-center justify-center font-black text-2xl text-white border border-white/20">
            {profile?.firstName?.[0] || "D"}
          </div>
          <div>
            <h1 className="text-xl font-black text-white">
              {profile?.firstName} {profile?.lastName}
            </h1>
            <p className="text-[10px] text-[#00D26A] font-black uppercase tracking-widest mt-1 flex items-center gap-2">
              <ShieldCheck className="w-3 h-3" /> Fully Verified
            </p>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <button
              onClick={onToggleOnline}
              className={cn(
                "px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-lg active:scale-95",
                isOnline
                  ? "bg-[#FF3B30] text-white shadow-red-500/20"
                  : "bg-[#00D26A] text-[#0D0D0F] shadow-emerald-500/20"
              )}
            >
              {isOnline ? "Go Offline" : "Go Online"}
            </button>

            {onClose && (
              <button
                onClick={onClose}
                className="w-10 h-10 flex shrink-0 items-center justify-center bg-[#1A1A1E] rounded-full border border-white/20 text-[#A1A1AA] hover:text-white transition-colors cursor-pointer active:scale-95"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Last Job Toggle */}
          {isOnline && (
            <button
              onClick={handleLastJobToggle}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors border",
                profile?.isLastJob
                  ? "bg-[#FF3B30]/10 border-white/20 text-[#FF3B30]"
                  : confirmLastJob
                    ? "bg-[#FF9500]/10 border-white/20 text-[#FF9500]"
                    : "bg-white/5 border-white/20 text-white/70 hover:text-white"
              )}
            >
              <Power className="w-3.5 h-3.5" />
              {profile?.isLastJob
                ? "Last Job Active"
                : confirmLastJob
                  ? "Tap to Confirm"
                  : "My Last Job"}
            </button>
          )}
        </div>
      </div>

      {/* Live "This Shift" Summary Card (Android Cockpit Parity) */}
      {isOnline && shiftSummary && (
        <div className="bg-[#1A1A1E] border border-white/20 rounded-2xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-black uppercase tracking-widest text-[#00D26A]">
              This Shift • Live
            </span>
            <span className="text-xs font-bold text-[#A1A1AA]">
              {shiftSummary.durationText}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="bg-[#0D0D0F] border border-white/10 rounded-xl p-2">
              <p className="text-[9px] font-bold uppercase text-[#A1A1AA]">Trips</p>
              <p className="text-sm font-black text-white mt-0.5">{shiftSummary.trips}</p>
            </div>
            <div className="bg-[#0D0D0F] border border-white/10 rounded-xl p-2">
              <p className="text-[9px] font-bold uppercase text-[#A1A1AA]">Earned</p>
              <p className="text-sm font-black text-[#00D26A] mt-0.5">
                £{shiftSummary.earnings.toFixed(0)}
              </p>
            </div>
            <div className="bg-[#0D0D0F] border border-white/10 rounded-xl p-2">
              <p className="text-[9px] font-bold uppercase text-[#A1A1AA]">Rate</p>
              <p className="text-sm font-black text-white mt-0.5">
                £{shiftSummary.gbpPerHour.toFixed(0)}/h
              </p>
            </div>
            <div className="bg-[#0D0D0F] border border-white/10 rounded-xl p-2">
              <p className="text-[9px] font-bold uppercase text-[#A1A1AA]">Paid/Dead</p>
              <p className="text-[11px] font-black text-white mt-1">
                {shiftSummary.paidMiles.toFixed(1)}/{shiftSummary.deadheadMiles.toFixed(1)}m
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Coffee Cup Break Mode Card (IDLE-Only when online — Android Parity) */}
      {isOnline && isIdle && onStartBreak && onResumeFromBreak && (
        <div className="bg-[#1A1A1E] border border-white/20 rounded-2xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-[#FF9500]/15 border border-white/20 flex items-center justify-center">
                <Coffee className="w-4 h-4 text-[#FF9500]" />
              </div>
              <div>
                <h3 className="text-xs font-black uppercase tracking-wider text-white">
                  Coffee Cup Break
                </h3>
                <p className="text-[11px] text-[#A1A1AA] font-medium">
                  {isOnBreak
                    ? `Offers paused • ${formatBreakTimer(breakRemainingSeconds)}`
                    : "Pause new offers without losing shift streak"}
                </p>
              </div>
            </div>
          </div>
          {isOnBreak ? (
            <button
              onClick={onResumeFromBreak}
              className="w-full py-2.5 rounded-xl bg-[#00D26A] text-[#0D0D0F] text-xs font-black uppercase tracking-wider active:scale-95 transition-transform"
            >
              Resume Taking Rides
            </button>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "15 min", mins: 15 },
                { label: "30 min", mins: 30 },
                { label: "Open Break", mins: null },
              ].map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => onStartBreak(opt.mins)}
                  className="py-2 rounded-xl bg-[#252529] border border-white/20 text-[11px] font-black text-white hover:bg-[#2C2C30] active:scale-95 transition-all"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Stripe Connect Onboarding Wizard */}
      {!profile?.stripeAccountId || profile?.chargesEnabled === false || profile?.payoutsEnabled === false ? (
        <div className="bg-[#1A1A1E] border border-white/20 rounded-3xl p-6 mb-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-[#AF52DE]/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none"></div>
          <div className="flex items-center gap-4 mb-4">
            <div className="w-12 h-12 rounded-2xl bg-[#AF52DE]/20 flex items-center justify-center border border-white/20">
              <CreditCard className="w-6 h-6 text-[#AF52DE]" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white uppercase tracking-tight">
                {profile?.stripeAccountId ? "Stripe Verification Incomplete" : "Payments Setup Required"}
              </h3>
              <p className="text-[11px] text-[#E4E4E7] font-bold">
                {profile?.stripeAccountId
                  ? "Finish Stripe ID & bank checks to accept card & QR rides"
                  : "Connect Stripe to receive instant payouts"}
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate("/billing")}
            className="w-full py-3.5 bg-[#AF52DE] text-white rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] shadow-[0_4px_15px_rgba(175,82,222,0.3)] active:scale-95 transition-transform border border-white/20"
          >
            {profile?.stripeAccountId ? "Finish Stripe Setup" : "Start Setup Wizard"}
          </button>
        </div>
      ) : (
        <div className="bg-[#1A1A1E] border border-white/20 rounded-3xl p-5 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-[#007AFF]/10 flex items-center justify-center border border-white/20">
              <ShieldCheck className="w-5 h-5 text-[#007AFF]" />
            </div>
            <div>
              <p className="text-[10px] font-black text-[#A1A1AA] uppercase tracking-widest leading-none mb-1">
                Stripe Connected
              </p>
              <p className="text-sm font-black text-white tracking-tight">
                Payouts Ready
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate("/billing")}
            className="text-[10px] font-black text-[#E4E4E7] uppercase tracking-widest border border-white/20 px-3 py-1.5 rounded-lg active:bg-[#252529]"
          >
            Manage
          </button>
        </div>
      )}

      {/* Switch to AnyTrader Banner */}
      <button
        onClick={() => {
          switchPortal("anytrader");
          setTimeout(() => navigate("/", { replace: true }), 50);
        }}
        className="w-full bg-[#007AFF] border border-white/20 hover:bg-blue-600 rounded-2xl p-4 mb-6 flex items-center justify-between active:scale-[0.98] transition-all group shadow-lg shadow-blue-500/20"
      >
        <div className="flex flex-col text-left">
          <h3 className="font-black text-white uppercase tracking-tight text-sm">
            Switch To AnyTrader
          </h3>
          <p className="text-xs text-white/90 font-bold mt-0.5">
            View leads & manage quotes
          </p>
        </div>
        <div className="bg-white/20 text-white p-2 rounded-xl group-hover:bg-white/30 transition-colors border border-white/20">
          <Zap className="w-5 h-5" />
        </div>
      </button>

      {/* Referral Banner */}
      <div className="bg-gradient-to-r from-[#00D26A]/20 to-[#007AFF]/20 border border-white/20 rounded-2xl p-4 mb-6 flex items-center justify-between active:scale-[0.98] transition-transform">
        <div>
          <h3 className="font-black text-white uppercase tracking-tight">
            Earn £25
          </h3>
          <p className="text-xs text-[#E4E4E7] font-bold mt-0.5">
            Invite a driver or trader
          </p>
        </div>
        <div className="bg-white text-[#0D0D0F] p-2 rounded-full border border-white/20">
          <Share2 className="w-5 h-5" />
        </div>
      </div>

      {/* 6 Grouped Operational Menu Categories */}
      <div className="space-y-6">
        {sections.map((section, idx) => (
          <div key={idx}>
            <div className="flex items-center justify-between px-2 mb-2">
              <p className="text-[10px] text-[#A1A1AA] font-black uppercase tracking-widest">
                {section.title}
              </p>
            </div>
            <div className="bg-[#1A1A1E] border border-white/20 rounded-2xl overflow-hidden shadow-sm">
              {section.items.map((item: any, idxi) => {
                const Icon = item.icon;
                const isLastVisible = idxi === section.items.length - 1;

                return (
                  <button
                    key={idxi}
                    onClick={() => {
                      if (item.type === "toggle") {
                        if (item.action === "toggle-keep-awake") {
                          onUpdateCockpitPrefs?.({
                            keepScreenAwake: !cockpitPrefs.keepScreenAwake,
                          });
                          toast.success(
                            `Keep Screen Awake turned ${!cockpitPrefs.keepScreenAwake ? "ON" : "OFF"}`
                          );
                          return;
                        }
                        if (!user?.uid) return;
                        setConfirmToggle({
                          id: item.action,
                          newState: !item.active,
                          label: item.label,
                        });
                      } else if (item.type === "action") {
                        if (item.action === "choose-nav-app") {
                          setShowNavAppModal(true);
                        } else if (item.action === "choose-map-theme") {
                          setShowMapThemeModal(true);
                        } else if (item.action === "choose-speed-alert") {
                          setShowSpeedAlertModal(true);
                        } else if (item.action === "choose-fatigue-reminder") {
                          setShowFatigueModal(true);
                        } else if (item.action === "configure-auto-accept") {
                          setShowAutoAcceptModal(true);
                        }
                      } else if (item.action === "switch-to-anytrader") {
                        switchPortal("anytrader");
                        setTimeout(() => navigate("/", { replace: true }), 50);
                      } else {
                        item.id && onNavigate(item.id);
                      }
                    }}
                    className={cn(
                      "w-full flex items-center justify-between p-4 bg-transparent outline-none active:bg-[#252529] transition-colors text-left disabled:opacity-50",
                      !isLastVisible ? "border-b border-white/20" : ""
                    )}
                    disabled={item.type === "text"}
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={cn(
                          "w-9 h-9 rounded-full flex items-center justify-center border border-white/20",
                          item.bg
                        )}
                      >
                        <Icon className={cn("w-5 h-5", item.color)} />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
                          {item.label}
                          {item.alert && (
                            <span className="w-2 h-2 rounded-full bg-[#FF3B30] animate-pulse"></span>
                          )}
                        </h4>
                        <p className="text-[11px] text-[#E4E4E7] font-medium mt-0.5">
                          {item.desc}
                        </p>
                      </div>
                    </div>
                    {item.type === "toggle" ? (
                      <div className="flex items-center gap-3">
                        {item.action === "toggle-destination-mode" &&
                          profile?.homeLat && (
                            <div className="flex items-center gap-2 mr-2">
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowHomeModal(true);
                                  setHomeInput("");
                                  setSuggestions([]);
                                }}
                                className="p-1.5 bg-[#2C2C30] border border-white/20 hover:bg-[#3F3F46] rounded flex items-center justify-center transition-colors cursor-pointer"
                              >
                                <Edit2 className="w-3.5 h-3.5 text-[#A1A1AA] hover:text-white" />
                              </div>
                              <div
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!user?.uid) return;
                                  try {
                                    await updateDoc(doc(db, "users", user.uid), {
                                      homeAddress: deleteField(),
                                      homeLat: deleteField(),
                                      homeLng: deleteField(),
                                      destinationModeActive: false,
                                    });
                                    toast.success("Destination mode cleared");
                                  } catch (err) {
                                    console.error(err);
                                  }
                                }}
                                className="p-1.5 bg-[#2C2C30] border border-white/20 hover:bg-[#FF3B30]/20 rounded flex items-center justify-center transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5 text-[#A1A1AA] hover:text-[#FF3B30]" />
                              </div>
                            </div>
                          )}
                        <div
                          className="relative inline-block w-10 h-6 cursor-pointer rounded-full shrink-0 transition-colors border border-white/20"
                          style={{
                            backgroundColor: item.active ? "#00D26A" : "#3F3F46",
                          }}
                        >
                          <div
                            className={cn(
                              "absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all",
                              item.active ? "right-1" : "left-1"
                            )}
                          ></div>
                        </div>
                      </div>
                    ) : item.type !== "text" ? (
                      <ChevronRight className="w-5 h-5 text-[#A1A1AA]" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Logout */}
      <button
        onClick={() => logout()}
        className="w-full mt-8 py-4 text-xs font-black text-[#FF3B30] uppercase tracking-widest active:bg-[#FF3B30]/10 rounded-xl transition-colors border border-transparent active:border-[#FF3B30]/20"
      >
        Log out
      </button>

      <p className="text-center text-[10px] text-[#A1A1AA] mt-8 font-medium">
        AnyRoller Driver Terminal v2.2
      </p>

      {/* Home Address Modal */}
      {showHomeModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1A1A1E] w-full max-w-sm rounded-[32px] p-6 shadow-2xl border border-white/20">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-black text-white">Set Home Address</h3>
              <button
                onClick={() => setShowHomeModal(false)}
                className="p-2 w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-white border border-white/20"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm font-medium text-[#A1A1AA] mb-4">
              Where are you heading? We'll prioritize rides going in this direction.
            </p>
            <div className="relative mb-6">
              <input
                type="text"
                placeholder="Search home address..."
                className="w-full bg-[#2C2C30] border border-white/20 rounded-2xl px-5 py-4 text-sm font-bold text-white outline-none focus:ring-2 focus:ring-emerald-500 transition-all pl-12 placeholder:text-[#A1A1AA]"
                value={homeInput}
                onChange={(e) => setHomeInput(e.target.value)}
              />
              <Search className="w-5 h-5 text-[#A1A1AA] absolute left-4 top-1/2 -translate-y-1/2" />
            </div>

            {suggestions.length > 0 && (
              <div className="bg-[#252529] rounded-2xl overflow-hidden shadow-lg border border-white/20 max-h-[50vh] overflow-y-auto mb-4">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => handleSelectHome(s.place_id, s.description)}
                    disabled={isGeocoding}
                    className="w-full text-left px-5 py-4 border-b border-white/20 hover:bg-[#2C2C30] transition-colors disabled:opacity-50 flex items-start gap-4"
                  >
                    <MapPin className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-white leading-tight">
                        {s.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {isGeocoding && (
              <p className="text-xs text-center text-emerald-400 font-bold mb-4 flex justify-center items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Setting home...
              </p>
            )}
          </div>
        </div>
      )}

      {/* Navigation App Modal */}
      {showNavAppModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1A1A1E] w-full max-w-sm rounded-[32px] p-6 shadow-2xl border border-white/20">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-black text-white">Navigation App</h3>
              <button
                onClick={() => setShowNavAppModal(false)}
                className="p-2 w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-white border border-white/20"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm font-medium text-[#A1A1AA] mb-4">
              Choose your preferred navigation app.
            </p>
            <div className="space-y-3">
              {["Google Maps", "Waze", "Apple Maps"].map((app) => (
                <button
                  key={app}
                  onClick={() => handleSelectNavApp(app)}
                  className={cn(
                    "w-full text-left px-5 py-4 rounded-2xl border transition-colors flex items-center justify-between",
                    profile?.defaultNavApp === app ||
                      (!profile?.defaultNavApp && app === "Google Maps")
                      ? "bg-[#007AFF]/20 border-[#007AFF] text-white"
                      : "bg-[#252529] border-white/10 text-white hover:border-white/30"
                  )}
                >
                  <span className="font-bold text-sm">{app}</span>
                  {(profile?.defaultNavApp === app ||
                    (!profile?.defaultNavApp && app === "Google Maps")) && (
                    <div className="w-2 h-2 rounded-full bg-[#007AFF]"></div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Cockpit Map Theme Modal */}
      {showMapThemeModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1A1A1E] w-full max-w-sm rounded-[32px] p-6 shadow-2xl border border-white/20">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-black text-white">Cockpit Map Theme</h3>
              <button
                onClick={() => setShowMapThemeModal(false)}
                className="p-2 w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-white border border-white/20"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              {(["auto", "dark", "daylight"] as DriverMapTheme[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    onUpdateCockpitPrefs?.({ mapTheme: mode });
                    toast.success(`Map theme: ${mapThemeLabel[mode]}`);
                    setShowMapThemeModal(false);
                  }}
                  className={cn(
                    "w-full text-left px-5 py-4 rounded-2xl border transition-colors flex items-center justify-between",
                    cockpitPrefs.mapTheme === mode
                      ? "bg-[#38BDF8]/20 border-[#38BDF8] text-white"
                      : "bg-[#252529] border-white/10 text-white"
                  )}
                >
                  <span className="font-bold text-sm">{mapThemeLabel[mode]}</span>
                  {cockpitPrefs.mapTheme === mode && (
                    <div className="w-2 h-2 rounded-full bg-[#38BDF8]" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Speed Alert Modal */}
      {showSpeedAlertModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1A1A1E] w-full max-w-sm rounded-[32px] p-6 shadow-2xl border border-white/20">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-black text-white">Speed Alert Limit</h3>
              <button
                onClick={() => setShowSpeedAlertModal(false)}
                className="p-2 w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-white border border-white/20"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[0, 30, 40, 50, 60, 70].map((mph) => (
                <button
                  key={mph}
                  onClick={() => {
                    onUpdateCockpitPrefs?.({ speedAlertMph: mph });
                    toast.success(
                      mph === 0 ? "Speed alert disabled" : `Speed alert set to ${mph} mph`
                    );
                    setShowSpeedAlertModal(false);
                  }}
                  className={cn(
                    "py-3 rounded-xl border text-xs font-black",
                    cockpitPrefs.speedAlertMph === mph
                      ? "bg-[#FF9500] text-[#0D0D0F] border-[#FF9500]"
                      : "bg-[#252529] text-white border-white/20"
                  )}
                >
                  {mph === 0 ? "Off" : `${mph} mph`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Fatigue Reminder Modal */}
      {showFatigueModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1A1A1E] w-full max-w-sm rounded-[32px] p-6 shadow-2xl border border-white/20">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-black text-white">Fatigue Reminder</h3>
              <button
                onClick={() => setShowFatigueModal(false)}
                className="p-2 w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-white border border-white/20"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[0, 2, 3, 4, 5].map((hrs) => (
                <button
                  key={hrs}
                  onClick={() => {
                    onUpdateCockpitPrefs?.({ fatigueReminderHours: hrs });
                    toast.success(
                      hrs === 0
                        ? "Fatigue reminder disabled"
                        : `Fatigue reminder set to ${hrs}h`
                    );
                    setShowFatigueModal(false);
                  }}
                  className={cn(
                    "py-3 rounded-xl border text-xs font-black",
                    cockpitPrefs.fatigueReminderHours === hrs
                      ? "bg-[#FACC15] text-[#0D0D0F] border-[#FACC15]"
                      : "bg-[#252529] text-white border-white/20"
                  )}
                >
                  {hrs === 0 ? "Off" : `${hrs} hours`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Auto-Accept Filter Modal */}
      {showAutoAcceptModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1A1A1E] w-full max-w-sm rounded-[32px] p-6 shadow-2xl border border-white/20">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-xl font-black text-white">Auto-Accept Mode</h3>
              <button
                onClick={() => setShowAutoAcceptModal(false)}
                className="p-2 w-10 h-10 bg-white/5 rounded-full flex items-center justify-center text-white border border-white/20"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-[#A1A1AA] mb-4">
              Automatically accept incoming offers while idle if they meet your minimum fare and pickup distance rules.
            </p>
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-[#252529] border border-white/20 rounded-xl p-3.5">
                <span className="text-sm font-bold text-white">Enable Auto-Accept</span>
                <button
                  onClick={() =>
                    onUpdateCockpitPrefs?.({
                      autoAcceptEnabled: !cockpitPrefs.autoAcceptEnabled,
                    })
                  }
                  className="relative inline-block w-11 h-6 rounded-full border border-white/20 transition-colors"
                  style={{
                    backgroundColor: cockpitPrefs.autoAcceptEnabled
                      ? "#00D26A"
                      : "#3F3F46",
                  }}
                >
                  <div
                    className={cn(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-all",
                      cockpitPrefs.autoAcceptEnabled ? "right-1" : "left-1"
                    )}
                  />
                </button>
              </div>
              <div>
                <div className="flex justify-between text-xs font-bold mb-1.5">
                  <span className="text-[#A1A1AA]">Minimum Fare</span>
                  <span className="text-[#00D26A]">£{cockpitPrefs.autoAcceptMinFare}</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={1}
                  value={cockpitPrefs.autoAcceptMinFare}
                  onChange={(e) =>
                    onUpdateCockpitPrefs?.({
                      autoAcceptMinFare: Number(e.target.value),
                    })
                  }
                  className="w-full accent-[#00D26A]"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs font-bold mb-1.5">
                  <span className="text-[#A1A1AA]">Max Pickup Distance</span>
                  <span className="text-[#007AFF]">
                    {cockpitPrefs.autoAcceptMaxPickupMiles} mi
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={0.5}
                  value={cockpitPrefs.autoAcceptMaxPickupMiles}
                  onChange={(e) =>
                    onUpdateCockpitPrefs?.({
                      autoAcceptMaxPickupMiles: Number(e.target.value),
                    })
                  }
                  className="w-full accent-[#007AFF]"
                />
              </div>
              <button
                onClick={() => {
                  toast.success("Auto-Accept settings saved");
                  setShowAutoAcceptModal(false);
                }}
                className="w-full py-3 rounded-xl bg-white text-[#0D0D0F] text-xs font-black uppercase tracking-wider"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Toggle Modal */}
      {confirmToggle && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1A1A1E] w-full max-w-[320px] rounded-[32px] p-6 shadow-2xl border border-white/20 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center border border-white/20 mb-4">
              <ToggleRight className="w-8 h-8 text-white" />
            </div>
            <h3 className="text-xl font-black text-white mb-2">
              Confirm {confirmToggle.newState ? "Enable" : "Disable"}
            </h3>
            <p className="text-sm font-medium text-[#A1A1AA] mb-6">
              Are you sure you want to turn{" "}
              <strong className="text-white">
                {confirmToggle.newState ? "on" : "off"}
              </strong>{" "}
              {confirmToggle.label}?
            </p>
            <div className="flex items-center gap-3 w-full">
              <button
                onClick={() => setConfirmToggle(null)}
                className="flex-1 py-3.5 rounded-2xl border border-white/20 bg-transparent text-white font-black text-[11px] uppercase tracking-wider active:bg-white/5 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!user?.uid) return;
                  const newStatus = confirmToggle.newState;
                  const action = confirmToggle.id;
                  const label = confirmToggle.label;

                  setConfirmToggle(null);

                  try {
                    if (action === "toggle-stacking") {
                      await updateDoc(doc(db, "users", user.uid), {
                        isStackingEnabled: newStatus,
                      });
                    }
                    if (action === "toggle-passcode") {
                      await updateDoc(doc(db, "users", user.uid), {
                        requirePasscode: newStatus,
                      });
                    }
                    if (action === "toggle-mute-heads-up") {
                      await updateDoc(doc(db, "users", user.uid), {
                        muteHeadsUpVolume: newStatus,
                      });
                    }
                    if (action === "toggle-destination-mode") {
                      if (!profile?.homeLat && newStatus) {
                        setShowHomeModal(true);
                      } else {
                        await updateDoc(doc(db, "users", user.uid), {
                          destinationModeActive: newStatus,
                        });
                      }
                    }
                    if (action === "toggle-mute-alerts") {
                      await updateDoc(doc(db, "users", user.uid), {
                        muteRideOfferAlerts: newStatus,
                      });
                    }

                    toast.success(`${label} turned ${newStatus ? "ON" : "OFF"}`);
                  } catch (err) {
                    console.error(err);
                    toast.error("Failed to update preferences");
                  }
                }}
                className={cn(
                  "flex-1 py-3.5 rounded-2xl font-black text-[11px] uppercase tracking-wider transition-all shadow-lg text-[#0D0D0F]",
                  confirmToggle.newState
                    ? "bg-[#00D26A] active:bg-[#00ba5d]"
                    : "bg-white active:bg-gray-200"
                )}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
