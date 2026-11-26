import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import admin from "firebase-admin";
import { buildClaimPropertyTransferUpdate } from "../../src/server/propertyTransferCommand";
import { assertCanReadJobIntelligence } from "../../src/server/intelligence/jobIntelligenceAccess";

describe("Batch 2 Security Remediations (Rules, Audit Trail, Transfer & Intelligence Fail-Closed)", () => {
  const firestoreRules = fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf-8");
  const storageRules = fs.readFileSync(path.resolve(process.cwd(), "storage.rules"), "utf-8");
  const adminComponent = fs.readFileSync(path.resolve(process.cwd(), "src/components/AnyTraderAdmin.tsx"), "utf-8");
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), "server.ts"), "utf-8");

  describe("AT-STOR-04 & AT-STOR-05: Named DB Binding & Property Storage Segregation", () => {
    it("removes all (default) database references from storage.rules", () => {
      expect(storageRules).not.toContain("/databases/(default)/documents/");
      expect(storageRules).not.toContain("InDefaultDb");
      expect(storageRules).toContain(
        "/databases/ai-studio-anytrader-44dab8b3-bbc9-4352-b725-2cbe7a1dfd2a/documents/"
      );
    });

    it("removes uid == propertyId ownership bypass and separates tenant-issues from private property docs", () => {
      expect(storageRules).not.toContain("request.auth.uid == propertyId");
      expect(storageRules).toContain("match /properties/{propertyId}/tenant-issues/{allPaths=**}");
      expect(storageRules).toContain("match /properties/{propertyId}/tenant_issues/{allPaths=**}");
      const propMatch = storageRules.match(/match \/properties\/\{propertyId\}\/\{allPaths=\*\*\} \{([\s\S]*?)\}/);
      expect(propMatch).toBeTruthy();
      expect(propMatch![1]).toContain("isPropertyOwnerOrAdmin(propertyId)");
      expect(propMatch![1]).not.toContain("isPropertyParticipant");
    });
  });

  describe("AT-ADMIN-CONFIG-03: platform_settings Secret Isolation", () => {
    it("forbids non-admin reads on platform_settings/ai_agent_ecosystem while isolating public_flags", () => {
      const settingsMatch = firestoreRules.match(/match \/platform_settings\/\{settingId\} \{([\s\S]*?)\}/);
      expect(settingsMatch).toBeTruthy();
      const block = settingsMatch![1];
      expect(block).not.toMatch(/allow\s+read\s*:\s*if\s+isSignedIn\(\)\s*;/);
      expect(block).toContain("isAdmin()");
      expect(block).toContain("settingId == 'public_flags'");
      expect(block).toContain("allow write: if isSuperAdmin();");
    });
  });

  describe("AT-ADMIN-AUDIT-01: Immutable Append-Only Audit Logs", () => {
    it("enforces server-only writes and denies client update/delete across audit collections", () => {
      for (const col of ["audit_logs", "admin_audit_logs", "admin_login_audits"]) {
        const match = firestoreRules.match(new RegExp(`match \\/${col}\\/\\{[^}]+\\} \\{([\\s\\S]*?)\\}`));
        expect(match, `Missing rule block for ${col}`).toBeTruthy();
        expect(match![1]).toContain("allow read: if isAdmin();");
        expect(match![1]).toContain("allow create, update, delete: if false;");
      }

      const aiAuditMatch = firestoreRules.match(/match \/ai_agent_audit_logs\/\{logId\} \{([\s\S]*?)\}/);
      expect(aiAuditMatch).toBeTruthy();
      expect(aiAuditMatch![1]).toContain("allow update, delete: if false;");
    });

    it("routes AnyTraderAdmin audit logging through POST /api/admin/audit-logs and removes client log deletion", () => {
      expect(serverSource).toContain('app.post("/api/admin/audit-logs", requireAdmin');
      expect(serverSource).toContain('app.post("/api/admin/login-audit", requireAdmin');
      expect(adminComponent).toContain('fetch("/api/admin/audit-logs"');
      expect(adminComponent).not.toMatch(/deleteDoc\(d\.ref\)/);
    });
  });

  describe("AT-PASS-04: Atomic Removal of Prior Landlord/Manager Authority on Property Transfer", () => {
    it("deletes landlordId, managerId, propertyManagerId, assignedManagerId and clears pending transfer targets", () => {
      const existingProperty = {
        ownerId: "old-owner-1",
        userId: "old-owner-1",
        landlordId: "old-landlord-9",
        managerId: "old-manager-2",
        propertyManagerId: "old-pm-3",
        assignedManagerId: "old-am-4",
        name: "10 Downing Mews",
        previousOwnersCount: 1,
        transferTargetEmail: "buyer@example.com",
        transferTargetName: "Buyer One",
        transferHistory: [{ fromOwnerUid: "zero", toOwnerUid: "old-owner-1", transferCode: "TRF-AAAAAA" }],
      };

      const patch = buildClaimPropertyTransferUpdate({
        property: existingProperty,
        newOwnerId: "buyer-uid-77",
        newOwnerEmail: "buyer@example.com",
        transferCode: "TRF-BC2345",
        transferredAtIso: "2026-11-18T12:00:00.000Z",
      });

      expect(patch.ownerId).toBe("buyer-uid-77");
      expect(patch.userId).toBe("buyer-uid-77");
      expect(patch.homeownerId).toBe("buyer-uid-77");
      expect(patch.transferStatus).toBe("completed");
      expect(patch.transferCode).toBeNull();
      expect(patch.transferExpiresAt).toBeNull();
      expect(patch.transferTargetEmail).toBeNull();
      expect(patch.transferTargetName).toBeNull();
      expect(patch.previousOwnersCount).toBe(2);
      expect(patch.transferHistory).toHaveLength(2);

      // Verify Sentinel FieldValue.delete() on all previous authority fields
      const deleteSentinel = admin.firestore.FieldValue.delete();
      expect(patch.landlordId).toEqual(deleteSentinel);
      expect(patch.managerId).toEqual(deleteSentinel);
      expect(patch.propertyManagerId).toEqual(deleteSentinel);
      expect(patch.assignedManagerId).toEqual(deleteSentinel);
    });
  });

  describe("AT-INTEL-JOB-02: Fail-Closed Derived Job Intelligence Authorization", () => {
    it("rejects non-admin callers when parent job document is missing", () => {
      expect(() =>
        assertCanReadJobIntelligence({
          jobExists: false,
          jobData: null,
          userUid: "random-user-1",
          isAdminUser: false,
        })
      ).toThrow(/Forbidden/i);
    });

    it("permits platform admin when parent job document is missing", () => {
      expect(() =>
        assertCanReadJobIntelligence({
          jobExists: false,
          jobData: null,
          userUid: "admin-1",
          isAdminUser: true,
        })
      ).not.toThrow();
    });

    it("enforces owner, assigned trader, or admin access when parent job exists", () => {
      const jobData = {
        homeownerId: "owner-1",
        assignedTraderId: "trader-1",
      };

      expect(() =>
        assertCanReadJobIntelligence({
          jobExists: true,
          jobData,
          userUid: "owner-1",
          isAdminUser: false,
        })
      ).not.toThrow();

      expect(() =>
        assertCanReadJobIntelligence({
          jobExists: true,
          jobData,
          userUid: "trader-1",
          isAdminUser: false,
        })
      ).not.toThrow();

      expect(() =>
        assertCanReadJobIntelligence({
          jobExists: true,
          jobData,
          userUid: "outsider-9",
          isAdminUser: false,
        })
      ).toThrow(/Forbidden/i);
    });
  });
});
