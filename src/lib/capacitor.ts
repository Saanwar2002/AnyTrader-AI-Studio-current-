// Pure Web / PWA platform utilities (Capacitor native runtime removed)

export enum ImpactStyle {
  Heavy = "HEAVY",
  Medium = "MEDIUM",
  Light = "LIGHT",
}

export const isCapacitor = () => false;

const MAPS_KEY_PLACEHOLDER_PATTERNS = [
  "your_",
  "replace_with",
  "placeholder",
  "example",
  "changeme",
  "test_key",
  "dummy",
  "xxxx",
];

export const isValidGoogleMapsApiKey = (key?: string): boolean => {
  if (!key || typeof key !== "string") return false;
  const clean = key.trim();
  if (clean.length < 20) return false;
  const lower = clean.toLowerCase();
  if (MAPS_KEY_PLACEHOLDER_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return false;
  }
  return true;
};

/**
 * Platform-specific Google Maps API key resolution.
 * - Web: requires VITE_GOOGLE_MAPS_API_KEY
 * - iOS / Android params retained strictly for backwards-compatible key validation tests.
 */
export const resolveGoogleMapsApiKey = (
  platform: string,
  env: Record<string, string | undefined>
): string => {
  const normalizedPlatform = String(platform || "web").trim().toLowerCase();

  if (normalizedPlatform === "ios") {
    const iosKey = env.VITE_GOOGLE_MAPS_IOS_API_KEY;
    return isValidGoogleMapsApiKey(iosKey) ? iosKey!.trim() : "";
  }

  if (normalizedPlatform === "android") {
    const androidKey = env.VITE_GOOGLE_MAPS_ANDROID_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY_ANDROID;
    return isValidGoogleMapsApiKey(androidKey) ? androidKey!.trim() : "";
  }

  const webKey = env.VITE_GOOGLE_MAPS_API_KEY;
  return isValidGoogleMapsApiKey(webKey) ? webKey!.trim() : "";
};

export const getGoogleMapsApiKey = (): string => {
  const env = ((import.meta as any).env || {}) as Record<string, string | undefined>;
  return resolveGoogleMapsApiKey("web", env);
};

export const triggerHaptic = async (style: ImpactStyle = ImpactStyle.Medium) => {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      const duration = style === ImpactStyle.Heavy ? 35 : style === ImpactStyle.Light ? 10 : 20;
      navigator.vibrate(duration);
    } catch {
      // Ignore unsupported browsers
    }
  }
};

export const setNativeStatusBar = async (_isDark: boolean) => {
  // No-op on responsive Web/PWA
};

export const hideNativeKeyboard = async () => {
  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
};

export const initCapacitorKeyboard = async () => {
  // No-op on responsive Web/PWA
};

export const speakText = async (text: string, volume: number = 1.0) => {
  if (volume <= 0 || !text) return;

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-GB";
      utterance.rate = 1.0;
      utterance.volume = volume;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn("Web TTS failed", e);
    }
  }
};
