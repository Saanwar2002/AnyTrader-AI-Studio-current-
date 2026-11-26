export type AuthMode = "signin" | "signup" | "reset";

export interface PasswordRequirements {
  hasMinLength: boolean;
  hasLetter: boolean;
  hasNumber: boolean;
  isValid: boolean;
}

export interface FormattedAuthError {
  message: string;
  kind:
    | "standard"
    | "iframe_blocked"
    | "third_party_cookies"
    | "account_exists_different_provider"
    | "cancelled";
}

export const PASSWORD_REQUIREMENT_MESSAGE =
  "Password must be at least 8 characters long and include both letters and numbers.";

/**
 * Safely detects whether the app is running inside an embedded iframe without
 * throwing a SecurityError on cross-origin parent windows.
 */
export function isRunningInEmbeddedIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Evaluates live password strength rules for Create Account feedback.
 */
export function evaluatePasswordRequirements(password: string): PasswordRequirements {
  const trimmed = password.trim();
  const hasMinLength = trimmed.length >= 8;
  const hasLetter = /[a-zA-Z]/.test(trimmed);
  const hasNumber = /\d/.test(trimmed);
  return {
    hasMinLength,
    hasLetter,
    hasNumber,
    isValid: hasMinLength && hasLetter && hasNumber,
  };
}

/**
 * Validates email and password input consistently across Sign In, Create Account, and Password Reset.
 */
export function validateEmailPasswordInput(params: {
  email: string;
  password: string;
  mode: AuthMode;
}): string | null {
  const trimmedEmail = params.email.trim();
  const trimmedPassword = params.password.trim();

  if (!trimmedEmail) {
    return "Please enter your email address.";
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return "Please enter a valid email address.";
  }

  if (params.mode === "reset") {
    return null;
  }

  if (!trimmedPassword) {
    return "Please enter your password.";
  }

  if (params.mode === "signup") {
    const reqs = evaluatePasswordRequirements(trimmedPassword);
    if (!reqs.isValid) {
      return PASSWORD_REQUIREMENT_MESSAGE;
    }
  }

  return null;
}

/**
 * Normalizes Firebase Auth error codes for Email & Google sign-in into clear,
 * accurate, user-safe messages with zero leaked developer setup dumps.
 */
export function formatAuthErrorMessage(
  error: any,
  context: { provider: "email" | "google"; isEmbeddedIframe?: boolean }
): FormattedAuthError {
  const errCode = String(error?.code || "").trim();
  const errMsg = String(error?.message || error || "").trim();
  const isIframe = Boolean(context.isEmbeddedIframe);

  if (context.provider === "google") {
    if (
      errCode === "auth/popup-closed-by-user" ||
      errMsg.includes("popup-closed-by-user")
    ) {
      return {
        kind: "cancelled",
        message: "Google sign-in was closed before completing. Click Continue with Google to try again.",
      };
    }

    if (
      errCode === "auth/cancelled-popup-request" ||
      errMsg.includes("cancelled-popup-request")
    ) {
      return {
        kind: "cancelled",
        message: "A Google sign-in window is already open. Complete it or try again.",
      };
    }

    if (
      errCode === "auth/popup-blocked" ||
      errMsg.includes("popup-blocked")
    ) {
      if (isIframe) {
        return {
          kind: "iframe_blocked",
          message:
            "Your browser blocked the Google sign-in window inside this preview frame. Open AnyTrader in a full browser tab to sign in with Google.",
        };
      }
      return {
        kind: "standard",
        message:
          "Your browser blocked the Google sign-in pop-up. Please allow pop-ups for this site and try again, or sign in with Email & Password.",
      };
    }

    if (
      errCode === "auth/account-exists-with-different-credential" ||
      errMsg.includes("account-exists-with-different-credential")
    ) {
      return {
        kind: "account_exists_different_provider",
        message:
          "An account with this email already exists using Email & Password. Sign in with your email and password above, or reset your password.",
      };
    }

    if (
      errCode === "auth/internal-error" ||
      errMsg.includes("auth/internal-error") ||
      errMsg.includes("web-channel-connection-failed")
    ) {
      return {
        kind: "third_party_cookies",
        message:
          "Your browser privacy settings blocked Google sign-in cookies. Allow third-party cookies for this site, open in a standard browser tab, or sign in with Email & Password.",
      };
    }

    if (
      errCode === "auth/network-request-failed" ||
      errMsg.includes("network-request-failed")
    ) {
      if (isIframe) {
        return {
          kind: "iframe_blocked",
          message:
            "Google sign-in is restricted inside embedded preview panels. Open AnyTrader in a full browser tab, or use Email & Password.",
        };
      }
      return {
        kind: "standard",
        message:
          "Unable to reach Google sign-in right now. Check your internet connection and try again, or sign in with Email & Password.",
      };
    }

    if (
      errCode === "auth/unauthorized-domain" ||
      errMsg.includes("unauthorized-domain")
    ) {
      return {
        kind: "standard",
        message:
          "Google sign-in is not yet enabled on this web domain. Please sign in with Email & Password instead.",
      };
    }

    if (
      errCode === "auth/operation-not-allowed" ||
      errMsg.includes("operation-not-allowed")
    ) {
      return {
        kind: "standard",
        message:
          "Google sign-in is currently disabled. Please sign in with Email & Password.",
      };
    }

    if (errCode === "auth/too-many-requests") {
      return {
        kind: "standard",
        message: "Too many sign-in attempts. Please wait a minute before trying again.",
      };
    }

    return {
      kind: "standard",
      message: "Could not complete Google sign-in. Please try again or use Email & Password.",
    };
  }

  // Email / Password auth errors
  switch (errCode) {
    case "auth/invalid-email":
      return { kind: "standard", message: "Please enter a valid email address." };
    case "auth/user-not-found":
      return { kind: "standard", message: "No account was found with this email address." };
    case "auth/wrong-password":
      return { kind: "standard", message: "Incorrect password. Please try again or reset your password." };
    case "auth/invalid-credential":
      return { kind: "standard", message: "Invalid email or password. Please check your details and try again." };
    case "auth/email-already-in-use":
      return {
        kind: "standard",
        message: "An account with this email already exists. Switch to Sign In or use Forgot Password.",
      };
    case "auth/weak-password":
      return { kind: "standard", message: PASSWORD_REQUIREMENT_MESSAGE };
    case "auth/too-many-requests":
      return {
        kind: "standard",
        message: "Too many attempts. Please wait a minute and try again, or reset your password.",
      };
    case "auth/network-request-failed":
      return {
        kind: "standard",
        message: "Network connection issue. Please check your internet connection and try again.",
      };
    case "auth/operation-not-allowed":
      return {
        kind: "standard",
        message: "Email & Password sign-in is temporarily unavailable. Please try Continue with Google.",
      };
    default:
      return {
        kind: "standard",
        message:
          errMsg && !errMsg.startsWith("Firebase:")
            ? errMsg
            : "We couldn't complete your request. Please check your details and try again.",
      };
  }
}

/**
 * Determines whether the non-blocking Email Verification Banner should be shown
 * to the currently signed-in user.
 */
export function shouldShowEmailVerificationBanner(params: {
  user: {
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    providerData?: Array<{ providerId?: string }>;
  } | null;
  isAnonymous?: boolean;
  isAdmin?: boolean;
}): boolean {
  const { user, isAnonymous, isAdmin } = params;
  if (!user || isAnonymous || user.isAnonymous || isAdmin) return false;
  if (!user.email || user.emailVerified === true) return false;

  const providers = Array.isArray(user.providerData) ? user.providerData : [];
  if (providers.length > 0) {
    const usesPassword = providers.some((p) => p?.providerId === "password");
    if (!usesPassword) return false;
  }

  return true;
}
