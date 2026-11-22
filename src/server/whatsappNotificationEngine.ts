/**
 * AnyTrader & AnyRoller Shared 4-Tier Messaging & Notification Escalation Engine
 *
 * Implements:
 * - Direct Meta WhatsApp Cloud API integration (zero third-party markup)
 * - Smart 24-hour customer service window detection (free-form service reply inside 24h window,
 *   pre-approved Meta Utility template outside 24h window)
 * - Atomic 5-minute per-conversation cooldown + daily per-user cap to prevent message-burst spend
 * - Delayed 45-second unread/offline check via `whatsapp_fallback_queue` with active presence cancellation
 * - Timing-safe `X-Hub-Signature-256` HMAC-SHA256 Meta webhook verification, 1-tap `AT-XXXXXX` opt-in
 *   activation, and instant UK GDPR `STOP` opt-out handling
 * - Zero cross-user phone number exposure (phone numbers stay server-side only)
 */

import crypto from "node:crypto";
import {
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
} from "./httpErrors.ts";

export const WHATSAPP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per (recipient, conversation/context)
export const WHATSAPP_CHAT_UNREAD_DELAY_MS = 45 * 1000; // 45s delay for standard chat messages
export const WHATSAPP_CRITICAL_OFFLINE_DELAY_MS = 5 * 1000; // 5s grace window for critical events
export const WHATSAPP_ACTIVATION_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const WHATSAPP_DAILY_USER_CAP = 20;
export const ACTIVE_PRESENCE_FRESHNESS_MS = 90 * 1000; // 90s heartbeat window

export type WhatsAppContextType =
  | "anytrader_chat"
  | "anytrader_quote"
  | "anytrader_job"
  | "anyroller_ride";

export interface AuthenticatedNotificationCaller {
  uid: string;
  email?: string;
  isAdmin?: boolean;
  admin?: boolean;
}

export interface WhatsAppDeliveryResult {
  sent: boolean;
  status:
    | "sent"
    | "skipped_unconfigured"
    | "skipped_read"
    | "skipped_cooldown"
    | "skipped_daily_cap"
    | "skipped_no_opt_in"
    | "skipped_blocked"
    | "failed";
  mode?: "service_window" | "utility_template";
  metaMessageId?: string | null;
  reason?: string;
}

export interface MetaWhatsAppRuntimeConfig {
  accessToken: string | null;
  phoneNumberId: string | null;
  appSecret: string | null;
  verifyToken: string | null;
  businessPhoneDisplay: string | null;
  businessPhoneDigits: string | null;
  graphVersion: string;
  utilityTemplateName: string;
  utilityTemplateLang: string;
  appBaseUrl: string;
}

export function getMetaWhatsAppConfig(
  env: Record<string, string | undefined> = process.env
): MetaWhatsAppRuntimeConfig {
  const accessToken = (env.META_WHATSAPP_ACCESS_TOKEN || "").trim() || null;
  const phoneNumberId = (env.META_WHATSAPP_PHONE_NUMBER_ID || "").trim() || null;
  const appSecret = (env.META_WHATSAPP_APP_SECRET || "").trim() || null;
  const verifyToken = (env.META_WHATSAPP_VERIFY_TOKEN || "").trim() || null;
  const rawBizPhone = (env.META_WHATSAPP_BUSINESS_NUMBER || "").trim() || null;
  const normalizedBiz = rawBizPhone ? normalizeUkPhoneToE164(rawBizPhone) : null;
  const businessPhoneDigits = normalizedBiz ? normalizedBiz.replace(/^\+/, "") : null;
  const graphVersion = (env.META_WHATSAPP_GRAPH_VERSION || "v21.0").trim();
  const utilityTemplateName =
    (env.META_WHATSAPP_UTILITY_TEMPLATE_NAME || "anytrader_offline_alert").trim();
  const utilityTemplateLang =
    (env.META_WHATSAPP_UTILITY_TEMPLATE_LANG || "en_GB").trim();
  const rawBaseUrl = (
    env.APP_URL ||
    env.VITE_APP_URL ||
    "https://anytrader.co.uk"
  )
    .trim()
    .replace(/\/+$/, "");

  return {
    accessToken,
    phoneNumberId,
    appSecret,
    verifyToken,
    businessPhoneDisplay: normalizedBiz,
    businessPhoneDigits,
    graphVersion,
    utilityTemplateName,
    utilityTemplateLang,
    appBaseUrl: rawBaseUrl,
  };
}

/**
 * Normalizes UK and international mobile phone numbers into strict E.164 format (`+447...`).
 * Returns `null` if invalid.
 */
export function normalizeUkPhoneToE164(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let cleaned = trimmed.replace(/[\s\-().]/g, "");
  if (cleaned.startsWith("00")) {
    cleaned = `+${cleaned.slice(2)}`;
  } else if (cleaned.startsWith("07") && cleaned.length === 11) {
    cleaned = `+44${cleaned.slice(1)}`;
  } else if (cleaned.startsWith("447") && cleaned.length === 12) {
    cleaned = `+${cleaned}`;
  } else if (!cleaned.startsWith("+") && /^[1-9]\d{9,14}$/.test(cleaned)) {
    cleaned = `+${cleaned}`;
  }

  if (!/^\+[1-9]\d{9,14}$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * Masks an E.164 phone number for safe self-display (e.g. `+44•••••6789`).
 */
export function maskPhoneNumber(e164: string | null | undefined): string | null {
  if (!e164 || typeof e164 !== "string" || e164.length < 7) return null;
  const prefix = e164.slice(0, 3);
  const suffix = e164.slice(-4);
  return `${prefix}•••••${suffix}`;
}

export function sanitizeContextId(raw: string): string {
  return String(raw || "general")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 96);
}

export function sanitizeDeepLinkPath(rawPath: string | undefined | null): string {
  if (!rawPath || typeof rawPath !== "string") return "/notifications";
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || /[\r\n]/.test(trimmed)) {
    return "/notifications";
  }
  return trimmed.slice(0, 200);
}

/**
 * Timing-safe verification of Meta's `X-Hub-Signature-256` header (`sha256=<hex>`).
 */
export function verifyMetaWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined | null,
  appSecret: string | undefined | null
): boolean {
  if (!appSecret || !signatureHeader || typeof signatureHeader !== "string") {
    return false;
  }
  const trimmedSig = signatureHeader.trim();
  if (!trimmedSig.startsWith("sha256=")) {
    return false;
  }
  const providedHex = trimmedSig.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) {
    return false;
  }
  const expectedHex = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const providedBuf = Buffer.from(providedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function getUtcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function getMonthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

async function safeWriteWhatsAppLog(db: any, entry: Record<string, any>): Promise<void> {
  try {
    const col = db?.collection?.("whatsapp_delivery_logs");
    if (col && typeof col.add === "function") {
      await col.add({
        ...entry,
        createdAt: new Date().toISOString(),
      });
    }
  } catch {
    // Audit logging is best-effort and must not crash dispatch
  }
}

/**
 * Checks whether sender and recipient have an active block relationship in `chat_user_blocks`.
 */
async function hasActiveUserBlock(
  db: any,
  userA: string | undefined | null,
  userB: string | undefined | null
): Promise<boolean> {
  if (!db || !userA || !userB || userA === userB) return false;
  try {
    const blocksCol = db.collection("chat_user_blocks");
    if (!blocksCol || typeof blocksCol.doc !== "function") return false;
    const [aBlocksB, bBlocksA] = await Promise.all([
      blocksCol.doc(`${userA}__${userB}`).get(),
      blocksCol.doc(`${userB}__${userA}`).get(),
    ]);
    const isBlockedA =
      aBlocksB &&
      (typeof aBlocksB.exists === "function" ? aBlocksB.exists() : aBlocksB.exists) &&
      (typeof aBlocksB.data === "function" ? aBlocksB.data() : aBlocksB.data)?.active !== false;
    const isBlockedB =
      bBlocksA &&
      (typeof bBlocksA.exists === "function" ? bBlocksA.exists() : bBlocksA.exists) &&
      (typeof bBlocksA.data === "function" ? bBlocksA.data() : bBlocksA.data)?.active !== false;
    return Boolean(isBlockedA || isBlockedB);
  } catch {
    return false;
  }
}

/**
 * Atomically enforces the 5-minute cooldown per `(recipientUid, contextId)` and daily per-user cap.
 */
export async function claimWhatsAppCooldownSlot(
  db: any,
  recipientUid: string,
  contextId: string,
  options?: {
    nowMs?: number;
    cooldownMs?: number;
    dailyCap?: number;
  }
): Promise<{
  allowed: boolean;
  reason?: "cooldown_active" | "daily_cap_reached";
  retryAfterMs?: number;
}> {
  const nowMs = options?.nowMs ?? Date.now();
  const cooldownMs = options?.cooldownMs ?? WHATSAPP_COOLDOWN_MS;
  const dailyCap = options?.dailyCap ?? WHATSAPP_DAILY_USER_CAP;
  const safeCtx = sanitizeContextId(contextId);
  const cooldownDocId = `${recipientUid}_${safeCtx}`;
  const dayKey = getUtcDateKey(nowMs);
  const dailyDocId = `${recipientUid}_${dayKey}`;

  const cooldownRef = db.collection("notification_cooldowns").doc(cooldownDocId);
  const dailyRef = db.collection("notification_cooldowns").doc(dailyDocId);

  const runCheck = async (tx: any) => {
    const [coolSnap, dailySnap] = await Promise.all([tx.get(cooldownRef), tx.get(dailyRef)]);
    const coolExists =
      coolSnap && (typeof coolSnap.exists === "function" ? coolSnap.exists() : coolSnap.exists);
    const coolData = coolExists
      ? typeof coolSnap.data === "function"
        ? coolSnap.data()
        : coolSnap.data
      : null;

    if (coolData && typeof coolData.lastWhatsAppSentAtMs === "number") {
      const elapsed = nowMs - coolData.lastWhatsAppSentAtMs;
      if (elapsed < cooldownMs) {
        return {
          allowed: false as const,
          reason: "cooldown_active" as const,
          retryAfterMs: cooldownMs - elapsed,
        };
      }
    }

    const dailyExists =
      dailySnap && (typeof dailySnap.exists === "function" ? dailySnap.exists() : dailySnap.exists);
    const dailyData = dailyExists
      ? typeof dailySnap.data === "function"
        ? dailySnap.data()
        : dailySnap.data
      : null;

    const currentDailyCount =
      dailyData && dailyData.dayKey === dayKey && typeof dailyData.count === "number"
        ? dailyData.count
        : 0;

    if (currentDailyCount >= dailyCap) {
      return {
        allowed: false as const,
        reason: "daily_cap_reached" as const,
        retryAfterMs: 60 * 60 * 1000,
      };
    }

    tx.set(
      cooldownRef,
      {
        recipientUid,
        contextId: safeCtx,
        lastWhatsAppSentAtMs: nowMs,
        updatedAt: new Date(nowMs).toISOString(),
      },
      { merge: true }
    );

    tx.set(
      dailyRef,
      {
        recipientUid,
        dayKey,
        count: currentDailyCount + 1,
        updatedAt: new Date(nowMs).toISOString(),
      },
      { merge: true }
    );

    return { allowed: true as const };
  };

  if (typeof db.runTransaction === "function") {
    return db.runTransaction(runCheck);
  }

  // Fallback for minimal non-transactional mocks
  return runCheck({
    get: (ref: any) => ref.get(),
    set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
  });
}

/**
 * Direct Meta WhatsApp Cloud API dispatcher.
 * Uses free-form Service Message if recipient's 24h service window is open; otherwise uses Utility template.
 * Fails honestly with `skipped_unconfigured` if Meta credentials are missing.
 */
export async function sendMetaWhatsAppMessage(
  db: any,
  input: {
    recipientUid: string;
    toE164: string;
    senderLabel: string;
    contextSummary: string;
    deepLinkPath: string;
    windowExpiresAtMs?: number | null;
    customText?: string;
    nowMs?: number;
  },
  deps?: {
    config?: MetaWhatsAppRuntimeConfig;
    fetchImpl?: typeof fetch;
  }
): Promise<WhatsAppDeliveryResult> {
  const nowMs = input.nowMs ?? Date.now();
  const cfg = deps?.config ?? getMetaWhatsAppConfig();
  const fetchFn = deps?.fetchImpl ?? fetch;

  const cleanPath = sanitizeDeepLinkPath(input.deepLinkPath);
  const fullDeepLink = `${cfg.appBaseUrl}${cleanPath}`;
  const isInsideServiceWindow =
    typeof input.windowExpiresAtMs === "number" && input.windowExpiresAtMs > nowMs;
  const mode: "service_window" | "utility_template" = isInsideServiceWindow
    ? "service_window"
    : "utility_template";

  if (!cfg.accessToken || !cfg.phoneNumberId) {
    await safeWriteWhatsAppLog(db, {
      recipientUid: input.recipientUid,
      status: "skipped_unconfigured",
      mode,
      monthKey: getMonthKey(nowMs),
      reason: "Meta WhatsApp Cloud API credentials are not configured.",
    });
    return {
      sent: false,
      status: "skipped_unconfigured",
      mode,
      reason: "Meta WhatsApp Cloud API credentials are not configured.",
    };
  }

  const toDigits = input.toE164.replace(/^\+/, "");
  const safeSender = String(input.senderLabel || "AnyTrader").replace(/[\r\n]+/g, " ").slice(0, 60);
  const safeSummary = String(input.contextSummary || "You have a new unread update.")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 140);

  const bodyPayload =
    mode === "service_window"
      ? {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toDigits,
          type: "text",
          text: {
            preview_url: false,
            body:
              input.customText ||
              `AnyTrader UK: ${safeSender} — ${safeSummary}\n\nReply safely inside AnyTrader: ${fullDeepLink}\n\n(Reply STOP to pause WhatsApp alerts)`,
          },
        }
      : {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toDigits,
          type: "template",
          template: {
            name: cfg.utilityTemplateName,
            language: { code: cfg.utilityTemplateLang },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: safeSender },
                  { type: "text", text: safeSummary },
                  { type: "text", text: fullDeepLink },
                ],
              },
            ],
          },
        };

  try {
    const endpoint = `https://graph.facebook.com/${encodeURIComponent(cfg.graphVersion)}/${encodeURIComponent(cfg.phoneNumberId)}/messages`;
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyPayload),
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg =
        json?.error?.message || `Meta Graph API returned HTTP ${response.status}`;
      await safeWriteWhatsAppLog(db, {
        recipientUid: input.recipientUid,
        status: "failed",
        mode,
        monthKey: getMonthKey(nowMs),
        error: String(errMsg).slice(0, 300),
      });
      return {
        sent: false,
        status: "failed",
        mode,
        reason: errMsg,
      };
    }

    const metaMessageId = json?.messages?.[0]?.id || null;
    await safeWriteWhatsAppLog(db, {
      recipientUid: input.recipientUid,
      status: "sent",
      mode,
      monthKey: getMonthKey(nowMs),
      metaMessageId,
    });

    return {
      sent: true,
      status: "sent",
      mode,
      metaMessageId,
    };
  } catch (err: any) {
    const errMsg = err?.message || "Network error calling Meta Graph API";
    await safeWriteWhatsAppLog(db, {
      recipientUid: input.recipientUid,
      status: "failed",
      mode,
      monthKey: getMonthKey(nowMs),
      error: String(errMsg).slice(0, 300),
    });
    return {
      sent: false,
      status: "failed",
      mode,
      reason: errMsg,
    };
  }
}

/**
 * Enqueues a deduplicated Tier-4 WhatsApp fallback job into `whatsapp_fallback_queue`.
 * Standard chat messages wait 45s so Tier-1 In-App and Tier-2 Free Push handle active users at £0.
 */
export async function enqueueWhatsAppFallback(
  db: any,
  input: {
    recipientUid: string;
    senderUid?: string | null;
    senderLabel: string;
    contextId: string;
    contextType: WhatsAppContextType;
    contextSummary: string;
    deepLinkPath: string;
    notificationId?: string | null;
    urgent?: boolean;
    nowMs?: number;
  }
): Promise<{ queued: boolean; queueDocId?: string; reason?: string; scheduledForMs?: number }> {
  if (!db || !input.recipientUid) {
    return { queued: false, reason: "invalid_input" };
  }

  const nowMs = input.nowMs ?? Date.now();
  if (input.senderUid && input.senderUid === input.recipientUid) {
    return { queued: false, reason: "self_notification" };
  }

  // Respect active chat safety blocks
  if (input.senderUid && (await hasActiveUserBlock(db, input.senderUid, input.recipientUid))) {
    return { queued: false, reason: "blocked_participant" };
  }

  // Load recipient opt-in & phone strictly server-side
  const userSnap = await db.collection("users").doc(input.recipientUid).get();
  const userExists =
    userSnap && (typeof userSnap.exists === "function" ? userSnap.exists() : userSnap.exists);
  if (!userExists) {
    return { queued: false, reason: "recipient_not_found" };
  }
  const userData = typeof userSnap.data === "function" ? userSnap.data() : userSnap.data;
  if (userData?.whatsappOptIn !== true) {
    return { queued: false, reason: "not_opted_in" };
  }

  const phoneE164 = normalizeUkPhoneToE164(
    userData.whatsappPhoneE164 || userData.phone || userData.phoneNumber
  );
  if (!phoneE164) {
    return { queued: false, reason: "no_valid_phone" };
  }

  const safeCtx = sanitizeContextId(input.contextId);
  const queueDocId = `${input.recipientUid}_${safeCtx}`;
  const delayMs = input.urgent
    ? WHATSAPP_CRITICAL_OFFLINE_DELAY_MS
    : WHATSAPP_CHAT_UNREAD_DELAY_MS;
  const scheduledForMs = nowMs + delayMs;

  await db
    .collection("whatsapp_fallback_queue")
    .doc(queueDocId)
    .set(
      {
        recipientUid: input.recipientUid,
        senderUid: input.senderUid || null,
        senderLabel: String(input.senderLabel || "AnyTrader").slice(0, 60),
        contextId: safeCtx,
        contextType: input.contextType,
        contextSummary: String(input.contextSummary || "You have a new update.").slice(0, 140),
        deepLinkPath: sanitizeDeepLinkPath(input.deepLinkPath),
        notificationId: input.notificationId || null,
        status: "pending",
        createdAtMs: nowMs,
        scheduledForMs,
        updatedAt: new Date(nowMs).toISOString(),
      },
      { merge: true }
    );

  return {
    queued: true,
    queueDocId,
    scheduledForMs,
  };
}

/**
 * Checks whether the recipient is actively viewing this conversation or already read the notification.
 */
async function isRecipientActiveOrAlreadyRead(
  db: any,
  item: {
    recipientUid: string;
    contextId: string;
    notificationId?: string | null;
    createdAtMs: number;
  },
  nowMs: number
): Promise<boolean> {
  // 1. Check active presence heartbeat (`user_presence/{recipientUid}`)
  try {
    const presSnap = await db.collection("user_presence").doc(item.recipientUid).get();
    const presExists =
      presSnap && (typeof presSnap.exists === "function" ? presSnap.exists() : presSnap.exists);
    if (presExists) {
      const pres = typeof presSnap.data === "function" ? presSnap.data() : presSnap.data;
      const updatedAtMs = typeof pres?.updatedAtMs === "number" ? pres.updatedAtMs : 0;
      const lastReadAtMs = typeof pres?.lastReadAtMs === "number" ? pres.lastReadAtMs : 0;
      const activeCtx =
        typeof pres?.activeConversationId === "string"
          ? sanitizeContextId(pres.activeConversationId)
          : null;

      if (activeCtx && activeCtx === item.contextId) {
        if (nowMs - updatedAtMs <= ACTIVE_PRESENCE_FRESHNESS_MS || lastReadAtMs >= item.createdAtMs) {
          return true;
        }
      }
    }
  } catch {
    // Continue to notification read check
  }

  // 2. Check linked notification document read state
  if (item.notificationId) {
    try {
      const notifSnap = await db.collection("notifications").doc(item.notificationId).get();
      const notifExists =
        notifSnap &&
        (typeof notifSnap.exists === "function" ? notifSnap.exists() : notifSnap.exists);
      if (notifExists) {
        const notif = typeof notifSnap.data === "function" ? notifSnap.data() : notifSnap.data;
        if (notif?.read === true || notif?.isRead === true) {
          return true;
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return false;
}

/**
 * Scheduled worker processing due items in `whatsapp_fallback_queue`.
 * Enforces: unread/presence cancellation -> opt-in & blocklist re-check -> 5-min cooldown -> Meta API send.
 */
export async function processWhatsAppFallbackQueue(
  db: any,
  options?: {
    nowMs?: number;
    batchLimit?: number;
    config?: MetaWhatsAppRuntimeConfig;
    fetchImpl?: typeof fetch;
  }
): Promise<{
  processed: number;
  sent: number;
  skippedRead: number;
  skippedCooldown: number;
  skippedUnconfigured: number;
  skippedOther: number;
  failed: number;
}> {
  const summary = {
    processed: 0,
    sent: 0,
    skippedRead: 0,
    skippedCooldown: 0,
    skippedUnconfigured: 0,
    skippedOther: 0,
    failed: 0,
  };
  if (!db) return summary;

  const nowMs = options?.nowMs ?? Date.now();
  const batchLimit = Math.min(50, Math.max(1, options?.batchLimit ?? 30));

  const snap = await db
    .collection("whatsapp_fallback_queue")
    .where("status", "==", "pending")
    .limit(batchLimit)
    .get();

  const docs = snap?.docs || [];
  for (const d of docs) {
    const item = typeof d.data === "function" ? d.data() : d.data;
    if (!item || (typeof item.scheduledForMs === "number" && item.scheduledForMs > nowMs)) {
      continue;
    }

    summary.processed++;
    const queueRef = db.collection("whatsapp_fallback_queue").doc(d.id);

    // 1. Cancel if recipient already read or is actively viewing this conversation
    const alreadyRead = await isRecipientActiveOrAlreadyRead(db, item, nowMs);
    if (alreadyRead) {
      await queueRef.set(
        { status: "skipped_read", processedAtMs: nowMs, updatedAt: new Date(nowMs).toISOString() },
        { merge: true }
      );
      summary.skippedRead++;
      continue;
    }

    // 2. Re-verify blocklist and current opt-in preference
    if (item.senderUid && (await hasActiveUserBlock(db, item.senderUid, item.recipientUid))) {
      await queueRef.set(
        { status: "skipped_blocked", processedAtMs: nowMs, updatedAt: new Date(nowMs).toISOString() },
        { merge: true }
      );
      summary.skippedOther++;
      continue;
    }

    const userSnap = await db.collection("users").doc(item.recipientUid).get();
    const userExists =
      userSnap && (typeof userSnap.exists === "function" ? userSnap.exists() : userSnap.exists);
    const userData = userExists
      ? typeof userSnap.data === "function"
        ? userSnap.data()
        : userSnap.data
      : null;

    const toE164 = normalizeUkPhoneToE164(
      userData?.whatsappPhoneE164 || userData?.phone || userData?.phoneNumber
    );
    if (userData?.whatsappOptIn !== true || !toE164) {
      await queueRef.set(
        { status: "skipped_no_opt_in", processedAtMs: nowMs, updatedAt: new Date(nowMs).toISOString() },
        { merge: true }
      );
      summary.skippedOther++;
      continue;
    }

    // 3. Enforce atomic 5-minute cooldown + daily cap
    const cooldownResult = await claimWhatsAppCooldownSlot(db, item.recipientUid, item.contextId, {
      nowMs,
    });
    if (!cooldownResult.allowed) {
      const nextStatus =
        cooldownResult.reason === "daily_cap_reached" ? "skipped_daily_cap" : "skipped_cooldown";
      await queueRef.set(
        {
          status: nextStatus,
          retryAfterMs: cooldownResult.retryAfterMs || 0,
          processedAtMs: nowMs,
          updatedAt: new Date(nowMs).toISOString(),
        },
        { merge: true }
      );
      summary.skippedCooldown++;
      continue;
    }

    // 4. Dispatch via Direct Meta WhatsApp Cloud API
    const windowExpiresAtMs =
      typeof userData?.whatsappWindowExpiresAtMs === "number"
        ? userData.whatsappWindowExpiresAtMs
        : null;

    const sendRes = await sendMetaWhatsAppMessage(
      db,
      {
        recipientUid: item.recipientUid,
        toE164,
        senderLabel: item.senderLabel || "AnyTrader",
        contextSummary: item.contextSummary || "You have a new unread message.",
        deepLinkPath: item.deepLinkPath || "/notifications",
        windowExpiresAtMs,
        nowMs,
      },
      {
        config: options?.config,
        fetchImpl: options?.fetchImpl,
      }
    );

    await queueRef.set(
      {
        status: sendRes.status,
        mode: sendRes.mode || null,
        metaMessageId: sendRes.metaMessageId || null,
        reason: sendRes.reason || null,
        processedAtMs: nowMs,
        updatedAt: new Date(nowMs).toISOString(),
      },
      { merge: true }
    );

    if (sendRes.status === "sent") {
      summary.sent++;
    } else if (sendRes.status === "skipped_unconfigured") {
      summary.skippedUnconfigured++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}

/**
 * Generates a single-use 15-minute WhatsApp activation code (`AT-XXXXXX`) and `wa.me` link
 * pointing strictly to the platform's official business number.
 */
export async function createWhatsAppActivationLink(
  db: any,
  caller: AuthenticatedNotificationCaller | null | undefined,
  options?: {
    contextLabel?: string;
    nowMs?: number;
    config?: MetaWhatsAppRuntimeConfig;
  }
): Promise<{
  activationCode: string;
  businessNumberConfigured: boolean;
  waMeUrl: string | null;
  prefilledMessage: string;
  expiresAt: string;
}> {
  if (!caller?.uid) {
    throw new UnauthorizedError("Authentication required.");
  }
  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const nowMs = options?.nowMs ?? Date.now();
  const cfg = options?.config ?? getMetaWhatsAppConfig();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[bytes[i] % alphabet.length];
  }
  const activationCode = `AT-${suffix}`;
  const expiresAtMs = nowMs + WHATSAPP_ACTIVATION_CODE_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();

  await db.collection("whatsapp_activation_codes").doc(activationCode).set({
    code: activationCode,
    uid: caller.uid,
    contextLabel: options?.contextLabel ? String(options.contextLabel).slice(0, 80) : null,
    used: false,
    createdAtMs: nowMs,
    expiresAtMs,
    expiresAt,
  });

  const cleanContext = options?.contextLabel
    ? ` for ${String(options.contextLabel).replace(/[\r\n]+/g, " ").slice(0, 50)}`
    : "";
  const prefilledMessage = `Enable AnyTrader WhatsApp alerts${cleanContext} (${activationCode})`;
  const waMeUrl = cfg.businessPhoneDigits
    ? `https://wa.me/${cfg.businessPhoneDigits}?text=${encodeURIComponent(prefilledMessage)}`
    : null;

  return {
    activationCode,
    businessNumberConfigured: Boolean(cfg.businessPhoneDigits),
    waMeUrl,
    prefilledMessage,
    expiresAt,
  };
}

/**
 * Loads authenticated user's own notification & WhatsApp preferences (never exposes other users' phones).
 */
export async function getUserNotificationPreferences(
  db: any,
  caller: AuthenticatedNotificationCaller | null | undefined,
  options?: { nowMs?: number; config?: MetaWhatsAppRuntimeConfig }
) {
  if (!caller?.uid) {
    throw new UnauthorizedError("Authentication required.");
  }
  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const nowMs = options?.nowMs ?? Date.now();
  const cfg = options?.config ?? getMetaWhatsAppConfig();
  const userSnap = await db.collection("users").doc(caller.uid).get();
  const exists =
    userSnap && (typeof userSnap.exists === "function" ? userSnap.exists() : userSnap.exists);
  const data = exists ? (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) : {};

  let activePushDevicesCount = 0;
  try {
    const devSnap = await db
      .collection("users")
      .doc(caller.uid)
      .collection("push_devices")
      .where("active", "==", true)
      .limit(25)
      .get();
    activePushDevicesCount = devSnap?.docs?.length || 0;
  } catch {
    activePushDevicesCount = data?.fcmToken ? 1 : 0;
  }

  const rawPhone = normalizeUkPhoneToE164(
    data?.whatsappPhoneE164 || data?.phone || data?.phoneNumber
  );
  const windowExpiresAtMs =
    typeof data?.whatsappWindowExpiresAtMs === "number" ? data.whatsappWindowExpiresAtMs : null;

  return {
    whatsappOptIn: data?.whatsappOptIn === true,
    whatsappPhoneMasked: maskPhoneNumber(rawPhone),
    whatsappHasPhone: Boolean(rawPhone),
    whatsappVerified: Boolean(data?.whatsappVerifiedAt),
    whatsappWindowActive: Boolean(windowExpiresAtMs && windowExpiresAtMs > nowMs),
    whatsappWindowExpiresAt: windowExpiresAtMs ? new Date(windowExpiresAtMs).toISOString() : null,
    emailNotifications: data?.emailNotifications !== false,
    pushNotifications: data?.pushNotifications !== false,
    activePushDevicesCount,
    businessWhatsAppConfigured: Boolean(cfg.businessPhoneDigits),
    metaApiConfigured: Boolean(cfg.accessToken && cfg.phoneNumberId),
  };
}

/**
 * Updates authenticated caller's own notification & WhatsApp preferences safely.
 * Note: `whatsappVerifiedAt` and `whatsappWindowExpiresAtMs` can ONLY be stamped by the Meta webhook.
 */
export async function updateUserNotificationPreferences(
  db: any,
  caller: AuthenticatedNotificationCaller | null | undefined,
  body: {
    whatsappOptIn?: boolean;
    whatsappPhone?: string | null;
    emailNotifications?: boolean;
    pushNotifications?: boolean;
  }
) {
  if (!caller?.uid) {
    throw new UnauthorizedError("Authentication required.");
  }
  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const patch: Record<string, any> = {
    updatedAt: new Date().toISOString(),
  };

  if (typeof body.whatsappPhone === "string" && body.whatsappPhone.trim().length > 0) {
    const normalized = normalizeUkPhoneToE164(body.whatsappPhone);
    if (!normalized) {
      throw new BadRequestError(
        "Please enter a valid UK mobile number (e.g. 07700 900123 or +447700900123)."
      );
    }
    patch.whatsappPhoneE164 = normalized;
    patch.phone = normalized;
  } else if (body.whatsappPhone === null) {
    patch.whatsappPhoneE164 = null;
  }

  if (typeof body.whatsappOptIn === "boolean") {
    if (body.whatsappOptIn) {
      // Ensure user either provided a valid phone in this request or already has one saved
      if (!patch.whatsappPhoneE164) {
        const snap = await db.collection("users").doc(caller.uid).get();
        const existing = snap?.exists ? (typeof snap.data === "function" ? snap.data() : snap.data) : {};
        const existingNormalized = normalizeUkPhoneToE164(
          existing?.whatsappPhoneE164 || existing?.phone || existing?.phoneNumber
        );
        if (!existingNormalized) {
          throw new BadRequestError(
            "A valid mobile phone number is required before enabling WhatsApp alerts."
          );
        }
        patch.whatsappPhoneE164 = existingNormalized;
      }
      patch.whatsappOptIn = true;
      patch.whatsappOptInUpdatedAt = new Date().toISOString();
    } else {
      patch.whatsappOptIn = false;
      patch.whatsappOptOutAt = new Date().toISOString();
    }
  }

  if (typeof body.emailNotifications === "boolean") {
    patch.emailNotifications = body.emailNotifications;
  }
  if (typeof body.pushNotifications === "boolean") {
    patch.pushNotifications = body.pushNotifications;
  }

  await db.collection("users").doc(caller.uid).set(patch, { merge: true });
  return getUserNotificationPreferences(db, caller);
}

/**
 * Records authenticated user's active conversation presence so pending 45s WhatsApp nudges self-cancel.
 */
export async function recordUserChatPresence(
  db: any,
  caller: AuthenticatedNotificationCaller | null | undefined,
  body: {
    activeConversationId?: string | null;
    markRead?: boolean;
  },
  nowMs: number = Date.now()
): Promise<{ success: boolean; activeConversationId: string | null }> {
  if (!caller?.uid) {
    throw new UnauthorizedError("Authentication required.");
  }
  if (!db) {
    throw new BadRequestError("Database unavailable.");
  }

  const activeConversationId =
    typeof body?.activeConversationId === "string" && body.activeConversationId.trim()
      ? sanitizeContextId(body.activeConversationId)
      : null;

  const patch: Record<string, any> = {
    uid: caller.uid,
    activeConversationId,
    updatedAtMs: nowMs,
    updatedAt: new Date(nowMs).toISOString(),
  };

  if (body?.markRead === true) {
    patch.lastReadAtMs = nowMs;
  }

  await db.collection("user_presence").doc(caller.uid).set(patch, { merge: true });

  // Also immediately cancel any pending fallback job for this active conversation
  if (activeConversationId) {
    try {
      const queueRef = db
        .collection("whatsapp_fallback_queue")
        .doc(`${caller.uid}_${activeConversationId}`);
      const qSnap = await queueRef.get();
      const qExists = qSnap && (typeof qSnap.exists === "function" ? qSnap.exists() : qSnap.exists);
      if (qExists) {
        const qData = typeof qSnap.data === "function" ? qSnap.data() : qSnap.data;
        if (qData?.status === "pending") {
          await queueRef.set(
            {
              status: "skipped_read",
              processedAtMs: nowMs,
              updatedAt: new Date(nowMs).toISOString(),
            },
            { merge: true }
          );
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return { success: true, activeConversationId };
}

/**
 * Handles signed inbound Meta WhatsApp Cloud API webhook events:
 * - Instant `STOP` / `UNSUBSCRIBE` UK GDPR opt-out
 * - `AT-XXXXXX` 1-tap activation verification + 24-hour customer service window stamping
 * - Refreshes 24-hour service window for known users who message the official business number
 */
export async function handleMetaWhatsAppWebhook(
  db: any,
  payload: any,
  deps?: {
    nowMs?: number;
    config?: MetaWhatsAppRuntimeConfig;
    fetchImpl?: typeof fetch;
  }
): Promise<{
  processedMessages: number;
  activatedUsers: string[];
  optedOutUsers: string[];
  refreshedWindows: string[];
}> {
  const nowMs = deps?.nowMs ?? Date.now();
  const cfg = deps?.config ?? getMetaWhatsAppConfig();
  const result = {
    processedMessages: 0,
    activatedUsers: [] as string[],
    optedOutUsers: [] as string[],
    refreshedWindows: [] as string[],
  };

  if (!db || !payload || typeof payload !== "object") {
    return result;
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
      for (const msg of messages) {
        const fromE164 = normalizeUkPhoneToE164(msg?.from ? `+${String(msg.from).replace(/^\+/, "")}` : "");
        const textBody = String(msg?.text?.body || msg?.button?.text || "").trim();
        if (!fromE164 || !textBody) continue;

        result.processedMessages++;
        const upperText = textBody.toUpperCase();
        const windowExpiresAtMs = nowMs + WHATSAPP_SERVICE_WINDOW_MS;

        // 1. Instant STOP / UNSUBSCRIBE opt-out compliance
        if (/^(STOP|UNSUBSCRIBE|OPT\s*OUT|CANCEL\s*ALERTS?)\b/i.test(upperText)) {
          const usersSnap = await db
            .collection("users")
            .where("whatsappPhoneE164", "==", fromE164)
            .limit(10)
            .get();

          for (const uDoc of usersSnap?.docs || []) {
            await db.collection("users").doc(uDoc.id).set(
              {
                whatsappOptIn: false,
                whatsappOptOutAt: new Date(nowMs).toISOString(),
                updatedAt: new Date(nowMs).toISOString(),
              },
              { merge: true }
            );
            result.optedOutUsers.push(uDoc.id);
          }

          await sendMetaWhatsAppMessage(
            db,
            {
              recipientUid: result.optedOutUsers[0] || "unknown",
              toE164: fromE164,
              senderLabel: "AnyTrader UK",
              contextSummary: "WhatsApp alerts paused",
              deepLinkPath: "/profile",
              windowExpiresAtMs,
              customText:
                "AnyTrader UK: You have been unsubscribed from WhatsApp alerts. You can re-enable them anytime in your AnyTrader account settings.",
              nowMs,
            },
            { config: cfg, fetchImpl: deps?.fetchImpl }
          );
          continue;
        }

        // 2. Check for 1-tap activation code `AT-XXXXXX`
        const codeMatch = upperText.match(/\b(AT-[A-Z0-9]{6})\b/);
        if (codeMatch) {
          const code = codeMatch[1];
          const codeRef = db.collection("whatsapp_activation_codes").doc(code);
          const codeSnap = await codeRef.get();
          const codeExists =
            codeSnap && (typeof codeSnap.exists === "function" ? codeSnap.exists() : codeSnap.exists);

          if (codeExists) {
            const codeData =
              typeof codeSnap.data === "function" ? codeSnap.data() : codeSnap.data;
            const notExpired =
              typeof codeData?.expiresAtMs === "number" && codeData.expiresAtMs >= nowMs;
            if (codeData?.uid && codeData.used !== true && notExpired) {
              await db.collection("users").doc(codeData.uid).set(
                {
                  whatsappOptIn: true,
                  whatsappPhoneE164: fromE164,
                  whatsappVerifiedAt: new Date(nowMs).toISOString(),
                  whatsappWindowExpiresAtMs: windowExpiresAtMs,
                  whatsappWindowExpiresAt: new Date(windowExpiresAtMs).toISOString(),
                  updatedAt: new Date(nowMs).toISOString(),
                },
                { merge: true }
              );

              await codeRef.set(
                {
                  used: true,
                  usedAt: new Date(nowMs).toISOString(),
                  verifiedPhoneE164: fromE164,
                },
                { merge: true }
              );

              result.activatedUsers.push(codeData.uid);

              await sendMetaWhatsAppMessage(
                db,
                {
                  recipientUid: codeData.uid,
                  toE164: fromE164,
                  senderLabel: "AnyTrader UK",
                  contextSummary: "WhatsApp alerts enabled",
                  deepLinkPath: "/notifications",
                  windowExpiresAtMs,
                  customText:
                    "AnyTrader UK: WhatsApp offline alerts are now active! We will only message you if you miss a quote or chat reply (max 1 alert per 5 mins). Reply STOP anytime to opt out.",
                  nowMs,
                },
                { config: cfg, fetchImpl: deps?.fetchImpl }
              );
              continue;
            }
          }
        }

        // 3. General inbound message from an already-registered user -> refresh 24h service window + 1-way reminder
        const matchedUsers = await db
          .collection("users")
          .where("whatsappPhoneE164", "==", fromE164)
          .limit(5)
          .get();

        for (const uDoc of matchedUsers?.docs || []) {
          await db.collection("users").doc(uDoc.id).set(
            {
              whatsappWindowExpiresAtMs: windowExpiresAtMs,
              whatsappWindowExpiresAt: new Date(windowExpiresAtMs).toISOString(),
              updatedAt: new Date(nowMs).toISOString(),
            },
            { merge: true }
          );
          result.refreshedWindows.push(uDoc.id);
        }

        if (result.refreshedWindows.length > 0) {
          await sendMetaWhatsAppMessage(
            db,
            {
              recipientUid: result.refreshedWindows[0],
              toE164: fromE164,
              senderLabel: "AnyTrader UK",
              contextSummary: "Reply in AnyTrader",
              deepLinkPath: "/messages",
              windowExpiresAtMs,
              customText: `AnyTrader UK: This WhatsApp line sends alerts only so your phone number stays private. Please reply directly in AnyTrader: ${cfg.appBaseUrl}/messages (Reply STOP to pause alerts).`,
              nowMs,
            },
            { config: cfg, fetchImpl: deps?.fetchImpl }
          );
        }
      }
    }
  }

  return result;
}
