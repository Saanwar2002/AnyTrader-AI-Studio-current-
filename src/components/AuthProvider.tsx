import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { auth, db, onAuthStateChanged, type FirebaseUser, doc, onSnapshot, handleFirestoreError, OperationType, logout, updateDoc, setDoc, addDoc, collection, serverTimestamp, signInWithGoogle, sendNotification, reloadCurrentUser } from "@/src/firebase";
import { Loader2, ShieldAlert, LogOut } from "lucide-react";
import { toast } from "sonner";

import { UserProfile } from "../types";
import { SessionReauthModal } from "./SessionReauthModal";
import { isAuthorizedAdminEmail } from "../services/adminAuthSecurityService";
import { checkAndNotifyTraderMatches } from "../services/traderNotificationEngine";
import { purgeClientSessionOnUidTransition } from "../lib/sessionIsolation";

export type SessionStatus = "active" | "expiring_soon" | "expired" | "invalid";

interface AuthContextType {
  user: FirebaseUser | null;
  profile: UserProfile | null;
  setProfile: React.Dispatch<React.SetStateAction<UserProfile | null>>;
  loading: boolean;
  isAuthReady: boolean;
  isAnonymous: boolean;
  emailVerified: boolean;
  refreshEmailVerification: () => Promise<boolean>;
  isTradeBotOpen: boolean;
  setIsTradeBotOpen: (isOpen: boolean) => void;
  signInWithGoogle: (options?: { forceWebView?: boolean }) => Promise<any>;
  sessionStatus: SessionStatus;
  lastHeartbeatAt: number | null;
  ensureFreshToken: (forceRefresh?: boolean) => Promise<boolean>;
  showReauthModal: boolean;
  setShowReauthModal: (show: boolean) => void;
  triggerReauthPrompt: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  setProfile: () => {},
  loading: true,
  isAuthReady: false,
  isAnonymous: false,
  emailVerified: false,
  refreshEmailVerification: async () => false,
  isTradeBotOpen: false,
  setIsTradeBotOpen: () => {},
  signInWithGoogle: async () => {},
  sessionStatus: "active",
  lastHeartbeatAt: null,
  ensureFreshToken: async () => true,
  showReauthModal: false,
  setShowReauthModal: () => {},
  triggerReauthPrompt: () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [isTradeBotOpen, setIsTradeBotOpen] = useState(false);

  const refreshEmailVerification = useCallback(async (): Promise<boolean> => {
    try {
      const refreshed = await reloadCurrentUser();
      const verified = Boolean(refreshed?.emailVerified);
      setEmailVerified(verified);
      if (refreshed) {
        setUser(refreshed);
      }
      return verified;
    } catch (err) {
      console.warn("[AuthProvider] Failed to refresh email verification status:", err);
      return Boolean(auth.currentUser?.emailVerified);
    }
  }, []);

  // Session Heartbeat States
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("active");
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);
  const [showReauthModal, setShowReauthModal] = useState(false);
  const activeUidRef = useRef<string | null>(null);

  // Lightweight, non-blocking token check
  const performHeartbeatCheck = useCallback(async (forceRefresh = false): Promise<boolean> => {
    if (!auth.currentUser) {
      setSessionStatus("active");
      return true;
    }

    const currentUser = auth.currentUser;

    return new Promise<boolean>((resolve) => {
      const runCheck = async () => {
        try {
          // getIdTokenResult(false) lightweight check of cached token claims and expiry
          const tokenResult = await currentUser.getIdTokenResult(forceRefresh);
          const expirationTimeMs = new Date(tokenResult.expirationTime).getTime();
          const nowMs = Date.now();
          const timeUntilExpiryMs = expirationTimeMs - nowMs;

          setLastHeartbeatAt(nowMs);

          // If token expires in < 5 minutes (300,000 ms), trigger background refresh
          if (timeUntilExpiryMs < 5 * 60 * 1000) {
            console.log(`[SessionHeartbeat] Auth token expiring in ~${Math.round(timeUntilExpiryMs / 1000)}s. Performing background token refresh...`);
            setSessionStatus("expiring_soon");
            try {
              await currentUser.getIdToken(true);
              setSessionStatus("active");
              console.log("[SessionHeartbeat] Auth token successfully refreshed in background.");
              resolve(true);
              return;
            } catch (refreshErr: any) {
              const isNetworkError =
                refreshErr?.code === "auth/network-request-failed" ||
                refreshErr?.message?.includes("network-request-failed") ||
                refreshErr?.code === "auth/timeout" ||
                (typeof navigator !== "undefined" && !navigator.onLine);

              if (isNetworkError) {
                console.warn("[SessionHeartbeat] Network glitch during background token refresh. Preserving active session state.");
                setSessionStatus("active");
                resolve(true);
                return;
              }

              console.warn("[SessionHeartbeat] Background token refresh failed:", refreshErr);
              setSessionStatus("expired");
              setShowReauthModal(true);
              resolve(false);
              return;
            }
          }

          setSessionStatus("active");
          resolve(true);
        } catch (err: any) {
          const isNetworkError =
            err?.code === "auth/network-request-failed" ||
            err?.message?.includes("network-request-failed") ||
            err?.code === "auth/timeout" ||
            err?.message?.includes("Failed to fetch") ||
            (typeof navigator !== "undefined" && !navigator.onLine);

          if (isNetworkError) {
            console.warn("[SessionHeartbeat] Transient network glitch during heartbeat token validation. Preserving active session:", err?.message || err);
            setSessionStatus("active");
            resolve(true);
            return;
          }

          console.error("[SessionHeartbeat] Token validation error:", err);
          if (
            err?.code === "auth/user-token-expired" ||
            err?.code === "auth/user-disabled" ||
            err?.code === "auth/user-not-found" ||
            err?.code === "auth/invalid-user-token"
          ) {
            setSessionStatus("invalid");
            setShowReauthModal(true);
            resolve(false);
          } else {
            // Unknown non-fatal error
            resolve(true);
          }
        }
      };

      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        (window as any).requestIdleCallback(() => runCheck(), { timeout: 2000 });
      } else {
        setTimeout(runCheck, 0);
      }
    });
  }, []);

  const ensureFreshToken = useCallback(async (forceRefresh = false): Promise<boolean> => {
    if (!auth.currentUser) return false;
    try {
      await auth.currentUser.getIdToken(forceRefresh);
      setSessionStatus("active");
      setLastHeartbeatAt(Date.now());
      return true;
    } catch (err: any) {
      const isNetworkError =
        err?.code === "auth/network-request-failed" ||
        err?.message?.includes("network-request-failed") ||
        err?.code === "auth/timeout" ||
        err?.message?.includes("Failed to fetch") ||
        (typeof navigator !== "undefined" && !navigator.onLine);

      if (isNetworkError) {
        console.warn("[SessionHeartbeat] Transient network error in ensureFreshToken, keeping session active:", err);
        return true;
      }

      console.warn("[SessionHeartbeat] ensureFreshToken failed:", err);
      setSessionStatus("expired");
      setShowReauthModal(true);
      toast.error("Session verification required before proceeding with critical action.", {
        id: "session-reauth-warning",
        duration: 5000,
      });
      return false;
    }
  }, []);

  const triggerReauthPrompt = useCallback(() => {
    setShowReauthModal(true);
  }, []);

  // Periodic Session Heartbeat & Tab Focus Listener
  useEffect(() => {
    if (!user) return;

    performHeartbeatCheck(false);

    // Heartbeat every 5 minutes (300,000ms)
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
    const intervalId = setInterval(() => {
      performHeartbeatCheck(false);
    }, HEARTBEAT_INTERVAL_MS);

    // Re-check when window regains focus / tab visibility
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") {
        const now = Date.now();
        if (!lastHeartbeatAt || now - lastHeartbeatAt > 60 * 1000) {
          performHeartbeatCheck(false);
        }
        // Check trader matches if trader/business profile is loaded
        if (profile && (profile.role === "tradesperson" || profile.role === "business")) {
          checkAndNotifyTraderMatches(profile).catch(() => {});
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
    };
  }, [user, profile, performHeartbeatCheck, lastHeartbeatAt]);

  useEffect(() => {
    let profileUnsubscribe: (() => void) | null = null;

    // Safety timer: unblock initial loading after 1500ms if Firebase Auth/Firestore is slow
    const initFallbackTimer = setTimeout(() => {
      setLoading(false);
      setIsAuthReady(true);
    }, 1500);

    const authUnsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      clearTimeout(initFallbackTimer);

      const nextUid = firebaseUser?.uid ?? null;
      const prevUid = activeUidRef.current;
      if (nextUid !== prevUid) {
        activeUidRef.current = nextUid;
        setProfile(null);
        setShowReauthModal(false);
        setSessionStatus("active");
        setLastHeartbeatAt(null);
        setIsTradeBotOpen(false);
        purgeClientSessionOnUidTransition(prevUid, nextUid);
        if (nextUid !== null) {
          setLoading(true);
        }
      }

      if (firebaseUser && !firebaseUser.emailVerified && !firebaseUser.isAnonymous) {
        console.warn("Unverified email signed in:", firebaseUser.email);
      }

      setUser(firebaseUser);
      setIsAnonymous(firebaseUser?.isAnonymous || false);
      setEmailVerified(Boolean(firebaseUser?.emailVerified));
      
      if (profileUnsubscribe) {
        profileUnsubscribe();
        profileUnsubscribe = null;
      }

      if (firebaseUser) {
        let expirySyncTriggeredForSession = false;
        // Listen for profile changes in real-time
        profileUnsubscribe = onSnapshot(doc(db, "users", firebaseUser.uid), async (docSnap) => {
          try {
            if (docSnap.exists()) {
              const data = docSnap.data();

              // Set profile and unblock UI immediately
              setProfile(data as UserProfile);
              setLoading(false);
              setIsAuthReady(true);

              // Trigger server-authoritative doc expiry/warning sync once per session if any doc is expired or within 30 days
              if (!expirySyncTriggeredForSession && Array.isArray(data.verificationDocs) && data.verificationDocs.length > 0) {
                const nowMs = Date.now();
                const thirtyDaysMs = nowMs + 30 * 24 * 60 * 60 * 1000;
                const needsServerExpirySync = data.verificationDocs.some((docItem: any) => {
                  if (!docItem?.expiryDate) return false;
                  const expMs = Date.parse(docItem.expiryDate);
                  if (!Number.isFinite(expMs)) return false;
                  return (expMs < nowMs && docItem.status !== "expired") ||
                    (expMs >= nowMs && expMs < thirtyDaysMs && !docItem.expiryWarningSent);
                });
                if (needsServerExpirySync) {
                  expirySyncTriggeredForSession = true;
                  firebaseUser
                    .getIdToken()
                    .then((idToken) =>
                      fetch("/api/account/sync-expired-docs", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${idToken}`,
                        },
                      })
                    )
                    .catch((syncErr) => console.warn("Background doc expiry sync skipped:", syncErr));
                }
              }
            } else {
              setProfile(null);
              setLoading(false);
              setIsAuthReady(true);
            }
          } catch (err) {
            console.error("Error in profile snapshot handler:", err);
            setLoading(false);
            setIsAuthReady(true);
          }
        }, (error) => {
          if (error.code === 'permission-denied') {
            console.log("Permission denied for profile listener, likely due to logout or missing rules.");
          } else {
            console.error("Error fetching profile:", error);
            try {
              handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
            } catch (e) {
              console.error("Failed to handle firestore error", e);
            }
          }
          setProfile(null);
          setLoading(false);
          setIsAuthReady(true);
        });
      } else {
        setProfile(null);
        setLoading(false);
        setIsAuthReady(true);
      }
    });

    return () => {
      clearTimeout(initFallbackTimer);
      authUnsubscribe();
      if (profileUnsubscribe) profileUnsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ 
      user, 
      profile, 
      setProfile, 
      loading, 
      isAuthReady, 
      isAnonymous, 
      emailVerified,
      refreshEmailVerification,
      isTradeBotOpen, 
      setIsTradeBotOpen, 
      signInWithGoogle,
      sessionStatus,
      lastHeartbeatAt,
      ensureFreshToken,
      showReauthModal,
      setShowReauthModal,
      triggerReauthPrompt
    }}>
      {loading ? (
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
            <p className="text-slate-600 font-medium animate-pulse">Initializing AnyTrader...</p>
          </div>
        </div>
      ) : (
        <>
          {children}
          <SessionReauthModal />
        </>
      )}
    </AuthContext.Provider>
  );
};
