import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  registerAuthoritativePushToken,
  unregisterAuthoritativePushToken,
  dispatchAuthoritativeFcmPush,
  sendAuthoritativeChatPush,
  hashPushToken,
} from "../../src/server/notificationEngine";
import {
  resolveGoogleMapsApiKey,
  isValidGoogleMapsApiKey,
} from "../../src/lib/capacitor";
import {
  buildAndroidAssetLinksPayload,
  buildAppleAppSiteAssociationPayload,
  isValidAndroidSha256Fingerprint,
  isValidAppleTeamId,
} from "../../src/server/mobileDeepLinks";
import {
  PRODUCTION_FIRESTORE_DATABASE_ID,
  loadVerifiedProductionDatabaseId,
  buildNamedDbEmulatorConfig,
} from "./helpers/namedDbEmulator";

function createSubcollectionDb(seed: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [colPath, docs] of Object.entries(seed)) {
    store[colPath] = {};
    for (const [docId, docData] of Object.entries(docs)) {
      store[colPath][docId] = { ...docData };
    }
  }

  function makeCollection(colPath: string) {
    if (!store[colPath]) store[colPath] = {};
    const makeQuery = (filters: Array<{ field: string; value: any }> = []) => ({
      where(field: string, _op: string, value: any) {
        return makeQuery([...filters, { field, value }]);
      },
      limit(_n: number) {
        return makeQuery(filters);
      },
      async get() {
        const docs = Object.entries(store[colPath] || {})
          .filter(([, d]) => filters.every((f) => d?.[f.field] === f.value))
          .map(([id, d]) => ({
            id,
            exists: true,
            data: () => ({ ...d }),
          }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    });

    return {
      doc(docId: string) {
        return {
          collection(subName: string) {
            return makeCollection(`${colPath}/${docId}/${subName}`);
          },
          async get() {
            const data = store[colPath]?.[docId];
            return {
              id: docId,
              exists: data !== undefined,
              data: () => (data !== undefined ? { ...data } : undefined),
            };
          },
          async set(payload: any, opts?: { merge?: boolean }) {
            if (!store[colPath]) store[colPath] = {};
            if (opts?.merge && store[colPath][docId]) {
              store[colPath][docId] = { ...store[colPath][docId], ...payload };
            } else {
              store[colPath][docId] = { ...payload };
            }
          },
          async update(payload: any) {
            if (!store[colPath]?.[docId]) throw new Error("Not found");
            store[colPath][docId] = { ...store[colPath][docId], ...payload };
          },
          async delete() {
            if (store[colPath]) delete store[colPath][docId];
          },
        };
      },
      where(field: string, _op: string, value: any) {
        return makeQuery([{ field, value }]);
      },
    };
  }

  return {
    store,
    collection: makeCollection,
  };
}

describe("Batch 16 — Native Push, Mobile Config, Database Indexes & Emulator Parity", () => {
  describe("AT-CJ-NOTIF-05: Per-installation push tokens, ownership validation & unregistration", () => {
    it("stores push tokens per deviceId under users/{uid}/push_devices, revokes prior owner on account switch, and unregisters cleanly", async () => {
      const db = createSubcollectionDb({
        users: {
          user_a: { uid: "user_a" },
          user_b: { uid: "user_b" },
        },
      });

      const sharedPhysicalToken = "fcm_physical_device_token_abc123456789";

      const regA = await registerAuthoritativePushToken(
        db,
        { uid: "user_a" },
        { token: sharedPhysicalToken, deviceId: "iphone-15-pro", platform: "ios" }
      );
      expect(regA.success).toBe(true);
      expect(regA.deviceId).toBe("iphone-15-pro");
      expect(regA.platform).toBe("ios");
      expect(db.store["users/user_a/push_devices"]["iphone-15-pro"].active).toBe(true);
      expect(db.store["push_device_index"][hashPushToken(sharedPhysicalToken)].uid).toBe("user_a");

      // Account switch on same device: user_b logs in and registers the same physical token
      const regB = await registerAuthoritativePushToken(
        db,
        { uid: "user_b" },
        { token: sharedPhysicalToken, deviceId: "iphone-15-pro", platform: "ios" }
      );
      expect(regB.success).toBe(true);
      // Prior user's device binding MUST be automatically revoked so user_a notifications never leak to user_b's phone
      expect(db.store["users/user_a/push_devices"]["iphone-15-pro"].active).toBe(false);
      expect(db.store["users/user_a/push_devices"]["iphone-15-pro"].revokedReason).toBe(
        "reassigned_to_another_account_on_device"
      );
      expect(db.store["users/user_b/push_devices"]["iphone-15-pro"].active).toBe(true);
      expect(db.store["push_device_index"][hashPushToken(sharedPhysicalToken)].uid).toBe("user_b");

      // Cross-user unregister attempt is strictly denied
      await expect(
        unregisterAuthoritativePushToken(
          db,
          { uid: "user_a" },
          { userId: "user_b", deviceId: "iphone-15-pro" }
        )
      ).rejects.toThrow("Cannot unregister push token for another user");

      // Owner unregisters on logout
      const unregB = await unregisterAuthoritativePushToken(
        db,
        { uid: "user_b" },
        { deviceId: "iphone-15-pro", token: sharedPhysicalToken }
      );
      expect(unregB.success).toBe(true);
      expect(unregB.unregisteredCount).toBeGreaterThanOrEqual(1);
      expect(db.store["users/user_b/push_devices"]["iphone-15-pro"].active).toBe(false);
      expect(db.store["push_device_index"][hashPushToken(sharedPhysicalToken)]).toBeUndefined();
      expect(db.store["users"]["user_b"].fcmToken).toBeNull();
    });

    it("wires logout push unregistration in firebase.ts and server rules in firestore.rules", () => {
      const firebaseSrc = fs.readFileSync(path.resolve("src/firebase.ts"), "utf8");
      const rulesSrc = fs.readFileSync(path.resolve("firestore.rules"), "utf8");
      const serverSrc = fs.readFileSync(path.resolve("server.ts"), "utf8");

      expect(firebaseSrc).toContain("unregisterCurrentDevicePushToken");
      expect(rulesSrc).toContain("match /push_devices/{deviceId}");
      expect(rulesSrc).toContain("match /push_delivery_receipts/{receiptId}");
      expect(rulesSrc).toContain("match /push_device_index/{tokenHash}");
      expect(serverSrc).toContain("/api/notifications/unregister-token");
      expect(serverSrc).toContain("/api/notifications/push-token/:deviceId");
    });
  });

  describe("AT-CJ-NOTIF-06: Real FCM multi-device dispatch behind strict config gate & delivery receipts", () => {
    it("fails closed with skipped_no_provider receipt when FCM messaging client is unconfigured", async () => {
      const db = createSubcollectionDb({
        users: {
          trader_1: { uid: "trader_1" },
        },
        "users/trader_1/push_devices": {
          "dev-ios": { uid: "trader_1", deviceId: "dev-ios", token: "tok_ios_111", active: true },
        },
      });

      const res = await dispatchAuthoritativeFcmPush(db, null, {
        recipientId: "trader_1",
        title: "New Job",
        body: "Boiler repair near SW1",
        eventType: "job_lead",
      });

      expect(res.success).toBe(false);
      expect(res.status).toBe("skipped_no_provider");
      expect(res.deliveredCount).toBe(0);
      expect(db.store["push_delivery_receipts"][res.receiptId].status).toBe("skipped_no_provider");
    });

    it("dispatches multicast to all active devices, logs delivery receipt, and prunes unregistered tokens", async () => {
      const db = createSubcollectionDb({
        users: {
          trader_2: { uid: "trader_2" },
        },
        "users/trader_2/push_devices": {
          "dev-phone": { uid: "trader_2", deviceId: "dev-phone", token: "tok_valid_phone", active: true },
          "dev-tablet": { uid: "trader_2", deviceId: "dev-tablet", token: "tok_stale_tablet", active: true },
          "dev-old": { uid: "trader_2", deviceId: "dev-old", token: "tok_inactive", active: false },
        },
      });

      const sendEachForMulticast = vi.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 1,
        responses: [
          { success: true, messageId: "projects/anytrader/messages/msg-1" },
          {
            success: false,
            error: {
              code: "messaging/registration-token-not-registered",
              message: "Requested entity was not found.",
            },
          },
        ],
      });

      const res = await dispatchAuthoritativeFcmPush(
        db,
        { sendEachForMulticast },
        {
          recipientId: "trader_2",
          title: "New Quote Accepted",
          body: "Your quote was accepted!",
          eventType: "quote_accepted",
          notificationId: "notif-777",
        }
      );

      expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
      const multicastPayload = sendEachForMulticast.mock.calls[0][0];
      expect(multicastPayload.tokens).toEqual(["tok_valid_phone", "tok_stale_tablet"]);
      expect(res.success).toBe(true);
      expect(res.status).toBe("partial");
      expect(res.deliveredCount).toBe(1);
      expect(res.failedCount).toBe(1);
      expect(res.prunedTokensCount).toBe(1);
      expect(res.messageIds).toEqual(["projects/anytrader/messages/msg-1"]);

      // Stale token deactivated automatically
      expect(db.store["users/trader_2/push_devices"]["dev-tablet"].active).toBe(false);
      expect(db.store["users/trader_2/push_devices"]["dev-phone"].active).toBe(true);

      // Delivery receipt logged durably
      const receipt = db.store["push_delivery_receipts"][res.receiptId];
      expect(receipt.status).toBe("partial");
      expect(receipt.notificationId).toBe("notif-777");
      expect(receipt.deliveredCount).toBe(1);
      expect(receipt.prunedTokensCount).toBe(1);
    });

    it("authorizes chat push via sendAuthoritativeChatPush and uses multicast client", async () => {
      const db = createSubcollectionDb({
        users: {
          homeowner_1: { uid: "homeowner_1" },
          trader_1: { uid: "trader_1" },
        },
        conversations: {
          conv_1: { participants: ["homeowner_1", "trader_1"] },
        },
        "users/trader_1/push_devices": {
          "dev-1": { uid: "trader_1", deviceId: "dev-1", token: "tok_chat_1", active: true },
        },
      });

      const mockFcm = {
        sendEachForMulticast: vi.fn().mockResolvedValue({
          successCount: 1,
          failureCount: 0,
          responses: [{ success: true, messageId: "msg-chat-1" }],
        }),
      };

      const res = await sendAuthoritativeChatPush(
        db,
        mockFcm,
        { uid: "homeowner_1" },
        {
          recipientId: "trader_1",
          conversationId: "conv_1",
          title: "New message",
          body: "Can you arrive at 10am?",
        }
      );

      expect(res.success).toBe(true);
      expect(res.messageId).toBe("msg-chat-1");
      expect(res.deliveredCount).toBe(1);
    });
  });

  describe("AT-MOBILE-02: Strict platform-specific Google Maps API key resolution", () => {
    const sampleEnv = {
      VITE_GOOGLE_MAPS_API_KEY: "AIzaSyWebRestrictedKey_1234567890",
      VITE_GOOGLE_MAPS_IOS_API_KEY: "AIzaSyIosRestrictedKey_1234567890",
      VITE_GOOGLE_MAPS_ANDROID_API_KEY: "AIzaSyAndroidRestricted_1234567890",
    };

    it("resolves exact platform key and refuses cross-platform fallback or placeholder values", () => {
      expect(resolveGoogleMapsApiKey("ios", sampleEnv)).toBe("AIzaSyIosRestrictedKey_1234567890");
      expect(resolveGoogleMapsApiKey("android", sampleEnv)).toBe("AIzaSyAndroidRestricted_1234567890");
      expect(resolveGoogleMapsApiKey("web", sampleEnv)).toBe("AIzaSyWebRestrictedKey_1234567890");

      // Missing iOS key MUST NOT silently fall back to web or android key
      expect(
        resolveGoogleMapsApiKey("ios", {
          VITE_GOOGLE_MAPS_API_KEY: sampleEnv.VITE_GOOGLE_MAPS_API_KEY,
          VITE_GOOGLE_MAPS_ANDROID_API_KEY: sampleEnv.VITE_GOOGLE_MAPS_ANDROID_API_KEY,
        })
      ).toBe("");

      // Missing Android key MUST NOT silently fall back to web or iOS key
      expect(
        resolveGoogleMapsApiKey("android", {
          VITE_GOOGLE_MAPS_API_KEY: sampleEnv.VITE_GOOGLE_MAPS_API_KEY,
          VITE_GOOGLE_MAPS_IOS_API_KEY: sampleEnv.VITE_GOOGLE_MAPS_IOS_API_KEY,
        })
      ).toBe("");

      // Placeholders rejected
      expect(isValidGoogleMapsApiKey("replace_with_restricted_ios_maps_api_key")).toBe(false);
      expect(isValidGoogleMapsApiKey("your_google_maps_key")).toBe(false);
      expect(isValidGoogleMapsApiKey("short")).toBe(false);
    });
  });

  describe("AT-MOBILE-03: Parameterized Android assetlinks & iOS AASA with placeholder rejection", () => {
    it("rejects synthetic placeholder signing values and missing config, accepts real production identities", () => {
      expect(
        isValidAndroidSha256Fingerprint(
          "10:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"
        )
      ).toBe(false);
      expect(isValidAppleTeamId("TEAMID1234")).toBe(false);
      expect(isValidAppleTeamId("0000000000")).toBe(false);

      expect(buildAndroidAssetLinksPayload({}).configured).toBe(false);
      expect(buildAppleAppSiteAssociationPayload({}).configured).toBe(false);

      const realSha256 =
        "3A:91:4F:C8:12:7B:E4:55:60:8D:A1:29:F0:33:BC:7E:44:9A:05:D2:68:1C:E9:74:B3:2F:81:56:C0:4A:9E:17";
      const androidRes = buildAndroidAssetLinksPayload({
        ANDROID_APP_PACKAGE: "com.anytrader.app",
        ANDROID_SHA256_CERT_FINGERPRINTS: realSha256,
      });
      expect(androidRes.configured).toBe(true);
      expect(androidRes.payload?.[0].target.package_name).toBe("com.anytrader.app");
      expect(androidRes.payload?.[0].target.sha256_cert_fingerprints).toEqual([realSha256]);

      const iosRes = buildAppleAppSiteAssociationPayload({
        IOS_TEAM_ID: "9K4M7P2Q8R",
        IOS_BUNDLE_ID: "com.anytrader.app",
      });
      expect(iosRes.configured).toBe(true);
      expect(iosRes.payload?.applinks.details[0].appID).toBe("9K4M7P2Q8R.com.anytrader.app");

      // Ensure static placeholder files in public/.well-known were removed
      expect(fs.existsSync(path.resolve("public/.well-known/assetlinks.json"))).toBe(false);
      expect(fs.existsSync(path.resolve("public/.well-known/apple-app-site-association"))).toBe(false);
    });
  });

  describe("AT-FIRESTORE-INDEX-01: Committed composite & collection-group indexes", () => {
    it("commits quotes COLLECTION_GROUP and compound indexes for jobs, ride_requests, notifications, conversations, and push_devices", () => {
      const raw = fs.readFileSync(path.resolve("firestore.indexes.json"), "utf8");
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed.indexes)).toBe(true);

      const hasIndex = (group: string, scope: string, fields: string[]) =>
        parsed.indexes.some(
          (idx: any) =>
            idx.collectionGroup === group &&
            idx.queryScope === scope &&
            fields.every((f) => idx.fields.some((entry: any) => entry.fieldPath === f))
        );

      expect(hasIndex("quotes", "COLLECTION_GROUP", ["tradespersonId", "createdAt"])).toBe(true);
      expect(hasIndex("quotes", "COLLECTION_GROUP", ["tradespersonId", "status", "createdAt"])).toBe(true);
      expect(hasIndex("jobs", "COLLECTION", ["assignedTradespersonId", "postedDate"])).toBe(true);
      expect(hasIndex("ride_requests", "COLLECTION", ["driverId", "status", "completedAt"])).toBe(true);
      expect(hasIndex("notifications", "COLLECTION", ["userId", "createdAt"])).toBe(true);
      expect(hasIndex("conversations", "COLLECTION", ["participants", "updatedAt"])).toBe(true);
      expect(hasIndex("calendarEvents", "COLLECTION", ["consultantId", "startTime"])).toBe(true);
      expect(hasIndex("chat_user_blocks", "COLLECTION", ["blockerUid", "active"])).toBe(true);
      expect(hasIndex("push_devices", "COLLECTION_GROUP", ["active", "updatedAt"])).toBe(true);
    });
  });

  describe("AT-FIRESTORE-DB-01: Named production database emulator parity", () => {
    it("binds namedDbEmulator helper and all emulator security-rules suites to the named production database ID", () => {
      expect(loadVerifiedProductionDatabaseId()).toBe(PRODUCTION_FIRESTORE_DATABASE_ID);
      expect(PRODUCTION_FIRESTORE_DATABASE_ID).toBe(
        "ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a"
      );

      const built = buildNamedDbEmulatorConfig({
        projectId: "demo-anytrader",
        firestore: { host: "127.0.0.1", port: 8088, rules: "" },
      });
      expect((built.firestore as any).databaseId).toBe(PRODUCTION_FIRESTORE_DATABASE_ID);

      // Verify zero emulator test files still call bare initializeTestEnvironment
      const unitDir = path.resolve("tests/unit");
      const testFiles = fs.readdirSync(unitDir).filter((f) => f.endsWith(".test.ts"));
      const bareCallers: string[] = [];
      let migratedCount = 0;
      const barePattern = new RegExp("await\\s+initialize" + "TestEnvironment\\(");
      for (const file of testFiles) {
        const content = fs.readFileSync(path.join(unitDir, file), "utf8");
        if (barePattern.test(content)) {
          bareCallers.push(file);
        }
        if (content.includes("initializeNamedDbTestEnvironment(")) {
          migratedCount++;
        }
      }
      expect(bareCallers).toEqual([]);
      expect(migratedCount).toBeGreaterThanOrEqual(18);
    });
  });
});
