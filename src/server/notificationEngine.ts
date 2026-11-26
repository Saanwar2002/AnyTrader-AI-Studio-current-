/**
 * AnyTrader V8.3 Task 35-D + Batch 16 (AT-CJ-NOTIF-05 / AT-CJ-NOTIF-06)
 * Notification Authorization, Per-Device Push Token Registry & Real FCM Multi-Device Dispatch Engine
 *
 * Invariants:
 * 1. Authenticated caller identity is derived strictly from server auth context (req.user).
 * 2. Reading notifications is strictly restricted to caller's own notifications unless admin.
 * 3. Mutating/deleting notifications is strictly restricted to document owner unless admin.
 * 4. Creating/sending notifications requires an authoritative database relationship (Job, Ride, Conversation, Project)
 *    or self-notification, verified by authorizeNotificationRequest.
 * 5. Push tokens are stored per installation under `users/{uid}/push_devices/{deviceId}` with ownership validation
 *    and explicit unregistration on logout/account switch.
 * 6. Real Firebase Cloud Messaging (`admin.messaging()`) multi-device dispatch operates behind strict configuration
 *    gates (never reports fake success when unconfigured), logs delivery receipts to `push_delivery_receipts`,
 *    and prunes invalid/unregistered tokens automatically.
 * 7. Client privilege fields (role, isAdmin, isDriver) in request bodies are completely ignored.
 */

import crypto from "crypto";
import { UnauthorizedError, ForbiddenError, BadRequestError, NotFoundError } from "./httpErrors.ts";
import { authorizeNotificationRequest, isUserAdminClaim, AuthenticatedUser } from "./authorization.ts";

export interface ListNotificationsOptions {
  targetUserId?: string;
  limit?: number;
  unreadOnly?: boolean;
}

export interface RegisterPushTokenInput {
  token?: string;
  fcmToken?: string;
  pushToken?: string;
  deviceId?: string;
  platform?: "ios" | "android" | "web" | string;
  appVersion?: string;
  userId?: string;
  uid?: string;
  ownerId?: string;
  targetUserId?: string;
}

export interface UnregisterPushTokenInput {
  deviceId?: string;
  token?: string;
  fcmToken?: string;
  pushToken?: string;
  userId?: string;
  uid?: string;
  ownerId?: string;
  targetUserId?: string;
}

export interface SendChatPushInput {
  recipientId: string;
  title?: string;
  body?: string;
  message?: string;
  rideId?: string;
  conversationId?: string;
  jobId?: string;
  type?: string;
  channelId?: string;
  notificationId?: string;
}

export interface DispatchFcmPushInput {
  recipientId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  channelId?: string;
  notificationId?: string;
  eventType?: string;
}

export interface FcmDeliveryReceipt {
  receiptId: string;
  recipientId: string;
  notificationId: string | null;
  eventType: string;
  status: "sent" | "partial" | "failed" | "skipped_no_tokens" | "skipped_no_provider";
  targetDeviceCount: number;
  deliveredCount: number;
  failedCount: number;
  prunedTokensCount: number;
  messageIds: string[];
  errors: string[];
  createdAt: string;
}

const INVALID_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/mismatched-credential",
]);

export function hashPushToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
}

export function sanitizePushDeviceId(rawDeviceId: unknown, token: string): string {
  if (typeof rawDeviceId === "string" && rawDeviceId.trim().length > 0) {
    const cleaned = rawDeviceId.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
    if (cleaned.length >= 3) {
      return cleaned;
    }
  }
  return `dev_${hashPushToken(token).slice(0, 20)}`;
}

function normalizePlatform(rawPlatform: unknown): "ios" | "android" | "web" {
  const lower = String(rawPlatform || "").trim().toLowerCase();
  if (lower === "ios") return "ios";
  if (lower === "android") return "android";
  return "web";
}

function getPushDevicesSubcollection(db: any, userId: string): any | null {
  try {
    const userDocRef = db?.collection?.("users")?.doc?.(userId);
    if (userDocRef && typeof userDocRef.collection === "function") {
      return userDocRef.collection("push_devices");
    }
  } catch {
    // Minimal test mock DB without nested subcollections
  }
  return null;
}

async function safeWriteReceipt(db: any, receipt: FcmDeliveryReceipt): Promise<void> {
  try {
    const col = db?.collection?.("push_delivery_receipts");
    if (col && typeof col.doc === "function") {
      await col.doc(receipt.receiptId).set(receipt);
    }
  } catch (err: any) {
    console.warn("[NotificationEngine] Could not persist push delivery receipt:", err?.message);
  }
}

/**
 * Server-authoritative listing of notifications for authenticated user.
 */
export async function listAuthoritativeNotifications(
  db: any,
  caller: AuthenticatedUser | null | undefined,
  options: ListNotificationsOptions = {}
): Promise<any[]> {
  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication required to list notifications.");
  }

  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const callerUid = caller.uid;
  const isCallerAdmin = isUserAdminClaim(caller);

  // If a targetUserId is requested, verify admin authorization
  let effectiveUserId = callerUid;
  if (options.targetUserId && typeof options.targetUserId === "string" && options.targetUserId.trim().length > 0) {
    const requestedTarget = options.targetUserId.trim();
    if (requestedTarget !== callerUid) {
      if (!isCallerAdmin) {
        throw new ForbiddenError("You do not have authorization to view notifications for another user.");
      }
      effectiveUserId = requestedTarget;
    }
  }

  const queryLimit = Math.min(Math.max(1, Number(options.limit) || 50), 100);

  try {
    let queryRef = db.collection("notifications").where("userId", "==", effectiveUserId);

    if (options.unreadOnly === true) {
      queryRef = queryRef.where("read", "==", false);
    }

    const snapshot = await queryRef.limit(queryLimit).get();
    const now = new Date();

    const notifications: any[] = [];
    if (snapshot && snapshot.docs) {
      for (const doc of snapshot.docs) {
        const data = typeof doc.data === "function" ? doc.data() : doc.data;
        if (!data) continue;

        // Visibility date check (delayed notifications / fuzzing) unless admin
        if (!isCallerAdmin && data.visibleAt) {
          const visibleDate = data.visibleAt.toDate ? data.visibleAt.toDate() : new Date(data.visibleAt);
          if (visibleDate > now) {
            continue; // Skip future-scheduled notification
          }
        }

        notifications.push({
          id: doc.id,
          ...data,
        });
      }
    }

    return notifications;
  } catch (err: any) {
    console.error("[NotificationEngine] Error listing notifications:", err?.message);
    throw new BadRequestError("Failed to retrieve notifications.");
  }
}

/**
 * Server-authoritative mark-read or mark-unread for a notification.
 */
export async function markAuthoritativeNotificationRead(
  db: any,
  caller: AuthenticatedUser | null | undefined,
  notificationId: string,
  readState: boolean = true
): Promise<{ success: boolean; id: string; read: boolean }> {
  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication required to update notification status.");
  }

  if (!notificationId || typeof notificationId !== "string" || !notificationId.trim()) {
    throw new BadRequestError("Notification ID is required.");
  }

  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const callerUid = caller.uid;
  const isCallerAdmin = isUserAdminClaim(caller);

  const notifDocRef = db.collection("notifications").doc(notificationId.trim());
  const notifSnap = await notifDocRef.get();
  const exists = notifSnap && (typeof notifSnap.exists === "function" ? notifSnap.exists() : notifSnap.exists);

  if (!exists) {
    throw new NotFoundError("Notification not found.");
  }

  const data = typeof notifSnap.data === "function" ? notifSnap.data() : notifSnap.data;
  const ownerId = data?.userId || data?.recipientId || data?.traderId;

  if (ownerId !== callerUid && !isCallerAdmin) {
    throw new ForbiddenError("You do not have authorization to modify this notification.");
  }

  const updatePayload: Record<string, any> = {
    read: readState,
    isRead: readState,
    updatedAt: new Date().toISOString(),
  };

  if (readState) {
    updatePayload.readAt = new Date().toISOString();
  }

  await notifDocRef.update(updatePayload);

  return {
    success: true,
    id: notificationId.trim(),
    read: readState,
  };
}

/**
 * Server-authoritative deletion of a notification.
 */
export async function deleteAuthoritativeNotification(
  db: any,
  caller: AuthenticatedUser | null | undefined,
  notificationId: string
): Promise<{ success: boolean; id: string }> {
  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication required to delete notification.");
  }

  if (!notificationId || typeof notificationId !== "string" || !notificationId.trim()) {
    throw new BadRequestError("Notification ID is required.");
  }

  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const callerUid = caller.uid;
  const isCallerAdmin = isUserAdminClaim(caller);

  const notifDocRef = db.collection("notifications").doc(notificationId.trim());
  const notifSnap = await notifDocRef.get();
  const exists = notifSnap && (typeof notifSnap.exists === "function" ? notifSnap.exists() : notifSnap.exists);

  if (!exists) {
    throw new NotFoundError("Notification not found.");
  }

  const data = typeof notifSnap.data === "function" ? notifSnap.data() : notifSnap.data;
  const ownerId = data?.userId || data?.recipientId;

  if (ownerId !== callerUid && !isCallerAdmin) {
    throw new ForbiddenError("You do not have authorization to delete this notification.");
  }

  await notifDocRef.delete();

  return {
    success: true,
    id: notificationId.trim(),
  };
}

/**
 * Server-authoritative per-installation push token registration (AT-CJ-NOTIF-05).
 * Invariants:
 * - Token owner is ALWAYS authenticated caller UID (even for admin callers).
 * - Stored per installation in `users/{uid}/push_devices/{deviceId}`.
 * - Validates token ownership via `push_device_index/{tokenHash}` and revokes stale
 *   registrations if the same physical installation switched accounts.
 */
export async function registerAuthoritativePushToken(
  db: any,
  caller: AuthenticatedUser | null | undefined,
  payload: RegisterPushTokenInput
): Promise<{ success: boolean; userId: string; deviceId: string; platform: "ios" | "android" | "web" }> {
  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication required to register push token.");
  }

  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const callerUid = caller.uid;

  // Client-supplied userId, uid, ownerId, or targetUserId MUST NOT permit registering tokens for another user (even if caller is admin)
  const clientSuppliedUserId = payload.userId || payload.uid || payload.ownerId || payload.targetUserId;
  if (
    clientSuppliedUserId &&
    typeof clientSuppliedUserId === "string" &&
    clientSuppliedUserId.trim().length > 0 &&
    clientSuppliedUserId.trim() !== callerUid
  ) {
    throw new ForbiddenError("Cannot register push token for another user.");
  }

  const rawToken = payload.fcmToken || payload.token || payload.pushToken;
  if (!rawToken || typeof rawToken !== "string" || rawToken.trim().length === 0) {
    throw new BadRequestError("Push token is required.");
  }

  const token = rawToken.trim();
  if (token.length > 500) {
    throw new BadRequestError("Push token exceeds maximum permitted length.");
  }

  const effectiveUserId = callerUid;
  const deviceId = sanitizePushDeviceId(payload.deviceId, token);
  const platform = normalizePlatform(payload.platform);
  const tokenHash = hashPushToken(token);
  const nowIso = new Date().toISOString();

  // Check if this physical token was previously registered to a different account on this device.
  // If so, revoke the stale account's device binding so notifications never leak across accounts.
  try {
    const indexCol = db.collection("push_device_index");
    if (indexCol && typeof indexCol.doc === "function") {
      const indexRef = indexCol.doc(tokenHash);
      const indexSnap = await indexRef.get();
      const indexExists = indexSnap && (typeof indexSnap.exists === "function" ? indexSnap.exists() : indexSnap.exists);
      if (indexExists) {
        const prevData = typeof indexSnap.data === "function" ? indexSnap.data() : indexSnap.data;
        if (prevData?.uid && prevData.uid !== effectiveUserId) {
          const prevDevicesCol = getPushDevicesSubcollection(db, prevData.uid);
          if (prevDevicesCol && prevData.deviceId) {
            await prevDevicesCol.doc(prevData.deviceId).set(
              {
                active: false,
                revokedReason: "reassigned_to_another_account_on_device",
                revokedAt: nowIso,
                updatedAt: nowIso,
              },
              { merge: true }
            );
          }
          // Also clear legacy top-level token if it still matches this physical token
          try {
            const prevUserRef = db.collection("users").doc(prevData.uid);
            const prevUserSnap = await prevUserRef.get();
            const prevUserData = typeof prevUserSnap?.data === "function" ? prevUserSnap.data() : prevUserSnap?.data;
            if (prevUserData && (prevUserData.fcmToken === token || prevUserData.pushToken === token)) {
              await prevUserRef.set(
                { fcmToken: null, pushToken: null, updatedAt: nowIso },
                { merge: true }
              );
            }
          } catch {
            // Non-fatal cleanup
          }
        }
      }

      await indexRef.set({
        tokenHash,
        uid: effectiveUserId,
        deviceId,
        platform,
        updatedAt: nowIso,
      });
    }
  } catch {
    // Minimal mocks without auxiliary collections still complete registration safely
  }

  // Persist per-installation device token record in subcollection `users/{uid}/push_devices/{deviceId}`
  const pushDevicesCol = getPushDevicesSubcollection(db, effectiveUserId);
  if (pushDevicesCol && typeof pushDevicesCol.doc === "function") {
    await pushDevicesCol.doc(deviceId).set(
      {
        uid: effectiveUserId,
        deviceId,
        token,
        tokenHash,
        platform,
        appVersion: typeof payload.appVersion === "string" ? payload.appVersion.slice(0, 40) : null,
        active: true,
        registeredAt: nowIso,
        updatedAt: nowIso,
      },
      { merge: true }
    );
  }

  // Keep user profile summary updated for backwards compatibility
  const userDocRef = db.collection("users").doc(effectiveUserId);
  await userDocRef.set(
    {
      fcmToken: token,
      pushToken: token,
      lastPushDeviceId: deviceId,
      updatedAt: nowIso,
    },
    { merge: true }
  );

  return {
    success: true,
    userId: effectiveUserId,
    deviceId,
    platform,
  };
}

/**
 * Server-authoritative push token unregistration on logout or account switch (AT-CJ-NOTIF-05).
 * Strictly locked to caller UID.
 */
export async function unregisterAuthoritativePushToken(
  db: any,
  caller: AuthenticatedUser | null | undefined,
  payload: UnregisterPushTokenInput
): Promise<{ success: boolean; userId: string; unregisteredCount: number }> {
  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication required to unregister push token.");
  }

  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const callerUid = caller.uid;
  const clientSuppliedUserId = payload?.userId || payload?.uid || payload?.ownerId || payload?.targetUserId;
  if (
    clientSuppliedUserId &&
    typeof clientSuppliedUserId === "string" &&
    clientSuppliedUserId.trim().length > 0 &&
    clientSuppliedUserId.trim() !== callerUid
  ) {
    throw new ForbiddenError("Cannot unregister push token for another user.");
  }

  const rawToken = payload?.fcmToken || payload?.token || payload?.pushToken;
  const cleanToken = typeof rawToken === "string" && rawToken.trim().length > 0 ? rawToken.trim() : null;
  const rawDeviceId = typeof payload?.deviceId === "string" && payload.deviceId.trim().length > 0
    ? payload.deviceId.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96)
    : null;

  if (!cleanToken && !rawDeviceId) {
    throw new BadRequestError("Either deviceId or push token is required to unregister.");
  }

  const nowIso = new Date().toISOString();
  let unregisteredCount = 0;
  const tokensToDeindex = new Set<string>();
  if (cleanToken) tokensToDeindex.add(cleanToken);

  const pushDevicesCol = getPushDevicesSubcollection(db, callerUid);
  if (pushDevicesCol) {
    if (rawDeviceId && typeof pushDevicesCol.doc === "function") {
      const devRef = pushDevicesCol.doc(rawDeviceId);
      const devSnap = await devRef.get();
      const exists = devSnap && (typeof devSnap.exists === "function" ? devSnap.exists() : devSnap.exists);
      if (exists) {
        const data = typeof devSnap.data === "function" ? devSnap.data() : devSnap.data;
        if (data?.uid && data.uid !== callerUid) {
          throw new ForbiddenError("You do not own this push device registration.");
        }
        if (data?.token) tokensToDeindex.add(data.token);
        await devRef.set(
          {
            active: false,
            unregisteredAt: nowIso,
            updatedAt: nowIso,
          },
          { merge: true }
        );
        unregisteredCount++;
      }
    }

    if (cleanToken && typeof pushDevicesCol.where === "function") {
      const matchSnap = await pushDevicesCol.where("token", "==", cleanToken).get();
      for (const d of matchSnap?.docs || []) {
        const data = typeof d.data === "function" ? d.data() : d.data;
        if (data?.active !== false) {
          await pushDevicesCol.doc(d.id).set(
            {
              active: false,
              unregisteredAt: nowIso,
              updatedAt: nowIso,
            },
            { merge: true }
          );
          unregisteredCount++;
        }
      }
    }
  }

  // Clear push_device_index entries owned by this caller
  try {
    const indexCol = db.collection("push_device_index");
    if (indexCol && typeof indexCol.doc === "function") {
      for (const tok of tokensToDeindex) {
        const idxRef = indexCol.doc(hashPushToken(tok));
        const idxSnap = await idxRef.get();
        const exists = idxSnap && (typeof idxSnap.exists === "function" ? idxSnap.exists() : idxSnap.exists);
        if (exists) {
          const data = typeof idxSnap.data === "function" ? idxSnap.data() : idxSnap.data;
          if (data?.uid === callerUid && typeof idxRef.delete === "function") {
            await idxRef.delete();
          }
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Clear legacy user doc token if it matches any unregistered token or deviceId
  try {
    const userDocRef = db.collection("users").doc(callerUid);
    const userSnap = await userDocRef.get();
    const userData = typeof userSnap?.data === "function" ? userSnap.data() : userSnap?.data;
    if (
      userData &&
      ((cleanToken && (userData.fcmToken === cleanToken || userData.pushToken === cleanToken)) ||
        (rawDeviceId && userData.lastPushDeviceId === rawDeviceId))
    ) {
      await userDocRef.set(
        {
          fcmToken: null,
          pushToken: null,
          updatedAt: nowIso,
        },
        { merge: true }
      );
      if (unregisteredCount === 0) unregisteredCount = 1;
    }
  } catch {
    // Non-fatal
  }

  return {
    success: true,
    userId: callerUid,
    unregisteredCount,
  };
}

/**
 * Loads all active deduplicated device tokens for a recipient from `users/{uid}/push_devices`
 * plus legacy fallback `users/{uid}.fcmToken` / `pushToken`.
 */
async function collectActiveRecipientTokens(
  db: any,
  recipientId: string
): Promise<Array<{ token: string; deviceId?: string }>> {
  const tokenMap = new Map<string, { token: string; deviceId?: string }>();

  const pushDevicesCol = getPushDevicesSubcollection(db, recipientId);
  if (pushDevicesCol && typeof pushDevicesCol.where === "function") {
    try {
      const snap = await pushDevicesCol.where("active", "==", true).limit(25).get();
      for (const d of snap?.docs || []) {
        const data = typeof d.data === "function" ? d.data() : d.data;
        const tok = typeof data?.token === "string" ? data.token.trim() : "";
        if (tok && !tokenMap.has(tok)) {
          tokenMap.set(tok, { token: tok, deviceId: d.id });
        }
      }
    } catch {
      // Fallback to user document below
    }
  }

  const userDoc = await db.collection("users").doc(recipientId).get();
  const exists = userDoc && (typeof userDoc.exists === "function" ? userDoc.exists() : userDoc.exists);
  if (!exists && tokenMap.size === 0) {
    throw new NotFoundError("Recipient user not found.");
  }

  const userData = exists ? (typeof userDoc.data === "function" ? userDoc.data() : userDoc.data) : null;
  const legacyToken = typeof userData?.fcmToken === "string" && userData.fcmToken.trim()
    ? userData.fcmToken.trim()
    : typeof userData?.pushToken === "string" && userData.pushToken.trim()
      ? userData.pushToken.trim()
      : null;

  if (legacyToken && !tokenMap.has(legacyToken)) {
    tokenMap.set(legacyToken, { token: legacyToken });
  }

  return Array.from(tokenMap.values());
}

/**
 * Real Firebase Cloud Messaging (`admin.messaging()`) multi-device dispatch engine (AT-CJ-NOTIF-06).
 * - Enforces strict config gate: if `messagingClient` is absent or lacks FCM methods, writes a
 *   `skipped_no_provider` receipt and returns `success: false` (NEVER reports fake success).
 * - Uses `sendEachForMulticast` when available (native multi-device batching) or `.send()` fallback.
 * - Automatically prunes invalid/unregistered device tokens and logs delivery receipts to
 *   `push_delivery_receipts`.
 */
export async function dispatchAuthoritativeFcmPush(
  db: any,
  messagingClient: any,
  input: DispatchFcmPushInput
): Promise<{
  success: boolean;
  status: FcmDeliveryReceipt["status"];
  recipientId: string;
  receiptId: string;
  deliveredCount: number;
  failedCount: number;
  prunedTokensCount: number;
  messageIds: string[];
}> {
  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }
  const recipientId = String(input?.recipientId || "").trim();
  if (!recipientId) {
    throw new BadRequestError("Recipient ID is required.");
  }

  const receiptId = `pushrcpt_${crypto.randomBytes(8).toString("hex")}`;
  const nowIso = new Date().toISOString();
  const eventType = input.eventType || input.data?.type || "notification";
  const notificationId = input.notificationId || null;

  const targets = await collectActiveRecipientTokens(db, recipientId);
  if (targets.length === 0) {
    const receipt: FcmDeliveryReceipt = {
      receiptId,
      recipientId,
      notificationId,
      eventType,
      status: "skipped_no_tokens",
      targetDeviceCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      prunedTokensCount: 0,
      messageIds: [],
      errors: [],
      createdAt: nowIso,
    };
    await safeWriteReceipt(db, receipt);
    return {
      success: false,
      status: "skipped_no_tokens",
      recipientId,
      receiptId,
      deliveredCount: 0,
      failedCount: 0,
      prunedTokensCount: 0,
      messageIds: [],
    };
  }

  const hasMulticast = Boolean(messagingClient && typeof messagingClient.sendEachForMulticast === "function");
  const hasSingleSend = Boolean(messagingClient && typeof messagingClient.send === "function");

  // Strict config gate: never claim success if FCM provider is unconfigured
  if (!hasMulticast && !hasSingleSend) {
    const receipt: FcmDeliveryReceipt = {
      receiptId,
      recipientId,
      notificationId,
      eventType,
      status: "skipped_no_provider",
      targetDeviceCount: targets.length,
      deliveredCount: 0,
      failedCount: 0,
      prunedTokensCount: 0,
      messageIds: [],
      errors: ["FCM Admin messaging provider is not configured."],
      createdAt: nowIso,
    };
    await safeWriteReceipt(db, receipt);
    return {
      success: false,
      status: "skipped_no_provider",
      recipientId,
      receiptId,
      deliveredCount: 0,
      failedCount: 0,
      prunedTokensCount: 0,
      messageIds: [],
    };
  }

  const stringData: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.data || {})) {
    stringData[k] = String(v ?? "");
  }

  const androidConfig = {
    priority: "high" as const,
    notification: {
      sound: "default",
      channelId: input.channelId || "chat_messages",
    },
  };
  const apnsConfig = {
    payload: {
      aps: {
        sound: "default",
        contentAvailable: true,
      },
    },
  };

  const messageIds: string[] = [];
  const errors: string[] = [];
  const tokensToPrune: Array<{ token: string; deviceId?: string }> = [];
  let deliveredCount = 0;
  let failedCount = 0;

  if (hasMulticast) {
    const batchRes = await messagingClient.sendEachForMulticast({
      tokens: targets.map((t) => t.token),
      notification: {
        title: input.title,
        body: input.body,
      },
      data: stringData,
      android: androidConfig,
      apns: apnsConfig,
    });

    const responses: any[] = Array.isArray(batchRes?.responses) ? batchRes.responses : [];
    responses.forEach((resp, idx) => {
      if (resp?.success) {
        deliveredCount++;
        if (resp.messageId) messageIds.push(String(resp.messageId));
      } else {
        failedCount++;
        const code = String(resp?.error?.code || "");
        const msg = String(resp?.error?.message || code || "FCM delivery failed");
        errors.push(msg);
        if (INVALID_TOKEN_ERROR_CODES.has(code) && targets[idx]) {
          tokensToPrune.push(targets[idx]);
        }
      }
    });
  } else {
    for (const target of targets) {
      try {
        const resp = await messagingClient.send({
          token: target.token,
          notification: {
            title: input.title,
            body: input.body,
          },
          data: stringData,
          android: androidConfig,
          apns: apnsConfig,
        });
        deliveredCount++;
        const id = typeof resp === "string" ? resp : resp?.messageId;
        if (id) messageIds.push(String(id));
      } catch (err: any) {
        failedCount++;
        const code = String(err?.code || "");
        errors.push(String(err?.message || code || "FCM send failed"));
        if (INVALID_TOKEN_ERROR_CODES.has(code)) {
          tokensToPrune.push(target);
        }
      }
    }
  }

  // Automatically prune invalid/unregistered tokens
  let prunedTokensCount = 0;
  if (tokensToPrune.length > 0) {
    const pushDevicesCol = getPushDevicesSubcollection(db, recipientId);
    for (const stale of tokensToPrune) {
      try {
        if (pushDevicesCol && stale.deviceId) {
          await pushDevicesCol.doc(stale.deviceId).set(
            {
              active: false,
              prunedReason: "fcm_token_unregistered",
              prunedAt: nowIso,
              updatedAt: nowIso,
            },
            { merge: true }
          );
          prunedTokensCount++;
        }
        const indexCol = db.collection("push_device_index");
        if (indexCol && typeof indexCol.doc === "function") {
          const idxRef = indexCol.doc(hashPushToken(stale.token));
          if (typeof idxRef.delete === "function") {
            await idxRef.delete();
          }
        }
      } catch {
        // Non-fatal cleanup
      }
    }
  }

  const status: FcmDeliveryReceipt["status"] =
    deliveredCount > 0 && failedCount === 0
      ? "sent"
      : deliveredCount > 0 && failedCount > 0
        ? "partial"
        : "failed";

  const receipt: FcmDeliveryReceipt = {
    receiptId,
    recipientId,
    notificationId,
    eventType,
    status,
    targetDeviceCount: targets.length,
    deliveredCount,
    failedCount,
    prunedTokensCount,
    messageIds,
    errors,
    createdAt: nowIso,
  };
  await safeWriteReceipt(db, receipt);

  return {
    success: deliveredCount > 0,
    status,
    recipientId,
    receiptId,
    deliveredCount,
    failedCount,
    prunedTokensCount,
    messageIds,
  };
}

/**
 * Server-authoritative chat push notification dispatch with strict recipient authorization.
 */
export async function sendAuthoritativeChatPush(
  db: any,
  messagingClient: any,
  caller: AuthenticatedUser | null | undefined,
  payload: SendChatPushInput
): Promise<{
  success: boolean;
  recipientId: string;
  messageId?: string;
  status?: FcmDeliveryReceipt["status"];
  receiptId?: string;
  deliveredCount?: number;
}> {
  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication required to dispatch push notification.");
  }

  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const callerUid = caller.uid;
  const { recipientId, title, body, message, rideId, conversationId, jobId, type, channelId, notificationId } = payload;

  if (!recipientId || typeof recipientId !== "string" || !recipientId.trim()) {
    throw new BadRequestError("Recipient ID is required.");
  }

  const sanitizedRecipientId = recipientId.trim();

  // Authorize caller to notify this recipient
  const isAuthorized = await authorizeNotificationRequest(
    db,
    callerUid,
    caller,
    {
      recipientId: sanitizedRecipientId,
      type: type || "message",
      rideId,
      conversationId,
      jobId,
    }
  );

  if (!isAuthorized) {
    throw new ForbiddenError("You do not have authorization to send push notifications to this recipient.");
  }

  const resolvedChannelId = channelId || (rideId ? "ride_chat_updates" : "chat_messages");

  const dispatchResult = await dispatchAuthoritativeFcmPush(db, messagingClient, {
    recipientId: sanitizedRecipientId,
    title: title || "New Message",
    body: body || message || "You have a new message",
    channelId: resolvedChannelId,
    notificationId,
    eventType: type || "chat_message",
    data: {
      rideId: rideId || "",
      conversationId: conversationId || "",
      jobId: jobId || "",
      type: type || "chat_message",
    },
  });

  if (dispatchResult.status === "skipped_no_tokens") {
    throw new BadRequestError("Recipient user has no registered push token.");
  }

  return {
    success: dispatchResult.success,
    recipientId: sanitizedRecipientId,
    messageId: dispatchResult.messageIds[0],
    status: dispatchResult.status,
    receiptId: dispatchResult.receiptId,
    deliveredCount: dispatchResult.deliveredCount,
  };
}
