/**
 * Distributed Firestore-Backed Rate-Limit Store for Multi-Instance Cloud Run (AT-ADMIN-OPS-06)
 *
 * Implements the `express-rate-limit` Store contract using atomic Firestore transactions
 * in `rate_limit_buckets/{bucketId}` so rate limits are shared consistently across all
 * Cloud Run container replicas. Falls back cleanly to a local bounded Map ONLY when the
 * Firestore client is unavailable (e.g. local offline tests or startup degraded mode).
 */

import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";

export interface FirestoreRateLimitStoreOptions {
  prefix: string;
  windowMs: number;
  getDb: () => any | null | undefined;
  collectionName?: string;
}

function sanitizeBucketKey(prefix: string, rawKey: string): string {
  const safeKey = String(rawKey || "anonymous")
    .replace(/[^a-zA-Z0-9._:-]/g, "_")
    .slice(0, 120);
  return `${prefix}__${safeKey}`;
}

export class FirestoreRateLimitStore implements Store {
  public prefix: string;
  public localKeys = false;
  private windowMs: number;
  private getDb: () => any | null | undefined;
  private collectionName: string;
  private fallbackStore = new Map<string, { totalHits: number; resetTimeMs: number }>();

  constructor(options: FirestoreRateLimitStoreOptions) {
    this.prefix = options.prefix;
    this.windowMs = Math.max(1000, options.windowMs);
    this.getDb = options.getDb;
    this.collectionName = options.collectionName || "rate_limit_buckets";
  }

  public init(options: Options): void {
    if (options?.windowMs && Number.isFinite(options.windowMs)) {
      this.windowMs = Math.max(1000, options.windowMs);
    }
  }

  private incrementFallback(bucketId: string, now: number): ClientRateLimitInfo {
    if (this.fallbackStore.size > 5000) {
      for (const [k, v] of this.fallbackStore.entries()) {
        if (now >= v.resetTimeMs) this.fallbackStore.delete(k);
      }
      if (this.fallbackStore.size > 5000) {
        this.fallbackStore.clear();
      }
    }

    const existing = this.fallbackStore.get(bucketId);
    if (!existing || now >= existing.resetTimeMs) {
      const resetTimeMs = now + this.windowMs;
      this.fallbackStore.set(bucketId, { totalHits: 1, resetTimeMs });
      return { totalHits: 1, resetTime: new Date(resetTimeMs) };
    }

    existing.totalHits += 1;
    return { totalHits: existing.totalHits, resetTime: new Date(existing.resetTimeMs) };
  }

  public async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    const bucketId = sanitizeBucketKey(this.prefix, key);
    const db = this.getDb();

    if (!db || typeof db.runTransaction !== "function") {
      return this.incrementFallback(bucketId, now);
    }

    try {
      const ref = db.collection(this.collectionName).doc(bucketId);
      const outcome = await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(ref);
        const data = snap && snap.exists ? (typeof snap.data === "function" ? snap.data() : snap.data) || {} : {};
        const existingResetMs = Number(data.resetTimeMs) || 0;
        const existingHits = Number(data.totalHits) || 0;

        let totalHits: number;
        let resetTimeMs: number;

        if (!snap?.exists || now >= existingResetMs) {
          totalHits = 1;
          resetTimeMs = now + this.windowMs;
        } else {
          totalHits = existingHits + 1;
          resetTimeMs = existingResetMs;
        }

        tx.set(
          ref,
          {
            bucketId,
            prefix: this.prefix,
            totalHits,
            resetTimeMs,
            windowMs: this.windowMs,
            updatedAtMs: now,
          },
          { merge: true }
        );

        return { totalHits, resetTimeMs };
      });

      return {
        totalHits: outcome.totalHits,
        resetTime: new Date(outcome.resetTimeMs),
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED")) {
        console.warn(`[DistributedRateLimit:${this.prefix}] Falling back to local bucket after Firestore error:`, msg);
      }
      return this.incrementFallback(bucketId, now);
    }
  }

  public async decrement(key: string): Promise<void> {
    const bucketId = sanitizeBucketKey(this.prefix, key);
    const db = this.getDb();

    if (!db || typeof db.runTransaction !== "function") {
      const existing = this.fallbackStore.get(bucketId);
      if (existing && existing.totalHits > 0) {
        existing.totalHits -= 1;
      }
      return;
    }

    try {
      const ref = db.collection(this.collectionName).doc(bucketId);
      await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(ref);
        if (!snap || !snap.exists) return;
        const data = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
        const nextHits = Math.max(0, (Number(data.totalHits) || 0) - 1);
        tx.set(ref, { totalHits: nextHits, updatedAtMs: Date.now() }, { merge: true });
      });
    } catch {
      // Non-fatal on decrement
    }
  }

  public async resetKey(key: string): Promise<void> {
    const bucketId = sanitizeBucketKey(this.prefix, key);
    this.fallbackStore.delete(bucketId);
    const db = this.getDb();
    if (!db) return;
    try {
      await db.collection(this.collectionName).doc(bucketId).delete();
    } catch {
      // Non-fatal on reset
    }
  }
}
