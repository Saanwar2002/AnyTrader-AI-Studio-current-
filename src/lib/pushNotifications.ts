// Per-installation Web/PWA Push (FCM) & 4-Tier Notification Preferences Client
import { getMessaging, getToken, isSupported as isMessagingSupported, onMessage } from "firebase/messaging";
import { app, auth } from "../firebase";
import { getApiUrl } from "./apiUrl";

const PUSH_DEVICE_ID_KEY = "anytrader_push_device_id";
const PUSH_TOKEN_CACHE_KEY = "anytrader_push_token_cache";
const PUSH_TOKEN_OWNER_KEY = "anytrader_push_token_owner_uid";
const FCM_PUSH_SW_SCOPE = "/firebase-cloud-messaging-push-scope";

let lastRegisteredToken: string | null = null;

export type WebPushPermissionState =
  | "unsupported"
  | "ios_needs_install"
  | "unconfigured"
  | "default"
  | "granted"
  | "denied";

export interface NotificationPreferencesDTO {
  whatsappOptIn: boolean;
  whatsappPhoneMasked: string | null;
  whatsappHasPhone: boolean;
  whatsappVerified: boolean;
  whatsappWindowActive: boolean;
  whatsappWindowExpiresAt: string | null;
  emailNotifications: boolean;
  pushNotifications: boolean;
  activePushDevicesCount: number;
  businessWhatsAppConfigured: boolean;
  metaApiConfigured: boolean;
}

export interface WhatsAppActivationLinkDTO {
  activationCode: string;
  businessNumberConfigured: boolean;
  waMeUrl: string | null;
  prefilledMessage: string;
  expiresAt: string;
}

export function getOrCreateInstallationDeviceId(): string {
  try {
    if (typeof localStorage !== "undefined") {
      const existing = localStorage.getItem(PUSH_DEVICE_ID_KEY);
      if (existing && existing.trim().length >= 8) {
        return existing.trim();
      }
      const generated =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? `inst_${crypto.randomUUID()}`
          : `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(PUSH_DEVICE_ID_KEY, generated);
      return generated;
    }
  } catch {
    // Fallback if storage unavailable
  }
  return `inst_${Date.now().toString(36)}`;
}

function getConfiguredVapidKey(): string | null {
  const raw = ((import.meta as any).env?.VITE_FIREBASE_VAPID_KEY || "").trim();
  if (!raw || raw.startsWith("replace_with_")) {
    return null;
  }
  return raw;
}

export function isRunningAsInstalledPwa(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as any)?.standalone === true
  );
}

export function isIosBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function getWebPushStatus(): WebPushPermissionState {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unsupported";
  }
  if (isIosBrowser() && !isRunningAsInstalledPwa()) {
    return "ios_needs_install";
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }
  if (!getConfiguredVapidKey()) {
    return "unconfigured";
  }
  const perm = Notification.permission;
  if (perm === "granted") return "granted";
  if (perm === "denied") return "denied";
  return "default";
}

async function getBearerHeaders(): Promise<Record<string, string> | null> {
  const user = auth.currentUser;
  if (!user) return null;
  const idToken = await user.getIdToken().catch(() => null);
  if (!idToken) return null;
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${idToken}`,
  };
}

/**
 * Requests browser push permission, obtains an FCM Web Push token via our dedicated push Service Worker,
 * and registers it with `/api/notifications/register-token` for multi-device Tier-2 free push delivery.
 */
export async function enableWebPushNotifications(userId: string): Promise<{
  enabled: boolean;
  status: WebPushPermissionState;
  token?: string;
  reason?: string;
}> {
  const status = getWebPushStatus();
  if (status === "unsupported" || status === "ios_needs_install" || status === "unconfigured") {
    return { enabled: false, status, reason: status };
  }

  const vapidKey = getConfiguredVapidKey();
  if (!vapidKey) {
    return { enabled: false, status: "unconfigured", reason: "vapid_unconfigured" };
  }

  try {
    const supported = await isMessagingSupported().catch(() => false);
    if (!supported) {
      return { enabled: false, status: "unsupported", reason: "fcm_unsupported" };
    }

    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();

    if (permission !== "granted") {
      return {
        enabled: false,
        status: permission === "denied" ? "denied" : "default",
        reason: "permission_not_granted",
      };
    }

    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
      scope: FCM_PUSH_SW_SCOPE,
    });

    const messaging = getMessaging(app);
    const fcmToken = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    });

    if (!fcmToken) {
      return { enabled: false, status: "default", reason: "empty_token" };
    }

    const headers = await getBearerHeaders();
    if (!headers) {
      return { enabled: false, status: "granted", reason: "unauthenticated" };
    }

    const deviceId = getOrCreateInstallationDeviceId();
    const res = await fetch(getApiUrl("/api/notifications/register-token"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        fcmToken,
        deviceId,
        platform: "web",
      }),
    });

    if (!res.ok) {
      return { enabled: false, status: "granted", reason: `register_http_${res.status}` };
    }

    lastRegisteredToken = fcmToken;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(PUSH_TOKEN_CACHE_KEY, fcmToken);
        localStorage.setItem(PUSH_TOKEN_OWNER_KEY, userId);
      }
    } catch {
      // Non-fatal
    }

    return { enabled: true, status: "granted", token: fcmToken };
  } catch (err: any) {
    return {
      enabled: false,
      status: getWebPushStatus(),
      reason: err?.message || "web_push_registration_failed",
    };
  }
}

/**
 * Silently syncs Web Push token on sign-in if the user has already granted browser notification permission.
 */
export async function registerForPushNotifications(userId: string) {
  if (getWebPushStatus() !== "granted") {
    return;
  }
  await enableWebPushNotifications(userId).catch(() => {});
}

/**
 * Listens for foreground FCM Web Push messages when the browser tab is active.
 */
export async function subscribeForegroundWebPush(
  handler: (payload: { title: string; body: string; link?: string }) => void
): Promise<() => void> {
  const noop = () => {};
  if (typeof window === "undefined") return noop;
  try {
    const supported = await isMessagingSupported().catch(() => false);
    if (!supported || !getConfiguredVapidKey()) return noop;
    const messaging = getMessaging(app);
    return onMessage(messaging, (payload) => {
      const title = payload.notification?.title || payload.data?.title || "AnyTrader UK";
      const body = payload.notification?.body || payload.data?.body || "";
      const link = payload.data?.link || undefined;
      handler({ title, body, link });
    });
  } catch {
    return noop;
  }
}

export async function unregisterCurrentDevicePushToken(explicitIdToken?: string | null): Promise<boolean> {
  let cachedToken = lastRegisteredToken;
  let deviceId: string | null = null;

  try {
    if (typeof localStorage !== "undefined") {
      if (!cachedToken) cachedToken = localStorage.getItem(PUSH_TOKEN_CACHE_KEY);
      deviceId = localStorage.getItem(PUSH_DEVICE_ID_KEY);
    }
  } catch {
    // Ignore
  }

  lastRegisteredToken = null;

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PUSH_TOKEN_CACHE_KEY);
      localStorage.removeItem(PUSH_TOKEN_OWNER_KEY);
    }
  } catch {
    // Ignore
  }

  if (!cachedToken && !deviceId) {
    return false;
  }

  try {
    const idToken =
      explicitIdToken ||
      (auth.currentUser ? await auth.currentUser.getIdToken().catch(() => null) : null);
    if (!idToken) {
      return false;
    }

    const res = await fetch(getApiUrl("/api/notifications/unregister-token"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        deviceId: deviceId || undefined,
        token: cachedToken || undefined,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferencesDTO | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;
  const res = await fetch(getApiUrl("/api/notifications/preferences"), {
    method: "GET",
    headers,
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.preferences || null;
}

export async function updateNotificationPreferences(patch: {
  whatsappOptIn?: boolean;
  whatsappPhone?: string | null;
  emailNotifications?: boolean;
  pushNotifications?: boolean;
}): Promise<{ preferences?: NotificationPreferencesDTO; error?: string }> {
  const headers = await getBearerHeaders();
  if (!headers) return { error: "Sign in required." };
  const res = await fetch(getApiUrl("/api/notifications/preferences"), {
    method: "PATCH",
    headers,
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: data?.error || "Unable to save notification preferences." };
  }
  return { preferences: data?.preferences };
}

export async function requestWhatsAppActivationLink(
  contextLabel?: string
): Promise<{ data?: WhatsAppActivationLinkDTO; error?: string }> {
  const headers = await getBearerHeaders();
  if (!headers) return { error: "Sign in required." };
  const res = await fetch(getApiUrl("/api/notifications/whatsapp-activation-link"), {
    method: "POST",
    headers,
    body: JSON.stringify({ contextLabel }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: data?.error || "Unable to create WhatsApp activation link." };
  }
  return {
    data: {
      activationCode: data.activationCode,
      businessNumberConfigured: Boolean(data.businessNumberConfigured),
      waMeUrl: data.waMeUrl || null,
      prefilledMessage: data.prefilledMessage || "",
      expiresAt: data.expiresAt || "",
    },
  };
}

export async function sendChatPresenceHeartbeat(
  activeConversationId: string | null,
  markRead = false
): Promise<void> {
  try {
    const headers = await getBearerHeaders();
    if (!headers) return;
    await fetch(getApiUrl("/api/notifications/presence"), {
      method: "POST",
      headers,
      body: JSON.stringify({ activeConversationId, markRead }),
    });
  } catch {
    // Presence heartbeat is best-effort
  }
}
