import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRideFinancialSummary } from "../../src/lib/rideEarningsDisplay.ts";
import { estimateUkSoleTraderTaxReserve, UK_TAX_ESTIMATOR_DISCLAIMER } from "../../src/lib/ukTaxEstimator.ts";
import { executeCompleteRideCommand, recordDriverOnlineHeartbeat } from "../../src/server/rideLifecycleCommands.ts";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../../src/server/httpErrors.ts";

function createInMemoryDb(seed: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [k, v] of Object.entries(seed)) {
    store[k] = { ...v };
  }

  function resolveFieldValue(prev: any, val: any): any {
    if (val && typeof val === "object") {
      if (val.constructor?.name === "ServerTimestampTransform") {
        return "2026-11-20T09:00:00.000Z";
      }
      if (val.constructor?.name === "DeleteTransform") {
        return undefined;
      }
      if (typeof val.operand === "number") {
        return (typeof prev === "number" ? prev : 0) + val.operand;
      }
    }
    return val;
  }

  function applyPatch(current: Record<string, any>, patch: Record<string, any>, merge = false) {
    const next: Record<string, any> = merge ? { ...current } : {};
    for (const [key, val] of Object.entries(patch)) {
      const resolved = resolveFieldValue(next[key], val);
      if (resolved === undefined) {
        delete next[key];
      } else {
        next[key] = resolved;
      }
    }
    return next;
  }

  function makeRef(col: string, id: string) {
    const docPath = `${col}/${id}`;
    return {
      id,
      path: docPath,
      async get() {
        const data = store[docPath];
        return {
          exists: Boolean(data),
          id,
          ref: makeRef(col, id),
          data: () => (data ? { ...data } : undefined),
        };
      },
      async set(data: Record<string, any>, opts?: { merge?: boolean }) {
        store[docPath] = applyPatch(store[docPath] || {}, data, opts?.merge === true);
      },
      async update(data: Record<string, any>) {
        if (!store[docPath]) {
          throw new Error(`Document ${docPath} does not exist`);
        }
        store[docPath] = applyPatch(store[docPath], data, true);
      },
    };
  }

  return {
    _store: store,
    collection(col: string) {
      return {
        doc(id: string) {
          return makeRef(col, id);
        },
      };
    },
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        async get(ref: any) {
          return ref.get();
        },
        set(ref: any, data: Record<string, any>, opts?: { merge?: boolean }) {
          store[ref.path] = applyPatch(store[ref.path] || {}, data, opts?.merge === true);
        },
        update(ref: any, data: Record<string, any>) {
          if (!store[ref.path]) {
            throw new Error(`Document ${ref.path} does not exist`);
          }
          store[ref.path] = applyPatch(store[ref.path], data, true);
        },
        create(ref: any, data: Record<string, any>) {
          if (store[ref.path]) {
            throw new Error(`Document ${ref.path} already exists`);
          }
          store[ref.path] = applyPatch({}, data, false);
        },
      };
      return fn(tx);
    },
  };
}

describe("Batch 10 — AnyRoller Driver Earnings, Metrics Integrity & UK Tax Heuristic", () => {
  describe("AT-RIDE-PAY-08: Canonical Server-Verified Ride Earnings & UI/Export Guardrails", () => {
    it("prefers persisted v2_excl_tip server payout fields and respects 10% Gold Driver commission without double-adding tips", () => {
      const summary = resolveRideFinancialSummary(
        {
          fareContractVersion: "v2_excl_tip",
          finalFare: 50,
          tipAmount: 5,
          totalFarePaid: 55,
          platformFee: 5,
          driverEarnings: 50, // (50 - 5) + 5 tip
          appliedCommissionRate: 0.1,
        },
        { commissionRate: 0.15, fixedTripFee: 1.0 }
      );

      expect(summary.isServerVerified).toBe(true);
      expect(summary.baseFare).toBe(50);
      expect(summary.tipAmount).toBe(5);
      expect(summary.totalFarePaid).toBe(55);
      expect(summary.platformFee).toBe(5);
      expect(summary.driverEarnings).toBe(50);
      expect(summary.driverBaseShare).toBe(45);
      expect(summary.appliedCommissionPct).toBe(10);
    });

    it("uses fallback config rather than hardcoded 12% when legacy rides omit server payout fields", () => {
      const summary = resolveRideFinancialSummary(
        {
          totalFare: 40,
          tipAmount: 4,
        },
        { commissionRate: 0.1, fixedTripFee: 1.5 }
      );

      expect(summary.isServerVerified).toBe(false);
      expect(summary.totalFarePaid).toBe(44);
      expect(summary.platformFee).toBe(5.5); // 40 * 0.1 + 1.5
      expect(summary.driverBaseShare).toBe(34.5);
      expect(summary.driverEarnings).toBe(38.5);
      expect(summary.appliedCommissionPct).toBe(10);
    });

    it("ensures DriverEarnings, DriverJobs, DriverFullTripHistory & BillingTab removed hardcoded multipliers and reverse-division", () => {
      const root = process.cwd();
      const driverEarningsSrc = fs.readFileSync(
        path.join(root, "src/components/driver/DriverEarnings.tsx"),
        "utf-8"
      );
      const driverJobsSrc = fs.readFileSync(
        path.join(root, "src/components/driver/DriverJobs.tsx"),
        "utf-8"
      );
      const tripHistorySrc = fs.readFileSync(
        path.join(root, "src/components/driver/DriverFullTripHistory.tsx"),
        "utf-8"
      );
      const billingTabSrc = fs.readFileSync(
        path.join(root, "src/components/BillingTab.tsx"),
        "utf-8"
      );

      // DriverEarnings no longer reverse-divides net earnings or writes directly to driver_profiles
      expect(driverEarningsSrc).not.toContain("/ (1 - fareConfig.commissionRate)");
      expect(driverEarningsSrc).not.toContain('doc(db, "driver_profiles"');
      expect(driverEarningsSrc).toContain("resolveRideFinancialSummary");

      // DriverJobs no longer hardcodes * 0.12 or Platform Commission (12%)
      expect(driverJobsSrc).not.toContain("* 0.12");
      expect(driverJobsSrc).not.toContain("Platform Commission (12%)");
      expect(driverJobsSrc).toContain("resolveRideFinancialSummary");

      // DriverFullTripHistory no longer hardcodes 0.12 or double-adds tipAmount onto netFare
      expect(tripHistorySrc).not.toContain("totalFare * 0.12");
      expect(tripHistorySrc).not.toContain("netFare + (trip.tipAmount || 0)");
      expect(tripHistorySrc).toContain("resolveRideFinancialSummary");

      // BillingTab no longer uses 0.8 / 0.2 Priority multipliers
      expect(billingTabSrc).not.toContain("totalSpent * 0.8");
      expect(billingTabSrc).not.toContain("totalSpent * 0.2");
      expect(billingTabSrc).toContain("resolveRideFinancialSummary");
    });
  });

  describe("AT-RIDE-PAY-09: driver_metrics Server-Only Writes & Heartbeat Telemetry", () => {
    it("locks driver_metrics against all client writes in firestore.rules and removes client writes from DriverTerminal", () => {
      const root = process.cwd();
      const rulesSrc = fs.readFileSync(path.join(root, "firestore.rules"), "utf-8");
      const terminalSrc = fs.readFileSync(
        path.join(root, "src/components/driver/DriverTerminal.tsx"),
        "utf-8"
      );

      const metricsRuleMatch = rulesSrc.match(/match \/driver_metrics\/\{driverId\}\s*\{[\s\S]*?\}/);
      expect(metricsRuleMatch).toBeTruthy();
      expect(metricsRuleMatch![0]).toContain("allow write: if false;");

      // DriverTerminal no longer executes direct client updateDoc/setDoc against driver_metrics
      expect(terminalSrc).not.toMatch(/updateDoc\(\s*doc\(db,\s*["']driver_metrics["']/);
      expect(terminalSrc).not.toMatch(/setDoc\(\s*doc\(db,\s*["']driver_metrics["']/);
      expect(terminalSrc).toContain("/api/driver/metrics/heartbeat");
    });

    it("records bounded heartbeat increments, throttles rapid replays, resets on UTC rollover, and flags safety limit", async () => {
      const db = createInMemoryDb({
        "users/drv_1": { uid: "drv_1", role: "driver" },
        "platform_config/rides": { maxDailyDriverHours: 10 },
      });

      const day1 = Date.parse("2026-11-20T10:00:00.000Z");
      const first = await recordDriverOnlineHeartbeat({
        db,
        caller: { uid: "drv_1" },
        nowMs: day1,
      });
      expect(first.onlineSecondsToday).toBe(60);
      expect(first.incrementSeconds).toBe(60);
      expect(first.limitReached).toBe(false);

      // Replay 10 seconds later must throttle incrementSeconds to 0
      const replay = await recordDriverOnlineHeartbeat({
        db,
        caller: { uid: "drv_1" },
        nowMs: day1 + 10_000,
      });
      expect(replay.onlineSecondsToday).toBe(60);
      expect(replay.incrementSeconds).toBe(0);

      // Next heartbeat after 60s adds 60s
      const second = await recordDriverOnlineHeartbeat({
        db,
        caller: { uid: "drv_1" },
        nowMs: day1 + 60_000,
      });
      expect(second.onlineSecondsToday).toBe(120);

      // Approaching 10h safety cap triggers limitReached
      db._store["driver_metrics/drv_1"].onlineSecondsToday = 10 * 3600 - 30;
      db._store["driver_metrics/drv_1"].lastHeartbeatAtMs = day1;
      const capped = await recordDriverOnlineHeartbeat({
        db,
        caller: { uid: "drv_1" },
        nowMs: day1 + 60_000,
      });
      expect(capped.onlineSecondsToday).toBe(10 * 3600);
      expect(capped.limitReached).toBe(true);

      // UTC day rollover resets onlineSecondsToday, dailyEarnings, and jobsDoneToday cleanly
      db._store["driver_metrics/drv_1"].dailyEarnings = 140;
      db._store["driver_metrics/drv_1"].jobsDoneToday = 4;
      const nextDay = Date.parse("2026-11-21T01:00:00.000Z");
      const rolledOver = await recordDriverOnlineHeartbeat({
        db,
        caller: { uid: "drv_1" },
        nowMs: nextDay,
      });
      expect(rolledOver.date).toBe("2026-11-21");
      expect(rolledOver.onlineSecondsToday).toBe(60);
      expect(rolledOver.dailyEarnings).toBe(0);
      expect(rolledOver.jobsDoneToday).toBe(0);
      expect(rolledOver.limitReached).toBe(false);
    });

    it("rejects unauthenticated, missing, and suspended drivers in recordDriverOnlineHeartbeat", async () => {
      const db = createInMemoryDb({
        "users/drv_suspended": { uid: "drv_suspended", accountStatus: "suspended" },
      });

      await expect(
        recordDriverOnlineHeartbeat({ db, caller: { uid: "" } })
      ).rejects.toThrow(UnauthorizedError);

      await expect(
        recordDriverOnlineHeartbeat({ db, caller: { uid: "missing_drv" } })
      ).rejects.toThrow(NotFoundError);

      await expect(
        recordDriverOnlineHeartbeat({ db, caller: { uid: "drv_suspended" } })
      ).rejects.toThrow(ForbiddenError);
    });

    it("credits driver_metrics strictly with NET earnings (never gross) when completing rides across UTC rollover", async () => {
      const db = createInMemoryDb({
        "users/drv_net": { uid: "drv_net", role: "driver" },
        "users/rider_net": { uid: "rider_net", role: "customer" },
        "platform_config/rides": { commission: 12, fixedTripFee: 0 },
        "driver_metrics/drv_net": {
          driverId: "drv_net",
          date: "2020-01-01",
          dailyEarnings: 500,
          jobsDoneToday: 9,
          onlineSecondsToday: 7200,
        },
        "ride_requests/ride_net_1": {
          id: "ride_net_1",
          status: "in_progress",
          driverId: "drv_net",
          assignedDriverId: "drv_net",
          passengerId: "rider_net",
          fareEstimate: 50,
          tipAmount: 5,
          paymentMethod: "cash",
        },
      });

      const res = await executeCompleteRideCommand({
        db,
        caller: { uid: "drv_net" },
        rideId: "ride_net_1",
        action: "cash_report",
        cashCollected: 55,
      });

      // Gross = 50 + 5 = 55; Commission = 12% of 50 = 6.00; Net driverEarnings = 44 + 5 = 49
      expect(res.finalFare).toBe(50);
      expect(res.platformFee).toBe(6);
      expect(res.driverEarnings).toBe(49);

      // Daily metrics rolled over to today and credited net £49 (not gross £55 or yesterday's £500)
      const metrics = db._store["driver_metrics/drv_net"];
      expect(metrics.dailyEarnings).toBe(49);
      expect(metrics.jobsDoneToday).toBe(1);
      expect(metrics.onlineSecondsToday).toBe(0);
    });
  });

  describe("AT-CJ-FIN-01: Banded UK Self-Assessment Income Tax & Class 4 NI Estimator", () => {
    it("calculates zero tax/NI within £12,570 personal allowance after configurable expenses", () => {
      // Gross £16,000 * (1 - 0.25) = £12,000 taxable profit (< £12,570)
      const res = estimateUkSoleTraderTaxReserve({ grossPaidGbp: 16000, expenseRatioPct: 25 });
      expect(res.estimatedExpensesGbp).toBe(4000);
      expect(res.estimatedTaxableProfitGbp).toBe(12000);
      expect(res.incomeTaxGbp).toBe(0);
      expect(res.class4NiGbp).toBe(0);
      expect(res.totalEstimatedReserveGbp).toBe(0);
      expect(res.taxBandLabel).toContain("Within Personal Allowance");
      expect(res.disclaimer).toBe(UK_TAX_ESTIMATOR_DISCLAIMER);
    });

    it("applies Basic Rate 20% Income Tax + 6% Class 4 NI accurately", () => {
      // Gross £40,000, 25% expenses -> £30,000 taxable profit
      // Above £12,570 = £17,430 => IT = 3,486.00; Class 4 NI (6%) = 1,045.80; total = 4,532 rounded
      const res = estimateUkSoleTraderTaxReserve({ grossPaidGbp: 40000, expenseRatioPct: 25 });
      expect(res.estimatedTaxableProfitGbp).toBe(30000);
      expect(res.incomeTaxGbp).toBe(3486);
      expect(res.class4NiGbp).toBe(1045.8);
      expect(res.totalEstimatedReserveGbp).toBe(4532);
      expect(res.taxBandLabel).toContain("Basic Rate Band");
    });

    it("applies Higher Rate 40% IT + 2% Class 4 NI and PA taper above £100k", () => {
      // Profit £70,000 (at 0% expenses)
      const higher = estimateUkSoleTraderTaxReserve({ grossPaidGbp: 70000, expenseRatioPct: 0 });
      // Taxable above £12,570 = £57,430 -> 37,700*0.2 + 19,730*0.4 = 7,540 + 7,892 = 15,432
      // Class 4 NI = (50,270 - 12,570)*0.06 + (70,000 - 50,270)*0.02 = 2,262 + 394.6 = 2,656.60
      expect(higher.incomeTaxGbp).toBe(15432);
      expect(higher.class4NiGbp).toBe(2656.6);
      expect(higher.taxBandLabel).toContain("Higher Rate Band");

      // Profit £150,000 (0% expenses) -> PA tapered completely to 0, Additional rate 45% IT applies
      const additional = estimateUkSoleTraderTaxReserve({ grossPaidGbp: 150000, expenseRatioPct: 0 });
      expect(additional.effectivePersonalAllowanceGbp).toBe(0);
      expect(additional.taxBandLabel).toContain("Additional Rate Band");
      // IT = 37,700*0.2 + (125,140 - 37,700)*0.4 + (150,000 - 125,140)*0.45 = 7,540 + 34,976 + 11,187 = 53,703
      expect(additional.incomeTaxGbp).toBe(53703);
    });

    it("renders banded reserve estimator & disclaimer inside FinancialDashboardWidget", () => {
      const widgetSrc = fs.readFileSync(
        path.join(process.cwd(), "src/components/FinancialDashboardWidget.tsx"),
        "utf-8"
      );
      expect(widgetSrc).toContain("estimateUkSoleTraderTaxReserve");
      expect(widgetSrc).toContain("taxEstimate.disclaimer");
      expect(widgetSrc).not.toContain("* 0.28");
    });
  });
});
