import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateAndNormalizeProfilePhone } from "../../src/lib/profileValidation.ts";
import {
  executeExportUserDataCommand,
  executeSelfServiceAccountDeletionCommand,
  sanitizeUserRecordForGdprExport,
} from "../../src/server/accountGdpr.ts";

function createMockDb(seed: Record<string, Record<string, any>>) {
  const store = new Map<string, Map<string, any>>();
  for (const [col, docs] of Object.entries(seed)) {
    const colMap = new Map<string, any>();
    for (const [id, data] of Object.entries(docs)) {
      colMap.set(id, { ...data });
    }
    store.set(col, colMap);
  }

  const getCol = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };

  let autoId = 1;

  const buildQuery = (colName: string, filters: Array<{ field: string; value: any }> = []) => ({
    where(field: string, _op: string, value: any) {
      return buildQuery(colName, [...filters, { field, value }]);
    },
    limit(_n: number) {
      return buildQuery(colName, filters);
    },
    async get() {
      const colMap = getCol(colName);
      const docs: any[] = [];
      for (const [id, data] of colMap.entries()) {
        const matches = filters.every((f) => data[f.field] === f.value);
        if (matches) {
          docs.push({ id, exists: true, data: () => ({ ...data }) });
        }
      }
      return { docs };
    },
  });

  return {
    store,
    collection(colName: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const data = getCol(colName).get(id);
              return { id, exists: Boolean(data), data: () => (data ? { ...data } : undefined) };
            },
            async set(payload: Record<string, any>, opts?: { merge?: boolean }) {
              const colMap = getCol(colName);
              const prev = opts?.merge ? colMap.get(id) || {} : {};
              colMap.set(id, { ...prev, ...payload });
            },
            async delete() {
              getCol(colName).delete(id);
            },
          };
        },
        async add(payload: Record<string, any>) {
          const id = `auto_${autoId++}`;
          getCol(colName).set(id, { ...payload });
          return { id };
        },
        where(field: string, op: string, value: any) {
          return buildQuery(colName, [{ field, value }]);
        },
      };
    },
    collectionGroup(colName: string) {
      return {
        where(field: string, _op: string, value: any) {
          return buildQuery(colName, [{ field, value }]);
        },
      };
    },
  };
}

describe("Task 11 — Profile Phone Validation", () => {
  it("allows empty phone input so optional field can be cleared", () => {
    expect(validateAndNormalizeProfilePhone("")).toEqual({ valid: true, normalized: "" });
    expect(validateAndNormalizeProfilePhone("   ")).toEqual({ valid: true, normalized: "" });
  });

  it("validates and normalizes UK mobile and landline numbers to +44 E.164", () => {
    expect(validateAndNormalizeProfilePhone("07700 900123")).toEqual({
      valid: true,
      normalized: "+447700900123",
    });
    expect(validateAndNormalizeProfilePhone("+44 (0) 7700-900123".replace("(0) ", ""))).toEqual({
      valid: true,
      normalized: "+447700900123",
    });
    expect(validateAndNormalizeProfilePhone("020 7946 0958")).toEqual({
      valid: true,
      normalized: "+442079460958",
    });
  });

  it("accepts valid international E.164 numbers and rejects junk/short numbers", () => {
    expect(validateAndNormalizeProfilePhone("+1 415 555 2671")).toEqual({
      valid: true,
      normalized: "+14155552671",
    });
    expect(validateAndNormalizeProfilePhone("abc12345678").valid).toBe(false);
    expect(validateAndNormalizeProfilePhone("07123").valid).toBe(false);
    expect(validateAndNormalizeProfilePhone("123456789012345678").valid).toBe(false);
  });
});

describe("Task 11 — Server-Authoritative UK GDPR Data Export & Account Deletion", () => {
  it("exports strictly caller-owned data, strips internal security fields, and logs a GDPR audit record", async () => {
    const db = createMockDb({
      users: {
        user_1: {
          name: "Alex Taylor",
          email: "alex@example.co.uk",
          phone: "+447700900123",
          postcode: "SW1A 1AA",
          ipAddress: "198.51.100.1",
          fraudScore: 2,
          internalAdminNotes: "Internal only",
        },
        user_2: {
          name: "Other Person",
          email: "other@example.co.uk",
        },
      },
      jobs: {
        job_1: { homeownerId: "user_1", title: "Boiler service", status: "completed" },
        job_2: { homeownerId: "user_2", title: "Someone else's job", status: "posted" },
      },
      properties: {
        prop_1: { ownerId: "user_1", postcode: "SW1A 1AA" },
      },
      quotes: {
        q_1: { tradespersonId: "user_1", amount: 180 },
      },
      notifications: {
        n_1: { userId: "user_1", title: "Welcome" },
      },
      reviews: {
        r_1: { reviewerId: "user_1", rating: 5 },
      },
    });

    const result = await executeExportUserDataCommand({ db, uid: "user_1" });
    expect(result.subjectUid).toBe("user_1");
    expect(result.profile.name).toBe("Alex Taylor");
    expect(result.profile.phone).toBe("+447700900123");
    expect(result.profile.ipAddress).toBeUndefined();
    expect(result.profile.fraudScore).toBeUndefined();
    expect(result.profile.internalAdminNotes).toBeUndefined();
    expect(result.jobsPosted).toHaveLength(1);
    expect(result.jobsPosted[0].id).toBe("job_1");
    expect(result.properties).toHaveLength(1);
    expect(result.quotesSubmitted).toHaveLength(1);
    expect(result.notifications).toHaveLength(1);
    expect(result.reviewsAuthored).toHaveLength(1);

    const gdprLogs = Array.from(db.store.get("gdpr_requests")?.values() || []);
    expect(gdprLogs).toHaveLength(1);
    expect(gdprLogs[0].type).toBe("data_export");
    expect(gdprLogs[0].uid).toBe("user_1");
  });

  it("strips all protected internal security keys in sanitizeUserRecordForGdprExport", () => {
    const clean = sanitizeUserRecordForGdprExport({
      name: "Sam",
      passwordHash: "secret",
      fcmTokens: ["tok1"],
      accountFlags: ["watch"],
    });
    expect(clean).toEqual({ name: "Sam" });
  });

  it("rejects self-service account deletion unless confirmationText is DELETE", async () => {
    const db = createMockDb({
      users: { user_1: { name: "Alex", accountStatus: "active" } },
    });

    await expect(
      executeSelfServiceAccountDeletionCommand({
        db,
        uid: "user_1",
        confirmationText: "wrong",
      })
    ).rejects.toThrow(/DELETE/i);
  });

  it("blocks self-service account deletion when active, funded, or disputed jobs exist", async () => {
    const db = createMockDb({
      users: { trader_1: { name: "Bob Builder", role: "tradesperson" } },
      jobs: {
        job_active: {
          homeownerId: "owner_1",
          acceptedTradespersonId: "trader_1",
          status: "funded",
        },
      },
    });

    await expect(
      executeSelfServiceAccountDeletionCommand({
        db,
        uid: "trader_1",
        confirmationText: "DELETE",
      })
    ).rejects.toThrow(/active, funded, or disputed/i);
  });

  it("erases PII, retracts public_profiles, pauses ads/deals, revokes auth tokens, and logs audit records when idle", async () => {
    const db = createMockDb({
      users: {
        trader_2: {
          name: "Jane Spark",
          email: "jane@spark.co.uk",
          phone: "+447700900456",
          postcode: "M1 1AE",
          role: "tradesperson",
          acceptingNewWork: true,
        },
      },
      public_profiles: {
        trader_2: { name: "Jane Spark", trades: ["Electrical"] },
      },
      advertisements: {
        ad_1: { traderId: "trader_2", active: true },
      },
      flash_deals: {
        deal_1: { traderId: "trader_2", active: true },
      },
      jobs: {
        job_old: { homeownerId: "owner_9", acceptedTradespersonId: "trader_2", status: "completed" },
      },
    });

    const authClient = {
      revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
      updateUser: vi.fn().mockResolvedValue(undefined),
    };

    const res = await executeSelfServiceAccountDeletionCommand({
      db,
      authClient,
      uid: "trader_2",
      email: "jane@spark.co.uk",
      confirmationText: "delete",
      reason: "Closing business",
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe("deleted_by_user");
    expect(res.publicProfileRetracted).toBe(true);
    expect(res.authRevoked).toBe(true);
    expect(res.authDisabled).toBe(true);
    expect(res.pausedAdsCount).toBe(1);
    expect(res.pausedDealsCount).toBe(1);

    const updatedUser = db.store.get("users")?.get("trader_2");
    expect(updatedUser.name).toBe("Deleted User");
    expect(updatedUser.phone).toBe("");
    expect(updatedUser.email).toBe("");
    expect(updatedUser.isDisabled).toBe(true);
    expect(updatedUser.acceptingNewWork).toBe(false);

    expect(db.store.get("public_profiles")?.has("trader_2")).toBe(false);
    expect(db.store.get("advertisements")?.get("ad_1")?.active).toBe(false);
    expect(db.store.get("flash_deals")?.get("deal_1")?.active).toBe(false);
    expect(authClient.revokeRefreshTokens).toHaveBeenCalledWith("trader_2");
    expect(authClient.updateUser).toHaveBeenCalledWith("trader_2", { disabled: true });

    const gdprLogs = Array.from(db.store.get("gdpr_requests")?.values() || []);
    expect(gdprLogs).toHaveLength(1);
    expect(gdprLogs[0].type).toBe("account_erasure");
  });
});

describe("Task 11 — Source Regression Guards (Dead Links, Phone Field, GDPR UI & Zero Browser Dialogs)", () => {
  const readSrc = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

  it("removes all dead path: '/profile' menu links and wires #account, #notifications, #faqs, #emergency, #help, #data-privacy in Profile.tsx", () => {
    const profileSrc = readSrc("src/components/Profile.tsx");
    expect(profileSrc).not.toContain('path: "/profile"');
    expect(profileSrc).toContain('path: "/portfolio"');
    expect(profileSrc).toContain('path: "#emergency"');
    expect(profileSrc).toContain('path: "#help"');
    expect(profileSrc).toContain('path: "#data-privacy"');
    expect(profileSrc).toContain('item.path === "#account"');
    expect(profileSrc).toContain('item.path === "#notifications"');
    expect(profileSrc).toContain('item.path === "#faqs"');
    expect(profileSrc).toContain('item.path === "#emergency"');
    expect(profileSrc).toContain('item.path === "#help"');
    expect(profileSrc).toContain('item.path === "#data-privacy"');
    expect(profileSrc).toContain("validateAndNormalizeProfilePhone");
    expect(profileSrc).toContain("/api/account/gdpr/export");
    expect(profileSrc).toContain("/api/account/gdpr/delete-account");
  });

  it("eliminates browser alert() and confirm() calls across core AnyTrader user-facing components", () => {
    const checkedFiles = [
      "src/components/Profile.tsx",
      "src/components/Layout.tsx",
      "src/components/MyQuotes.tsx",
      "src/components/PublicProfile.tsx",
      "src/components/EmergencyJobWizard.tsx",
      "src/components/MyJobs.tsx",
      "src/components/JobDetails.tsx",
      "src/components/TradesDashboard.tsx",
      "src/components/TraderVideoVerificationCard.tsx",
      "src/components/TradesBannerAdStudio.tsx",
      "src/components/BusinessTeamManagement.tsx",
    ];

    for (const file of checkedFiles) {
      const content = readSrc(file);
      expect(content, `Unexpected browser alert() in ${file}`).not.toMatch(/(?:window\.)?\balert\(/);
      expect(content, `Unexpected browser confirm() in ${file}`).not.toMatch(/(?:window\.)?\bconfirm\(/);
    }
  });
});
