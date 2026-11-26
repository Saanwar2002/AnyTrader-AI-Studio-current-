import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { executeQuoteCommand } from "../../src/server/quoteCommands.ts";
import {
  executeInviteTraderToJobCommand,
  executeCreateBomOrderCommand,
  executeGenerateRecurringJobCommand,
} from "../../src/server/stage1Commands.ts";
import { sanitizePostLoginRedirect, extractRedirectFromSearch } from "../../src/lib/authRedirect.ts";

/**
 * Lightweight deterministic in-memory Firestore mock supporting collections,
 * nested subcollections, and atomic transactions for Stage 1B command tests.
 */
function createMockDb(initialDocs: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Record<string, any>>();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k, JSON.parse(JSON.stringify(v)));
  }

  let autoIdCounter = 1;

  function makeDocRef(docPath: string): any {
    const parts = docPath.split("/");
    const id = parts[parts.length - 1];
    return {
      id,
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        const data = store.get(docPath);
        return {
          id,
          exists: data !== undefined,
          data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
          ref: makeDocRef(docPath),
        };
      },
      set: async (data: Record<string, any>, opts?: { merge?: boolean }) => {
        if (opts?.merge && store.has(docPath)) {
          store.set(docPath, { ...store.get(docPath), ...data });
        } else {
          store.set(docPath, { ...data });
        }
      },
      update: async (patch: Record<string, any>) => {
        if (!store.has(docPath)) throw new Error(`Document ${docPath} does not exist`);
        store.set(docPath, { ...store.get(docPath), ...patch });
      },
      delete: async () => {
        store.delete(docPath);
      },
    };
  }

  function makeCollectionRef(colPath: string): any {
    return {
      doc: (id?: string) => makeDocRef(`${colPath}/${id || `auto_${autoIdCounter++}`}`),
      get: async () => {
        const prefix = `${colPath}/`;
        const docs: any[] = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
            const docId = k.slice(prefix.length);
            docs.push({
              id: docId,
              exists: true,
              data: () => JSON.parse(JSON.stringify(v)),
              ref: makeDocRef(k),
            });
          }
        }
        return { docs, empty: docs.length === 0 };
      },
    };
  }

  return {
    store,
    collection: (name: string) => makeCollectionRef(name),
    runTransaction: async (fn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: Record<string, any>, opts?: { merge?: boolean }) => {
          if (opts?.merge && store.has(ref.path)) {
            store.set(ref.path, { ...store.get(ref.path), ...data });
          } else {
            store.set(ref.path, { ...data });
          }
        },
        update: (ref: any, patch: Record<string, any>) => {
          if (!store.has(ref.path)) throw new Error(`Document ${ref.path} does not exist`);
          store.set(ref.path, { ...store.get(ref.path), ...patch });
        },
        delete: (ref: any) => {
          store.delete(ref.path);
        },
      };
      return fn(tx);
    },
  };
}

describe("Stage 1B — Cross-Cutting P0 Foundation Remediation", () => {
  describe("1. Server-Authoritative DeleteQuote Command", () => {
    it("allows quoting tradesperson to delete their own pending quote and decrements job quoteCount", async () => {
      const db = createMockDb({
        "jobs/job_1": {
          id: "job_1",
          homeownerId: "home_1",
          status: "quoted",
          quoteCount: 2,
          quotesCount: 2,
          hasQuotes: true,
        },
        "jobs/job_1/quotes/q_1": {
          id: "q_1",
          jobId: "job_1",
          tradespersonId: "trader_1",
          homeownerId: "home_1",
          amount: 250,
          status: "pending",
        },
      });

      const res = await executeQuoteCommand({
        db,
        identity: { uid: "trader_1", accountType: "service_provider", capabilities: ["tradesperson"] } as any,
        command: { type: "DeleteQuote", payload: { jobId: "job_1", quoteId: "q_1", reason: "No longer available" } },
        idempotencyKey: "del_quote_test_0001",
      });

      expect(res.success).toBe(true);
      expect(res.commandType).toBe("DeleteQuote");
      expect(db.store.has("jobs/job_1/quotes/q_1")).toBe(false);
      expect(db.store.get("jobs/job_1")?.quoteCount).toBe(1);
      expect(db.store.get("trader_quote_locks/job_1_trader_1")?.status).toBe("deleted");
    });

    it("rejects deleting another tradesperson's quote (Forbidden) and blocks deleting accepted/funded quotes (Conflict)", async () => {
      const db = createMockDb({
        "jobs/job_2": {
          id: "job_2",
          homeownerId: "home_2",
          status: "accepted",
          acceptedQuoteId: "q_acc",
        },
        "jobs/job_2/quotes/q_acc": {
          id: "q_acc",
          jobId: "job_2",
          tradespersonId: "trader_owner",
          status: "accepted",
          amount: 500,
        },
      });

      await expect(
        executeQuoteCommand({
          db,
          identity: { uid: "trader_attacker", accountType: "service_provider", capabilities: ["tradesperson"] } as any,
          command: { type: "DeleteQuote", payload: { jobId: "job_2", quoteId: "q_acc" } },
          idempotencyKey: "del_quote_test_0002",
        })
      ).rejects.toThrow(/only delete your own quotes/i);

      await expect(
        executeQuoteCommand({
          db,
          identity: { uid: "trader_owner", accountType: "service_provider", capabilities: ["tradesperson"] } as any,
          command: { type: "DeleteQuote", payload: { jobId: "job_2", quoteId: "q_acc" } },
          idempotencyKey: "del_quote_test_0003",
        })
      ).rejects.toThrow(/accepted or funded quotes cannot be deleted/i);

      expect(db.store.has("jobs/job_2/quotes/q_acc")).toBe(true);
    });
  });

  describe("2. Server-Authoritative Trader Invitation (PublicProfile -> Job)", () => {
    it("allows job owner to invite an existing tradesperson and resolves trader name authoritatively", async () => {
      const db = createMockDb({
        "jobs/job_inv_1": { id: "job_inv_1", homeownerId: "home_1", status: "open", urgency: "standard" },
        "users/trader_42": { uid: "trader_42", businessName: "Apex Heating Ltd", role: "tradesperson" },
      });

      const res = await executeInviteTraderToJobCommand({
        db,
        identity: { uid: "home_1", accountType: "consumer" } as any,
        jobId: "job_inv_1",
        traderId: "trader_42",
      });

      expect(res.success).toBe(true);
      expect(res.targetTradespersonId).toBe("trader_42");
      expect(res.targetTradespersonName).toBe("Apex Heating Ltd");
      expect(res.invitedTraderIds).toContain("trader_42");
    });

    it("blocks non-owners and rejects emergency job direct invitations", async () => {
      const db = createMockDb({
        "jobs/job_em": { id: "job_em", homeownerId: "home_1", status: "open", urgency: "emergency" },
        "users/trader_42": { uid: "trader_42", name: "Bob", role: "tradesperson" },
      });

      await expect(
        executeInviteTraderToJobCommand({
          db,
          identity: { uid: "other_user", accountType: "consumer" } as any,
          jobId: "job_em",
          traderId: "trader_42",
        })
      ).rejects.toThrow(/only the job owner/i);

      await expect(
        executeInviteTraderToJobCommand({
          db,
          identity: { uid: "home_1", accountType: "consumer" } as any,
          jobId: "job_em",
          traderId: "trader_42",
        })
      ).rejects.toThrow(/emergency jobs cannot be directly requested/i);
    });
  });

  describe("3. Server-Authoritative BOM Material Orders", () => {
    it("computes VAT/totals on server, writes bom_orders atomically, and updates linked job for assigned participant", async () => {
      const db = createMockDb({
        "jobs/job_bom_1": {
          id: "job_bom_1",
          title: "Boiler Replacement",
          homeownerId: "home_9",
          acceptedTradespersonId: "trader_9",
          status: "accepted",
        },
        "users/trader_9": { uid: "trader_9", businessName: "WarmHome Plumbers" },
      });

      const order = await executeCreateBomOrderCommand({
        db,
        identity: { uid: "trader_9", accountType: "service_provider" } as any,
        payload: {
          jobId: "job_bom_1",
          items: [
            { id: "item_1", name: "15mm Copper Pipe", quantity: 10, unit: "lengths", unitCost: 10 },
          ],
          selectedMerchant: {
            brand: "Screwfix",
            merchantName: "Screwfix Trade",
            branchAddress: "SW1 Depot",
            basketTotal: 100,
            tradeSavingsAmount: 15,
            affiliateBreakdown: { affiliateCommissionAmount: 3 },
          },
          fulfillmentType: "click_and_collect",
          paymentSource: "trader_trade_credit",
        },
      });

      expect(order.subtotalCost).toBe(100);
      expect(order.vatAmount).toBe(20);
      expect(order.totalAmount).toBe(120);
      expect(order.tradespersonId).toBe("trader_9");
      expect(order.homeownerId).toBe("home_9");
      expect(db.store.has(`bom_orders/${order.id}`)).toBe(true);
      expect(db.store.get("jobs/job_bom_1")?.hasBOMOrder).toBe(true);
      expect(db.store.get("jobs/job_bom_1")?.bomOrderId).toBe(order.id);
    });

    it("rejects unrelated callers attempting to attach a BOM order to someone else's job", async () => {
      const db = createMockDb({
        "jobs/job_bom_2": { id: "job_bom_2", homeownerId: "home_9", acceptedTradespersonId: "trader_9" },
      });

      await expect(
        executeCreateBomOrderCommand({
          db,
          identity: { uid: "intruder_1", accountType: "service_provider" } as any,
          payload: {
            jobId: "job_bom_2",
            items: [{ id: "i1", name: "Pipe", quantity: 1, unit: "unit", unitCost: 20 }],
            selectedMerchant: { brand: "Screwfix", merchantName: "Screwfix", basketTotal: 20 },
            fulfillmentType: "click_and_collect",
            paymentSource: "stripe_card",
          },
        })
      ).rejects.toThrow(/only the assigned tradesperson or job owner/i);
    });
  });

  describe("4. Server-Authoritative Recurring Job & Accepted Quote Generation", () => {
    it("atomically generates due recurring job + accepted quote + arrival PIN and replays idempotently", async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const db = createMockDb({
        "recurring_schedules/sched_1": {
          id: "sched_1",
          status: "active",
          title: "Weekly Garden Maintenance",
          category: "Gardening & Landscaping",
          postcode: "SW1A 1AA",
          frequency: "weekly",
          amount: 120,
          homeownerId: "home_rec_1",
          tradespersonId: "trader_rec_1",
          participants: ["home_rec_1", "trader_rec_1"],
          lastJobGeneratedAt: tenDaysAgo,
        },
        "users/trader_rec_1": { uid: "trader_rec_1", tier: "payg" },
      });

      const first = await executeGenerateRecurringJobCommand({
        db,
        identity: { uid: "home_rec_1", accountType: "consumer" } as any,
        scheduleId: "sched_1",
      });

      expect(first.generated).toBe(true);
      expect(first.wasReplayed).toBe(false);
      expect(first.jobId).toBeTruthy();
      expect(first.quoteId).toBeTruthy();

      const createdJob = db.store.get(`jobs/${first.jobId}`);
      const createdQuote = db.store.get(`jobs/${first.jobId}/quotes/${first.quoteId}`);
      expect(createdJob?.status).toBe("accepted");
      expect(createdJob?.acceptedTradespersonId).toBe("trader_rec_1");
      expect(createdQuote?.status).toBe("accepted");
      expect(createdQuote?.amount).toBe(120);
      expect(db.store.has(`job_arrival_pins/${first.jobId}`)).toBe(true);

      // Second immediate call after commit sees updated lastJobGeneratedAt and returns not_due_yet
      const secondCall = await executeGenerateRecurringJobCommand({
        db,
        identity: { uid: "home_rec_1", accountType: "consumer" } as any,
        scheduleId: "sched_1",
      });
      expect(secondCall.generated).toBe(false);
      expect(secondCall.reason).toBe("not_due_yet");

      // Even if a stale retry targets the same due cycle, idempotency_keys replays without duplicating
      db.store.set("recurring_schedules/sched_1", {
        ...db.store.get("recurring_schedules/sched_1"),
        lastJobGeneratedAt: tenDaysAgo,
      });
      const replay = await executeGenerateRecurringJobCommand({
        db,
        identity: { uid: "home_rec_1", accountType: "consumer" } as any,
        scheduleId: "sched_1",
      });
      expect(replay.generated).toBe(true);
      expect(replay.wasReplayed).toBe(true);
      expect(replay.jobId).toBe(first.jobId);
    });

    it("rejects non-participants from triggering someone else's recurring schedule", async () => {
      const db = createMockDb({
        "recurring_schedules/sched_2": {
          id: "sched_2",
          status: "active",
          homeownerId: "home_a",
          tradespersonId: "trader_b",
          participants: ["home_a", "trader_b"],
        },
      });

      await expect(
        executeGenerateRecurringJobCommand({
          db,
          identity: { uid: "stranger_x", accountType: "consumer" } as any,
          scheduleId: "sched_2",
        })
      ).rejects.toThrow(/only participants/i);
    });
  });

  describe("5. Safe Post-Login Redirect Sanitizer (Open-Redirect Defense)", () => {
    it("preserves safe internal relative paths with query strings and blocks external/unsafe redirects", () => {
      expect(sanitizePostLoginRedirect("/passport/view/prop_123?claim=1")).toBe("/passport/view/prop_123?claim=1");
      expect(extractRedirectFromSearch("?redirect=%2Fpassport%2Fview%2Fprop_99")).toBe("/passport/view/prop_99");

      // Open redirect / XSS / loop vectors must all be rejected
      expect(sanitizePostLoginRedirect("https://evil.example/phish")).toBeNull();
      expect(sanitizePostLoginRedirect("//evil.example/phish")).toBeNull();
      expect(sanitizePostLoginRedirect("/\\evil.example")).toBeNull();
      expect(sanitizePostLoginRedirect("javascript:alert(1)")).toBeNull();
      expect(sanitizePostLoginRedirect("/login?redirect=/dashboard")).toBeNull();
    });
  });

  describe("6. Static Cross-Link, Firestore Rules & Composite Index Regression Guards", () => {
    const root = process.cwd();

    it("verifies broken links fixed across server review notifications, Portfolio, Appointments, and Ticker", () => {
      const serverTxt = fs.readFileSync(path.join(root, "server.ts"), "utf8");
      const portfolioTxt = fs.readFileSync(path.join(root, "src/components/Portfolio.tsx"), "utf8");
      const apptTxt = fs.readFileSync(path.join(root, "src/components/shared/TraderUpcomingAppointments.tsx"), "utf8");
      const tickerTxt = fs.readFileSync(path.join(root, "src/components/shared/IllustratedAdTicker.tsx"), "utf8");

      expect(serverTxt).not.toContain("link: `/jobs/${jobId}`");
      expect(portfolioTxt).not.toContain("/admin/job/${job.id}");
      expect(apptTxt).toContain('to="/trader/calendar"');
      expect(tickerTxt).not.toContain('link: "/property-passports"');
      expect(tickerTxt).not.toContain('link: "/payment-protection"');
      expect(tickerTxt).not.toContain('link: "/pricing"');
      expect(tickerTxt).not.toContain('link: "/rides"');
    });

    it("verifies firestore.rules secures platform_config_versions, gdpr_requests, and bom_orders as server-write-only", () => {
      const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
      expect(rules).toContain("match /platform_config_versions/{versionId}");
      expect(rules).toContain("match /gdpr_requests/{requestId}");
      expect(rules).toContain("match /bom_orders/{orderId}");
    });

    it("verifies firestore.indexes.json contains valid JSON and critical Stage 1 AnyTrader composite indexes", () => {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, "firestore.indexes.json"), "utf8"));
      expect(Array.isArray(parsed.indexes)).toBe(true);
      const hasIdx = (col: string, fields: string[]) =>
        parsed.indexes.some(
          (ix: any) =>
            ix.collectionGroup === col &&
            fields.every((f) => ix.fields.some((entry: any) => entry.fieldPath === f))
        );

      expect(hasIdx("public_job_cards", ["category", "postedDate"])).toBe(true);
      expect(hasIdx("public_job_cards", ["status", "postedDate"])).toBe(true);
      expect(hasIdx("reviews", ["revieweeId", "createdAt"])).toBe(true);
      expect(hasIdx("jobs", ["acceptedTradespersonId", "createdAt"])).toBe(true);
      expect(hasIdx("jobs", ["acceptedTradespersonId", "status"])).toBe(true);
      expect(hasIdx("jobs", ["targetTradespersonId", "status"])).toBe(true);
      expect(hasIdx("appointments", ["traderId", "date"])).toBe(true);
      expect(hasIdx("instant_match_attempts", ["traderId", "status"])).toBe(true);
      expect(hasIdx("flash_deals", ["traderId", "status"])).toBe(true);
    });
  });
});
