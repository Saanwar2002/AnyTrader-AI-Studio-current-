import { describe, it, expect, beforeEach } from "vitest";
import {
  isMaintenanceModeActive,
  invalidateMaintenanceCache,
  createMaintenanceEmergencyStopMiddleware,
} from "../../src/server/maintenanceGate.ts";
import { verifyFirebaseIdTokenWithRevocation } from "../../src/server/tokenVerification.ts";
import { UnauthorizedError } from "../../src/server/httpErrors.ts";
import {
  bindGoogleCalendarSessionUid,
  getStoredAccessToken,
  setStoredAccessToken,
  disconnectGoogleCalendar,
  isGoogleCalendarConnected,
} from "../../src/services/googleCalendarService.ts";
import { purgeClientSessionOnUidTransition } from "../../src/lib/sessionIsolation.ts";
import {
  bindGoogleDriveDocsSessionUid,
  getStoredDocsAccessToken,
  setStoredDocsAccessToken,
} from "../../src/services/googleDriveDocsService.ts";
import {
  bindGoogleSheetsSessionUid,
  getStoredAccessToken as getSheetsStoredToken,
  setStoredAccessToken as setSheetsStoredToken,
} from "../../src/services/googleSheetsService.ts";

describe("Batch 1 Security & Session Isolation", () => {
  describe("AT-ADMIN-OPS-01: Maintenance Mode Emergency Stop Middleware", () => {
    beforeEach(() => {
      invalidateMaintenanceCache();
    });

    it("blocks regular API requests with 503 when maintenanceMode is enabled in Firestore", async () => {
      const mockDb = {
        collection: () => ({
          doc: () => ({
            get: async () => ({
              exists: true,
              data: () => ({ maintenanceMode: true }),
            }),
          }),
        }),
      };

      const middleware = createMaintenanceEmergencyStopMiddleware({
        getDb: () => mockDb,
        verifyTokenFn: async () => ({ uid: "user_1", isAdmin: false }),
        checkIsAdminFn: async () => false,
        env: { NODE_ENV: "test" } as any,
      });

      const nextCalls: number[] = [];
      let statusCode = 200;
      let jsonBody: any = null;

      await middleware(
        { path: "/jobs/create", originalUrl: "/api/jobs/create", headers: { authorization: "Bearer tok" } } as any,
        {
          status(code: number) {
            statusCode = code;
            return this;
          },
          json(body: any) {
            jsonBody = body;
            return this;
          },
        } as any,
        () => {
          nextCalls.push(1);
        }
      );

      expect(nextCalls.length).toBe(0);
      expect(statusCode).toBe(503);
      expect(jsonBody.code).toBe("MAINTENANCE_MODE_ACTIVE");
    });

    it("allows /api/health, /api/webhook, /api/maintenance/status, /api/admin/*, and verified admins during maintenance", async () => {
      const mockDb = {
        collection: () => ({
          doc: () => ({
            get: async () => ({
              exists: true,
              data: () => ({ maintenanceMode: true }),
            }),
          }),
        }),
      };

      const middleware = createMaintenanceEmergencyStopMiddleware({
        getDb: () => mockDb,
        verifyTokenFn: async () => ({ uid: "admin_1", isAdmin: true }),
        checkIsAdminFn: async (u) => u.isAdmin === true,
        env: { NODE_ENV: "test" } as any,
      });

      for (const path of ["/health", "/webhook", "/maintenance/status", "/admin/maintenance"]) {
        let called = false;
        await middleware(
          { path, originalUrl: `/api${path}`, headers: {} } as any,
          { status: () => ({ json: () => {} }) } as any,
          () => {
            called = true;
          }
        );
        expect(called).toBe(true);
      }

      let adminCalled = false;
      await middleware(
        { path: "/jobs/create", originalUrl: "/api/jobs/create", headers: { authorization: "Bearer admin_tok" } } as any,
        { status: () => ({ json: () => {} }) } as any,
        () => {
          adminCalled = true;
        }
      );
      expect(adminCalled).toBe(true);
    });

    it("detects MAINTENANCE_MODE env override immediately", async () => {
      const active = await isMaintenanceModeActive({ env: { MAINTENANCE_MODE: "true" } as any });
      expect(active).toBe(true);
    });
  });

  describe("AT-CJ-AUTH-05: Strict Token Verification & Revocation Checks", () => {
    const idToolkitErr = Object.assign(new Error("identitytoolkit.googleapis.com has not been used in project"), {
      code: "auth/internal-error",
    });

    it("always fails closed in production when Identity Toolkit is unavailable even if ALLOW_DEGRADED_AUTH=true", async () => {
      await expect(
        verifyFirebaseIdTokenWithRevocation("tok", {
          adminAuth: {
            verifyIdToken: async (_tok, checkRevoked) => {
              if (checkRevoked) throw idToolkitErr;
              return { uid: "u1", auth_time: 100 };
            },
            getUser: async () => ({ disabled: false }),
          },
          getDb: () => null,
          env: { NODE_ENV: "production", ALLOW_DEGRADED_AUTH: "true" } as any,
        })
      ).rejects.toThrow(UnauthorizedError);
    });

    it("fails closed in non-production if both secondary checks (getUser & Firestore) fail", async () => {
      await expect(
        verifyFirebaseIdTokenWithRevocation("tok", {
          adminAuth: {
            verifyIdToken: async (_tok, checkRevoked) => {
              if (checkRevoked) throw idToolkitErr;
              return { uid: "u1", auth_time: 100 };
            },
            getUser: async () => {
              throw new Error("identitytoolkit down");
            },
          },
          getDb: () => ({
            collection: () => ({
              doc: () => ({
                get: async () => {
                  throw new Error("firestore unavailable");
                },
              }),
            }),
          }),
          env: { NODE_ENV: "development", ALLOW_DEGRADED_AUTH: "true" } as any,
        })
      ).rejects.toThrow(UnauthorizedError);
    });

    it("rejects revoked or suspended accounts when Firestore secondary check detects revocation", async () => {
      await expect(
        verifyFirebaseIdTokenWithRevocation("tok", {
          adminAuth: {
            verifyIdToken: async (_tok, checkRevoked) => {
              if (checkRevoked) throw idToolkitErr;
              return { uid: "u1", auth_time: 1000 };
            },
            getUser: async () => {
              throw new Error("identitytoolkit down");
            },
          },
          getDb: () => ({
            collection: () => ({
              doc: () => ({
                get: async () => ({
                  exists: true,
                  data: () => ({ tokensRevokedAt: new Date(2000 * 1000).toISOString() }),
                }),
              }),
            }),
          }),
          env: { NODE_ENV: "development", ALLOW_DEGRADED_AUTH: "true" } as any,
        })
      ).rejects.toThrow(UnauthorizedError);
    });

    it("accepts cryptographically verified ID tokens in dev preview when Identity Toolkit and Admin Firestore lack IAM permissions", async () => {
      const permErr = Object.assign(new Error("7 PERMISSION_DENIED: Missing or insufficient permissions."), {
        code: 7,
      });
      const result = await verifyFirebaseIdTokenWithRevocation("valid-preview-jwt", {
        adminAuth: {
          verifyIdToken: async (_tok, checkRevoked) => {
            if (checkRevoked) throw idToolkitErr;
            return { uid: "admin_preview_1", email: "saanwar2002@gmail.com", auth_time: 1000 };
          },
          getUser: async () => {
            throw idToolkitErr;
          },
        },
        getDb: () => ({
          collection: () => ({
            doc: () => ({
              get: async () => {
                throw permErr;
              },
            }),
          }),
        }),
        env: { NODE_ENV: "development" } as any,
      });

      expect(result.uid).toBe("admin_preview_1");
    });

    it("fails closed in non-production when ALLOW_DEGRADED_AUTH is explicitly set to 'false'", async () => {
      await expect(
        verifyFirebaseIdTokenWithRevocation("tok", {
          adminAuth: {
            verifyIdToken: async (_tok, checkRevoked) => {
              if (checkRevoked) throw idToolkitErr;
              return { uid: "u1", auth_time: 1000 };
            },
            getUser: async () => ({ disabled: false }),
          },
          getDb: () => null,
          env: { NODE_ENV: "development", ALLOW_DEGRADED_AUTH: "false" } as any,
        })
      ).rejects.toThrow(UnauthorizedError);
    });

    it("still rejects invalid or expired tokens in dev preview even when revocation service is unavailable", async () => {
      const expiredErr = Object.assign(new Error("Firebase ID token has expired."), {
        code: "auth/id-token-expired",
      });
      await expect(
        verifyFirebaseIdTokenWithRevocation("expired-jwt", {
          adminAuth: {
            verifyIdToken: async (_tok, checkRevoked) => {
              if (checkRevoked) throw idToolkitErr;
              throw expiredErr;
            },
            getUser: async () => ({ disabled: false }),
          },
          getDb: () => null,
          env: { NODE_ENV: "development" } as any,
        })
      ).rejects.toThrow("Firebase ID token has expired.");
    });

    it("always fails closed in production when revocation check returns PERMISSION_DENIED", async () => {
      const iamErr = Object.assign(new Error("PERMISSION_DENIED on identitytoolkit"), {
        code: "auth/insufficient-permission",
      });
      await expect(
        verifyFirebaseIdTokenWithRevocation("tok", {
          adminAuth: {
            verifyIdToken: async (_tok, checkRevoked) => {
              if (checkRevoked) throw iamErr;
              return { uid: "u1", auth_time: 1000 };
            },
            getUser: async () => ({ disabled: false }),
          },
          getDb: () => null,
          env: { NODE_ENV: "production" } as any,
        })
      ).rejects.toThrow(UnauthorizedError);
    });
  });

  describe("AT-CJ-AUTH-06 & AT-CJ-CALENDAR-01: OAuth Token & Session Isolation Across UID Switches", () => {
    beforeEach(() => {
      disconnectGoogleCalendar();
      bindGoogleCalendarSessionUid(null);
      bindGoogleDriveDocsSessionUid(null);
      bindGoogleSheetsSessionUid(null);
    });

    it("clears Google Calendar, Docs, and Sheets tokens immediately when switching Firebase UID or logging out", () => {
      bindGoogleCalendarSessionUid("user_A");
      bindGoogleDriveDocsSessionUid("user_A");
      bindGoogleSheetsSessionUid("user_A");

      setStoredAccessToken("ya29.user_A_calendar_secret", 3600, "user_A");
      setStoredDocsAccessToken("ya29.user_A_docs_secret", 3600, "user_A");
      setSheetsStoredToken("ya29.user_A_sheets_secret", 3600, "user_A");

      expect(getStoredAccessToken("user_A")).toBe("ya29.user_A_calendar_secret");
      expect(getStoredDocsAccessToken("user_A")).toBe("ya29.user_A_docs_secret");
      expect(getSheetsStoredToken("user_A")).toBe("ya29.user_A_sheets_secret");

      // Mismatched UID read fails closed immediately
      expect(getStoredAccessToken("user_B")).toBeNull();
      expect(getStoredDocsAccessToken("user_B")).toBeNull();
      expect(getSheetsStoredToken("user_B")).toBeNull();

      // UID transition purges all tokens
      setStoredAccessToken("ya29.user_A_calendar_secret", 3600, "user_A");
      const purgeRes = purgeClientSessionOnUidTransition("user_A", "user_B");
      expect(purgeRes.purged).toBe(true);
      expect(isGoogleCalendarConnected()).toBe(false);
      expect(getStoredAccessToken()).toBeNull();
    });

    it("purges scoped storage keys cleanly on logout or account transition", () => {
      const mockLocal = new Map<string, string>();
      const mockSess = new Map<string, string>();
      (globalThis as any).localStorage = {
        get length() { return mockLocal.size; },
        key: (i: number) => Array.from(mockLocal.keys())[i] ?? null,
        getItem: (k: string) => mockLocal.get(k) ?? null,
        setItem: (k: string, v: string) => mockLocal.set(k, v),
        removeItem: (k: string) => mockLocal.delete(k),
      };
      (globalThis as any).sessionStorage = {
        get length() { return mockSess.size; },
        key: (i: number) => Array.from(mockSess.keys())[i] ?? null,
        getItem: (k: string) => mockSess.get(k) ?? null,
        setItem: (k: string, v: string) => mockSess.set(k, v),
        removeItem: (k: string) => mockSess.delete(k),
      };

      localStorage.setItem("anytrader_active_portal", "anyroller");
      localStorage.setItem("anytrader_active_role", "driver");
      localStorage.setItem("outreach_queue_state", "draft");
      sessionStorage.setItem("is_test_admin", "true");

      purgeClientSessionOnUidTransition("user_A", null);

      expect(localStorage.getItem("anytrader_active_portal")).toBeNull();
      expect(localStorage.getItem("anytrader_active_role")).toBeNull();
      expect(localStorage.getItem("outreach_queue_state")).toBeNull();
      expect(sessionStorage.getItem("is_test_admin")).toBeNull();
    });
  });
});
