// AT-CJ-NOTIF-05: Per-installation native push registration & logout/account-switch unregistration
import { PushNotifications } from "@capacitor/push-notifications";
import { Capacitor } from "@capacitor/core";
import { auth } from "../firebase";

const PUSH_DEVICE_ID_KEY = "anytrader_push_device_id";
const PUSH_TOKEN_CACHE_KEY = "anytrader_push_token_cache";
const PUSH_TOKEN_OWNER_KEY = "anytrader_push_token_owner_uid";

let listenersRegistered = false;
let currentRegisteredUserId: string | null = null;
let lastRegisteredToken: string | null = null;

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

async function submitTokenToServer(userId: string, tokenValue: string): Promise<boolean> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== userId) {
    return false;
  }

  const idToken = await currentUser.getIdToken();
  const deviceId = getOrCreateInstallationDeviceId();
  const platform = Capacitor.getPlatform();

  const res = await fetch("/api/notifications/register-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      token: tokenValue,
      deviceId,
      platform,
    }),
  });

  if (res.ok) {
    lastRegisteredToken = tokenValue;
    currentRegisteredUserId = userId;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(PUSH_TOKEN_CACHE_KEY, tokenValue);
        localStorage.setItem(PUSH_TOKEN_OWNER_KEY, userId);
      }
    } catch {
      // Non-fatal
    }
    return true;
  }
  return false;
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
  currentRegisteredUserId = null;

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

    const res = await fetch("/api/notifications/unregister-token", {
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

export async function registerForPushNotifications(userId: string) {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  // If a previous user owned a cached token on this device, unregister cleanly first
  try {
    const prevOwner =
      typeof localStorage !== "undefined" ? localStorage.getItem(PUSH_TOKEN_OWNER_KEY) : null;
    if (prevOwner && prevOwner !== userId) {
      await unregisterCurrentDevicePushToken();
    }
  } catch {
    // Non-fatal
  }

  currentRegisteredUserId = userId;

  try {
    let permStatus = await PushNotifications.checkPermissions();

    if (permStatus.receive === "prompt") {
      permStatus = await PushNotifications.requestPermissions();
    }

    if (permStatus.receive !== "granted") {
      console.warn("User denied push notification permissions");
      return;
    }

    if (!listenersRegistered) {
      listenersRegistered = true;

      PushNotifications.addListener("registration", async (token) => {
        if (!currentRegisteredUserId) return;
        try {
          await submitTokenToServer(currentRegisteredUserId, token.value);
        } catch (err) {
          console.error("Failed to register push token with server:", err);
        }
      });

      PushNotifications.addListener("registrationError", (error: any) => {
        console.error("Error on push registration:", error);
      });

      PushNotifications.addListener("pushNotificationReceived", (notification) => {
        console.log("Push received:", notification);
      });

      PushNotifications.addListener("pushNotificationActionPerformed", (notification) => {
        console.log("Push action performed:", notification);
      });
    }

    await PushNotifications.register();
  } catch (error) {
    console.error("Failed to initialize push notifications:", error);
  }
}
