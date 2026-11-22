import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WHATSAPP_CHAT_UNREAD_DELAY_MS,
  WHATSAPP_COOLDOWN_MS,
  WHATSAPP_SERVICE_WINDOW_MS,
  claimWhatsAppCooldownSlot,
  createWhatsAppActivationLink,
  enqueueWhatsAppFallback,
  getUserNotificationPreferences,
  handleMetaWhatsAppWebhook,
  maskPhoneNumber,
  normalizeUkPhoneToE164,
  processWhatsAppFallbackQueue,
  recordUserChatPresence,
  sendMetaWhatsAppMessage,
  updateUserNotificationPreferences,
  verifyMetaWebhookSignature,
  type MetaWhatsAppRuntimeConfig,
} from "../../src/server/whatsappNotificationEngine";

/**
 * Lightweight deterministic in-memory Firestore mock supporting collections,
 * nested subcollections, `.where("field", "==", value)`, `.limit()`, `.add()`,
 * and atomic `.runTransaction()`.
 */
function createMockFirestore(initialData: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Map<string, any>>();

  const ensureCollection = (colPath: string) => {
    let col = store.get(colPath);
    if (!col) {
      col = new Map<string, any>();
      store.set(colPath, col);
    }
    return col;
  };

  for (const [colPath, docs] of Object.entries(initialData)) {
    const col = ensureCollection(colPath);
    for (const [id, data] of Object.entries(docs)) {
      col.set(id, { ...data });
    }
  }

  let autoIdSeq = 1;

  const makeDocRef = (colPath: string, id: string): any => ({
    id,
    path: `${colPath}/${id}`,
    get: async () => {
      const data = ensureCollection(colPath).get(id);
      return {
        id,
        exists: data !== undefined,
        data: () => (data !== undefined ? { ...data } : undefined),
      };
    },
    set: async (data: Record<string, any>, opts?: { merge?: boolean }) => {
      const col = ensureCollection(colPath);
      const prev = opts?.merge ? col.get(id) || {} : {};
      col.set(id, { ...prev, ...data });
    },
    collection: (sub: string) => makeCollectionRef(`${colPath}/${id}/${sub}`),
  });

  const makeQuery = (
    colPath: string,
    filters: Array<{ field: string; op: string; value: any }> = [],
    maxCount?: number
  ): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(colPath, [...filters, { field, op, value }], maxCount),
    limit: (n: number) => makeQuery(colPath, filters, n),
    get: async () => {
      const col = ensureCollection(colPath);
      let entries = Array.from(col.entries()).filter(([, docData]) =>
        filters.every((f) => {
          if (f.op === "==") return docData?.[f.field] === f.value;
          return true;
        })
      );
      if (typeof maxCount === "number") {
        entries = entries.slice(0, maxCount);
      }
      const docs = entries.map(([id, data]) => ({
        id,
        exists: true,
        data: () => ({ ...data }),
      }));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });

  const makeCollectionRef = (colPath: string): any => ({
    doc: (id: string) => makeDocRef(colPath, id),
    add: async (data: Record<string, any>) => {
      const id = `auto_${autoIdSeq++}`;
      ensureCollection(colPath).set(id, { ...data });
      return makeDocRef(colPath, id);
    },
    where: (field: string, op: string, value: any) =>
      makeQuery(colPath, [{ field, op, value }]),
    limit: (n: number) => makeQuery(colPath, [], n),
    get: async () => makeQuery(colPath).get(),
  });

  const db: any = {
    collection: (colPath: string) => makeCollectionRef(colPath),
    runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      };
      return fn(tx);
    },
    _dump: (colPath: string) => Object.fromEntries(ensureCollection(colPath).entries()),
  };

  return db;
}

const TEST_META_CONFIG: MetaWhatsAppRuntimeConfig = {
  accessToken: "EAAG_test_token_123",
  phoneNumberId: "109988776655",
  appSecret: "meta_app_secret_xyz",
  verifyToken: "verify_token_abc",
  businessPhoneDisplay: "+447700900001",
  businessPhoneDigits: "447700900001",
  graphVersion: "v21.0",
  utilityTemplateName: "anytrader_offline_alert",
  utilityTemplateLang: "en_GB",
  appBaseUrl: "https://anytrader.co.uk",
};

const UNCONFIGURED_META_CONFIG: MetaWhatsAppRuntimeConfig = {
  ...TEST_META_CONFIG,
  accessToken: null,
  phoneNumberId: null,
  businessPhoneDisplay: null,
  businessPhoneDigits: null,
};

describe("Hybrid Messaging & 4-Tier Notification Waterfall Engine", () => {
  it("normalizes valid UK/E.164 phone numbers and masks them without exposing digits", () => {
    expect(normalizeUkPhoneToE164("07700 900123")).toBe("+447700900123");
    expect(normalizeUkPhoneToE164("+44 (7700) 900-123")).toBe("+447700900123");
    expect(normalizeUkPhoneToE164("447700900123")).toBe("+447700900123");
    expect(normalizeUkPhoneToE164("00447700900123")).toBe("+447700900123");
    expect(normalizeUkPhoneToE164("invalid-phone")).toBeNull();
    expect(normalizeUkPhoneToE164("12345")).toBeNull();
    expect(maskPhoneNumber("+447700900123")).toBe("+44•••••0123");
  });

  it("verifies Meta X-Hub-Signature-256 HMAC-SHA256 strictly in timing-safe mode", () => {
    const rawBody = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }), "utf8");
    const validSig =
      "sha256=" +
      crypto.createHmac("sha256", TEST_META_CONFIG.appSecret!).update(rawBody).digest("hex");

    expect(verifyMetaWebhookSignature(rawBody, validSig, TEST_META_CONFIG.appSecret)).toBe(true);
    expect(
      verifyMetaWebhookSignature(
        Buffer.from('{"object":"tampered"}', "utf8"),
        validSig,
        TEST_META_CONFIG.appSecret
      )
    ).toBe(false);
    expect(verifyMetaWebhookSignature(rawBody, "sha256=deadbeef", TEST_META_CONFIG.appSecret)).toBe(
      false
    );
    expect(verifyMetaWebhookSignature(rawBody, validSig, null)).toBe(false);
    expect(verifyMetaWebhookSignature(rawBody, undefined, TEST_META_CONFIG.appSecret)).toBe(false);
  });

  it("activates 1-tap AT-XXXXXX opt-in via webhook, opens 24h window, and blocks single-use replay", async () => {
    const nowMs = 1_760_000_000_000;
    const db = createMockFirestore({
      users: {
        user_homeowner: { name: "Alex Homeowner" },
      },
    });

    const linkRes = await createWhatsAppActivationLink(
      db,
      { uid: "user_homeowner" },
      { contextLabel: "Boiler Repair", nowMs, config: TEST_META_CONFIG }
    );

    expect(linkRes.activationCode).toMatch(/^AT-[A-Z0-9]{6}$/);
    expect(linkRes.businessNumberConfigured).toBe(true);
    expect(linkRes.waMeUrl).toContain("https://wa.me/447700900001?text=");
    expect(linkRes.prefilledMessage).toContain(linkRes.activationCode);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.confirm1" }] }),
    });

    const inboundPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447700900555",
                    text: { body: linkRes.prefilledMessage },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const firstResult = await handleMetaWhatsAppWebhook(db, inboundPayload, {
      nowMs: nowMs + 5_000,
      config: TEST_META_CONFIG,
      fetchImpl: fetchMock as any,
    });

    expect(firstResult.activatedUsers).toEqual(["user_homeowner"]);
    const userDoc = db._dump("users").user_homeowner;
    expect(userDoc.whatsappOptIn).toBe(true);
    expect(userDoc.whatsappPhoneE164).toBe("+447700900555");
    expect(userDoc.whatsappVerifiedAt).toBeTruthy();
    expect(userDoc.whatsappWindowExpiresAtMs).toBe(nowMs + 5_000 + WHATSAPP_SERVICE_WINDOW_MS);

    // Replay of the exact same AT-XXXXXX code must NOT re-activate another user or re-use code
    const codeDoc = db._dump("whatsapp_activation_codes")[linkRes.activationCode];
    expect(codeDoc.used).toBe(true);

    const replayResult = await handleMetaWhatsAppWebhook(db, inboundPayload, {
      nowMs: nowMs + 10_000,
      config: TEST_META_CONFIG,
      fetchImpl: fetchMock as any,
    });
    expect(replayResult.activatedUsers).toEqual([]);
  });

  it("processes instant STOP opt-out via Meta webhook for UK GDPR compliance", async () => {
    const nowMs = 1_760_000_000_000;
    const db = createMockFirestore({
      users: {
        user_trader: {
          whatsappOptIn: true,
          whatsappPhoneE164: "+447700900777",
        },
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.stop1" }] }),
    });

    const res = await handleMetaWhatsAppWebhook(
      db,
      {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ from: "447700900777", text: { body: "STOP" } }],
                },
              },
            ],
          },
        ],
      },
      { nowMs, config: TEST_META_CONFIG, fetchImpl: fetchMock as any }
    );

    expect(res.optedOutUsers).toEqual(["user_trader"]);
    expect(db._dump("users").user_trader.whatsappOptIn).toBe(false);
    expect(db._dump("users").user_trader.whatsappOptOutAt).toBeTruthy();
  });

  it("enforces atomic 5-minute per-conversation cooldown and daily per-user cap", async () => {
    const t0 = 1_760_000_000_000;
    const db = createMockFirestore();

    const first = await claimWhatsAppCooldownSlot(db, "u1", "conv_123", {
      nowMs: t0,
      dailyCap: 2,
    });
    expect(first.allowed).toBe(true);

    // Within 5 minutes for same conversation -> blocked by cooldown
    const second = await claimWhatsAppCooldownSlot(db, "u1", "conv_123", {
      nowMs: t0 + 60_000,
      dailyCap: 2,
    });
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("cooldown_active");

    // Different conversation still allowed until daily cap reached
    const otherConv = await claimWhatsAppCooldownSlot(db, "u1", "conv_999", {
      nowMs: t0 + 60_000,
      dailyCap: 2,
    });
    expect(otherConv.allowed).toBe(true);

    // After 5 minutes on conv_123, daily cap (2) is now exhausted -> blocked by daily cap
    const afterCooldown = await claimWhatsAppCooldownSlot(db, "u1", "conv_123", {
      nowMs: t0 + WHATSAPP_COOLDOWN_MS + 1_000,
      dailyCap: 2,
    });
    expect(afterCooldown.allowed).toBe(false);
    expect(afterCooldown.reason).toBe("daily_cap_reached");
  });

  it("cancels delayed WhatsApp fallback when user has active chat presence or read notification, and skips blocked senders", async () => {
    const t0 = 1_760_000_000_000;
    const db = createMockFirestore({
      users: {
        u_active: { whatsappOptIn: true, whatsappPhoneE164: "+447700900111" },
        u_read: { whatsappOptIn: true, whatsappPhoneE164: "+447700900222" },
        u_blocked: { whatsappOptIn: true, whatsappPhoneE164: "+447700900333" },
      },
      notifications: {
        notif_read_1: { userId: "u_read", read: true },
      },
      chat_user_blocks: {
        u_blocked__sender_bad: { blockerUid: "u_blocked", blockedUid: "sender_bad", active: true },
      },
    });

    // 1. Enqueue for active user, then record active presence heartbeat
    const q1 = await enqueueWhatsAppFallback(db, {
      recipientUid: "u_active",
      senderUid: "sender_ok",
      senderLabel: "Sam Plumber",
      contextId: "conv_active",
      contextType: "anytrader_chat",
      contextSummary: "Are you home?",
      deepLinkPath: "/chat/conv_active",
      nowMs: t0,
    });
    expect(q1.queued).toBe(true);
    expect(q1.scheduledForMs).toBe(t0 + WHATSAPP_CHAT_UNREAD_DELAY_MS);

    await recordUserChatPresence(
      db,
      { uid: "u_active" },
      { activeConversationId: "conv_active", markRead: true },
      t0 + 10_000
    );
    expect(db._dump("whatsapp_fallback_queue")["u_active_conv_active"].status).toBe("skipped_read");

    // 2. Enqueue for user who already read the notification
    await enqueueWhatsAppFallback(db, {
      recipientUid: "u_read",
      senderUid: "sender_ok",
      senderLabel: "Sam Plumber",
      contextId: "conv_read",
      contextType: "anytrader_chat",
      contextSummary: "Quote sent",
      deepLinkPath: "/chat/conv_read",
      notificationId: "notif_read_1",
      nowMs: t0,
    });

    // 3. Blocked sender is rejected immediately at enqueue time
    const qBlocked = await enqueueWhatsAppFallback(db, {
      recipientUid: "u_blocked",
      senderUid: "sender_bad",
      senderLabel: "Blocked User",
      contextId: "conv_blocked",
      contextType: "anytrader_chat",
      contextSummary: "Spam",
      deepLinkPath: "/chat/conv_blocked",
      nowMs: t0,
    });
    expect(qBlocked.queued).toBe(false);
    expect(qBlocked.reason).toBe("blocked_participant");

    const fetchMock = vi.fn();
    const summary = await processWhatsAppFallbackQueue(db, {
      nowMs: t0 + WHATSAPP_CHAT_UNREAD_DELAY_MS + 5_000,
      config: TEST_META_CONFIG,
      fetchImpl: fetchMock as any,
    });

    expect(summary.sent).toBe(0);
    expect(summary.skippedRead).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects free-form service_window inside 24h window, utility_template outside, and returns honest skipped_unconfigured when credentials are missing", async () => {
    const t0 = 1_760_000_000_000;
    const db = createMockFirestore({
      users: {
        u_in_window: {
          whatsappOptIn: true,
          whatsappPhoneE164: "+447700900444",
          whatsappWindowExpiresAtMs: t0 + 3_600_000,
        },
        u_out_window: {
          whatsappOptIn: true,
          whatsappPhoneE164: "+447700900888",
          whatsappWindowExpiresAtMs: t0 - 1_000,
        },
      },
    });

    const sentPayloads: any[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: any) => {
      sentPayloads.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: `wamid.${sentPayloads.length}` }] }),
      };
    });

    await enqueueWhatsAppFallback(db, {
      recipientUid: "u_in_window",
      senderUid: "trader_1",
      senderLabel: "Dave Electrician",
      contextId: "conv_w1",
      contextType: "anytrader_chat",
      contextSummary: "On my way at 10am",
      deepLinkPath: "/chat/conv_w1",
      nowMs: t0,
    });
    await enqueueWhatsAppFallback(db, {
      recipientUid: "u_out_window",
      senderUid: "trader_1",
      senderLabel: "Dave Electrician",
      contextId: "conv_w2",
      contextType: "anytrader_quote",
      contextSummary: "New quote £240",
      deepLinkPath: "/job/job_42",
      nowMs: t0,
    });

    const summary = await processWhatsAppFallbackQueue(db, {
      nowMs: t0 + WHATSAPP_CHAT_UNREAD_DELAY_MS + 1_000,
      config: TEST_META_CONFIG,
      fetchImpl: fetchMock as any,
    });

    expect(summary.sent).toBe(2);
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[0].type).toBe("text");
    expect(sentPayloads[0].text.body).toContain("https://anytrader.co.uk/chat/conv_w1");
    expect(sentPayloads[1].type).toBe("template");
    expect(sentPayloads[1].template.name).toBe("anytrader_offline_alert");

    // Unconfigured credentials fail honestly without network call
    const unconfRes = await sendMetaWhatsAppMessage(
      db,
      {
        recipientUid: "u_in_window",
        toE164: "+447700900444",
        senderLabel: "AnyTrader",
        contextSummary: "Test",
        deepLinkPath: "/notifications",
        nowMs: t0,
      },
      { config: UNCONFIGURED_META_CONFIG, fetchImpl: fetchMock as any }
    );
    expect(unconfRes.sent).toBe(false);
    expect(unconfRes.status).toBe("skipped_unconfigured");
  });

  it("never exposes raw phone numbers in preferences API and blocks client verification spoofing", async () => {
    const db = createMockFirestore({
      users: {
        u_self: {
          whatsappOptIn: false,
          phone: "07700 900123",
        },
        u_other: {
          whatsappOptIn: true,
          whatsappPhoneE164: "+447700900999",
        },
      },
    });

    const updated = await updateUserNotificationPreferences(
      db,
      { uid: "u_self" },
      { whatsappPhone: "07700 900123", whatsappOptIn: true }
    );

    expect(updated.whatsappOptIn).toBe(true);
    expect(updated.whatsappPhoneMasked).toBe("+44•••••0123");
    expect(JSON.stringify(updated)).not.toContain("+447700900123");
    expect(JSON.stringify(updated)).not.toContain("+447700900999");
    expect(updated.whatsappVerified).toBe(false);
    expect(updated.whatsappWindowActive).toBe(false);

    const selfPrefs = await getUserNotificationPreferences(
      db,
      { uid: "u_self" },
      { config: TEST_META_CONFIG }
    );
    expect(selfPrefs.whatsappPhoneMasked).toBe("+44•••••0123");
  });
});
