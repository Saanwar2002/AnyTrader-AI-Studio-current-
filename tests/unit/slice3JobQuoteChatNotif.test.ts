import { describe, it, expect, vi } from "vitest";
import { executeDeleteJobCommand, executeUpdateJobCommand } from "../../src/server/createJobCommand";
import { executeJobScheduleActionCommand } from "../../src/server/jobLifecycleCommands";
import { executeQuoteCommand, executeAcceptQuoteCommand } from "../../src/server/quoteCommands";
import {
  authorizeNotificationRequest,
  validateNotificationPayload,
} from "../../src/server/authorization";
import {
  areUsersChatBlocked,
  listUserChatBlocksCommand,
} from "../../src/server/chatSafety";
import type { CanonicalIdentity } from "../../src/server/identity";

function createInMemoryFirestore(initial: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Record<string, any>>();
  for (const [path, data] of Object.entries(initial)) {
    store.set(path, structuredClone(data));
  }
  let autoIdCounter = 1;

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop()!,
    path,
    async get() {
      const val = store.get(path);
      return {
        id: path.split("/").pop()!,
        exists: val !== undefined,
        data: () => (val !== undefined ? structuredClone(val) : undefined),
      };
    },
    async set(data: Record<string, any>, opts?: { merge?: boolean }) {
      const prev = store.get(path);
      if (opts?.merge && prev) {
        store.set(path, structuredClone({ ...prev, ...data }));
      } else {
        store.set(path, structuredClone(data));
      }
    },
    async update(data: Record<string, any>) {
      const prev = store.get(path) || {};
      store.set(path, structuredClone({ ...prev, ...data }));
    },
    async delete() {
      store.delete(path);
    },
    collection(subName: string) {
      return makeCollectionRef(`${path}/${subName}`);
    },
  });

  const makeQuery = (colPath: string, filters: Array<{ field: string; op: string; value: any }> = [], limitN?: number): any => ({
    where(field: string, op: string, value: any) {
      return makeQuery(colPath, [...filters, { field, op, value }], limitN);
    },
    limit(n: number) {
      return makeQuery(colPath, filters, n);
    },
    async get() {
      const prefix = `${colPath}/`;
      const matches: Array<{ id: string; ref: any; data: () => any }> = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(prefix)) continue;
        const remainder = k.slice(prefix.length);
        if (remainder.includes("/")) continue;
        const passes = filters.every((f) => {
          const fv = v[f.field];
          if (f.op === "==") return fv === f.value;
          return true;
        });
        if (passes) {
          matches.push({
            id: remainder,
            ref: makeDocRef(k),
            data: () => structuredClone(v),
          });
        }
      }
      const sliced = typeof limitN === "number" ? matches.slice(0, limitN) : matches;
      return {
        empty: sliced.length === 0,
        size: sliced.length,
        docs: sliced,
      };
    },
  });

  const makeCollectionRef = (colPath: string): any => ({
    doc(id?: string) {
      const resolvedId = id || `auto_${autoIdCounter++}`;
      return makeDocRef(`${colPath}/${resolvedId}`);
    },
    async add(data: Record<string, any>) {
      const ref = makeDocRef(`${colPath}/auto_${autoIdCounter++}`);
      await ref.set(data);
      return ref;
    },
    where(field: string, op: string, value: any) {
      return makeQuery(colPath, [{ field, op, value }]);
    },
    limit(n: number) {
      return makeQuery(colPath, [], n);
    },
    async get() {
      return makeQuery(colPath, []).get();
    },
  });

  const db: any = {
    store,
    collection(name: string) {
      return makeCollectionRef(name);
    },
    async runTransaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        async get(refOrQuery: any) {
          return refOrQuery.get();
        },
        set(ref: any, data: any, opts?: any) {
          const prev = store.get(ref.path);
          if (opts?.merge && prev) {
            store.set(ref.path, structuredClone({ ...prev, ...data }));
          } else {
            store.set(ref.path, structuredClone(data));
          }
        },
        update(ref: any, data: any) {
          const prev = store.get(ref.path) || {};
          store.set(ref.path, structuredClone({ ...prev, ...data }));
        },
        delete(ref: any) {
          store.delete(ref.path);
        },
      };
      return fn(tx);
    },
  };

  return db;
}

const homeownerIdentity: CanonicalIdentity = {
  uid: "homeowner_1",
  email: "homeowner@example.com",
  accountType: "consumer",
  capabilities: ["homeowner"],
  verification: { status: "verified" },
  subscription: { tierId: "PAYG", status: "active" },
};

const trader1Identity: CanonicalIdentity = {
  uid: "trader_1",
  email: "trader1@example.com",
  accountType: "service_provider",
  capabilities: ["tradesperson"],
  verification: { status: "verified" },
  subscription: { tierId: "PAYG", status: "active" },
};

const outsiderIdentity: CanonicalIdentity = {
  uid: "outsider_99",
  email: "outsider@example.com",
  accountType: "consumer",
  capabilities: ["homeowner"],
  verification: { status: "verified" },
  subscription: { tierId: "PAYG", status: "active" },
};

describe("Slice 3 Hardening — Job Lifecycle, Quoting, Chat Blocks & Notifications", () => {
  describe("Server-Authoritative Job Delete & Archive (No Ghost public_job_cards)", () => {
    it("atomically deletes job, public_job_cards projection, and arrival PIN", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_1": {
          id: "job_1",
          homeownerId: "homeowner_1",
          title: "Fix leaking tap",
          status: "open",
        },
        "public_job_cards/job_1": {
          id: "job_1",
          title: "Fix leaking tap",
          status: "open",
        },
        "job_arrival_pins/job_1": {
          jobId: "job_1",
          verificationPin: "4321",
        },
      });

      const res = await executeDeleteJobCommand({
        db,
        identity: homeownerIdentity,
        jobId: "job_1",
        mode: "delete",
      });

      expect(res.deleted).toBe(true);
      expect(res.publicCardRemoved).toBe(true);
      expect(db.store.has("jobs/job_1")).toBe(false);
      expect(db.store.has("public_job_cards/job_1")).toBe(false);
      expect(db.store.has("job_arrival_pins/job_1")).toBe(false);
    });

    it("archive mode soft-deletes open job, cancels it, and removes public_job_cards", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_2": {
          id: "job_2",
          homeownerId: "homeowner_1",
          title: "Paint hallway",
          status: "quoted",
        },
        "public_job_cards/job_2": {
          id: "job_2",
          title: "Paint hallway",
          status: "quoted",
        },
      });

      const res = await executeDeleteJobCommand({
        db,
        identity: homeownerIdentity,
        jobId: "job_2",
        mode: "archive",
      });

      expect(res.mode).toBe("archive");
      expect(res.publicCardRemoved).toBe(true);
      expect(db.store.has("public_job_cards/job_2")).toBe(false);
      expect(db.store.get("jobs/job_2")?.clientDeleted).toBe(true);
      expect(db.store.get("jobs/job_2")?.status).toBe("cancelled");
    });

    it("blocks non-owners and blocks deleting accepted/funded jobs", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_active": {
          id: "job_active",
          homeownerId: "homeowner_1",
          status: "accepted",
        },
        "jobs/job_funded": {
          id: "job_funded",
          homeownerId: "homeowner_1",
          status: "completed",
          paymentStatus: "funded",
        },
      });

      await expect(
        executeDeleteJobCommand({ db, identity: outsiderIdentity, jobId: "job_active", mode: "delete" })
      ).rejects.toThrow(/owner/i);

      await expect(
        executeDeleteJobCommand({ db, identity: homeownerIdentity, jobId: "job_active", mode: "delete" })
      ).rejects.toThrow(/active job/i);

      await expect(
        executeDeleteJobCommand({ db, identity: homeownerIdentity, jobId: "job_funded", mode: "delete" })
      ).rejects.toThrow(/funded or paid escrow/i);
    });
  });

  describe("Emergency Expiry Actions Sync public_job_cards Atomically", () => {
    it("convertToStandard sets canonical standard urgency and updates public_job_cards", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_emg": {
          id: "job_emg",
          homeownerId: "homeowner_1",
          title: "Burst pipe",
          category: "Plumbing",
          postcode: "SW1A 1AA",
          urgency: "emergency",
          isEmergency: true,
          status: "open",
        },
        "public_job_cards/job_emg": {
          id: "job_emg",
          urgency: "emergency",
          status: "open",
        },
      });

      const res = await executeUpdateJobCommand({
        db,
        identity: homeownerIdentity,
        jobId: "job_emg",
        rawPayload: { convertToStandard: true },
      });

      expect(res.publicCardSynced).toBe(true);
      expect(db.store.get("jobs/job_emg")?.urgency).toBe("standard");
      expect(db.store.get("jobs/job_emg")?.isEmergency).toBe(false);
      expect(db.store.get("public_job_cards/job_emg")?.urgency).toBe("standard");
    });

    it("repostAsEmergency sets server-controlled 2h emergency window and syncs public card", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_emg2": {
          id: "job_emg2",
          homeownerId: "homeowner_1",
          title: "No heating",
          category: "Heating",
          postcode: "E1 6AN",
          urgency: "emergency",
          isEmergency: true,
          status: "open",
        },
      });

      const res = await executeUpdateJobCommand({
        db,
        identity: homeownerIdentity,
        jobId: "job_emg2",
        rawPayload: { repostAsEmergency: true },
      });

      expect(res.job.urgency).toBe("emergency");
      expect(typeof res.job.emergencyBoostExpiresAt).toBe("string");
      expect(db.store.get("public_job_cards/job_emg2")?.urgency).toBe("emergency");
    });
  });

  describe("Server-Authoritative Scheduling & Atomic Trader Calendar Sync", () => {
    it("proposes reschedule to actual counterparty and atomically updates trader dateOverrides on accept", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_sched": {
          id: "job_sched",
          title: "Boiler Service",
          homeownerId: "homeowner_1",
          acceptedTradespersonId: "trader_1",
          status: "accepted",
          scheduledDate: "2026-12-01",
          isConfirmedByTradesperson: true,
        },
        "users/trader_1": {
          uid: "trader_1",
          dateOverrides: { "2026-12-01": "booked", "2026-12-03": "busy" },
        },
      });

      // Homeowner initiates reschedule -> notifies trader_1 (NOT homeowner_1!)
      const proposeRes = await executeJobScheduleActionCommand({
        db,
        identity: homeownerIdentity,
        jobId: "job_sched",
        action: "propose_reschedule",
        proposedDate: "2026-12-05",
        reason: "Away on Monday",
      });
      expect(proposeRes.rescheduleProposal?.proposedBy).toBe("homeowner_1");

      const notifsAfterPropose = Array.from(db.store.entries())
        .filter(([k]) => k.startsWith("notifications/"))
        .map(([, v]) => v);
      expect(notifsAfterPropose.some((n) => n.userId === "trader_1" && n.title.includes("Reschedule"))).toBe(true);

      // Homeowner cannot accept their own proposal
      await expect(
        executeJobScheduleActionCommand({
          db,
          identity: homeownerIdentity,
          jobId: "job_sched",
          action: "accept_reschedule",
        })
      ).rejects.toThrow(/own reschedule proposal/i);

      // Trader accepts -> atomically updates job scheduledDate & trader dateOverrides
      const acceptRes = await executeJobScheduleActionCommand({
        db,
        identity: trader1Identity,
        jobId: "job_sched",
        action: "accept_reschedule",
      });
      expect(acceptRes.scheduledDate).toBe("2026-12-05");
      expect(acceptRes.calendarSynced).toBe(true);
      expect(db.store.get("users/trader_1")?.dateOverrides["2026-12-01"]).toBeUndefined();
      expect(db.store.get("users/trader_1")?.dateOverrides["2026-12-05"]).toBe("booked");
      expect(db.store.get("users/trader_1")?.dateOverrides["2026-12-03"]).toBe("busy");
    });

    it("confirm_booking restricts to assigned trader and books date on calendar", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_conf": {
          id: "job_conf",
          title: "Socket Install",
          homeownerId: "homeowner_1",
          acceptedTradespersonId: "trader_1",
          status: "accepted",
          scheduledDate: "2026-12-10",
          isConfirmedByTradesperson: false,
        },
        "users/trader_1": {
          uid: "trader_1",
          dateOverrides: {},
        },
      });

      await expect(
        executeJobScheduleActionCommand({
          db,
          identity: homeownerIdentity,
          jobId: "job_conf",
          action: "confirm_booking",
        })
      ).rejects.toThrow(/assigned tradesperson/i);

      const res = await executeJobScheduleActionCommand({
        db,
        identity: trader1Identity,
        jobId: "job_conf",
        action: "confirm_booking",
      });

      expect(res.isConfirmedByTradesperson).toBe(true);
      expect(res.calendarSynced).toBe(true);
      expect(db.store.get("users/trader_1")?.dateOverrides["2026-12-10"]).toBe("booked");
    });
  });

  describe("Bidirectional Chat Blocks & Appointment Notification Authorization", () => {
    it("blocks cross-user notifications in both directions when chat_user_blocks is active", async () => {
      const db = createInMemoryFirestore({
        "conversations/conv_1": {
          participants: ["homeowner_1", "trader_1"],
        },
        "chat_user_blocks/homeowner_1__trader_1": {
          blockerUid: "homeowner_1",
          blockedUid: "trader_1",
          active: true,
        },
      });

      const blockedStatus = await areUsersChatBlocked(db, "homeowner_1", "trader_1");
      expect(blockedStatus.blocked).toBe(true);
      expect(blockedStatus.blockedByA).toBe(true);

      // Blocked user cannot notify blocker
      const traderToHomeowner = await authorizeNotificationRequest(db, "trader_1", null, {
        recipientId: "homeowner_1",
        type: "message",
        conversationId: "conv_1",
      });
      expect(traderToHomeowner).toBe(false);

      // Blocker cannot notify blocked user while block is active
      const homeownerToTrader = await authorizeNotificationRequest(db, "homeowner_1", null, {
        recipientId: "trader_1",
        type: "message",
        conversationId: "conv_1",
      });
      expect(homeownerToTrader).toBe(false);

      // listUserChatBlocksCommand exposes blockedByUserIds for the blocked user
      const traderBlocks = await listUserChatBlocksCommand(db, "trader_1");
      expect(traderBlocks.blockedByUserIds).toContain("homeowner_1");
      expect(traderBlocks.blockedUserIds).toEqual([]);
    });

    it("authorizes customer <-> trader appointment notifications via appointmentId (Rule 3E)", async () => {
      const db = createInMemoryFirestore({
        "appointments/appt_1": {
          customerId: "homeowner_1",
          traderId: "trader_1",
          status: "pending",
        },
      });

      const payload = validateNotificationPayload({
        recipientId: "trader_1",
        title: "New Appointment Request",
        message: "Booking for Friday at 10:00",
        type: "system",
        link: "/profile#appointments",
        appointmentId: "appt_1",
      });
      expect(payload.appointmentId).toBe("appt_1");

      const allowed = await authorizeNotificationRequest(db, "homeowner_1", null, payload);
      expect(allowed).toBe(true);

      const deniedOutsider = await authorizeNotificationRequest(db, "outsider_99", null, payload);
      expect(deniedOutsider).toBe(false);
    });
  });

  describe("Re-Quote Response Metadata & Consolidated AcceptQuote Notifications", () => {
    it("RespondToRequote succeeds on requote_requested quote and persists Flash Deal metadata & lineItems", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_rq": {
          id: "job_rq",
          homeownerId: "homeowner_1",
          title: "Kitchen Tiling",
          status: "quoted",
        },
        "jobs/job_rq/quotes/q_1": {
          id: "q_1",
          jobId: "job_rq",
          homeownerId: "homeowner_1",
          tradespersonId: "trader_1",
          amount: 500,
          status: "requote_requested",
          revisionCount: 1,
        },
        "users/trader_1": {
          uid: "trader_1",
          role: "tradesperson",
          isVerified: true,
        },
      });

      const res = await executeQuoteCommand({
        db,
        identity: trader1Identity,
        idempotencyKey: "resp_requote_slice3_001",
        command: {
          type: "RespondToRequote",
          payload: {
            jobId: "job_rq",
            quoteId: "q_1",
            amount: 450,
            coverNote: "Applied 10% flash deal",
            materialsBreakdown: [{ description: "Adhesive & Grout", amount: 50 }],
            metadata: {
              isDiscountApplied: true,
              discountPercentage: 10,
              appliedFlashDealId: "deal_99",
              originalAmount: 500,
            },
          },
        },
      });

      expect(res.status).toBe("requoted");
      expect(res.quote?.metadata?.appliedFlashDealId).toBe("deal_99");
      expect(res.quote?.materialsBreakdown).toHaveLength(1);
    });

    it("AcceptQuote sends one consolidated alert to winner and notifies competing pending & requoted traders", async () => {
      const db = createInMemoryFirestore({
        "jobs/job_acc": {
          id: "job_acc",
          homeownerId: "homeowner_1",
          title: "Bathroom Plumbing",
          status: "quoted",
        },
        "public_job_cards/job_acc": {
          id: "job_acc",
          status: "quoted",
        },
        "jobs/job_acc/quotes/q_win": {
          id: "q_win",
          jobId: "job_acc",
          homeownerId: "homeowner_1",
          tradespersonId: "trader_1",
          amount: 320,
          status: "pending",
          startDate: "2026-12-12",
        },
        "jobs/job_acc/quotes/q_comp_pending": {
          id: "q_comp_pending",
          jobId: "job_acc",
          homeownerId: "homeowner_1",
          tradespersonId: "trader_2",
          amount: 350,
          status: "pending",
        },
        "jobs/job_acc/quotes/q_comp_requoted": {
          id: "q_comp_requoted",
          jobId: "job_acc",
          homeownerId: "homeowner_1",
          tradespersonId: "trader_3",
          amount: 310,
          status: "requoted",
        },
      });

      const messagingMock = { sendEachForMulticast: vi.fn(async () => ({ responses: [] })) };

      const res = await executeAcceptQuoteCommand({
        db,
        identity: homeownerIdentity,
        jobId: "job_acc",
        quoteId: "q_win",
        idempotencyKey: "accept_slice3_001",
        messagingClient: messagingMock,
      });

      expect(res.status).toBe("accepted");
      const allNotifs = Array.from(db.store.entries())
        .filter(([k]) => k.startsWith("notifications/"))
        .map(([, v]) => v);

      const winnerNotifs = allNotifs.filter((n) => n.userId === "trader_1");
      const trader2Notifs = allNotifs.filter((n) => n.userId === "trader_2");
      const trader3Notifs = allNotifs.filter((n) => n.userId === "trader_3");

      expect(winnerNotifs).toHaveLength(1);
      expect(winnerNotifs[0].title).toContain("Quote Accepted");
      expect(trader2Notifs).toHaveLength(1);
      expect(trader3Notifs).toHaveLength(1);
      expect(trader3Notifs[0].link).toBe("/my-quotes");
    });
  });
});
