import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireSchedulerLock,
  renewSchedulerLeaseHeartbeat,
  releaseSchedulerLock,
} from '../../src/server/schedulerLock';
import {
  parseAdminBackfillOptions,
  BackfillValidationError,
  controlledBackfillEngine,
} from '../../src/server/intelligence/backfillEngine';
import {
  calculateFlashDealsTelemetry,
  calculateAiAgentsTelemetry,
  detectPlatformAnomalies,
} from '../../src/services/adminAnalyticsService';
import {
  runServerMaterialsArbitrage,
  runServerTraderChurnPredictor,
  runServerPlatformMisuseDeepScan,
} from '../../src/services/geminiServer';
import {
  dispatchTransactionalEmail,
  getEmailTransportConfig,
} from '../../src/server/emailTransport';
import {
  createAndDispatchStaffInvitation,
  acceptStaffInvitationToken,
  hashInvitationToken,
  StaffInvitationError,
} from '../../src/server/staffInvitations';

class MemoryDocRef {
  constructor(
    private readonly store: Map<string, any>,
    public readonly id: string
  ) {}

  async get() {
    const exists = this.store.has(this.id);
    return {
      id: this.id,
      exists,
      data: () => (exists ? structuredClone(this.store.get(this.id)) : undefined),
    };
  }

  async set(data: any, opts?: { merge?: boolean }) {
    if (opts?.merge && this.store.has(this.id)) {
      this.store.set(this.id, { ...this.store.get(this.id), ...structuredClone(data) });
    } else {
      this.store.set(this.id, structuredClone(data));
    }
  }

  async update(patch: Record<string, any>) {
    const existing = this.store.get(this.id) || {};
    this.store.set(this.id, { ...existing, ...structuredClone(patch) });
  }
}

class MemoryCollection {
  public readonly store = new Map<string, any>();
  private seq = 0;

  doc(id: string) {
    return new MemoryDocRef(this.store, id);
  }

  async add(data: any) {
    const id = `auto_${++this.seq}`;
    this.store.set(id, structuredClone(data));
    return new MemoryDocRef(this.store, id);
  }
}

class MemoryDb {
  private readonly cols = new Map<string, MemoryCollection>();

  collection(name: string) {
    let col = this.cols.get(name);
    if (!col) {
      col = new MemoryCollection();
      this.cols.set(name, col);
    }
    return col;
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: (ref: MemoryDocRef) => ref.get(),
      set: (ref: MemoryDocRef, data: any, opts?: { merge?: boolean }) => ref.set(data, opts),
      update: (ref: MemoryDocRef, patch: any) => ref.update(patch),
    };
    return fn(tx);
  }
}

describe('Batch 4 P1 Security & Operational Integrity Remediations', () => {
  describe('AT-ADMIN-OPS-04 — Fail-Closed Scheduler Locks & Worker Lease Fencing', () => {
    it('fails closed when database is unavailable or lock transaction throws', async () => {
      const noDbRes = await acquireSchedulerLock(null, 'matching_system', 10_000);
      expect(noDbRes.acquired).toBe(false);
      expect(noDbRes.reason).toBe('database_unavailable');

      const brokenDb = {
        collection: () => ({ doc: () => ({}) }),
        runTransaction: async () => {
          throw new Error('DEADLINE_EXCEEDED: firestore unavailable');
        },
      };
      const errRes = await acquireSchedulerLock(brokenDb, 'matching_system', 10_000);
      expect(errRes.acquired).toBe(false);
      expect(errRes.reason).toBe('lock_acquisition_error');
    });

    it('acquires lease once, blocks concurrent acquisition, renews heartbeat, fences stale owner, and releases only owner', async () => {
      const db = new MemoryDb();

      const first = await acquireSchedulerLock(db, 'driver_payouts', 60_000, 'worker-1');
      expect(first.acquired).toBe(true);
      expect(first.leaseToken).toBeTruthy();

      const competing = await acquireSchedulerLock(db, 'driver_payouts', 60_000, 'worker-2');
      expect(competing.acquired).toBe(false);
      expect(competing.reason).toBe('lock_held');

      const hb1 = await renewSchedulerLeaseHeartbeat(db, 'driver_payouts', first.leaseToken, 60_000);
      expect(hb1.renewed).toBe(true);

      // Simulate lease reclamation by newer worker after expiration
      await db.collection('cron_locks').doc('driver_payouts').set(
        { leaseToken: 'lease_newer_worker', status: 'active', leaseExpiresAtMs: Date.now() + 60_000 },
        { merge: true }
      );

      const staleHb = await renewSchedulerLeaseHeartbeat(db, 'driver_payouts', first.leaseToken, 60_000);
      expect(staleHb.renewed).toBe(false);
      expect(staleHb.fencedOut).toBe(true);

      const badRelease = await releaseSchedulerLock(db, 'driver_payouts', first.leaseToken);
      expect(badRelease.released).toBe(false);
      expect(badRelease.reason).toBe('lease_token_mismatch');

      const ownerRelease = await releaseSchedulerLock(db, 'driver_payouts', 'lease_newer_worker');
      expect(ownerRelease.released).toBe(true);

      const afterRelease = await acquireSchedulerLock(db, 'driver_payouts', 60_000, 'worker-3');
      expect(afterRelease.acquired).toBe(true);
    });

    it('server.ts uses fail-closed acquireSchedulerLock and runWithSchedulerLease without fallback return true', () => {
      const serverSrc = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
      expect(serverSrc).toContain('runWithSchedulerLease');
      expect(serverSrc).toContain('renewSchedulerLeaseHeartbeat');
      expect(serverSrc).not.toContain('Fallback to allowing execution if lock check fails');
    });
  });

  describe('AT-INTEL-BACKFILL-01 — Strict Boolean dryRun & Closed Collection Allowlist', () => {
    it('rejects truthy/stringified non-boolean dryRun values and disallowed collections', async () => {
      for (const badDryRun of ['false', 'true', 0, 1, '0', null]) {
        expect(() => parseAdminBackfillOptions({ dryRun: badDryRun as any })).toThrow(BackfillValidationError);
      }

      for (const badCol of ['users', 'admins', 'payments', 'invitations', '', 123]) {
        expect(() => parseAdminBackfillOptions({ collection: badCol as any })).toThrow(BackfillValidationError);
      }

      const valid = parseAdminBackfillOptions({ dryRun: false, collection: 'properties', batchSize: 100 });
      expect(valid.dryRun).toBe(false);
      expect(valid.collection).toBe('properties');
      expect(valid.batchSize).toBe(100);

      await expect(
        controlledBackfillEngine.executeFirestoreBackfill({} as any, {
          dryRun: 'false' as any,
          collection: 'jobs',
        })
      ).rejects.toThrow(BackfillValidationError);

      await expect(
        controlledBackfillEngine.executeFirestoreBackfill({} as any, {
          dryRun: true,
          collection: 'users' as any,
        })
      ).rejects.toThrow(BackfillValidationError);
    });
  });

  describe('AT-AI-SCAN-01 — Live Aggregated Signals & Honest Unavailability (No Demo Fakes)', () => {
    it('returns zeroed metrics and empty arrays instead of hardcoded demo baselines when collections are empty', () => {
      const dealsTelemetry = calculateFlashDealsTelemetry([], []);
      expect(dealsTelemetry.totalDeals).toBe(0);
      expect(dealsTelemetry.totalClaimsCount).toBe(0);
      expect(dealsTelemetry.avgDiscountPercentage).toBe(0);
      expect(dealsTelemetry.categoryDistribution).toEqual([]);
      expect(dealsTelemetry.topPerformingTraders).toEqual([]);

      const agentsTelemetry = calculateAiAgentsTelemetry([]);
      expect(agentsTelemetry.totalInvocations).toBe(0);
      expect(agentsTelemetry.successRate).toBe(0);
      expect(agentsTelemetry.activeAgentsCount).toBe(0);

      const anomalies = detectPlatformAnomalies([], [], [], []);
      expect(anomalies).toEqual([]);
    });

    it('detects real duplicate phone clusters and real failed audit logs from live inputs', () => {
      const anomalies = detectPlatformAnomalies(
        [],
        [
          { uid: 'u1', name: 'Alice', role: 'homeowner', phone: '+447700900111' },
          { uid: 'u2', name: 'Bob', role: 'homeowner', phone: '+447700900111' },
        ],
        [],
        [
          { id: 'log1', agentType: 'sentinel_guard', action: 'RATE_LIMIT_BURST', status: 'failed', details: 'Blocked burst' },
        ]
      );
      expect(anomalies.length).toBe(2);
      expect(anomalies.some((a) => a.type === 'multi_account_ip_cluster')).toBe(true);
      expect(anomalies.some((a) => a.type === 'ai_rate_limit_burst')).toBe(true);
    });

    it('server AI scanners refuse to fabricate scores/traders when GEMINI_API_KEY is missing or sample traders are empty', async () => {
      const prevKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      try {
        await expect(runServerPlatformMisuseDeepScan({ totalDeals: 0 })).rejects.toThrow(/GEMINI_API_KEY|PERMISSION_DENIED|API_KEY/i);
        await expect(runServerMaterialsArbitrage('Manchester', [])).rejects.toThrow(/GEMINI_API_KEY|PERMISSION_DENIED|API_KEY/i);
        const emptyChurn = await runServerTraderChurnPredictor([]);
        expect(emptyChurn.profiles).toEqual([]);
        expect(emptyChurn.overallRetentionHealthScore).toBeNull();
        expect(emptyChurn.highRiskCount).toBe(0);
      } finally {
        if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
      }
    });
  });

  describe('AT-ADMIN-ALERT-01 — Real Email Transport Behind Config Verification', () => {
    it('fails explicitly as unconfigured (never faking delivered) when no provider API key is configured', async () => {
      const db = new MemoryDb();
      const cfg = getEmailTransportConfig({} as NodeJS.ProcessEnv);
      expect(cfg.configured).toBe(false);

      const res = await dispatchTransactionalEmail({
        db,
        to: 'ops@anytrader.co.uk',
        subject: 'Threshold Breach',
        html: '<p>Alert</p>',
        env: {} as NodeJS.ProcessEnv,
      });

      expect(res.success).toBe(false);
      expect(res.delivered).toBe(false);
      expect(res.status).toBe('unconfigured');
      expect(res.queueId).toBeTruthy();

      const stored = db.collection('email_queue').store.get(res.queueId!);
      expect(stored.status).toBe('unconfigured');
    });

    it('records failure on HTTP 500 from provider and reports delivered only on 2xx response', async () => {
      const db = new MemoryDb();
      const failingFetch = (async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ message: 'upstream error' }),
      })) as any;

      const failRes = await dispatchTransactionalEmail({
        db,
        to: 'ops@anytrader.co.uk',
        subject: 'Breach 1',
        html: '<p>Alert</p>',
        env: { RESEND_API_KEY: 're_test_123' } as any,
        fetchFn: failingFetch,
      });
      expect(failRes.success).toBe(false);
      expect(failRes.delivered).toBe(false);
      expect(failRes.status).toBe('failed');
      expect(db.collection('email_queue').store.get(failRes.queueId!)?.status).toBe('failed');

      const okFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg_live_999' }),
      })) as any;

      const okRes = await dispatchTransactionalEmail({
        db,
        to: 'ops@anytrader.co.uk',
        subject: 'Breach 2',
        html: '<p>Alert</p>',
        env: { RESEND_API_KEY: 're_test_123' } as any,
        fetchFn: okFetch,
      });
      expect(okRes.success).toBe(true);
      expect(okRes.delivered).toBe(true);
      expect(okRes.status).toBe('delivered');
      expect(okRes.providerMessageId).toBe('msg_live_999');
    });
  });

  describe('AT-ADMIN-CTRL-02 — Durable Staff Invitations with Token Hashing, Expiry & Delivery Integrity', () => {
    let db: MemoryDb;

    beforeEach(() => {
      db = new MemoryDb();
    });

    it('hashes raw invitation tokens, persists expiry, and fails honestly when mail provider is unconfigured', async () => {
      const result = await createAndDispatchStaffInvitation({
        db,
        email: 'NewStaff@AnyTrader.co.uk',
        permissions: ['view_analytics', 'manage_users'],
        invitedByUid: 'admin-1',
        invitedByEmail: 'root@anytrader.co.uk',
        env: {} as NodeJS.ProcessEnv,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe('delivery_failed');
      expect(result.deliveryStatus).toBe('unconfigured');

      const stored = db.collection('invitations').store.get(result.invitationId);
      expect(stored).toBeTruthy();
      expect(stored.email).toBe('newstaff@anytrader.co.uk');
      expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.token).toBeUndefined();
      expect(Date.parse(stored.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('dispatches real invitation link when configured and enforces token hash, expiry, and email verification on accept', async () => {
      let capturedUrlLink = '';
      const sendFetch = (async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        const textBody = body.content?.[0]?.value || body.text || '';
        const match = String(textBody).match(/https:\/\/[^\s"<]+/);
        capturedUrlLink = match ? match[0] : '';
        return {
          ok: true,
          status: 202,
          headers: { get: () => 'sg-msg-101' },
        };
      }) as any;

      const created = await createAndDispatchStaffInvitation({
        db,
        email: 'staff@anytrader.co.uk',
        permissions: ['manage_jobs'],
        invitedByUid: 'admin-1',
        appOrigin: 'https://anytrader.app',
        env: { SENDGRID_API_KEY: 'SG.real_key_123' } as any,
        fetchFn: sendFetch,
      });

      expect(created.success).toBe(true);
      expect(created.status).toBe('pending');
      expect(created.deliveryStatus).toBe('delivered');
      expect(capturedUrlLink).toContain('/admin-invite?id=');

      const parsedUrl = new URL(capturedUrlLink);
      const invId = parsedUrl.searchParams.get('id')!;
      const rawToken = parsedUrl.searchParams.get('token')!;
      expect(db.collection('invitations').store.get(invId)?.tokenHash).toBe(hashInvitationToken(rawToken));

      // Reject unverified email, wrong email, or wrong token
      await expect(
        acceptStaffInvitationToken({
          db,
          invitationId: invId,
          token: rawToken,
          callerUid: 'u-staff',
          callerEmail: 'staff@anytrader.co.uk',
          emailVerified: false,
        })
      ).rejects.toThrow(StaffInvitationError);

      await expect(
        acceptStaffInvitationToken({
          db,
          invitationId: invId,
          token: 'wrong-token',
          callerUid: 'u-staff',
          callerEmail: 'staff@anytrader.co.uk',
          emailVerified: true,
        })
      ).rejects.toThrow(/Invalid invitation token/);

      const accepted = await acceptStaffInvitationToken({
        db,
        invitationId: invId,
        token: rawToken,
        callerUid: 'u-staff',
        callerEmail: 'staff@anytrader.co.uk',
        emailVerified: true,
      });
      expect(accepted.status).toBe('accepted');
      expect(accepted.permissions).toEqual(['manage_jobs']);
      expect(db.collection('admins').store.get('u-staff')?.invitationId).toBe(invId);
      expect(db.collection('invitations').store.get(invId)?.status).toBe('accepted');

      // Replay attempt after acceptance fails with 409 conflict
      await expect(
        acceptStaffInvitationToken({
          db,
          invitationId: invId,
          token: rawToken,
          callerUid: 'u-staff',
          callerEmail: 'staff@anytrader.co.uk',
          emailVerified: true,
        })
      ).rejects.toThrow(/cannot be accepted/);
    });
  });
});
