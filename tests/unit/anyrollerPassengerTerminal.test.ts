import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  ALLOWED_VEHICLE_CATEGORIES,
  DEFAULT_RIDES_FARE_CONFIG,
  DEFAULT_VEHICLE_MULTIPLIERS,
  computeServerBookingFareEstimate,
} from "../../src/server/rideFareCalculator.ts";
import {
  dispatchRideOffersCommand,
  executePassengerUpdateRideCommand,
  executeReassignDelayedRideCommand,
  getSanitizedNearbyDrivers,
} from "../../src/server/rideOfferDispatch.ts";

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
      } else if (
        val &&
        typeof val === "object" &&
        (val._methodName === "FieldValue.arrayUnion" || val.constructor?.name === "ArrayUnionTransform" || Array.isArray(val.elements))
      ) {
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

  return {
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
}

describe("AnyRoller Web Passenger Terminal Remediation & Electric Vehicle Tier", () => {
  const pickupLat = 53.6458;
  const pickupLng = -1.785;
  const nearbyLat = 53.652;
  const nearbyLng = -1.781;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Electric Vehicle Category & Authoritative Fare Calculation", () => {
    it("registers electric in allowed categories with 1.15x default multiplier and calculates fares accurately", () => {
      expect(ALLOWED_VEHICLE_CATEGORIES).toContain("electric");
      expect(DEFAULT_VEHICLE_MULTIPLIERS.electric).toBe(1.15);
      expect(DEFAULT_RIDES_FARE_CONFIG.petFee).toBe(3.0);

      const standardFare = computeServerBookingFareEstimate({
        distanceMiles: 5,
        durationMinutes: 15,
        carCategory: "standard",
        ridesConfig: DEFAULT_RIDES_FARE_CONFIG,
      });

      const electricFare = computeServerBookingFareEstimate({
        distanceMiles: 5,
        durationMinutes: 15,
        carCategory: "electric",
        isPriority: true,
        isPetFriendly: true,
        surgeModel: "multiplier",
        surgeMultiplier: 1.2,
        ridesConfig: DEFAULT_RIDES_FARE_CONFIG,
      });

      expect(electricFare.baseCalc).toBe(standardFare.baseCalc);
      // baseCalc * 1.15 * 1.2 + priorityFee(3) + petFee(3)
      const expected = Math.round((electricFare.baseCalc * 1.15 * 1.2 + 3 + 3) * 100) / 100;
      expect(electricFare.fareEstimate).toBe(expected);
      expect(electricFare.fareEstimate).toBeGreaterThan(standardFare.fareEstimate);
    });
  });

  describe("2. Sanitized Nearby Drivers (Categories, Pet-Friendly, Break Exclusion, Available-Soon Stacking)", () => {
    it("returns sanitized pins, real availableCategories including electric, excludes on-break drivers, and counts stackable on-ride drivers", async () => {
      const nowMs = 1_750_000_000_000;
      const db = createInMemoryFirestore({
        "live_tracking/d_ev": {
          driverId: "d_ev",
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["standard", "electric"],
          isPetFriendly: true,
          lastHeartbeatAtMs: nowMs - 15_000,
        },
        "live_tracking/d_break": {
          driverId: "d_break",
          isOnline: true,
          status: "busy",
          onBreak: true,
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["luxury"],
          lastHeartbeatAtMs: nowMs - 10_000,
        },
        "live_tracking/d_stackable": {
          driverId: "d_stackable",
          isOnline: true,
          status: "on_ride",
          isStackingEnabled: true,
          isPetFriendly: true,
          lat: nearbyLat,
          lng: nearbyLng,
          dropoffLat: pickupLat,
          dropoffLng: pickupLng,
          vehicleCategories: ["executive"],
          lastHeartbeatAtMs: nowMs - 10_000,
        },
        "live_tracking/d_nonpet": {
          driverId: "d_nonpet",
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["6seater"],
          isPetFriendly: false,
          lastHeartbeatAtMs: nowMs - 10_000,
        },
      });

      const allNearby = await getSanitizedNearbyDrivers({
        db: db as any,
        lat: pickupLat,
        lng: pickupLng,
        nowMs,
      });

      expect(allNearby.success).toBe(true);
      expect(allNearby.count).toBe(2); // d_ev + d_nonpet (d_break excluded, d_stackable counted in availableSoonCount)
      expect(allNearby.availableSoonCount).toBe(1);
      expect(allNearby.availableCategories).toContain("electric");
      expect(allNearby.availableCategories).toContain("executive");
      expect(allNearby.availableCategories).toContain("6seater");
      expect(allNearby.availableCategories).not.toContain("luxury");
      expect(allNearby.estimatedWaitEta).toBeTypeOf("number");
      // Ensure no raw driverId or PII leaks
      for (const pin of allNearby.drivers) {
        expect((pin as any).driverId).toBeUndefined();
      }

      const petOnly = await getSanitizedNearbyDrivers({
        db: db as any,
        lat: pickupLat,
        lng: pickupLng,
        isPetFriendly: true,
        nowMs,
      });
      expect(petOnly.count).toBe(1);
      expect(petOnly.availableSoonCount).toBe(1);
      expect(petOnly.availableCategories).toContain("electric");
      expect(petOnly.availableCategories).not.toContain("6seater");
    });
  });

  describe("3. Authoritative Passenger Ride Update Command", () => {
    it("transitions a draft ride to pending with electric category and recomputes fare server-side", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_draft_1": {
          riderId: "pax_1",
          passengerId: "pax_1",
          status: "draft",
          pickup: "10 High St",
          dropoff: "Leeds Station",
          pickupLat,
          pickupLng,
          dropoffLat: 53.7955,
          dropoffLng: -1.5476,
          carCategory: "standard",
          fareEstimate: 12.0,
        },
      });

      const res = await executePassengerUpdateRideCommand({
        db: db as any,
        caller: { uid: "pax_1" },
        rideId: "ride_draft_1",
        body: {
          carCategory: "electric",
          isPriority: true,
          isPetFriendly: false,
          distanceMiles: 15,
          durationMinutes: 30,
          confirmDraft: true,
        },
      });

      expect(res.success).toBe(true);
      expect(res.status).toBe("pending");
      expect(res.shouldRedispatch).toBe(true);

      const updated = db._store.get("ride_requests/ride_draft_1")!;
      expect(updated.status).toBe("pending");
      expect(updated.carCategory).toBe("electric");
      expect(updated.vehicleCategory).toBe("electric");
      expect(updated.isPriority).toBe(true);
      expect(updated.fareEstimate).toBe(res.fareEstimate);
    });

    it("locks pickup, vehicle category, and completed stops during an in_progress ride and syncs driver live_tracking dropoff", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_active_1": {
          riderId: "pax_1",
          passengerId: "pax_1",
          driverId: "drv_1",
          status: "in_progress",
          pickup: "Original Pickup",
          pickupAddress: "Original Pickup",
          pickupLat,
          pickupLng,
          dropoff: "Old Dropoff",
          dropoffAddress: "Old Dropoff",
          dropoffLat: 53.66,
          dropoffLng: -1.78,
          carCategory: "electric",
          isPetFriendly: true,
          isPriority: false,
          currentStopIndex: 1,
          stops: [
            { address: "Completed Stop 1", coords: { lat: 53.65, lng: -1.782 } },
            { address: "Pending Stop 2", coords: { lat: 53.655, lng: -1.781 } },
          ],
          fareEstimate: 18.0,
        },
        "live_tracking/drv_1": {
          driverId: "drv_1",
          activeRideId: "ride_active_1",
          status: "on_ride",
          dropoffLat: 53.66,
          dropoffLng: -1.78,
        },
      });

      const res = await executePassengerUpdateRideCommand({
        db: db as any,
        caller: { uid: "pax_1" },
        rideId: "ride_active_1",
        body: {
          pickup: "Hacked Pickup",
          pickupLat: 51.5,
          pickupLng: -0.1,
          dropoff: "New Airport Dropoff",
          dropoffLat: 53.8659,
          dropoffLng: -1.6606,
          stops: [
            { address: "Attempted Overwrite Stop 1", coords: { lat: 51.0, lng: -1.0 } },
            { address: "Updated Pending Stop 2", coords: { lat: 53.7, lng: -1.7 } },
          ],
          carCategory: "standard", // locked while active
          isPetFriendly: false, // locked while active
          distanceMiles: 20,
          durationMinutes: 35,
        },
      });

      expect(res.success).toBe(true);
      expect(res.assignedDriverId).toBe("drv_1");
      expect(res.shouldRedispatch).toBe(false);

      const ride = db._store.get("ride_requests/ride_active_1")!;
      // Pickup locked during in_progress
      expect(ride.pickup).toBe("Original Pickup");
      expect(ride.pickupLat).toBe(pickupLat);
      // Category & pet locked during active ride
      expect(ride.carCategory).toBe("electric");
      expect(ride.isPetFriendly).toBe(true);
      // Completed stop 0 preserved; pending stop 1 updated
      expect(ride.stops[0].address).toBe("Completed Stop 1");
      expect(ride.stops[1].address).toBe("Updated Pending Stop 2");
      // Dropoff updated on ride and driver live_tracking
      expect(ride.dropoff).toBe("New Airport Dropoff");
      expect(ride.dropoffAddress).toBe("New Airport Dropoff");
      const tracking = db._store.get("live_tracking/drv_1")!;
      expect(tracking.dropoffLat).toBe(53.8659);
      expect(tracking.dropoffLng).toBe(-1.6606);
    });

    it("rejects unauthorized passenger updates", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_other_1": {
          riderId: "pax_owner",
          status: "pending",
          pickup: "10 High St",
          dropoff: "Station",
        },
      });

      await expect(
        executePassengerUpdateRideCommand({
          db: db as any,
          caller: { uid: "pax_attacker" },
          rideId: "ride_other_1",
          body: { dropoff: "Tampered" },
        })
      ).rejects.toThrow(/not authorized to edit this ride/);
    });
  });

  describe("4. Authoritative Delayed Ride Reassignment Command", () => {
    it("releases a delayed accepted driver cleanly, clears passenger live_tracking link, and resets ride to pending", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_delayed_1": {
          riderId: "pax_1",
          passengerId: "pax_1",
          driverId: "drv_delayed",
          assignedDriverId: "drv_delayed",
          driverName: "Slow Driver",
          status: "accepted",
          pickup: "10 High St",
          dropoff: "Station",
          declinedBy: [],
        },
        "live_tracking/drv_delayed": {
          driverId: "drv_delayed",
          activeRideId: "ride_delayed_1",
          passengerId: "pax_1",
          riderId: "pax_1",
          status: "on_ride",
        },
        "driver_status/drv_delayed": {
          activeRideId: "ride_delayed_1",
          status: "on_ride",
        },
        "live_tracking/pax_1": {
          passengerId: "pax_1",
          driverId: "drv_delayed",
          activeRideId: "ride_delayed_1",
        },
      });

      const res = await executeReassignDelayedRideCommand({
        db: db as any,
        caller: { uid: "pax_1" },
        rideId: "ride_delayed_1",
      });

      expect(res.success).toBe(true);
      expect(res.previousDriverId).toBe("drv_delayed");
      expect(res.status).toBe("pending");

      const ride = db._store.get("ride_requests/ride_delayed_1")!;
      expect(ride.status).toBe("pending");
      expect(ride.driverId).toBeUndefined();
      expect(ride.declinedBy).toContain("drv_delayed");
      expect(ride.declinedDriverIds).toContain("drv_delayed");

      const drvTracking = db._store.get("live_tracking/drv_delayed")!;
      expect(drvTracking.status).toBe("available");
      expect(drvTracking.activeRideId).toBeUndefined();

      const paxTracking = db._store.get("live_tracking/pax_1")!;
      expect(paxTracking.driverId).toBeUndefined();
    });

    it("rejects reassignment once driver has already arrived", async () => {
      const db = createInMemoryFirestore({
        "ride_requests/ride_arrived_1": {
          riderId: "pax_1",
          driverId: "drv_1",
          status: "arrived",
        },
      });

      await expect(
        executeReassignDelayedRideCommand({
          db: db as any,
          caller: { uid: "pax_1" },
          rideId: "ride_arrived_1",
        })
      ).rejects.toThrow(/before your driver arrives/);
    });
  });

  describe("5. Dispatch Push Address Fallback & UI Integration Contracts", () => {
    it("reads pickup/dropoff fallback fields in dispatchRideOffersCommand so Android offer cards show real street addresses", async () => {
      const nowMs = 1_750_000_000_000;
      const db = createInMemoryFirestore({
        "ride_requests/ride_fallback_addr": {
          riderId: "pax_1",
          status: "pending",
          pickup: "22 King Street, Huddersfield",
          dropoff: "Manchester Airport Terminal 2",
          pickupLat,
          pickupLng,
          dropoffLat: 53.3537,
          dropoffLng: -2.275,
          carCategory: "electric",
          fareEstimate: 64.5,
        },
        "live_tracking/drv_ev": {
          driverId: "drv_ev",
          isOnline: true,
          status: "available",
          lat: nearbyLat,
          lng: nearbyLng,
          vehicleCategories: ["electric"],
          lastHeartbeatAtMs: nowMs - 5_000,
        },
        "users/drv_ev": {
          role: "driver",
          driverApproved: true,
          fcmToken: "tok_ev_1",
        },
      });

      const sendEachForMulticast = vi.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 0,
        responses: [{ success: true }],
      });
      const res = await dispatchRideOffersCommand({
        db: db as any,
        messagingClient: { sendEachForMulticast } as any,
        caller: { uid: "pax_1" },
        rideId: "ride_fallback_addr",
        nowMs,
      });

      expect(res.dispatchedCount).toBe(1);
      expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
      const pushArg = sendEachForMulticast.mock.calls[0][0];
      expect(pushArg.data.pickupAddress).toBe("22 King Street, Huddersfield");
      expect(pushArg.data.dropoffAddress).toBe("Manchester Airport Terminal 2");
      expect(pushArg.notification.body).toContain("22 King Street, Huddersfield");
      expect(pushArg.notification.body).toContain("Manchester Airport Terminal 2");
    });

    it("wires PassengerBooking and PassengerRideHistory to server-authoritative endpoints, Electric tier, and RideChat driver push", () => {
      const bookingSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/components/passenger/PassengerBooking.tsx"),
        "utf-8"
      );
      const historySrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/components/passenger/PassengerRideHistory.tsx"),
        "utf-8"
      );

      expect(bookingSrc).toMatch(/id:\s*['"]electric['"]/);
      expect(bookingSrc).toContain("/api/rides/nearby-drivers");
      expect(bookingSrc).toContain("/passenger-update");
      expect(bookingSrc).toContain("/reassign");
      expect(bookingSrc).toContain("passengerId={assignedDriverInfo?.uid || undefined}");
      expect(bookingSrc).not.toContain("simulateDriverAccepts");
      expect(bookingSrc).not.toContain("runDispatch");
      expect(bookingSrc).toContain("downloadRideReceipt");

      expect(historySrc).toContain("/api/rides/cancel");
      expect(historySrc).toContain("downloadRideReceipt");
      expect(historySrc).toContain("support_tickets");
    });
  });
});
