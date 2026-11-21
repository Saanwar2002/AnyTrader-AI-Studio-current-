import * as admin from 'firebase-admin';

export interface SchedulerLockResult {
  acquired: boolean;
  jobName: string;
  leaseToken?: string;
  leaseExpiresAtMs?: number;
  reason?: string;
  error?: string;
}

export interface SchedulerHeartbeatResult {
  renewed: boolean;
  fencedOut?: boolean;
  leaseExpiresAtMs?: number;
  reason?: string;
}

export interface SchedulerReleaseResult {
  released: boolean;
  reason?: string;
}

function resolveTimestampMs(value: any): number {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Acquires a fenced distributed scheduler lease transactionally in `cron_locks/{jobName}`.
 * FAIL-CLOSED: If the database is unavailable or lock transaction fails, returns `acquired: false`
 * so overlapping/uncoordinated background work never executes silently.
 */
export async function acquireSchedulerLock(
  db: admin.firestore.Firestore | any | null | undefined,
  jobName: string,
  lockDurationMs: number = 60_000,
  ownerId?: string
): Promise<SchedulerLockResult> {
  if (!db) {
    return {
      acquired: false,
      jobName,
      reason: 'database_unavailable',
    };
  }
  if (!jobName || typeof jobName !== 'string' || !jobName.trim()) {
    return {
      acquired: false,
      jobName: String(jobName || ''),
      reason: 'invalid_job_name',
    };
  }

  const normalizedJob = jobName.trim();
  const safeDurationMs = Math.max(1000, Number.isFinite(lockDurationMs) ? Math.floor(lockDurationMs) : 60_000);
  const instanceId = ownerId || process.env.K_REVISION || process.env.HOSTNAME || 'local';

  try {
    const lockRef = db.collection('cron_locks').doc(normalizedJob);
    const now = Date.now();
    const leaseToken = `lease_${normalizedJob}_${now}_${Math.random().toString(36).slice(2, 10)}`;
    const leaseExpiresAtMs = now + safeDurationMs;

    const acquired = await db.runTransaction(async (tx: any) => {
      const snap = await tx.get(lockRef);
      if (snap && snap.exists) {
        const data = snap.data() || {};
        const isExplicitlyReleased = data.status === 'released';
        if (!isExplicitlyReleased) {
          const explicitExpiryMs = resolveTimestampMs(data.leaseExpiresAtMs);
          if (explicitExpiryMs > now) {
            return false;
          }
          if (!explicitExpiryMs) {
            const legacyLastRunMs = resolveTimestampMs(data.lastRunAt) || resolveTimestampMs(data.timestamp);
            if (legacyLastRunMs > 0 && now - legacyLastRunMs < safeDurationMs) {
              return false;
            }
          }
        }
      }

      const serverTs =
        typeof admin?.firestore?.FieldValue?.serverTimestamp === 'function'
          ? admin.firestore.FieldValue.serverTimestamp()
          : new Date(now).toISOString();

      await tx.set(
        lockRef,
        {
          jobName: normalizedJob,
          status: 'active',
          leaseToken,
          leaseAcquiredAtMs: now,
          heartbeatAtMs: now,
          leaseExpiresAtMs,
          heartbeatCount: 0,
          lastRunAt: serverTs,
          timestamp: now,
          instanceId,
        },
        { merge: true }
      );
      return true;
    });

    if (!acquired) {
      return {
        acquired: false,
        jobName: normalizedJob,
        reason: 'lock_held',
      };
    }

    return {
      acquired: true,
      jobName: normalizedJob,
      leaseToken,
      leaseExpiresAtMs,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (!msg.includes('PERMISSION_DENIED') && !msg.includes('UNAUTHENTICATED')) {
      console.warn(`[SchedulerLock] Fail-closed lock acquisition error for ${normalizedJob}:`, msg);
    }
    return {
      acquired: false,
      jobName: normalizedJob,
      reason: 'lock_acquisition_error',
      error: msg,
    };
  }
}

/**
 * Renews an active worker lease with fencing verification (`data.leaseToken === leaseToken`).
 * If another worker reclaimed the lease after expiration or status changed, returns
 * `{ renewed: false, fencedOut: true }` so the caller halts work cleanly.
 */
export async function renewSchedulerLeaseHeartbeat(
  db: admin.firestore.Firestore | any | null | undefined,
  jobName: string,
  leaseToken: string | undefined,
  lockDurationMs: number = 60_000
): Promise<SchedulerHeartbeatResult> {
  if (!db || !jobName || !leaseToken) {
    return { renewed: false, fencedOut: true, reason: 'missing_lease_context' };
  }

  const safeDurationMs = Math.max(1000, Number.isFinite(lockDurationMs) ? Math.floor(lockDurationMs) : 60_000);
  try {
    const lockRef = db.collection('cron_locks').doc(jobName.trim());
    const now = Date.now();
    const nextExpiryMs = now + safeDurationMs;

    const outcome = await db.runTransaction(async (tx: any) => {
      const snap = await tx.get(lockRef);
      if (!snap || !snap.exists) {
        return { renewed: false, fencedOut: true, reason: 'lock_missing' };
      }
      const data = snap.data() || {};
      if (data.status === 'released' || data.leaseToken !== leaseToken) {
        return { renewed: false, fencedOut: true, reason: 'lease_fenced_by_newer_owner' };
      }
      await tx.set(
        lockRef,
        {
          heartbeatAtMs: now,
          leaseExpiresAtMs: nextExpiryMs,
          heartbeatCount: (Number(data.heartbeatCount) || 0) + 1,
          timestamp: now,
        },
        { merge: true }
      );
      return { renewed: true, leaseExpiresAtMs: nextExpiryMs };
    });

    return outcome;
  } catch (err: any) {
    // Fail-closed: if heartbeat storage/transaction fails, fence out the worker
    // so it halts rather than continuing without a verified distributed lease.
    return {
      renewed: false,
      fencedOut: true,
      reason: err?.message || 'heartbeat_storage_error',
    };
  }
}

/**
 * Releases a scheduler lock strictly when the caller holds the matching fencing token.
 */
export async function releaseSchedulerLock(
  db: admin.firestore.Firestore | any | null | undefined,
  jobName: string,
  leaseToken: string | undefined
): Promise<SchedulerReleaseResult> {
  if (!db || !jobName || !leaseToken) {
    return { released: false, reason: 'missing_lease_context' };
  }
  try {
    const lockRef = db.collection('cron_locks').doc(jobName.trim());
    const now = Date.now();
    return await db.runTransaction(async (tx: any) => {
      const snap = await tx.get(lockRef);
      if (!snap || !snap.exists) {
        return { released: false, reason: 'lock_missing' };
      }
      const data = snap.data() || {};
      if (data.leaseToken !== leaseToken) {
        return { released: false, reason: 'lease_token_mismatch' };
      }
      await tx.set(
        lockRef,
        {
          status: 'released',
          leaseExpiresAtMs: 0,
          releasedAtMs: now,
        },
        { merge: true }
      );
      return { released: true };
    });
  } catch (err: any) {
    return { released: false, reason: err?.message || 'release_error' };
  }
}
