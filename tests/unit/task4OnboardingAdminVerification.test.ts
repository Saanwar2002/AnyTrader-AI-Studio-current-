import { describe, it, expect } from "vitest";
import { executeBootstrapProfileCommand } from "../../src/server/accountBootstrap.ts";
import { reviewTraderVerificationDocument } from "../../src/server/accountLifecycle.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../src/server/httpErrors.ts";

function createMockFirestore() {
  const store: Record<string, any> = {};
  const addedCollections: Record<string, any[]> = {};

  const db: any = {
    _store: store,
    _added: addedCollections,
    collection: (col: string) => ({
      add: async (data: any) => {
        if (!addedCollections[col]) addedCollections[col] = [];
        const id = `${col}_${addedCollections[col].length + 1}`;
        const copy = JSON.parse(JSON.stringify(data));
        addedCollections[col].push({ id, ...copy });
        store[`${col}/${id}`] = copy;
        return { id };
      },
      doc: (id: string) => ({
        id,
        path: `${col}/${id}`,
        async get() {
          const data = store[`${col}/${id}`];
          return {
            id,
            exists: data !== undefined,
            data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
          };
        },
      }),
    }),
    runTransaction: async (fn: any) => {
      const transaction = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: any) => {
          const current = store[ref.path];
          if (options?.merge && current) {
            store[ref.path] = { ...current, ...JSON.parse(JSON.stringify(data)) };
          } else {
            store[ref.path] = JSON.parse(JSON.stringify(data));
          }
        },
        update: (ref: any, data: any) => {
          const current = store[ref.path];
          if (!current) throw new Error(`Document ${ref.path} does not exist`);
          store[ref.path] = { ...current, ...JSON.parse(JSON.stringify(data)) };
        },
      };
      return fn(transaction);
    },
  };

  return db;
}

describe("Task 4: Onboarding Certification Persistence & Admin Verification Queue Sync", () => {
  it("persists validated Firebase Storage verificationDocs and sets verificationStatus='pending' on users and public_profiles", async () => {
    const mockDb = createMockFirestore();
    const uid = "trader_cert_1";

    const result = await executeBootstrapProfileCommand(
      mockDb,
      { uid, email: "gas@example.com" },
      {
        role: "business",
        businessLayer: "field_services",
        name: "Sam Gas Engineer",
        phone: "07700900123",
        postcode: "SW1A 1AA",
        city: "London",
        trades: ["Gas & Heating"],
        subcategories: ["Boiler Installation"],
        verificationDocs: [
          {
            type: "Gas Safe Register",
            fileUrl: "https://firebasestorage.googleapis.com/v0/b/anytrader.appspot.com/o/verifications%2Ftrader_cert_1%2Fonboarding%2Fgas_safe.pdf?alt=media&token=abc",
            fileName: "gas_safe_2026.pdf",
            storagePath: `verifications/${uid}/onboarding/gas_safe_1700000000_gas_safe_2026.pdf`,
            uploadedAt: "2026-11-22T10:00:00.000Z",
          },
          {
            type: "Gas Safe Register", // Duplicate type should deduplicate
            fileUrl: "https://firebasestorage.googleapis.com/v0/b/anytrader.appspot.com/o/verifications%2Ftrader_cert_1%2Fonboarding%2Fgas_safe_v2.pdf?alt=media&token=def",
            fileName: "gas_safe_v2.pdf",
            storagePath: `verifications/${uid}/onboarding/gas_safe_1700000001_gas_safe_v2.pdf`,
          },
        ],
      },
      "127.0.0.1"
    );

    expect(result.success).toBe(true);
    const createdUser = mockDb._store[`users/${uid}`];
    expect(createdUser.verificationStatus).toBe("pending");
    expect(createdUser.verificationDocs).toHaveLength(1);
    expect(createdUser.verificationDocs[0].type).toBe("Gas Safe Register");
    expect(createdUser.verificationDocs[0].status).toBe("pending");
    expect(createdUser.verificationDocs[0].fileName).toBe("gas_safe_v2.pdf");

    const publicProfile = mockDb._store[`public_profiles/${uid}`];
    expect(publicProfile).toBeDefined();
    expect(publicProfile.verificationStatus).toBe("pending");
    expect(publicProfile.isVerified).toBe(false);
  });

  it("keeps verificationStatus='unverified' when trader skips uploading docs ('I'll do this later')", async () => {
    const mockDb = createMockFirestore();
    const uid = "trader_skip_1";

    await executeBootstrapProfileCommand(
      mockDb,
      { uid, email: "skip@example.com" },
      {
        role: "business",
        businessLayer: "field_services",
        name: "Alex Electrician",
        postcode: "M1 1AE",
        trades: ["Electrical"],
        verificationDocs: [],
      },
      "127.0.0.1"
    );

    const createdUser = mockDb._store[`users/${uid}`];
    expect(createdUser.verificationStatus).toBe("unverified");
    expect(createdUser.verificationDocs).toEqual([]);
    expect(mockDb._store[`public_profiles/${uid}`].verificationStatus).toBe("unverified");
  });

  it("rejects placeholder/base64 URLs and cross-user storage paths in verificationDocs", async () => {
    const mockDb = createMockFirestore();

    await expect(
      executeBootstrapProfileCommand(
        mockDb,
        { uid: "trader_bad_url", email: "bad@example.com" },
        {
          role: "business",
          businessLayer: "field_services",
          name: "Bad URL",
          verificationDocs: [
            {
              type: "NICEIC",
              fileUrl: "https://example.com/docs/NICEIC.pdf",
            },
          ],
        },
        "127.0.0.1"
      )
    ).rejects.toThrow(BadRequestError);

    await expect(
      executeBootstrapProfileCommand(
        mockDb,
        { uid: "trader_data_url", email: "data@example.com" },
        {
          role: "business",
          businessLayer: "field_services",
          name: "Data URL",
          verificationDocs: [
            {
              type: "NICEIC",
              fileUrl: "data:application/pdf;base64,JVBERi0xLjQK",
            },
          ],
        },
        "127.0.0.1"
      )
    ).rejects.toThrow(BadRequestError);

    await expect(
      executeBootstrapProfileCommand(
        mockDb,
        { uid: "trader_cross_path", email: "cross@example.com" },
        {
          role: "business",
          businessLayer: "field_services",
          name: "Cross Path",
          verificationDocs: [
            {
              type: "NICEIC",
              fileUrl: "https://firebasestorage.googleapis.com/v0/b/anytrader.appspot.com/o/verifications%2Fvictim%2Fcert.pdf?alt=media",
              storagePath: "verifications/victim_uid/onboarding/cert.pdf",
            },
          ],
        },
        "127.0.0.1"
      )
    ).rejects.toThrow(ForbiddenError);
  });

  it("atomically reviews individual docs, promotes account & public_profiles on final approval, and revokes on rejection", async () => {
    const mockDb = createMockFirestore();
    const uid = "trader_review_1";

    await executeBootstrapProfileCommand(
      mockDb,
      { uid, email: "review@example.com" },
      {
        role: "business",
        businessLayer: "field_services",
        name: "Maya Heating Ltd",
        postcode: "E1 6AN",
        city: "London",
        trades: ["Gas & Heating"],
        verificationDocs: [
          {
            type: "Gas Safe Register",
            fileUrl: "https://firebasestorage.googleapis.com/v0/b/anytrader.appspot.com/o/verifications%2Ftrader_review_1%2Fgas.pdf?alt=media",
            fileName: "gas.pdf",
            storagePath: `verifications/${uid}/onboarding/gas.pdf`,
          },
          {
            type: "Public Liability Insurance",
            fileUrl: "https://firebasestorage.googleapis.com/v0/b/anytrader.appspot.com/o/verifications%2Ftrader_review_1%2Fpli.pdf?alt=media",
            fileName: "pli.pdf",
            storagePath: `verifications/${uid}/onboarding/pli.pdf`,
          },
        ],
      },
      "127.0.0.1"
    );

    // 1. Approve first document -> still pending overall
    const firstReview = await reviewTraderVerificationDocument({
      db: mockDb,
      adminUid: "admin_1",
      adminEmail: "admin@anytrader.uk",
      targetUid: uid,
      docType: "Gas Safe Register",
      decision: "approved",
    });

    expect(firstReview.allApproved).toBe(false);
    expect(firstReview.verificationStatus).toBe("pending");
    expect(firstReview.isVerified).toBe(false);
    expect(mockDb._store[`users/${uid}`].isVerified).toBe(false);
    expect(mockDb._store[`public_profiles/${uid}`].isVerified).toBe(false);

    // 2. Approve second (final) document -> account + public_profiles promoted to verified
    const secondReview = await reviewTraderVerificationDocument({
      db: mockDb,
      adminUid: "admin_1",
      adminEmail: "admin@anytrader.uk",
      targetUid: uid,
      docType: "Public Liability Insurance",
      decision: "approved",
    });

    expect(secondReview.allApproved).toBe(true);
    expect(secondReview.verificationStatus).toBe("verified");
    expect(secondReview.isVerified).toBe(true);
    expect(secondReview.publicProfileSynced).toBe(true);
    expect(mockDb._store[`users/${uid}`].isVerified).toBe(true);
    expect(mockDb._store[`users/${uid}`].verifiedTrader).toBe(true);
    expect(mockDb._store[`public_profiles/${uid}`].isVerified).toBe(true);
    expect(mockDb._store[`public_profiles/${uid}`].verifiedTrader).toBe(true);
    expect(mockDb._store[`public_profiles/${uid}`].verificationStatus).toBe("verified");

    // 3. Rejecting without a reason fails closed
    await expect(
      reviewTraderVerificationDocument({
        db: mockDb,
        adminUid: "admin_1",
        targetUid: uid,
        docType: "Gas Safe Register",
        decision: "rejected",
        reason: "   ",
      })
    ).rejects.toThrow(BadRequestError);

    // 4. Rejecting a document revokes verified status on both users and public_profiles
    const rejectReview = await reviewTraderVerificationDocument({
      db: mockDb,
      adminUid: "admin_1",
      adminEmail: "admin@anytrader.uk",
      targetUid: uid,
      docType: "Gas Safe Register",
      decision: "rejected",
      reason: "Certificate expired last month",
    });

    expect(rejectReview.verificationStatus).toBe("rejected");
    expect(rejectReview.isVerified).toBe(false);
    expect(mockDb._store[`users/${uid}`].isVerified).toBe(false);
    expect(mockDb._store[`users/${uid}`].verifiedTrader).toBe(false);
    expect(mockDb._store[`public_profiles/${uid}`].isVerified).toBe(false);
    expect(mockDb._store[`public_profiles/${uid}`].verifiedTrader).toBe(false);
    expect(mockDb._store[`public_profiles/${uid}`].verificationStatus).toBe("rejected");

    const rejectedDoc = mockDb._store[`users/${uid}`].verificationDocs.find(
      (d: any) => d.type === "Gas Safe Register"
    );
    expect(rejectedDoc.status).toBe("rejected");
    expect(rejectedDoc.rejectionReason).toBe("Certificate expired last month");

    // Notifications & audit logs emitted for all 3 reviews
    expect(mockDb._added.notifications).toHaveLength(3);
    expect(mockDb._added.notifications[1].title).toBe("Account Verified!");
    expect(mockDb._added.notifications[2].message).toContain("Certificate expired last month");
    expect(mockDb._added.admin_audit_logs).toHaveLength(3);

    // 5. Unknown docType throws NotFoundError
    await expect(
      reviewTraderVerificationDocument({
        db: mockDb,
        adminUid: "admin_1",
        targetUid: uid,
        docType: "Nonexistent Certificate",
        decision: "approved",
      })
    ).rejects.toThrow(NotFoundError);
  });
});
