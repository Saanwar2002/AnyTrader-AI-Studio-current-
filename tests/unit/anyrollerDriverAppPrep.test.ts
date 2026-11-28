import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  calculateHaversineMiles,
  dispatchRideOffersCommand,
  evaluateDriverOfferCandidate,
  executeDeclineRideOfferCommand,
  executeRatePassengerCommand,
  getSanitizedNearbyDrivers,
  notifyRideCounterpartyPush,
  RIDE_OFFER_CHANNEL_ID,
  RIDE_UPDATES_CHANNEL_ID,
} from "../../src/server/rideOfferDispatch.ts";
import { executeAcceptRideCommand } from "../../src/server/driverAuthorization.ts";
import {
  executeCancelRideCommand,
  executeCompleteRideCommand,
  executeTransitionRideCommand,
} from "../../src/server/rideLifecycleCommands.ts";
import { reportOrBlockChatParticipantCommand } from "../../src/server/chatSafety.ts";
import { buildAndroidAssetLinksPayload } from "../../src/server/mobileDeepLinks.ts";
import { sanitizeRedirectUrl } from "../../src/server/paymentVerification.ts";
import { sendAuthoritativeChatPush } from "../../src/server/notificationEngine.ts";
import { analyzeOfferIntelligence } from "../../src/lib/offerIntelligence.ts";

function createInMemoryFirestore(initialDocs: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Record<string, any>>();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k, { ...v });
  }

  const applyPatch = (existing: Record<string, any>, patch: Record<string, any>, merge = true) => {
    const next = merge ? { ...existing } : {};
    for (const [key, val] of Object.entries(patch)) {
      if (val && typeof val === "object" && (val._methodName === "FieldValue.delete" || val.constructor?.name === "DeleteTransform")) {
        delete next[key];
      } else if (val && typeof val === "object" && (val._methodName === "FieldValue.arrayUnion" || val.constructor?.name === "ArrayUnionTransform" || Array.isArray(val.elements))) {
        const existingArr = Array.isArray(next[key]) ? [...next[key]] : [];
        const toAdd = Array.isArray(val.elements) ? val.elements : Array.isArray(val._elements) ? val._elements : [];
        for (const item of toAdd) {
          if (!existingArr.includes(item)) existingArr.push(item);
        }
        next[key] = existingArr;
      } else if (val && typeof val === "object" && (val._methodName === "FieldValue.increment" || typeof val.operand === "number")) {
        const delta = Number(val.operand ?? val._operand ?? 0);
        next[key] = Number(next[key] || 0) + delta;
      } else {
        next[key] = val;
      }
    }
    return next;
  };

  const makeDocRef = (colPath: string, docId: string) => {
    const fullPath = `${colPath}/${docId}`;
    return {
      id: docId,
      path: fullPath,
      async get() {
        const data = store.get(fullPath);
        return {
          id: docId,
          exists: data !== undefined,
          data: () => (data ? { ...data } : undefined),
        };
      },
      async set(patch: Record<string, any>, opts?: { merge?: boolean }) {
        const current = store.get(fullPath) || {};
        store.set(fullPath, applyPatch(current, patch, opts?.merge !== false));
      },
      async update(patch: Record<string, any>) {
        const current = store.get(fullPath);
        if (!current) throw new Error(`Doc ${fullPath} does not exist`);
        store.set(fullPath, applyPatch(current, patch, true));
      },
      collection(subCol: string) {
        return makeCollection(`${fullPath}/${subCol}`);
      },
    };
  };

  const makeCollection = (colPath: string, filters: Array<{ field: string; op: string; value: any }> = []) => ({
    doc(docId?: string) {
      return makeDocRef(colPath, docId || `auto_${Math.random().toString(36).slice(2, 10)}`);
    },
    where(field: string, op: string, value: any) {
      return makeCollection(colPath, [...filters, { field, op, value }]);
    },
    limit() {
      return makeCollection(colPath, filters);
    },
    async get() {
      const prefix = `${colPath}/`;
      const docs: any[] = [];
      for (const [fullPath, data] of store.entries()) {
        if (!fullPath.startsWith(prefix)) continue;
        const remainder = fullPath.slice(prefix.length);
        if (remainder.includes("/")) continue;
        const matches = filters.every((f) => {
          if (f.op === "==") return data[f.field] === f.value;
          return true;
        });
        if (matches) {
          docs.push({
            id: remainder,
            exists: true,
            data: () => ({ ...data }),
            ref: makeDocRef(colPath, remainder),
          });
        }
      }
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });

  const db = {
    _store: store,
    collection(colPath: string) {
      return makeCollection(colPath);
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, patch: any, opts?: any) => ref.set(patch, opts),
        update: (ref: any, patch: any) => ref.update(patch),
        create: (ref: any, data: any) => ref.set(data, { merge: false }),
      };
      return fn(tx);
    },
  };

  return db;
}

describe("AnyRoller Standalone Android Driver App Backend Prep", () => {
  const huddersfieldLat = 53.6458;
  const huddersfieldLng = -1.785;
  const nearbyLat = 53.652; // ~0.5 mi away
  const nearbyLng = -1.781;
  const farLat = 51.5074; // London (~165 mi away)
  const farLng = -0.1278;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Server-Side Ride Offer FCM Push Dispatch", () => {
    it("dispatches high-priority ride_offers_urgent FCM pushes only to eligible, approved nearby drivers and enforces cooldown", async () => {
      const nowMs = 1_750_000_000_000;
      const db = createInMemoryFirestore({
        "ride_requests/ride_open_1": {
          passengerId: "passenger_1",
          status: "pending",
          pickupAddress: "10 High St, Huddersfield",
          dropoffAddress: "Huddersfield Train Station",
          pickupLat: huddersfieldLat,
          pickupLng: huddersfieldLng,
          dropoffLat: 53.6485,
          dropoffLng: -1.7845,
          fareEstimate: 14.5,
          surgeMultiplier: 1.2,
          carCategory: "standard",
          declinedBy: ["driver_declined"],
        },
        "live_tracking/driver_approved": {
          driverId: "driver_approved",
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["standard"],
          lastHeartbeatAtMs: nowMs - 10_000,
        },
        "live_tracking/driver_unapproved": {
          driverId: "driver_unapproved",
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["standard"],
          lastHeartbeatAtMs: nowMs - 5_000,
        },
        "live_tracking/driver_declined": {
          driverId: "driver_declined",
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["standard"],
          lastHeartbeatAtMs: nowMs - 5_000,
        },
        "live_tracking/driver_far": {
          driverId: "driver_far",
          isOnline: true,
          status: "available",
          lat: farLat,
          lng: farLng,
          vehicleCategories: ["standard"],
          lastHeartbeatAtMs: nowMs - 5_000,
        },
        "live_tracking/driver_last_job": {
          driverId: "driver_last_job",
          isOnline: true,
          status: "available",
          lastJobMode: true,
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["standard"],
          lastHeartbeatAtMs: nowMs - 5_000,
        },
        "users/driver_approved": {
          role: "taxi_driver",
          driverApproved: true,
          fcmToken: "fcm_token_approved_driver_1",
        },
        "users/driver_unapproved": {
          role: "driver",
          driverApproved: false,
          fcmToken: "fcm_token_unapproved",
        },
        "users/driver_declined": {
          role: "fleet_driver",
          driverApproved: true,
          fcmToken: "fcm_token_declined",
        },
        "users/driver_far": {
          role: "driver",
          driverApproved: true,
          fcmToken: "fcm_token_far",
        },
        "users/driver_last_job": {
          role: "driver",
          driverApproved: true,
          fcmToken: "fcm_token_last_job",
        },
      });

      const sendMock = vi.fn().mockResolvedValue("projects/anytradercombined/messages/msg_offer_1");
      const messagingClient = { send: sendMock };

      const res = await dispatchRideOffersCommand({
        db,
        caller: { uid: "passenger_1" },
        rideId: "ride_open_1",
        messagingClient,
        nowMs,
      });

      expect(res.success).toBe(true);
      expect(res.throttled).toBe(false);
      expect(res.matchedDrivers).toBe(1);
      expect(res.dispatchedCount).toBe(1);
      expect(res.deliveredCount).toBe(1);
      expect(sendMock).toHaveBeenCalledTimes(1);

      const sentPayload = sendMock.mock.calls[0][0];
      expect(sentPayload.token).toBe("fcm_token_approved_driver_1");
      expect(sentPayload.android?.priority).toBe("high");
      expect(sentPayload.android?.notification?.channelId).toBe(RIDE_OFFER_CHANNEL_ID);
      expect(sentPayload.data?.type).toBe("ride_offer");
      expect(sentPayload.data?.rideId).toBe("ride_open_1");
      expect(sentPayload.data?.fareEstimate).toBe("14.5");

      const updatedRide = db._store.get("ride_requests/ride_open_1");
      expect(updatedRide?.offeredDriverIds).toEqual(["driver_approved"]);
      expect(updatedRide?.lastOfferDispatchAtMs).toBe(nowMs);

      // Immediate second call within 10s cooldown is throttled
      const throttledRes = await dispatchRideOffersCommand({
        db,
        caller: { uid: "passenger_1" },
        rideId: "ride_open_1",
        messagingClient,
        nowMs: nowMs + 3_000,
      });
      expect(throttledRes.throttled).toBe(true);
      expect(throttledRes.dispatchedCount).toBe(0);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("rejects unauthorized callers trying to dispatch offers for another passenger's ride", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_other": {
          passengerId: "passenger_owner",
          status: "pending",
          pickupLat: huddersfieldLat,
          pickupLng: huddersfieldLng,
        },
      });

      await expect(
        dispatchRideOffersCommand({
          db,
          caller: { uid: "stranger_user" },
          rideId: "ride_other",
        })
      ).rejects.toThrow(/not authorized/i);
    });

    it("evaluates job stacking, destination mode, and working zone filters accurately", () => {
      const nowMs = 1_750_000_000_000;
      const baseRide = {
        pickupLat: huddersfieldLat,
        pickupLng: huddersfieldLng,
        dropoffLat: 53.7997, // Leeds (~14 mi)
        dropoffLng: -1.5492,
        carCategory: "standard",
      };

      // Busy driver with job stacking enabled and active dropoff close to next pickup -> eligible
      const stackingOk = evaluateDriverOfferCandidate({
        driverUid: "d_stack",
        trackingData: {
          isOnline: true,
          status: "on_ride",
          allowJobStacking: true,
          lat: farLat,
          lng: farLng,
          dropoffLat: nearbyLat,
          dropoffLng: nearbyLng,
          lastHeartbeatAtMs: nowMs - 1_000,
        },
        rideData: baseRide,
        radiusMiles: 15,
        nowMs,
      });
      expect(stackingOk.eligible).toBe(true);

      // Destination mode filtering out rides heading away from driver's destination
      const destMismatch = evaluateDriverOfferCandidate({
        driverUid: "d_dest",
        trackingData: {
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          destinationMode: true,
          destinationLat: 53.4808, // Manchester (far from Leeds dropoff)
          destinationLng: -2.2426,
          destinationRadiusMiles: 5,
          lastHeartbeatAtMs: nowMs - 1_000,
        },
        rideData: baseRide,
        radiusMiles: 15,
        nowMs,
      });
      expect(destMismatch.eligible).toBe(false);
      expect(destMismatch.reason).toBe("destination_mismatch");

      // Zone filter rejecting pickup outside working zone
      const zoneOutside = evaluateDriverOfferCandidate({
        driverUid: "d_zone",
        trackingData: {
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          zoneFilterEnabled: true,
          zoneCenterLat: 53.4808,
          zoneCenterLng: -2.2426,
          zoneRadiusMiles: 3,
          lastHeartbeatAtMs: nowMs - 1_000,
        },
        rideData: baseRide,
        radiusMiles: 15,
        nowMs,
      });
      expect(zoneOutside.eligible).toBe(false);
      expect(zoneOutside.reason).toBe("outside_driver_zone");
    });

    it("returns privacy-safe nearby driver pins with zero driver UIDs or PII", async () => {
      const nowMs = 1_750_000_000_000;
      const db = createInMemoryFirestore({
        "live_tracking/driver_secret_uid": {
          driverId: "driver_secret_uid",
          driverName: "John Doe",
          vehiclePlate: "AB12 CDE",
          isOnline: true,
          status: "available",
          lat: 53.652456,
          lng: -1.781234,
          heading: 182.4,
          vehicleCategories: ["standard", "xl"],
          lastHeartbeatAtMs: nowMs - 15_000,
        },
        "live_tracking/driver_stale": {
          driverId: "driver_stale",
          isOnline: true,
          status: "available",
          lat: 53.65,
          lng: -1.78,
          lastHeartbeatAtMs: nowMs - 30 * 60 * 1000, // 30 mins stale
        },
        "live_tracking/driver_busy": {
          driverId: "driver_busy",
          isOnline: true,
          status: "on_ride",
          lat: 53.65,
          lng: -1.78,
          lastHeartbeatAtMs: nowMs - 5_000,
        },
      });

      const res = await getSanitizedNearbyDrivers({
        db,
        lat: huddersfieldLat,
        lng: huddersfieldLng,
        radiusMiles: 10,
        nowMs,
      });

      expect(res.count).toBe(1);
      const pin: any = res.drivers[0];
      expect(pin.lat).toBe(53.652);
      expect(pin.lng).toBe(-1.781);
      expect(pin.heading).toBe(182);
      expect(pin.driverId).toBeUndefined();
      expect(pin.uid).toBeUndefined();
      expect(pin.driverName).toBeUndefined();
      expect(pin.vehiclePlate).toBeUndefined();
      expect(calculateHaversineMiles(huddersfieldLat, huddersfieldLng, nearbyLat, nearbyLng)).toBeLessThan(1);
    });
  });

  describe("2. Live Tracking Passenger Visibility Sync on Accept / Complete / Cancel", () => {
    it("stamps passengerId, riderId, activeRideId, and status=on_ride on live_tracking/{driverUid} during accept", async () => {
      const db = createInMemoryFirestore({
        "users/driver_1": {
          role: "taxi_driver",
          driverApproved: true,
        },
        "ride_requests/ride_sync_1": {
          passengerId: "passenger_99",
          status: "pending",
          dropoffLat: 53.66,
          dropoffLng: -1.77,
        },
        "live_tracking/driver_1": {
          driverId: "driver_1",
          isOnline: true,
          status: "available",
          lat: 53.645,
          lng: -1.785,
        },
      });

      const res = await executeAcceptRideCommand({
        db,
        caller: { uid: "driver_1" },
        body: { rideId: "ride_sync_1" },
      });

      expect(res.success).toBe(true);
      expect(res.passengerId).toBe("passenger_99");

      const tracking = db._store.get("live_tracking/driver_1");
      expect(tracking?.status).toBe("on_ride");
      expect(tracking?.activeRideId).toBe("ride_sync_1");
      expect(tracking?.passengerId).toBe("passenger_99");
      expect(tracking?.riderId).toBe("passenger_99");
      expect(tracking?.dropoffLat).toBe(53.66);
      expect(tracking?.dropoffLng).toBe(-1.77);
    });

    it("clears passengerId, riderId, activeRideId and restores status=available on complete and cancel", async () => {
      const db = createInMemoryFirestore({
        "users/driver_1": { role: "driver", driverApproved: true },
        "users/passenger_99": { role: "homeowner", pendingCharges: 0 },
        "ride_requests/ride_complete_1": {
          passengerId: "passenger_99",
          assignedDriverId: "driver_1",
          driverId: "driver_1",
          status: "in_progress",
          fareEstimate: 15,
          paymentMethod: "cash",
        },
        "ride_requests/ride_cancel_1": {
          passengerId: "passenger_99",
          assignedDriverId: "driver_1",
          driverId: "driver_1",
          status: "accepted",
        },
        "live_tracking/driver_1": {
          driverId: "driver_1",
          isOnline: true,
          status: "on_ride",
          activeRideId: "ride_complete_1",
          passengerId: "passenger_99",
          riderId: "passenger_99",
        },
      });

      await executeCompleteRideCommand({
        db,
        caller: { uid: "driver_1" },
        rideId: "ride_complete_1",
        action: "cash_finalize",
        cashCollected: 15,
      });

      let tracking = db._store.get("live_tracking/driver_1");
      expect(tracking?.status).toBe("available");
      expect(tracking?.activeRideId).toBeUndefined();
      expect(tracking?.passengerId).toBeUndefined();
      expect(tracking?.riderId).toBeUndefined();

      // Re-attach for cancel test
      await db.collection("live_tracking").doc("driver_1").set({
        status: "on_ride",
        activeRideId: "ride_cancel_1",
        passengerId: "passenger_99",
        riderId: "passenger_99",
      });

      const cancelRes: any = await executeCancelRideCommand({
        db,
        caller: { uid: "passenger_99" },
        rideId: "ride_cancel_1",
      });

      expect(cancelRes.success).toBe(true);
      expect(cancelRes.assignedDriverId).toBe("driver_1");
      expect(cancelRes.passengerId).toBe("passenger_99");

      tracking = db._store.get("live_tracking/driver_1");
      expect(tracking?.status).toBe("available");
      expect(tracking?.activeRideId).toBeUndefined();
      expect(tracking?.passengerId).toBeUndefined();
      expect(tracking?.riderId).toBeUndefined();
    });
  });

  describe("3. Multi-App Android App Links, Stripe Custom Tab Redirects & Push Channel Parity", () => {
    const validTraderFp =
      "A1:B2:C3:D4:E5:F6:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:12:34:56:78:9A:BC:DE:F0:23:45:67:89";
    const validDriverFp =
      "F0:E1:D2:C3:B4:A5:96:87:78:69:5A:4B:3C:2D:1E:0F:19:28:37:46:55:64:73:82:91:A0:B1:C2:D3:E4:F5:06";

    it("emits both AnyTrader and AnyRoller Driver Android App Link statements when configured", () => {
      const res = buildAndroidAssetLinksPayload({
        ANDROID_APP_PACKAGE: "com.anytrader.app",
        ANDROID_SHA256_CERT_FINGERPRINTS: validTraderFp,
        ANDROID_DRIVER_APP_PACKAGE: "com.anyroller.driver",
        ANDROID_DRIVER_SHA256_CERT_FINGERPRINTS: validDriverFp,
      });

      expect(res.configured).toBe(true);
      expect(res.payload).toHaveLength(2);
      expect(res.payload?.[0].target.package_name).toBe("com.anytrader.app");
      expect(res.payload?.[1].target.package_name).toBe("com.anyroller.driver");
      expect(res.payload?.[1].target.sha256_cert_fingerprints).toEqual([validDriverFp]);
    });

    it("supports driver-only configuration and fails closed on placeholder driver fingerprints", () => {
      const driverOnly = buildAndroidAssetLinksPayload({
        ANDROID_DRIVER_APP_PACKAGE: "com.anyroller.driver",
        ANDROID_DRIVER_SHA256_CERT_FINGERPRINTS: validDriverFp,
      });
      expect(driverOnly.configured).toBe(true);
      expect(driverOnly.payload).toHaveLength(1);
      expect(driverOnly.payload?.[0].target.package_name).toBe("com.anyroller.driver");

      const invalidDriver = buildAndroidAssetLinksPayload({
        ANDROID_APP_PACKAGE: "com.anytrader.app",
        ANDROID_SHA256_CERT_FINGERPRINTS: validTraderFp,
        ANDROID_DRIVER_APP_PACKAGE: "com.anyroller.driver",
        ANDROID_DRIVER_SHA256_CERT_FINGERPRINTS: "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
      });
      expect(invalidDriver.configured).toBe(false);
      expect(invalidDriver.reason).toContain("ANDROID_DRIVER_SHA256_CERT_FINGERPRINTS");
    });

    it("allows /driver-terminal and /driver-return in Stripe redirect allowlist", () => {
      const appUrl = "https://anytrader.example.co.uk";
      expect(
        sanitizeRedirectUrl(`${appUrl}/driver-terminal?stripe_onboarding=success`, appUrl, "/driver-dashboard")
      ).toBe(`${appUrl}/driver-terminal?stripe_onboarding=success`);
      expect(
        sanitizeRedirectUrl(`${appUrl}/driver-return?status=complete`, appUrl, "/driver-dashboard")
      ).toBe(`${appUrl}/driver-return?status=complete`);
    });

    it("defaults ride chat push Android channelId to ride_chat_updates and sends counterparty cancellation push", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_chat_1": {
          passengerId: "passenger_1",
          assignedDriverId: "driver_1",
          driverId: "driver_1",
          status: "accepted",
        },
        "users/driver_1": {
          role: "driver",
          driverApproved: true,
          fcmToken: "fcm_driver_1",
        },
      });
      const sendMock = vi.fn().mockResolvedValue("projects/anytradercombined/messages/msg_1");
      const messagingClient = { send: sendMock };

      await sendAuthoritativeChatPush(db, messagingClient, { uid: "passenger_1" }, {
        recipientId: "driver_1",
        rideId: "ride_chat_1",
        title: "Passenger Message",
        body: "I am outside the main entrance",
      });

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0].android?.notification?.channelId).toBe(RIDE_UPDATES_CHANNEL_ID);

      const cancelPush = await notifyRideCounterpartyPush({
        db,
        messagingClient,
        rideId: "ride_chat_1",
        recipientId: "driver_1",
        title: "Ride Cancelled by Passenger",
        body: "The passenger cancelled your assigned ride.",
        eventType: "ride_cancelled",
      });
      expect(cancelPush.dispatched).toBe(true);
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(sendMock.mock.calls[1][0].android?.notification?.channelId).toBe(RIDE_UPDATES_CHANNEL_ID);
      expect(sendMock.mock.calls[1][0].data?.type).toBe("ride_cancelled");
    });

    it("enforces driver role parity (taxi_driver, accountType, driverApproved) in firestore.rules", () => {
      const rules = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8");
      const match = rules.match(/function isAnyRollerDriver\(\)\s*\{([\s\S]*?)\}/);
      expect(match).not.toBeNull();
      const fnBody = match?.[1] || "";
      expect(fnBody).toContain("'driver'");
      expect(fnBody).toContain("'fleet_driver'");
      expect(fnBody).toContain("'taxi_driver'");
      expect(fnBody).toContain("accountType");
      expect(fnBody).toContain("driverApproved");
    });
  });

  describe("4. Android Driver App Live Sync Reconciliation (P0-1..P0-6 & P1-1..P1-5)", () => {
    it("P0-1 & P0-2: allows offered driver to accept offered ride, blocks competing driver before expiry, and stamps authoritative driver profile fields", async () => {
      const futureIso = new Date(Date.now() + 30_000).toISOString();
      const db = createInMemoryFirestore({
        "users/driver_offered": {
          role: "taxi_driver",
          driverApproved: true,
          firstName: "Amina",
          lastName: "Khan",
          phone: "+447700900111",
          vehicle: "Black Skoda Octavia",
          vehicleRegistration: "YD72 KLM",
          rating: 4.92,
          requirePasscode: true,
          photoURL: "https://example.com/amina.jpg",
        },
        "users/driver_other": {
          role: "driver",
          driverApproved: true,
          firstName: "Bob",
        },
        "ride_requests/ride_offered_1": {
          passengerId: "passenger_1",
          status: "offered",
          assignedDriverId: "driver_offered",
          offerExpiresAt: futureIso,
          dropoffLat: 53.66,
          dropoffLng: -1.77,
        },
        "live_tracking/driver_offered": {
          driverId: "driver_offered",
          isOnline: true,
          status: "available",
          lat: 53.645,
          lng: -1.785,
        },
      });

      // Competing driver blocked while offer is active
      await expect(
        executeAcceptRideCommand({
          db,
          caller: { uid: "driver_other" },
          body: { rideId: "ride_offered_1" },
        })
      ).rejects.toThrow(/already been accepted|currently offered/i);

      // Offered driver succeeds and authoritative profile fields + passenger live_tracking link are stamped
      const res = await executeAcceptRideCommand({
        db,
        caller: { uid: "driver_offered" },
        body: { rideId: "ride_offered_1" },
      });

      expect(res.success).toBe(true);
      expect(res.driverId).toBe("driver_offered");
      expect(res.isStackedAccept).toBeFalsy();

      const ride = db._store.get("ride_requests/ride_offered_1");
      expect(ride?.status).toBe("accepted");
      expect(ride?.driverId).toBe("driver_offered");
      expect(ride?.assignedDriverId).toBe("driver_offered");
      expect(ride?.driverName).toBe("Amina Khan");
      expect(ride?.driverPhone).toBe("+447700900111");
      expect(ride?.vehicleInfo).toBe("Black Skoda Octavia");
      expect(ride?.vehiclePlate).toBe("YD72 KLM");
      expect(ride?.driverRating).toBe(4.92);
      expect(ride?.driverRequirePasscode).toBe(true);
      expect(ride?.driverPhotoUrl).toBe("https://example.com/amina.jpg");
      expect(ride?.acceptedAt).toBeDefined();

      // P0-3: Passenger live_tracking doc stamped with driverId so driver sees passenger GPS blue dot
      const passengerTracking = db._store.get("live_tracking/passenger_1");
      expect(passengerTracking?.driverId).toBe("driver_offered");
      expect(passengerTracking?.activeRideId).toBe("ride_offered_1");
      expect(passengerTracking?.passengerId).toBe("passenger_1");
      expect(passengerTracking?.isPassenger).toBe(true);
    });

    it("P0-3 & P0-6: preserves active passenger on stacked accept and promotes queued ride on completion with ridesToday metric mirror", async () => {
      const db = createInMemoryFirestore({
        "users/driver_stack": {
          role: "driver",
          driverApproved: true,
          firstName: "Tariq",
        },
        "users/passenger_A": { role: "homeowner", pendingCharges: 0 },
        "users/passenger_B": { role: "homeowner", pendingCharges: 0 },
        "ride_requests/ride_A": {
          passengerId: "passenger_A",
          driverId: "driver_stack",
          assignedDriverId: "driver_stack",
          status: "in_progress",
          fareEstimate: 12,
          paymentMethod: "cash",
        },
        "ride_requests/ride_B": {
          passengerId: "passenger_B",
          status: "offered",
          assignedDriverId: "driver_stack",
          dropoffLat: 53.68,
          dropoffLng: -1.75,
        },
        "live_tracking/driver_stack": {
          driverId: "driver_stack",
          isOnline: true,
          status: "on_ride",
          activeRideId: "ride_A",
          passengerId: "passenger_A",
          riderId: "passenger_A",
          isStackingEnabled: true,
        },
        "live_tracking/passenger_A": {
          passengerId: "passenger_A",
          driverId: "driver_stack",
          activeRideId: "ride_A",
          isPassenger: true,
        },
      });

      // Accept Ride B while on Ride A -> stacked accept
      const stackRes = await executeAcceptRideCommand({
        db,
        caller: { uid: "driver_stack" },
        body: { rideId: "ride_B" },
      });
      expect(stackRes.success).toBe(true);
      expect(stackRes.isStackedAccept).toBe(true);

      let driverTrack = db._store.get("live_tracking/driver_stack");
      expect(driverTrack?.activeRideId).toBe("ride_A");
      expect(driverTrack?.passengerId).toBe("passenger_A");
      expect(driverTrack?.queuedRideId).toBe("ride_B");
      expect(driverTrack?.queuedPassengerId).toBe("passenger_B");
      expect(driverTrack?.isStackingEnabled).toBe(false);

      // Complete Ride A -> promotes Ride B to active and clears passenger_A's driverId
      await executeCompleteRideCommand({
        db,
        caller: { uid: "driver_stack" },
        rideId: "ride_A",
        action: "cash_finalize",
        cashCollected: 12,
      });

      driverTrack = db._store.get("live_tracking/driver_stack");
      expect(driverTrack?.status).toBe("on_ride");
      expect(driverTrack?.activeRideId).toBe("ride_B");
      expect(driverTrack?.passengerId).toBe("passenger_B");
      expect(driverTrack?.queuedRideId).toBeUndefined();
      expect(driverTrack?.queuedPassengerId).toBeUndefined();

      const paxATrack = db._store.get("live_tracking/passenger_A");
      expect(paxATrack?.driverId).toBeUndefined();
      expect(paxATrack?.activeRideId).toBeUndefined();

      const paxBTrack = db._store.get("live_tracking/passenger_B");
      expect(paxBTrack?.driverId).toBe("driver_stack");
      expect(paxBTrack?.activeRideId).toBe("ride_B");

      // Android driver_metrics parity: both jobsDoneToday and ridesToday updated
      const metrics = db._store.get("driver_metrics/driver_stack");
      expect(metrics?.jobsDoneToday).toBe(1);
      expect(metrics?.ridesToday).toBe(1);
    });

    it("supports Android live_tracking filter field aliases (isStackingEnabled, isLastJob, destinationModeActive, zoneEnabled, declinedDriverIds)", () => {
      const nowMs = 1_750_000_000_000;
      const baseRide = {
        pickupLat: huddersfieldLat,
        pickupLng: huddersfieldLng,
        dropoffLat: 53.7997,
        dropoffLng: -1.5492,
        vehicleCategory: "standard",
        declinedDriverIds: ["d_declined_android"],
      };

      expect(
        evaluateDriverOfferCandidate({
          driverUid: "d_declined_android",
          trackingData: { isOnline: true, status: "available", lat: nearbyLat, lng: nearbyLng, lastHeartbeatAtMs: nowMs },
          rideData: baseRide,
          radiusMiles: 15,
          nowMs,
        }).reason
      ).toBe("declined");

      expect(
        evaluateDriverOfferCandidate({
          driverUid: "d_last_job_android",
          trackingData: { isOnline: true, status: "available", isLastJob: true, lat: nearbyLat, lng: nearbyLng, lastHeartbeatAtMs: nowMs },
          rideData: baseRide,
          radiusMiles: 15,
          nowMs,
        }).reason
      ).toBe("last_job_mode");

      expect(
        evaluateDriverOfferCandidate({
          driverUid: "d_stack_android",
          trackingData: {
            isOnline: true,
            status: "on_ride",
            isStackingEnabled: true,
            lat: farLat,
            lng: farLng,
            dropoffLat: nearbyLat,
            dropoffLng: nearbyLng,
            lastHeartbeatAtMs: nowMs,
          },
          rideData: baseRide,
          radiusMiles: 15,
          nowMs,
        }).eligible
      ).toBe(true);

      expect(
        evaluateDriverOfferCandidate({
          driverUid: "d_zone_android",
          trackingData: {
            isOnline: true,
            status: "available",
            lat: nearbyLat,
            lng: nearbyLng,
            zoneEnabled: true,
            homeLat: 53.4808,
            homeLng: -2.2426,
            zoneMaxDistance: 3,
            lastHeartbeatAtMs: nowMs,
          },
          rideData: baseRide,
          radiusMiles: 15,
          nowMs,
        }).reason
      ).toBe("outside_driver_zone");
    });

    it("P1-2, P1-3 & P1-4: executes ride offer decline, live ETA update_eta, and driver-to-passenger rating", async () => {
      const db = createInMemoryFirestore({
        "users/driver_1": { role: "driver", driverApproved: true },
        "users/passenger_1": { role: "homeowner", passengerRating: 5.0, passengerRatingCount: 1 },
        "ride_requests/ride_decline_1": {
          passengerId: "passenger_1",
          status: "offered",
          assignedDriverId: "driver_1",
          offerExpiresAt: new Date(Date.now() + 15_000).toISOString(),
        },
        "ride_requests/ride_eta_1": {
          passengerId: "passenger_1",
          assignedDriverId: "driver_1",
          driverId: "driver_1",
          status: "accepted",
        },
        "ride_requests/ride_done_1": {
          passengerId: "passenger_1",
          assignedDriverId: "driver_1",
          driverId: "driver_1",
          status: "completed",
        },
      });

      // P1-2 Decline
      const declineRes = await executeDeclineRideOfferCommand({
        db,
        caller: { uid: "driver_1" },
        rideId: "ride_decline_1",
      });
      expect(declineRes.success).toBe(true);
      expect(declineRes.status).toBe("pending");
      const declinedRide = db._store.get("ride_requests/ride_decline_1");
      expect(declinedRide?.status).toBe("pending");
      expect(declinedRide?.assignedDriverId).toBeUndefined();
      expect(declinedRide?.declinedDriverIds).toContain("driver_1");
      expect(declinedRide?.declinedBy).toContain("driver_1");

      // P1-3 update_eta
      const etaRes = await executeTransitionRideCommand({
        db,
        caller: { uid: "driver_1" },
        rideId: "ride_eta_1",
        action: "update_eta",
        liveEtaSeconds: 240,
        stackedDriverDelay: 5,
      });
      expect(etaRes.success).toBe(true);
      const etaRide = db._store.get("ride_requests/ride_eta_1");
      expect(etaRide?.liveEtaSeconds).toBe(240);
      expect(etaRide?.durationMinutes).toBe(4);
      expect(etaRide?.stackedDriverDelay).toBe(5);

      // P1-4 rate-passenger
      const rateRes = await executeRatePassengerCommand({
        db,
        caller: { uid: "driver_1" },
        rideId: "ride_done_1",
        rating: 4,
        tags: ["Polite", "Ready on time"],
        comment: "Smooth pickup",
      });
      expect(rateRes.success).toBe(true);
      expect(rateRes.passengerAverageRating).toBe(4.5);
      const passengerDoc = db._store.get("users/passenger_1");
      expect(passengerDoc?.passengerRating).toBe(4.5);
      expect(passengerDoc?.passengerRatingCount).toBe(2);
      const reviewDoc = db._store.get("passenger_reviews/ride_done_1");
      expect(reviewDoc?.rating).toBe(4);
      expect(reviewDoc?.driverId).toBe("driver_1");
      const doneRide = db._store.get("ride_requests/ride_done_1");
      expect(doneRide?.driverRatedPassenger).toBe(true);
    });

    it("chatSafety supports AnyRoller rideId & blockUser boolean payload from native Android", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_chat_safety": {
          passengerId: "passenger_bad",
          driverId: "driver_1",
          assignedDriverId: "driver_1",
          status: "in_progress",
        },
      });

      const res = await reportOrBlockChatParticipantCommand(
        db,
        { uid: "driver_1" },
        {
          rideId: "ride_chat_safety",
          targetUserId: "passenger_bad",
          reason: "abusive_language",
          blockUser: true,
        }
      );

      expect(res.action).toBe("report_and_block");
      expect(res.blockRecord?.blockedUid).toBe("passenger_bad");
      expect(res.reportRecord?.id).toBeTruthy();
    });

    it("P1-5: firestore.rules allows queuedPassengerId read on live_tracking and protects passenger_reviews", () => {
      const rules = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8");
      expect(rules).toContain("resource.data.get('queuedPassengerId', '') == request.auth.uid");
      expect(rules).toContain("match /passenger_reviews/{rideId}");
    });
  });

  describe("5. Web Driver Terminal ↔ Android Driver App Parity & Break/Stacked-Push Sync", () => {
    it("rejects drivers on Coffee Cup Break (onBreak=true or status=busy) even if stacking is enabled", () => {
      const nowMs = 1_750_000_000_000;
      const baseRide = {
        pickupLat: huddersfieldLat,
        pickupLng: huddersfieldLng,
        dropoffLat: 53.7997,
        dropoffLng: -1.5492,
        vehicleCategory: "standard",
      };

      const resBusy = evaluateDriverOfferCandidate({
        driverUid: "d_break_busy",
        trackingData: {
          isOnline: true,
          status: "busy",
          isStackingEnabled: true,
          lat: nearbyLat,
          lng: nearbyLng,
          lastHeartbeatAtMs: nowMs,
        },
        rideData: baseRide,
        radiusMiles: 15,
        nowMs,
      });
      expect(resBusy.eligible).toBe(false);
      expect(resBusy.reason).toBe("on_break");

      const resOnBreakFlag = evaluateDriverOfferCandidate({
        driverUid: "d_break_flag",
        trackingData: {
          isOnline: true,
          status: "available",
          onBreak: true,
          lat: nearbyLat,
          lng: nearbyLng,
          lastHeartbeatAtMs: nowMs,
        },
        rideData: baseRide,
        radiusMiles: 15,
        nowMs,
      });
      expect(resOnBreakFlag.eligible).toBe(false);
      expect(resOnBreakFlag.reason).toBe("on_break");
    });

    it("tags stacked ride offer FCM pushes with type=stacked_ride_offer when dispatching to an on_ride driver", async () => {
      const nowMs = 1_750_000_000_000;
      const db = createInMemoryFirestore({
        "ride_requests/ride_stack_push": {
          passengerId: "passenger_stack",
          status: "pending",
          pickup: "Huddersfield Rail Station",
          dropoff: "Leeds Station",
          pickupLat: huddersfieldLat,
          pickupLng: huddersfieldLng,
          dropoffLat: 53.795,
          dropoffLng: -1.547,
          fareEstimate: 26.5,
          vehicleCategory: "standard",
        },
        "live_tracking/driver_on_ride": {
          driverId: "driver_on_ride",
          isOnline: true,
          status: "on_ride",
          isStackingEnabled: true,
          lat: farLat,
          lng: farLng,
          dropoffLat: nearbyLat,
          dropoffLng: nearbyLng,
          lastHeartbeatAtMs: nowMs - 2_000,
        },
        "users/driver_on_ride": {
          role: "driver",
          driverApproved: true,
          fcmToken: "fcm_stacked_driver_token",
        },
      });

      const sendMock = vi.fn().mockResolvedValue("projects/anytradercombined/messages/stack_1");
      const res = await dispatchRideOffersCommand({
        db,
        caller: { uid: "passenger_stack" },
        rideId: "ride_stack_push",
        messagingClient: { send: sendMock },
        nowMs,
      });

      expect(res.success).toBe(true);
      expect(res.matchedDrivers).toBe(1);
      expect(res.dispatchedCount).toBe(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0].data?.type).toBe("stacked_ride_offer");
      expect(sendMock.mock.calls[0][0].android?.notification?.channelId).toBe(RIDE_OFFER_CHANNEL_ID);
    });

    it("analyzeOfferIntelligence computes £/hr, £/mi, smart tags, compass direction, and Toward Home parity", () => {
      const airportIntel = analyzeOfferIntelligence({
        offer: {
          pickupAddress: "Huddersfield Town Centre",
          dropoffAddress: "Manchester Airport Terminal 2",
          pickupLat: 53.6458,
          pickupLng: -1.785,
          dropoffLat: 53.365,
          dropoffLng: -2.2728,
          fareEstimate: 54.0,
          distanceMiles: 29.0,
          durationMinutes: 45,
        },
        driverLat: 53.648,
        driverLng: -1.782,
        homeLat: 53.35,
        homeLng: -2.28,
      });

      expect(airportIntel.smartTag).toBe("AIRPORT");
      expect(airportIntel.estimatedGbpPerHour).toBeGreaterThan(50);
      expect(airportIntel.estimatedGbpPerMile).toBeGreaterThan(1.5);
      expect(airportIntel.compassShort).toBe("SW");
      expect(airportIntel.isHeadingTowardHome).toBe(true);

      const stationIntel = analyzeOfferIntelligence({
        offer: {
          pickupAddress: "10 High Street",
          dropoffAddress: "Leeds Railway Station",
          pickupLat: 53.6458,
          pickupLng: -1.785,
          dropoffLat: 53.7946,
          dropoffLng: -1.5476,
          fareEstimate: 24.0,
          distanceMiles: 12.0,
          durationMinutes: 25,
        },
        driverLat: 53.6458,
        driverLng: -1.785,
      });
      expect(stationIntel.smartTag).toBe("RAIL STATION");
      expect(stationIntel.compassShort).toBe("NE");

      const longTripIntel = analyzeOfferIntelligence({
        offer: {
          pickupAddress: "10 High Street",
          dropoffAddress: "York City Centre",
          pickupLat: 53.6458,
          pickupLng: -1.785,
          dropoffLat: 53.9591,
          dropoffLng: -1.0815,
          fareEstimate: 65.0,
          distanceMiles: 35.0,
          durationMinutes: 55,
        },
        driverLat: 53.6458,
        driverLng: -1.785,
      });
      expect(longTripIntel.smartTag).toBe("LONG TRIP");
    });
  });
});
