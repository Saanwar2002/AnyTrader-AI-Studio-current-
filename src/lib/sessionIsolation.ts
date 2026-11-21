import { bindGoogleCalendarSessionUid } from "../services/googleCalendarService";
import { bindGoogleDriveDocsSessionUid } from "../services/googleDriveDocsService";
import { bindGoogleSheetsSessionUid } from "../services/googleSheetsService";

const USER_SCOPED_LOCAL_KEYS = [
  "anytrader_active_portal",
  "anytrader_active_role",
  "anytrader_gsheets_spreadsheet_id",
  "master_admin_auth_config",
];

const USER_SCOPED_SESSION_KEYS = [
  "is_test_admin",
];

/**
 * Synchronously binds Google OAuth token caches to nextUid and purges
 * per-user cached storage keys when signing out or switching Firebase UIDs.
 */
export function purgeClientSessionOnUidTransition(
  prevUid: string | null,
  nextUid: string | null
): { purged: boolean } {
  bindGoogleCalendarSessionUid(nextUid);
  bindGoogleDriveDocsSessionUid(nextUid);
  bindGoogleSheetsSessionUid(nextUid);

  const isSignOut = nextUid === null;
  const isAccountSwitch = prevUid !== null && prevUid !== nextUid;
  if (!isSignOut && !isAccountSwitch) {
    return { purged: false };
  }

  try {
    if (typeof localStorage !== "undefined") {
      for (const key of USER_SCOPED_LOCAL_KEYS) {
        localStorage.removeItem(key);
      }
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith("outreach_") || k.startsWith("anytrader_outreach_") || k.startsWith("maintenance_dismissed_"))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    // Storage may be unavailable in restricted contexts
  }

  try {
    if (typeof sessionStorage !== "undefined") {
      for (const key of USER_SCOPED_SESSION_KEYS) {
        sessionStorage.removeItem(key);
      }
      const sessKeysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && (k.startsWith("outreach_") || k.startsWith("anytrader_outreach_"))) {
          sessKeysToRemove.push(k);
        }
      }
      sessKeysToRemove.forEach((k) => sessionStorage.removeItem(k));
    }
  } catch {
    // Storage may be unavailable in restricted contexts
  }

  return { purged: true };
}
