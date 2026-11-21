import { Haptics, ImpactStyle } from '@capacitor/haptics';
export { ImpactStyle };
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface TextToSpeechPlugin {
  speak(options: {
    text: string;
    lang?: string;
    rate?: number;
    pitch?: number;
    volume?: number;
    voice?: number;
    category?: string;
  }): Promise<void>;
  stop?(): Promise<void>;
}

export const TextToSpeech = registerPlugin<TextToSpeechPlugin>('TextToSpeech');

export const isCapacitor = () => {
  return Capacitor.isNativePlatform();
};

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
 * AT-MOBILE-02: Strict platform-specific Google Maps API key resolution.
 * - iOS native: strictly requires VITE_GOOGLE_MAPS_IOS_API_KEY
 * - Android native: strictly requires VITE_GOOGLE_MAPS_ANDROID_API_KEY (or legacy VITE_GOOGLE_MAPS_API_KEY_ANDROID)
 * - Web: strictly requires VITE_GOOGLE_MAPS_API_KEY
 * Never silently falls back to a wrong-platform key (e.g., web key in native iOS/Android WebView or Android key on iOS).
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
  const platform = Capacitor.isNativePlatform() ? Capacitor.getPlatform() : "web";
  return resolveGoogleMapsApiKey(platform, env);
};

export const triggerHaptic = async (style: ImpactStyle = ImpactStyle.Medium) => {
  if (isCapacitor()) {
    try {
      await Haptics.impact({ style });
    } catch (e) {
      console.warn('Haptics failed', e);
    }
  }
};

export const setNativeStatusBar = async (isDark: boolean) => {
  if (isCapacitor()) {
    try {
      await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
    } catch (e) {
       // Ignore
    }
  }
};

export const hideNativeKeyboard = async () => {
  if (isCapacitor()) {
    try {
      await Keyboard.hide();
    } catch (e) {
       // Ignore
    }
  }
};

export const initCapacitorKeyboard = async () => {
  if (isCapacitor()) {
    try {
      // Configure body resize mode so WebView viewport adjusts when virtual keyboard opens
      await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
      await Keyboard.setScroll({ isDisabled: false });

      // Listen for keyboard lifecycle events to handle layout shifts and scroll active input into clear view
      Keyboard.addListener('keyboardWillShow', (info) => {
        document.body.classList.add('keyboard-is-open');
        document.documentElement.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);

        setTimeout(() => {
          const activeEl = document.activeElement as HTMLElement | null;
          if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
            const inputType = (activeEl as HTMLInputElement).type;
            if (inputType !== 'checkbox' && inputType !== 'radio' && inputType !== 'file') {
              activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }, 120);
      });

      Keyboard.addListener('keyboardDidShow', () => {
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
          const inputType = (activeEl as HTMLInputElement).type;
          if (inputType !== 'checkbox' && inputType !== 'radio' && inputType !== 'file') {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      });

      Keyboard.addListener('keyboardWillHide', () => {
        document.body.classList.remove('keyboard-is-open');
        document.documentElement.style.setProperty('--keyboard-height', '0px');
      });
    } catch (e) {
      console.warn('Capacitor Keyboard setup warning:', e);
    }
  }
};

export const speakText = async (text: string, volume: number = 1.0) => {
  if (volume <= 0 || !text) return;

  if (isCapacitor()) {
    try {
      await TextToSpeech.speak({
        text: text,
        lang: 'en-GB',
        rate: 1.0,
        pitch: 1.0,
        volume: volume,
        category: 'ambient',
      });
    } catch (e) {
      console.warn('Capacitor TTS failed', e);
    }
  } else if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-GB";
      utterance.rate = 1.0;
      utterance.volume = volume;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('Web TTS failed', e);
    }
  }
};
