/**
 * Safe external URL validation and navigation helper.
 * Prevents javascript:, data:, vbscript:, and file: scheme injection as well as
 * reverse tabnabbing when opening user-supplied, partner-supplied, or remote-config URLs.
 */

export interface SafeUrlOptions {
  /** Allow blob: URLs (only for locally recorded/uploaded media previews). Defaults to false. */
  allowBlob?: boolean;
  /** Allow http: on localhost/127.0.0.1 for local development. Defaults to true. */
  allowLocalhostHttp?: boolean;
}

export function sanitizeExternalUrl(
  rawUrl: string | null | undefined,
  options: SafeUrlOptions = {}
): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Reject control characters or whitespace-smuggled protocols
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol === "https:") {
      return parsed.toString();
    }

    if (protocol === "http:") {
      const allowLocalhostHttp = options.allowLocalhostHttp !== false;
      const isLocalhost =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]";
      if (allowLocalhostHttp && isLocalhost) {
        return parsed.toString();
      }
      return null;
    }

    if (protocol === "blob:" && options.allowBlob === true) {
      return parsed.toString();
    }

    return null;
  } catch {
    return null;
  }
}

export function openSafeExternalUrl(
  rawUrl: string | null | undefined,
  options: SafeUrlOptions = {}
): boolean {
  const safeUrl = sanitizeExternalUrl(rawUrl, options);
  if (!safeUrl || typeof window === "undefined") {
    return false;
  }
  window.open(safeUrl, "_blank", "noopener,noreferrer");
  return true;
}
