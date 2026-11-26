import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PASSWORD_REQUIREMENT_MESSAGE,
  evaluatePasswordRequirements,
  formatAuthErrorMessage,
  shouldShowEmailVerificationBanner,
  validateEmailPasswordInput,
} from "../../src/lib/authHelpers.ts";

describe("Task 10 — Login & Sign-Up UX Hardening + Google Login Fixes", () => {
  describe("Password & Email Validation Consistency", () => {
    it("evaluates live 8-char + letter + number requirements accurately", () => {
      expect(evaluatePasswordRequirements("short1")).toEqual({
        hasMinLength: false,
        hasLetter: true,
        hasNumber: true,
        isValid: false,
      });
      expect(evaluatePasswordRequirements("onlyletters")).toEqual({
        hasMinLength: true,
        hasLetter: true,
        hasNumber: false,
        isValid: false,
      });
      expect(evaluatePasswordRequirements("12345678")).toEqual({
        hasMinLength: true,
        hasLetter: false,
        hasNumber: true,
        isValid: false,
      });
      expect(evaluatePasswordRequirements("TradeSafe9")).toEqual({
        hasMinLength: true,
        hasLetter: true,
        hasNumber: true,
        isValid: true,
      });
    });

    it("rejects weak signup passwords with consistent 8-char message while allowing reset without password", () => {
      expect(
        validateEmailPasswordInput({
          email: "user@example.com",
          password: "abc123",
          mode: "signup",
        })
      ).toBe(PASSWORD_REQUIREMENT_MESSAGE);

      expect(
        validateEmailPasswordInput({
          email: "user@example.com",
          password: "",
          mode: "reset",
        })
      ).toBeNull();

      expect(
        validateEmailPasswordInput({
          email: "not-an-email",
          password: "Password1",
          mode: "signin",
        })
      ).toBe("Please enter a valid email address.");
    });
  });

  describe("Google & Email Auth Error Formatting", () => {
    it("formats auth/weak-password with the accurate 8-char rule (never 6 chars)", () => {
      const formatted = formatAuthErrorMessage(
        { code: "auth/weak-password", message: "Firebase: Password should be at least 6 characters" },
        { provider: "email" }
      );
      expect(formatted.message).toBe(PASSWORD_REQUIREMENT_MESSAGE);
      expect(formatted.message).not.toContain("6 characters");
    });

    it("handles Google auth/account-exists-with-different-credential cleanly", () => {
      const formatted = formatAuthErrorMessage(
        { code: "auth/account-exists-with-different-credential" },
        { provider: "google" }
      );
      expect(formatted.kind).toBe("account_exists_different_provider");
      expect(formatted.message).toContain("Email & Password");
    });

    it("distinguishes iframe popup/network blocks from top-level network drops without leaking console setup dumps", () => {
      const iframeBlocked = formatAuthErrorMessage(
        { code: "auth/popup-blocked" },
        { provider: "google", isEmbeddedIframe: true }
      );
      expect(iframeBlocked.kind).toBe("iframe_blocked");
      expect(iframeBlocked.message).toContain("full browser tab");

      const topLevelNetwork = formatAuthErrorMessage(
        { code: "auth/network-request-failed" },
        { provider: "google", isEmbeddedIframe: false }
      );
      expect(topLevelNetwork.kind).toBe("standard");
      expect(topLevelNetwork.message).not.toContain("FIREBASE_MISCONFIGURED");
      expect(topLevelNetwork.message).not.toContain("Firebase Console");
    });

    it("marks popup-closed-by-user and cancelled-popup-request as non-fatal cancellations", () => {
      expect(
        formatAuthErrorMessage({ code: "auth/popup-closed-by-user" }, { provider: "google" }).kind
      ).toBe("cancelled");
      expect(
        formatAuthErrorMessage({ code: "auth/cancelled-popup-request" }, { provider: "google" }).kind
      ).toBe("cancelled");
    });
  });

  describe("Email Verification Banner Visibility Rules", () => {
    it("shows only for unverified non-anonymous, non-admin password accounts", () => {
      expect(
        shouldShowEmailVerificationBanner({
          user: {
            email: "newuser@example.com",
            emailVerified: false,
            isAnonymous: false,
            providerData: [{ providerId: "password" }],
          },
          isAnonymous: false,
          isAdmin: false,
        })
      ).toBe(true);

      expect(
        shouldShowEmailVerificationBanner({
          user: {
            email: "verified@example.com",
            emailVerified: true,
            isAnonymous: false,
            providerData: [{ providerId: "password" }],
          },
          isAnonymous: false,
          isAdmin: false,
        })
      ).toBe(false);

      expect(
        shouldShowEmailVerificationBanner({
          user: {
            email: "google@example.com",
            emailVerified: false,
            isAnonymous: false,
            providerData: [{ providerId: "google.com" }],
          },
          isAnonymous: false,
          isAdmin: false,
        })
      ).toBe(false);

      expect(
        shouldShowEmailVerificationBanner({
          user: {
            email: "admin@example.com",
            emailVerified: false,
            isAnonymous: false,
            providerData: [{ providerId: "password" }],
          },
          isAnonymous: false,
          isAdmin: true,
        })
      ).toBe(false);
    });
  });

  describe("Source Regression Guards (Firebase Auth, Login UI, TermsModal, EmailVerificationBanner)", () => {
    const firebaseSrc = fs.readFileSync(path.resolve(process.cwd(), "src/firebase.ts"), "utf8");
    const loginSrc = fs.readFileSync(path.resolve(process.cwd(), "src/components/Login.tsx"), "utf8");
    const termsModalSrc = fs.readFileSync(path.resolve(process.cwd(), "src/components/TermsModal.tsx"), "utf8");
    const layoutSrc = fs.readFileSync(path.resolve(process.cwd(), "src/components/Layout.tsx"), "utf8");
    const bannerSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/shared/EmailVerificationBanner.tsx"),
      "utf8"
    );

    it("initializes Firebase Auth with initializeAuth before getAuth fallback and protects Google redirect inside iframes", () => {
      const initIdx = firebaseSrc.indexOf("authInstance = initializeAuth(");
      const getAuthIdx = firebaseSrc.indexOf("authInstance = getAuth(app)");
      expect(initIdx).toBeGreaterThan(-1);
      expect(getAuthIdx).toBeGreaterThan(initIdx);
      expect(firebaseSrc).toContain("googleSignInInFlight");
      expect(firebaseSrc).toContain("isEmbeddedPreviewFrame()");
      expect(firebaseSrc).toContain("signInWithPopup(auth, googleProvider, browserPopupRedirectResolver)");
      expect(firebaseSrc).toContain("getRedirectResult(auth, browserPopupRedirectResolver)");
      expect(firebaseSrc).toContain("export const reloadCurrentUser");
    });

    it("removes weak 6-char copy, external Google favicon, developer console dump, and fake 600ms biometric modal from Login.tsx", () => {
      expect(loginSrc).not.toContain("minimum 6 characters");
      expect(loginSrc).not.toContain("google.com/favicon.ico");
      expect(loginSrc).not.toContain("FIREBASE_MISCONFIGURED");
      expect(loginSrc).not.toContain("showBiometricOverlay");
      expect(loginSrc).not.toContain("setTimeout(resolve, 600)");
      expect(loginSrc).toContain("GoogleMark");
      expect(loginSrc).toContain("<TermsModal");
      expect(loginSrc).toContain('openLegalModal("general")');
      expect(loginSrc).toContain('openLegalModal("privacy")');
      expect(loginSrc).toContain("handleRedirectResult()");
    });

    it("syncs TermsModal initialTab on open and mounts EmailVerificationBanner in Layout", () => {
      expect(termsModalSrc).toContain("setSelectedCategory(initialTab)");
      expect(layoutSrc).toContain("<EmailVerificationBanner");
      expect(bannerSrc).toContain("Resend Verification Email");
      expect(bannerSrc).toContain("sendVerificationEmail");
      expect(bannerSrc).toContain("refreshEmailVerification");
    });
  });
});
