import { auth, db, collection, query, where, or, and, getDocs, handleFirestoreError, OperationType } from "@/src/firebase";
import { getApiUrl } from "@/src/lib/apiUrl";

export async function processRecurringSchedules(userId: string) {
  try {
    // Query active recurring schedules where the signed-in user is a participant
    const q = query(
      collection(db, "recurring_schedules"),
      and(
        where("status", "==", "active"),
        or(
          where("participants", "array-contains", userId),
          where("homeownerId", "==", userId),
          where("tradespersonId", "==", userId)
        )
      )
    );

    const snapshot = await getDocs(q);
    const now = new Date();

    for (const scheduleDoc of snapshot.docs) {
      const schedule = scheduleDoc.data();

      const lastGenerated = schedule.lastJobGeneratedAt?.toDate?.() || schedule.createdAt?.toDate?.() || now;
      const frequencyDays = schedule.frequency === "weekly" ? 7 : schedule.frequency === "fortnightly" ? 14 : 30;

      const nextJobDate = new Date(lastGenerated);
      nextJobDate.setDate(nextJobDate.getDate() + frequencyDays);

      // If the next job is within 3 days and we haven't generated it yet
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

      if (nextJobDate <= threeDaysFromNow && auth.currentUser) {
        const token = await auth.currentUser.getIdToken();
        const res = await fetch(
          getApiUrl(`/api/recurring-schedules/${encodeURIComponent(scheduleDoc.id)}/generate-job`),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.warn(
            `Recurring schedule ${scheduleDoc.id} generation returned ${res.status}:`,
            errData?.error || "Unknown error"
          );
        }
      }
    }
  } catch (err) {
    console.error("Error processing recurring schedules:", err);
    handleFirestoreError(err, OperationType.LIST, "recurring_schedules/processing");
  }
}
