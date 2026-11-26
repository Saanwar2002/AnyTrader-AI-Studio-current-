/**
 * Safe Post-Login Redirect Helper (Open-Redirect Defense)
 *
 * Validates and preserves internal relative redirect paths across `/login?redirect=...`,
 * Google OAuth redirects, and first-time user onboarding without ever allowing
 * external hosts, protocol-relative URLs (`//evil.com`), or `javascript:`/`data:` schemes.
 */

const PENDING_REDIRECT_KEY = "anytrader_pending_login_redirect";

/**
 * Returns a sanitized same-origin relative path (e.g. "/passport/view/123?tab=docs")
 * or null if the candidate is empty, unsafe, external, or points back to `/login`.
 */
export function sanitizePostLoginRedirect(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let candidate = raw.trim();
  if (!candidate || candidate.length > 512) return null;

  // Decode once if URI-encoded, rejecting malformed sequences
  try {
    if (candidate.includes("%")) {
      const decoded = decodeURIComponent(candidate);
      if (decoded.startsWith("/")) {
        candidate = decoded.trim();
      }
    }
  } catch {
    return null;
  }

  // Must start with a single leading slash and never `//` or `/\`
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return null;
  }

  // Reject any control characters, backslashes, or scheme prefixes
  if (/[\x00-\x1f\x7f\\]/.test(candidate)) {
    return null;
  }
  const lower = candidate.toLowerCase();
  if (
    lower.includes("javascript:") ||
    lower.includes("data:") ||
    lower.includes("vbscript:") ||
    lower.startsWith("/http:") ||
    lower.startsWith("/https:")
  ) {
    return null;
  }

  // Avoid infinite redirect loops back to /login
  const pathname = candidate.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  if (pathname === "/login") {
    return null;
  }

  return candidate;
}

export function extractRedirectFromSearch(search: string): string | null {
  try {
    const params = new URLSearchParams(search || "");
    return sanitizePostLoginRedirect(params.get("redirect"));
  } catch {
    return null;
  }
}

export function savePendingLoginRedirect(raw: string | null | undefined): string | null {
  const safe = sanitizePostLoginRedirect(raw);
  if (!safe || typeof window === "undefined") return null;
  try {
    window.sessionStorage.setItem(PENDING_REDIRECT_KEY, safe);
  } catch {
    // Ignore storage restriction errors in strict privacy contexts
  }
  return safe;
}

export function consumePendingLoginRedirect(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(PENDING_REDIRECT_KEY);
    if (!stored) return null;
    window.sessionStorage.removeItem(PENDING_REDIRECT_KEY);
    return sanitizePostLoginRedirect(stored);
  } catch {
    return null;
  }
}
