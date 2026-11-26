import { db, collection, query, where, limit, getDocs, doc, updateDoc, sendNotification } from "../firebase";
import { isOpenJobStatus, isProfileAcceptingNewWork, PUBLIC_OPEN_JOB_STATUSES } from "../lib/marketplaceContracts";
import {
  evaluateCategoryAlignment,
  evaluateCertificationEligibility,
  evaluateGeographicFit,
  extractJobPostcode,
  extractTraderCategories,
  hasExclusiveLeadAccess,
  isTraderInQuietHours,
  isWithinExclusiveWindow,
} from "../lib/unifiedJobMatching";
import { getCategoryMetadata } from "../lib/fuzzyMatch";
import { categoryRegistry } from "./categoryRegistrySync";

export type MatchNotificationSchedule = "every_5_hours" | "morning_8am" | "afternoon_2pm" | "silent_in_app_only";

export interface TraderMatchNotificationSettings {
  schedule: MatchNotificationSchedule;
  radiusMiles: number; // e.g. 5, 10, 15, 25, 50
  bypassEmergency: boolean; // default true
  soundEnabled: boolean; // default true unless silent
  lastCheckedAt?: number;
  lastNotifiedAt?: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: TraderMatchNotificationSettings = {
  schedule: "every_5_hours",
  radiusMiles: 25,
  bypassEmergency: true,
  soundEnabled: true,
};

/**
 * Checks if the current time window aligns with the trader's schedule preferences.
 */
export function isScheduleWindowActive(
  schedule: MatchNotificationSchedule,
  lastNotifiedAt?: number
): boolean {
  if (schedule === "silent_in_app_only") {
    return false; // Does not trigger OS system/sound banner
  }

  const now = new Date();
  const currentHour = now.getHours();
  const nowMs = now.getTime();
  const lastTime = lastNotifiedAt || 0;
  const hoursSinceLast = (nowMs - lastTime) / (1000 * 60 * 60);

  if (schedule === "every_5_hours") {
    return hoursSinceLast >= 5;
  }

  if (schedule === "morning_8am") {
    const isMorning = currentHour >= 8 && currentHour < 12;
    return isMorning && hoursSinceLast >= 12;
  }

  if (schedule === "afternoon_2pm") {
    const isAfternoon = currentHour >= 14 && currentHour < 18;
    return isAfternoon && hoursSinceLast >= 12;
  }

  return false;
}

/**
 * Evaluates whether a job strictly matches a trader's trade, services, certifications,
 * Priority Offers exclusive window, and true geodesic/postcode-centroid radius.
 * Works identically on private `/jobs` AND sanitized `/public_job_cards`.
 */
export function isJobStrictMatch(
  job: any,
  traderProfile: any,
  radiusMiles: number = 25
): { isMatch: boolean; distance: number; reason: string } {
  if (!job || !traderProfile) {
    return { isMatch: false, distance: 0, reason: "Missing job or trader data" };
  }

  // 1. Status Check: Must be open for quotes
  if (!isOpenJobStatus(job.status)) {
    return { isMatch: false, distance: 0, reason: "Job is not open" };
  }

  // 1b. Respect Priority Offers exclusive early-access window
  if (isWithinExclusiveWindow(job) && !hasExclusiveLeadAccess(traderProfile)) {
    return { isMatch: false, distance: 0, reason: "In Priority Offers exclusive window" };
  }

  // 2. Prevent notifying self
  const ownerId = job.homeownerId || job.userId || job.ownerId;
  if (ownerId && traderProfile.uid && ownerId === traderProfile.uid) {
    return { isMatch: false, distance: 0, reason: "Self-posted job" };
  }

  // 3. Strict Trade Category & Subcategory Matching via Unified Engine
  const meta = getCategoryMetadata(job.category || "");
  const reg = categoryRegistry.getCategoryByName(job.category || "");
  const categorySynonyms = Array.from(new Set([...(meta?.synonyms || []), ...(reg?.synonyms || [])]));

  const catAlign = evaluateCategoryAlignment(traderProfile, job, {
    mode: "strict",
    categorySynonyms,
  });

  if (!catAlign.matched) {
    return { isMatch: false, distance: 0, reason: "Category mismatch" };
  }

  // 3b. Regulated Certification Gate
  const certCheck = evaluateCertificationEligibility(traderProfile, job);
  if (!certCheck.eligible) {
    return {
      isMatch: false,
      distance: 0,
      reason: certCheck.reason || "Regulated certification required",
    };
  }

  // 4. Unified Geodesic + UK Postcode-Centroid Distance Radius Check (works on public_job_cards.postcodeArea!)
  const geo = evaluateGeographicFit(traderProfile, job, {
    overrideRadiusMiles: radiusMiles,
  });

  if (!geo.withinRadius) {
    const distDisplay = geo.distanceMiles !== null ? `${geo.distanceMiles.toFixed(1)}mi` : "unverified";
    return {
      isMatch: false,
      distance: geo.distanceMiles ?? 0,
      reason: `Outside ${radiusMiles}mi radius (${distDisplay})`,
    };
  }

  return {
    isMatch: true,
    distance: geo.distanceMiles ?? 0,
    reason: "Exact trade and area match",
  };
}

/**
 * Triggers a native system / Web Push / Local notification if supported
 */
export async function triggerDeviceNotification(params: {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  data?: any;
  silent?: boolean;
}): Promise<boolean> {
  const { title, body, icon = "/icon.png", tag = "trader-match", data = {}, silent = false } = params;

  if (typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "granted") {
      try {
        if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
          const registration = await navigator.serviceWorker.ready;
          await registration.showNotification(title, {
            body,
            icon,
            badge: "/icon.png",
            tag,
            data: {
              url: "/job-feed",
              openSettings: false,
              ...data,
            },
            silent,
            vibrate: silent ? [] : [100, 50, 100],
            requireInteraction: false,
          } as any);
          return true;
        } else {
          new Notification(title, {
            body,
            icon,
            tag,
            data: { url: "/job-feed", ...data },
            silent,
          });
          return true;
        }
      } catch (e) {
        console.warn("[TraderNotification] Web Notification failed:", e);
      }
    }
  }

  return false;
}

/**
 * Checks for newly matched jobs and delivers either an Emergency bypass alert or a periodic batch digest.
 */
export async function checkAndNotifyTraderMatches(
  traderProfile: any,
  options?: { forceCheck?: boolean; onOpenSettings?: () => void }
): Promise<{ matchedCount: number; notified: boolean; topJobs: any[] }> {
  if (!traderProfile || (traderProfile.role !== "tradesperson" && traderProfile.role !== "business")) {
    return { matchedCount: 0, notified: false, topJobs: [] };
  }

  if (traderProfile.role === "business" && String(traderProfile.businessLayer || "").toLowerCase() === "properties") {
    return { matchedCount: 0, notified: false, topJobs: [] };
  }

  if (!isProfileAcceptingNewWork(traderProfile)) {
    return { matchedCount: 0, notified: false, topJobs: [] };
  }

  const settings: TraderMatchNotificationSettings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(traderProfile.matchNotificationSettings || {}),
  };

  const lastNotifiedAt = settings.lastNotifiedAt || 0;
  const isPeriodicDue = isScheduleWindowActive(settings.schedule, lastNotifiedAt);
  const force = options?.forceCheck || false;

  try {
    const traderCats = extractTraderCategories(traderProfile).slice(0, 10);

    // Scoped bounded query (Firestore allows max 1 `in` clause per query: scope by category when available)
    const q =
      traderCats.length > 0
        ? query(
            collection(db, "public_job_cards"),
            where("category", "in", traderCats),
            limit(100)
          )
        : query(
            collection(db, "public_job_cards"),
            where("status", "in", [...PUBLIC_OPEN_JOB_STATUSES]),
            limit(100)
          );

    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return { matchedCount: 0, notified: false, topJobs: [] };
    }

    const matchedJobs: any[] = [];
    let hasEmergency = false;

    snapshot.docs.forEach((d) => {
      const job: any = { id: d.id, ...d.data() };
      const evalResult = isJobStrictMatch(job, traderProfile, settings.radiusMiles);
      if (evalResult.isMatch) {
        matchedJobs.push({ ...job, distanceMiles: evalResult.distance });
        if (job.urgency === "emergency" || job.isEmergency) {
          hasEmergency = true;
        }
      }
    });

    if (matchedJobs.length === 0) {
      return { matchedCount: 0, notified: false, topJobs: [] };
    }

    // Sort by emergency first, then closest distance, then newest
    matchedJobs.sort((a, b) => {
      if (a.isEmergency && !b.isEmergency) return -1;
      if (!a.isEmergency && b.isEmergency) return 1;
      const distA = typeof a.distanceMiles === "number" ? a.distanceMiles : 999;
      const distB = typeof b.distanceMiles === "number" ? b.distanceMiles : 999;
      if (distA !== distB) return distA - distB;
      const timeA = a.postedDate?.seconds || (a.postedDate ? new Date(a.postedDate).getTime() : 0);
      const timeB = b.postedDate?.seconds || (b.postedDate ? new Date(b.postedDate).getTime() : 0);
      return timeB - timeA;
    });

    const inQuietHours = isTraderInQuietHours(traderProfile);
    const emergencyOptIn = Boolean(
      traderProfile.isAvailableForEmergency === true || traderProfile.isAvailableForInstantMatch === true
    );
    const shouldBypass = hasEmergency && settings.bypassEmergency && (!inQuietHours || emergencyOptIn);
    const shouldNotify = shouldBypass || (!inQuietHours && isPeriodicDue) || force;

    if (shouldNotify && matchedJobs.length > 0) {
      const topJob = matchedJobs[0];
      const jobSample = matchedJobs
        .slice(0, 2)
        .map((j) => `${j.title || "Trade Job"}${j.estimateMax ? ` (up to £${j.estimateMax})` : j.budget ? ` (£${j.budget})` : ""}`)
        .join(" • ");

      const locationSummary =
        extractJobPostcode(topJob) || topJob.city || topJob.area || "your area";
      const count = matchedJobs.length;

      const title = shouldBypass
        ? `⚡ URGENT Emergency Job in ${locationSummary} (${settings.radiusMiles}mi)`
        : `🔔 AnyTrader: ${count} New Matched Job${count > 1 ? "s" : ""} in Your Area (${settings.radiusMiles}mi)`;

      const body = shouldBypass
        ? `${topJob.title || "Emergency Repair"} needs immediate assistance in ${locationSummary}. Tap to view.`
        : `${jobSample}${count > 2 ? ` + ${count - 2} more` : ""} in ${locationSummary}. Tap to quote.`;

      const isSilent = settings.schedule === "silent_in_app_only" || inQuietHours;
      const targetLink = count === 1 || shouldBypass ? `/job/${topJob.id}` : "/job-feed";

      await triggerDeviceNotification({
        title,
        body,
        tag: shouldBypass ? `emergency-${topJob.id}` : `match-digest-${Date.now()}`,
        data: {
          jobId: topJob.id,
          url: targetLink,
          count,
        },
        silent: isSilent,
      });

      await sendNotification(
        traderProfile.uid,
        title,
        body,
        shouldBypass ? "emergency_alert" : "job_lead",
        targetLink,
        { jobId: topJob.id }
      );

      if (traderProfile.uid) {
        try {
          await updateDoc(doc(db, "users", traderProfile.uid), {
            "matchNotificationSettings.lastNotifiedAt": Date.now(),
            "matchNotificationSettings.lastCheckedAt": Date.now(),
          });
        } catch (e) {
          console.warn("Error updating matchNotificationSettings timestamp:", e);
        }
      }

      return { matchedCount: count, notified: true, topJobs: matchedJobs.slice(0, 3) };
    }

    return { matchedCount: matchedJobs.length, notified: false, topJobs: matchedJobs.slice(0, 3) };
  } catch (err) {
    console.error("Error evaluating trader matches:", err);
    return { matchedCount: 0, notified: false, topJobs: [] };
  }
}
