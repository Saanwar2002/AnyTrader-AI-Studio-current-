import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  resolveLondonAppointmentWindow,
  getLondonOffsetForLocalDateTime,
  buildLondonIcsContent,
  buildGoogleCalendarUrl,
  buildOutlookCalendarUrl,
} from "../../src/lib/calendarExport";
import {
  reportOrBlockChatParticipantCommand,
  unblockChatParticipantCommand,
  listUserChatBlocksCommand,
  buildChatBlockDocId,
} from "../../src/server/chatSafety";
import {
  buildContractTextContent,
  generateLegalContractDoc,
} from "../../src/services/googleDriveDocsService";

function createInMemoryDb(seed: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = {};
  for (const [col, docs] of Object.entries(seed)) {
    store[col] = { ...docs };
  }

  return {
    store,
    collection(colName: string) {
      if (!store[colName]) store[colName] = {};
      const makeQuery = (filters: Array<{ field: string; value: any }> = []) => ({
        where(field: string, _op: string, value: any) {
          return makeQuery([...filters, { field, value }]);
        },
        limit(_n: number) {
          return makeQuery(filters);
        },
        async get() {
          const docs = Object.entries(store[colName] || {})
            .filter(([, data]) => filters.every((f) => data?.[f.field] === f.value))
            .map(([id, data]) => ({
              id,
              exists: true,
              data: () => ({ ...data }),
            }));
          return { docs, empty: docs.length === 0, size: docs.length };
        },
      });

      return {
        doc(docId: string) {
          return {
            async get() {
              const data = store[colName]?.[docId];
              return {
                id: docId,
                exists: data !== undefined,
                data: () => (data !== undefined ? { ...data } : undefined),
              };
            },
            async set(payload: any, opts?: { merge?: boolean }) {
              if (opts?.merge && store[colName][docId]) {
                store[colName][docId] = { ...store[colName][docId], ...payload };
              } else {
                store[colName][docId] = { ...payload };
              }
            },
          };
        },
        where(field: string, _op: string, value: any) {
          return makeQuery([{ field, value }]);
        },
      };
    },
  };
}

describe("Batch 15 — Scheduling, Calendar, Chat Safety, Google Docs & Accessibility", () => {
  describe("AT-CJ-SCHED-02: Real Europe/London calendar exports (GMT/BST)", () => {
    it("resolves GMT (+00:00) in winter and BST (+01:00) in summer with explicit appointment slot", () => {
      expect(getLondonOffsetForLocalDateTime("2026-01-15", "14:30")).toBe("+00:00");
      expect(getLondonOffsetForLocalDateTime("2026-07-15", "14:30")).toBe("+01:00");

      const summerWin = resolveLondonAppointmentWindow(
        { scheduledDate: "2026-07-15", appointmentTimeSlot: "14:30 - 16:45" },
        { amount: 420 }
      );
      expect(summerWin.dateYmd).toBe("2026-07-15");
      expect(summerWin.startTimeHm).toBe("14:30");
      expect(summerWin.endTimeHm).toBe("16:45");
      expect(summerWin.startLocalCompact).toBe("20260715T143000");
      expect(summerWin.endLocalCompact).toBe("20260715T164500");
      expect(summerWin.startIsoWithLondonOffset).toBe("2026-07-15T14:30:00+01:00");
      expect(summerWin.endIsoWithLondonOffset).toBe("2026-07-15T16:45:00+01:00");
      expect(summerWin.timezone).toBe("Europe/London");
    });

    it("generates RFC 5545 .ics with Europe/London VTIMEZONE and TZID without fixed UTC placeholders", () => {
      const ics = buildLondonIcsContent(
        {
          id: "job-london-1",
          title: "Boiler Annual Service",
          description: "Full safety inspection",
          postcode: "SW1A 1AA",
          scheduledDate: "2026-11-20",
          scheduledTime: "11:15",
          durationMinutes: 90,
        },
        { amount: 185 }
      );

      expect(ics).toContain("BEGIN:VTIMEZONE");
      expect(ics).toContain("TZID:Europe/London");
      expect(ics).toContain("TZNAME:BST");
      expect(ics).toContain("TZNAME:GMT");
      expect(ics).toContain("DTSTART;TZID=Europe/London:20261120T111500");
      expect(ics).toContain("DTEND;TZID=Europe/London:20261120T124500");
      expect(ics).not.toContain("T090000Z");
      expect(ics).not.toContain("T170000Z");

      const gcal = buildGoogleCalendarUrl(
        { id: "job-london-1", title: "Boiler Annual Service", scheduledDate: "2026-11-20", scheduledTime: "11:15", durationMinutes: 90 },
        { amount: 185 }
      );
      expect(gcal).toContain("dates=20261120T111500/20261120T124500");
      expect(gcal).toContain("ctz=Europe%2FLondon");

      const outlook = buildOutlookCalendarUrl(
        { id: "job-london-1", title: "Boiler Annual Service", scheduledDate: "2026-07-20", scheduledTime: "11:15", durationMinutes: 90 },
        { amount: 185 }
      );
      expect(outlook).toContain("startdt=2026-07-20T11%3A15%3A00%2B01%3A00");
      expect(outlook).toContain("enddt=2026-07-20T12%3A45%3A00%2B01%3A00");
    });
  });

  describe("AT-CJ-SCHED-03: Canonical jobs queries on TraderCalendar and Availability", () => {
    it("migrates TraderCalendar and Availability away from legacy bidding_jobs and window.alert", () => {
      const traderCalendarSrc = fs.readFileSync(
        path.resolve("src/components/TraderCalendar.tsx"),
        "utf8"
      );
      const availabilitySrc = fs.readFileSync(
        path.resolve("src/components/Availability.tsx"),
        "utf8"
      );

      expect(traderCalendarSrc).not.toContain('collection(db, "bidding_jobs")');
      expect(traderCalendarSrc).toContain('collection(db, "jobs")');
      expect(traderCalendarSrc).toContain('where("assignedTradespersonId", "==", user.uid)');

      expect(availabilitySrc).not.toContain('collection(db, "bidding_jobs")');
      expect(availabilitySrc).not.toMatch(/\balert\(/);
      expect(availabilitySrc).toContain('collection(db, "jobs")');
      expect(availabilitySrc).toContain('where("acceptedTradespersonId", "==", user.uid)');
    });
  });

  describe("AT-CJ-CHAT-03: Report / Block Participant server authority and UI wiring", () => {
    it("persists block and report records with audit log for valid conversation participants", async () => {
      const db = createInMemoryDb({
        conversations: {
          "conv-1": {
            participants: ["homeowner-1", "trader-1"],
            jobId: "job-99",
          },
        },
      });

      const res = await reportOrBlockChatParticipantCommand(
        db,
        { uid: "homeowner-1", email: "owner@example.com" },
        {
          conversationId: "conv-1",
          targetUserId: "trader-1",
          action: "report_and_block",
          reason: "off_platform_solicitation",
          details: "Asked for cash outside escrow",
        }
      );

      expect(res.action).toBe("report_and_block");
      expect(res.blockRecord?.id).toBe(buildChatBlockDocId("homeowner-1", "trader-1"));
      expect(res.blockRecord?.active).toBe(true);
      expect(res.reportRecord?.status).toBe("open");
      expect(res.reportRecord?.jobId).toBe("job-99");

      const listed = await listUserChatBlocksCommand(db, "homeowner-1");
      expect(listed.blockedUserIds).toEqual(["trader-1"]);

      expect(Object.keys(db.store.admin_audit_logs || {}).length).toBe(1);

      const unblocked = await unblockChatParticipantCommand(db, "homeowner-1", "trader-1");
      expect(unblocked.unblocked).toBe(true);

      const listedAfter = await listUserChatBlocksCommand(db, "homeowner-1");
      expect(listedAfter.blockedUserIds).toEqual([]);
    });

    it("rejects self-blocking and non-participant requests with explicit HTTP errors", async () => {
      const db = createInMemoryDb({
        conversations: {
          "conv-1": { participants: ["homeowner-1", "trader-1"] },
        },
      });

      await expect(
        reportOrBlockChatParticipantCommand(
          db,
          { uid: "homeowner-1" },
          { conversationId: "conv-1", targetUserId: "homeowner-1", action: "block" }
        )
      ).rejects.toThrow("cannot report or block yourself");

      await expect(
        reportOrBlockChatParticipantCommand(
          db,
          { uid: "attacker-9" },
          { conversationId: "conv-1", targetUserId: "trader-1", action: "block" }
        )
      ).rejects.toThrow("not a participant");
    });

    it("wires API routes, Firestore rules, and Chat UI report/block controls", () => {
      const serverSrc = fs.readFileSync(path.resolve("server.ts"), "utf8");
      const rulesSrc = fs.readFileSync(path.resolve("firestore.rules"), "utf8");
      const chatSrc = fs.readFileSync(path.resolve("src/components/Chat.tsx"), "utf8");

      expect(serverSrc).toContain("/api/chat/report-block");
      expect(serverSrc).toContain("/api/chat/blocks");
      expect(rulesSrc).toContain("match /chat_user_blocks/{blockId}");
      expect(rulesSrc).toContain("match /chat_reports/{reportId}");
      expect(chatSrc).toContain("/api/chat/report-block");
      expect(chatSrc).toContain('role="dialog"');
    });
  });

  describe("AT-CJ-GDOC-01 & AT-CJ-GDOC-02: Verified contract clauses and batchUpdate verification", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("marks unverified insurance, warranty, and site-safety clauses as [To Confirm]", () => {
      const unverifiedText = buildContractTextContent(
        {
          documentType: "Trade Service Agreement",
          jobTitle: "Rewire Kitchen",
          jobRef: "JOB-401",
          clientName: "Alice Homeowner",
          traderName: "Bob Spark",
          amount: 1200,
        },
        "21 November 2026"
      );

      expect(unverifiedText).toContain("UK Public Liability Insurance: [To Confirm]");
      expect(unverifiedText).toContain("Workmanship Guarantee & Warranty Period: [To Confirm]");
      expect(unverifiedText).toContain("Site Safety & Compliance Credentials: [To Confirm]");
      expect(unverifiedText).not.toContain("24-Month Workmanship");

      const verifiedText = buildContractTextContent(
        {
          documentType: "Trade Service Agreement",
          jobTitle: "Rewire Kitchen",
          jobRef: "JOB-401",
          clientName: "Alice Homeowner",
          traderName: "Bob Spark",
          amount: 1200,
          verifiedCredentials: {
            publicLiabilityVerified: true,
            insuranceProvider: "Hiscox UK",
            insurancePolicyNumber: "PL-998877",
            publicLiabilityLimit: "£5,000,000",
            warrantyVerified: true,
            warrantyMonths: 12,
            siteSafetyVerified: true,
            certifications: ["NICEIC", "Part P"],
          },
        },
        "21 November 2026"
      );

      expect(verifiedText).toContain("Hiscox UK");
      expect(verifiedText).toContain("PL-998877");
      expect(verifiedText).toContain("Verified 12-Month Workmanship Guarantee");
      expect(verifiedText).toContain("NICEIC, Part P");
    });

    it("fails closed when Google Docs batchUpdate returns non-OK or unconfirmed reply", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ documentId: "doc-123" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: { message: "Backend write failed" } }),
        }) as any;

      const failed = await generateLegalContractDoc(
        {
          documentType: "Liability Waiver",
          jobTitle: "Roof Repair",
          jobRef: "JOB-500",
          clientName: "Client A",
          traderName: "Trader B",
          amount: 500,
        },
        "test-token"
      );
      expect(failed.success).toBe(false);
      expect(failed.error).toContain("Backend write failed");

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ documentId: "doc-456" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({}),
        }) as any;

      const unconfirmed = await generateLegalContractDoc(
        {
          documentType: "Job Completion Certificate",
          jobTitle: "Roof Repair",
          jobRef: "JOB-500",
          clientName: "Client A",
          traderName: "Trader B",
          amount: 500,
        },
        "test-token"
      );
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain("did not confirm document population");

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ documentId: "doc-789" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ documentId: "doc-789", replies: [{}] }),
        }) as any;

      const confirmed = await generateLegalContractDoc(
        {
          documentType: "Trade Service Agreement",
          jobTitle: "Roof Repair",
          jobRef: "JOB-500",
          clientName: "Client A",
          traderName: "Trader B",
          amount: 500,
        },
        "test-token"
      );
      expect(confirmed.success).toBe(true);
      expect(confirmed.documentUrl).toBe("https://docs.google.com/document/d/doc-789/edit");
    });
  });

  describe("AT-A11Y-02, AT-A11Y-03, AT-A11Y-04, AT-A11Y-05: Accessible labels and dialog semantics", () => {
    it("wires programmatic labels in PostJobWizard (AT-A11Y-02)", () => {
      const src = fs.readFileSync(path.resolve("src/components/PostJobWizard.tsx"), "utf8");
      expect(src).toContain('htmlFor="post-job-title-input"');
      expect(src).toContain('id="post-job-title-input"');
      expect(src).toContain('htmlFor="post-job-description-input"');
      expect(src).toContain('htmlFor="post-job-address-input"');
      expect(src).toContain('htmlFor="custom-budget-input"');
    });

    it("wires dialog ARIA semantics, Escape-to-close, and focus restoration in QuoteComparisonModal and BnplFinancingModal (AT-A11Y-03)", () => {
      const quoteSrc = fs.readFileSync(path.resolve("src/components/QuoteComparisonModal.tsx"), "utf8");
      const bnplSrc = fs.readFileSync(path.resolve("src/components/BnplFinancingModal.tsx"), "utf8");

      expect(quoteSrc).toContain("useDialogA11y");
      expect(quoteSrc).toContain('role="dialog"');
      expect(quoteSrc).toContain('aria-modal="true"');
      expect(quoteSrc).toContain("aria-labelledby=");
      expect(quoteSrc).not.toContain("window.confirm");

      expect(bnplSrc).toContain("useDialogA11y");
      expect(bnplSrc).toContain('role="dialog"');
      expect(bnplSrc).toContain('aria-modal="true"');
      expect(bnplSrc).toContain("aria-labelledby=");
    });

    it("wires accessible labels, keyboard upload input, and dialog semantics in JobDetails modals (AT-A11Y-04)", () => {
      const src = fs.readFileSync(path.resolve("src/components/JobDetails.tsx"), "utf8");
      expect(src).toContain("useDialogA11y");
      expect(src).toContain('id="dispute-evidence-photos-input"');
      expect(src).toContain('htmlFor="dispute-evidence-photos-input"');
      expect(src).toContain('aria-labelledby="dispute-modal-title"');
      expect(src).toContain('aria-labelledby="recurring-schedule-modal-title"');
      expect(src).toContain('aria-labelledby="reschedule-modal-title"');
    });

    it("wires accessible dialog semantics and labels in ConsultancyManager and DriverEarnings (AT-A11Y-05)", () => {
      const consultancySrc = fs.readFileSync(path.resolve("src/components/ConsultancyManager.tsx"), "utf8");
      const driverEarningsSrc = fs.readFileSync(path.resolve("src/components/driver/DriverEarnings.tsx"), "utf8");

      expect(consultancySrc).toContain("useDialogA11y");
      expect(consultancySrc).toContain('aria-labelledby="consultancy-booking-modal-title"');
      expect(consultancySrc).toContain('aria-labelledby="consultancy-client-modal-title"');
      expect(consultancySrc).toContain('aria-labelledby="consultancy-invoice-modal-title"');
      expect(consultancySrc).toContain('htmlFor="invoice-client-select"');
      expect(consultancySrc).toContain('htmlFor="invoice-amount-input"');

      expect(driverEarningsSrc).toContain("useDialogA11y");
      expect(driverEarningsSrc).toContain('aria-labelledby="driver-earnings-analytics-title"');
      expect(driverEarningsSrc).toContain('aria-labelledby="driver-gold-payment-modal-title"');
      expect(driverEarningsSrc).toContain('aria-label="Report start day"');
      expect(driverEarningsSrc).toContain('aria-label="Report end year"');
      expect(driverEarningsSrc).toContain('aria-label="Edit earnings goal"');
    });
  });
});
