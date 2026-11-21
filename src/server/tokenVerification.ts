import { UnauthorizedError } from "./httpErrors.ts";

export interface TokenVerificationDeps {
  adminAuth: {
    verifyIdToken: (token: string, checkRevoked?: boolean) => Promise<any>;
    getUser: (uid: string) => Promise<any>;
  };
  getDb: () => any;
  env?: NodeJS.ProcessEnv;
}

export function isRevocationBackendUnavailableError(err: any): boolean {
  const code = String(err?.code ?? "");
  const message = String(err?.message ?? "");

  // Never treat genuine token or account failures as backend unavailability
  if (
    code === "auth/id-token-expired" ||
    code === "auth/id-token-revoked" ||
    code === "auth/user-disabled" ||
    code === "auth/argument-error" ||
    code === "auth/invalid-id-token" ||
    code === "auth/user-not-found"
  ) {
    return false;
  }

  return Boolean(
    message.includes("identitytoolkit.googleapis.com") ||
    code === "auth/internal-error" ||
    code === "auth/insufficient-permission" ||
    err?.code === 7 ||
    message.includes("SERVICE_DISABLED") ||
    message.includes("accessNotConfigured") ||
    message.includes("has not been used in project") ||
    message.includes("PERMISSION_DENIED") ||
    message.includes("UNAUTHENTICATED") ||
    message.includes("insufficient authentication scopes") ||
    message.includes("Could not load the default credentials")
  );
}

let lastPreviewFallbackWarningAt = 0;

function logRateLimitedPreviewWarning(message: string): void {
  const now = Date.now();
  if (now - lastPreviewFallbackWarningAt >= 60_000) {
    lastPreviewFallbackWarningAt = now;
    console.warn(message);
  }
}

export async function verifyFirebaseIdTokenWithRevocation(
  token: string,
  deps: TokenVerificationDeps
): Promise<any> {
  const { adminAuth, getDb, env = process.env } = deps;

  try {
    return await adminAuth.verifyIdToken(token, true);
  } catch (err: any) {
    if (!isRevocationBackendUnavailableError(err)) {
      throw err;
    }

    // Hard fail closed in production regardless of ALLOW_DEGRADED_AUTH
    if (env.NODE_ENV === "production") {
      console.error(
        "[Auth] Identity Toolkit unavailable; refusing degraded authentication without cryptographic revocation checks in production."
      );
      throw new UnauthorizedError("Authentication service temporarily unavailable. Please retry.");
    }

    // Explicit opt-out in non-production environments always fails closed
    if (env.ALLOW_DEGRADED_AUTH === "false") {
      throw new UnauthorizedError("Authentication revocation service unavailable; failing closed.");
    }

    logRateLimitedPreviewWarning(
      "[Auth Warning] Identity Toolkit revocation service unavailable in non-production; verifying cryptographic ID token signature and running best-effort secondary status checks."
    );

    // Cryptographically verifies JWT signature, expiration, issuer, audience, and project ID (requires no IAM)
    const decodedToken = await adminAuth.verifyIdToken(token, false);

    let authRecordVerified = false;
    let authFailure: any = null;
    let firestoreRecordVerified = false;
    let firestoreFailure: any = null;

    // 1. Secondary check via Firebase Admin getUser (enforces disabled & tokensValidAfterTime if reachable)
    try {
      const userRecord = await adminAuth.getUser(decodedToken.uid);
      if (userRecord.disabled) {
        throw new UnauthorizedError("Account has been disabled or banned.");
      }
      if (userRecord.tokensValidAfterTime && decodedToken.auth_time) {
        const validSinceSec = Math.floor(new Date(userRecord.tokensValidAfterTime).getTime() / 1000);
        if (decodedToken.auth_time < validSinceSec) {
          throw new UnauthorizedError("Authentication token has been revoked.");
        }
      }
      authRecordVerified = true;
    } catch (authErr: any) {
      if (authErr instanceof UnauthorizedError) {
        throw authErr;
      }
      if (authErr?.code === "auth/user-disabled") {
        throw new UnauthorizedError("Account has been disabled or banned.");
      }
      authFailure = authErr;
    }

    // 2. Secondary Firestore user security status & revocation timestamp verification (if reachable)
    const targetDb = getDb();
    if (targetDb) {
      try {
        const userDoc = await targetDb.collection("users").doc(decodedToken.uid).get();
        const exists = typeof userDoc?.exists === "function" ? userDoc.exists() : Boolean(userDoc?.exists);
        if (exists) {
          const userData = (typeof userDoc.data === "function" ? userDoc.data() : userDoc.data) || {};
          if (
            userData.disabled === true ||
            userData.isSuspended === true ||
            userData.isBanned === true ||
            userData.banned === true ||
            userData.status === "banned" ||
            userData.status === "suspended" ||
            userData.status === "deleted"
          ) {
            throw new UnauthorizedError("Account has been suspended, banned, or disabled.");
          }
          if (userData.tokensRevokedAt && decodedToken.auth_time) {
            const revokedTimestamp =
              typeof userData.tokensRevokedAt.toMillis === "function"
                ? Math.floor(userData.tokensRevokedAt.toMillis() / 1000)
                : Math.floor(new Date(userData.tokensRevokedAt).getTime() / 1000);
            if (decodedToken.auth_time < revokedTimestamp) {
              throw new UnauthorizedError("Authentication token has been revoked.");
            }
          }
        }
        firestoreRecordVerified = true;
      } catch (dbErr: any) {
        if (dbErr instanceof UnauthorizedError) {
          throw dbErr;
        }
        firestoreFailure = dbErr;
        if (!isRevocationBackendUnavailableError(dbErr)) {
          console.warn(
            "[Auth Fallback Warning] Secondary Firestore user status check failed:",
            dbErr?.message || dbErr
          );
        }
      }
    }

    // If neither secondary check succeeded:
    // - In dev preview when both backends are blocked strictly by IAM / missing preview credentials / disabled APIs,
    //   accept the cryptographically verified ID token (verified above via verifyIdToken(token, false)).
    // - For any other unexpected backend error, fail closed.
    if (!authRecordVerified && !firestoreRecordVerified) {
      const authBlockedByIam = authFailure !== null && isRevocationBackendUnavailableError(authFailure);
      const firestoreBlockedByIam = !targetDb || isRevocationBackendUnavailableError(firestoreFailure);
      if (authBlockedByIam && firestoreBlockedByIam) {
        logRateLimitedPreviewWarning(
          "[Auth Warning] Secondary Auth/Firestore IAM access unavailable in dev preview; accepting cryptographically verified Firebase ID token."
        );
        return decodedToken;
      }
      throw new UnauthorizedError(
        "Token revocation status could not be confirmed by secondary checks; failing closed."
      );
    }

    return decodedToken;
  }
}
