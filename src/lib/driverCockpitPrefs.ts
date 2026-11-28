export type DriverMapTheme = "auto" | "dark" | "daylight";

export interface DriverCockpitPrefs {
  mapTheme: DriverMapTheme;
  keepScreenAwake: boolean;
  speedAlertMph: number; // 0 = Off, 30..70
  fatigueReminderHours: number; // 0 = Off, 2..5
  autoAcceptEnabled: boolean;
  autoAcceptMinFare: number;
  autoAcceptMaxPickupMiles: number;
}

export const DEFAULT_DRIVER_COCKPIT_PREFS: DriverCockpitPrefs = {
  mapTheme: "auto",
  keepScreenAwake: true,
  speedAlertMph: 0,
  fatigueReminderHours: 3,
  autoAcceptEnabled: false,
  autoAcceptMinFare: 12,
  autoAcceptMaxPickupMiles: 3,
};

const STORAGE_KEY = "anyroller_driver_cockpit_prefs_v1";

export function loadDriverCockpitPrefs(): DriverCockpitPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DRIVER_COCKPIT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      mapTheme:
        parsed?.mapTheme === "dark" || parsed?.mapTheme === "daylight" || parsed?.mapTheme === "auto"
          ? parsed.mapTheme
          : DEFAULT_DRIVER_COCKPIT_PREFS.mapTheme,
      keepScreenAwake:
        typeof parsed?.keepScreenAwake === "boolean"
          ? parsed.keepScreenAwake
          : DEFAULT_DRIVER_COCKPIT_PREFS.keepScreenAwake,
      speedAlertMph:
        Number.isFinite(Number(parsed?.speedAlertMph))
          ? Math.max(0, Math.min(70, Number(parsed.speedAlertMph)))
          : DEFAULT_DRIVER_COCKPIT_PREFS.speedAlertMph,
      fatigueReminderHours:
        Number.isFinite(Number(parsed?.fatigueReminderHours))
          ? Math.max(0, Math.min(5, Number(parsed.fatigueReminderHours)))
          : DEFAULT_DRIVER_COCKPIT_PREFS.fatigueReminderHours,
      autoAcceptEnabled: Boolean(parsed?.autoAcceptEnabled),
      autoAcceptMinFare:
        Number.isFinite(Number(parsed?.autoAcceptMinFare))
          ? Math.max(5, Math.min(100, Number(parsed.autoAcceptMinFare)))
          : DEFAULT_DRIVER_COCKPIT_PREFS.autoAcceptMinFare,
      autoAcceptMaxPickupMiles:
        Number.isFinite(Number(parsed?.autoAcceptMaxPickupMiles))
          ? Math.max(0.5, Math.min(20, Number(parsed.autoAcceptMaxPickupMiles)))
          : DEFAULT_DRIVER_COCKPIT_PREFS.autoAcceptMaxPickupMiles,
    };
  } catch {
    return { ...DEFAULT_DRIVER_COCKPIT_PREFS };
  }
}

export function saveDriverCockpitPrefs(prefs: DriverCockpitPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors in private browsing
  }
}
