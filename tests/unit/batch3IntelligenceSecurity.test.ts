import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DataRetentionService,
  DataRetentionSecurityError,
} from '../../src/server/intelligence/dataRetention';
import {
  DataClassificationEligibilityService,
  DataClassificationSecurityError,
} from '../../src/server/intelligence/dataClassificationEligibility';
import {
  AiTrainingUsageControlsService,
  AiUsageControlsSecurityError,
} from '../../src/server/intelligence/aiTrainingUsageControls';
import {
  ContractorArchiveRightsService,
  computeArchiveComponentId,
} from '../../src/server/intelligence/contractorArchiveRights';
import { DataRightsService } from '../../src/server/intelligence/dataRights';
import { ProvenanceGraphService } from '../../src/server/intelligence/provenanceGraph';

class InMemoryDocRef {
  constructor(
    private store: Map<string, any>,
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

  async set(data: any) {
    this.store.set(this.id, structuredClone(data));
  }

  async update(patch: Record<string, any>) {
    const existing = this.store.get(this.id) || {};
    this.store.set(this.id, { ...existing, ...structuredClone(patch) });
  }

  async delete() {
    this.store.delete(this.id);
  }
}

class InMemoryCollection {
  public store = new Map<string, any>();

  doc(id: string) {
    return new InMemoryDocRef(this.store, id);
  }

  where(field: string, op: string, value: any) {
    return this._buildQuery([{ field, op, value }]);
  }

  private _buildQuery(filters: Array<{ field: string; op: string; value: any }>) {
    const getPath = (obj: any, fieldPath: string) =>
      fieldPath.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);

    return {
      where: (field: string, op: string, value: any) =>
        this._buildQuery([...filters, { field, op, value }]),
      get: async () => {
        const docs: any[] = [];
        for (const [id, data] of this.store.entries()) {
          const matches = filters.every((f) => {
            const actual = getPath(data, f.field);
            if (f.op === '==') return actual === f.value;
            return false;
          });
          if (matches) {
            docs.push({
              id,
              exists: true,
              data: () => structuredClone(data),
            });
          }
        }
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      },
    };
  }
}

class InMemoryFirestore {
  private collections = new Map<string, InMemoryCollection>();

  collection(name: string) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new InMemoryCollection());
    }
    return this.collections.get(name)!;
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (ref: InMemoryDocRef) => ref.get(),
      set: async (ref: InMemoryDocRef, data: any) => ref.set(data),
      update: async (ref: InMemoryDocRef, patch: Record<string, any>) => ref.update(patch),
      delete: async (ref: InMemoryDocRef) => ref.delete(),
    };
    return fn(tx);
  }
}

describe('Batch 3 — Intelligence Lifecycle, Classification, AI Controls & Archive Security', () => {
  let db: InMemoryFirestore;
  let rightsService: DataRightsService;
  let provService: ProvenanceGraphService;
  let archiveService: ContractorArchiveRightsService;
  let classificationService: DataClassificationEligibilityService;
  let aiService: AiTrainingUsageControlsService;
  let retentionService: DataRetentionService;

  beforeEach(() => {
    db = new InMemoryFirestore();
    rightsService = new DataRightsService(db as any);
    provService = new ProvenanceGraphService(db as any);
    archiveService = new ContractorArchiveRightsService(db as any, rightsService, provService);
    classificationService = new DataClassificationEligibilityService(
      db as any,
      rightsService,
      provService,
      archiveService
    );
    aiService = new AiTrainingUsageControlsService(
      db as any,
      rightsService,
      provService,
      archiveService,
      classificationService
    );
    retentionService = new DataRetentionService(
      db as any,
      rightsService,
      provService,
      archiveService,
      classificationService,
      aiService
    );
  });

  it('AT-INTEL-LIFECYCLE-03: enforces job ownership and blocks cross-user or missing job deletion', async () => {
    const ownerUid = 'homeowner_1';
    const attackerUid = 'attacker_2';

    await db.collection('jobs').doc('job_abc').set({
      id: 'job_abc',
      title: 'Boiler service',
      homeownerId: ownerUid,
    });

    await retentionService.registerRetentionPolicy({
      tenantId: attackerUid,
      recordType: 'job',
      retentionClass: 'ephemeral_operational',
      retentionPeriodDays: 0,
      retentionUntil: new Date(Date.now() - 10_000).toISOString(),
    });

    await expect(
      retentionService.requestDeletion({
        tenantId: attackerUid,
        recordType: 'job',
        recordId: 'job_abc',
        reason: 'Cross-user deletion attempt',
      })
    ).rejects.toThrow(DataRetentionSecurityError);

    await expect(
      retentionService.requestDeletion({
        tenantId: attackerUid,
        recordType: 'job',
        recordId: 'missing_job_id',
        reason: 'Missing target check',
      })
    ).rejects.toThrow(DataRetentionSecurityError);

    await retentionService.registerRetentionPolicy({
      tenantId: ownerUid,
      recordType: 'job',
      retentionClass: 'ephemeral_operational',
      retentionPeriodDays: 0,
      retentionUntil: new Date(Date.now() - 10_000).toISOString(),
    });

    const req = await retentionService.requestDeletion({
      tenantId: ownerUid,
      recordType: 'job',
      recordId: 'job_abc',
      reason: 'Owner requested erasure',
    });
    expect(req.status).toBe('approved');
  });

  it('AT-INTEL-LIFECYCLE-02: preserves active admin legal hold during ordinary retention-policy updates', async () => {
    const tenantId = 'tenant_hold_1';
    const policy = await retentionService.registerRetentionPolicy({
      tenantId,
      recordType: 'buyer_intelligence',
      retentionClass: 'short_term_operational',
      retentionPeriodDays: 30,
    });

    const held = await retentionService.setLegalHold(
      tenantId,
      policy.policyId,
      true,
      'Active dispute freeze',
      'admin_uid_1'
    );
    expect(held.legalHold).toBe(true);

    const reRegistered = await retentionService.registerRetentionPolicy({
      tenantId,
      recordType: 'buyer_intelligence',
      retentionClass: 'ephemeral_operational',
      retentionPeriodDays: 0,
      legalHold: false,
    });
    expect(reRegistered.legalHold).toBe(true);
    expect(reRegistered.legalHoldReason).toBe('Active dispute freeze');
  });

  it('AT-INTEL-LIFECYCLE-04: rejects conflicting deletion lease and aborts mid-flight legal hold before delete', async () => {
    const tenantId = 'tenant_lease_1';
    await db.collection('jobs').doc('job_lease_1').set({
      id: 'job_lease_1',
      homeownerId: tenantId,
    });
    const policy = await retentionService.registerRetentionPolicy({
      tenantId,
      recordType: 'job',
      retentionClass: 'ephemeral_operational',
      retentionPeriodDays: 0,
      retentionUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    const req = await retentionService.requestDeletion({
      tenantId,
      recordType: 'job',
      recordId: 'job_lease_1',
      reason: 'Cleanup',
    });

    // Simulate active lease conflict
    await db.collection('data_deletion_requests').doc(req.requestId).update({
      status: 'processing',
      leaseToken: 'lease_existing_active',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      retentionService.processDeletion({
        tenantId,
        requestId: req.requestId,
        processedBy: tenantId,
      })
    ).rejects.toThrow(DataRetentionSecurityError);

    // Clear lease, apply legal hold immediately prior to commit via hooked runTransaction
    await db.collection('data_deletion_requests').doc(req.requestId).update({
      status: 'approved',
      leaseToken: null,
      leaseExpiresAt: null,
    });

    let txCall = 0;
    const origRunTx = db.runTransaction.bind(db);
    db.runTransaction = (async (fn: any) => {
      txCall++;
      if (txCall === 2) {
        await db.collection('data_retention_policies').doc(policy.policyId).update({
          legalHold: true,
          legalHoldReason: 'Mid-flight admin legal hold',
        });
      }
      return origRunTx(fn);
    }) as any;

    await expect(
      retentionService.processDeletion({
        tenantId,
        requestId: req.requestId,
        processedBy: tenantId,
      })
    ).rejects.toThrow(DataRetentionSecurityError);

    const jobStillExists = await db.collection('jobs').doc('job_lease_1').get();
    expect(jobStillExists.exists).toBe(true);
    const reqAfter = await db.collection('data_deletion_requests').doc(req.requestId).get();
    expect(reqAfter.data()?.status).toBe('blocked');
  });

  it('AT-INTEL-CLASS-01 & AT-INTEL-CLASS-02: strips public_api isInternalAi spoof and prevents reviving revoked classification', async () => {
    const tenantId = 'tenant_class_1';
    const node = await provService.createNode({
      tenantId,
      nodeType: 'source',
      sourceType: 'user_submission',
      sourceId: 'rec_1',
      sourceVersion: 1,
      createdBy: tenantId,
    });

    const record = await classificationService.registerClassification({
      tenantId,
      recordType: 'user_submission',
      recordId: 'rec_1',
      category: 'unknown_unclassified',
      provenanceRef: {
        tenantId,
        nodeId: node.nodeId,
        sourceType: 'user_submission',
        sourceId: 'rec_1',
        sourceVersion: '1',
      },
    });

    // Caller spoofs isInternalAi over public_api channel -> must fail closed
    const publicAttempt = await classificationService.evaluateEligibility({
      tenantId,
      recordType: 'user_submission',
      recordId: 'rec_1',
      requestedPurpose: 'internal_ai_use',
      classificationId: record.classificationId,
      context: {
        callerUid: tenantId,
        isInternalAi: true,
        executionChannel: 'public_api',
      },
    });
    expect(publicAttempt.eligible).toBe(false);
    expect(publicAttempt.outcome).toBe('unknown');

    // Trusted internal worker continues to succeed where permitted
    const workerAttempt = await classificationService.evaluateEligibility({
      tenantId,
      recordType: 'user_submission',
      recordId: 'rec_1',
      requestedPurpose: 'internal_ai_use',
      classificationId: record.classificationId,
      context: {
        callerUid: tenantId,
        isInternalAi: true,
        executionChannel: 'internal_worker',
      },
    });
    expect(workerAttempt.eligible).toBe(true);

    // Server route boundary static verification
    const serverSrc = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    expect(serverSrc).not.toContain('isInternalAi: req.body?.isInternalAi === true');
    expect(serverSrc).toContain('executionChannel: "public_api"');

    // Revoke classification -> subsequent registerClassification must fail closed
    await classificationService.revokeClassification(tenantId, record.classificationId, 'Revoked permanently');
    await expect(
      classificationService.registerClassification({
        tenantId,
        recordType: 'user_submission',
        recordId: 'rec_1',
        category: 'property_intelligence',
        provenanceRef: {
          tenantId,
          nodeId: node.nodeId,
          sourceType: 'user_submission',
          sourceId: 'rec_1',
          sourceVersion: '1',
        },
      })
    ).rejects.toThrow(DataClassificationSecurityError);
  });

  it('AT-INTEL-AICONTROL-01: preserves revocation and explicit denials unless authorized re-consent ceremony executes', async () => {
    const tenantId = 'tenant_ai_1';
    const node = await provService.createNode({
      tenantId,
      nodeType: 'source',
      sourceType: 'invoice',
      sourceId: 'inv_1',
      sourceVersion: 1,
      createdBy: tenantId,
    });

    const initial = await aiService.registerAiUsageControls({
      tenantId,
      recordType: 'invoice',
      recordId: 'inv_1',
      trainingConsent: 'opt_out',
      purposes: {
        internal_ai_use: 'allowed',
        external_ai_training: 'denied',
      },
      provenanceRef: {
        tenantId,
        nodeId: node.nodeId,
        sourceType: 'invoice',
        sourceId: 'inv_1',
        sourceVersion: '1',
      },
    });

    // Attempt silent overwrite to opt_in / allowed without reConsentCeremony -> sticky denial preserved
    const preserved = await aiService.registerAiUsageControls({
      tenantId,
      recordType: 'invoice',
      recordId: 'inv_1',
      trainingConsent: 'opt_in',
      purposes: {
        internal_ai_use: 'allowed',
        external_ai_training: 'allowed',
      },
      provenanceRef: {
        tenantId,
        nodeId: node.nodeId,
        sourceType: 'invoice',
        sourceId: 'inv_1',
        sourceVersion: '1',
      },
    });
    expect(preserved.trainingConsent).toBe('opt_out');
    expect(preserved.purposes.external_ai_training).toBe('denied');

    // Revoke control -> plain re-registration blocked
    await aiService.revokeAiUsageControls(tenantId, initial.controlId, 'User withdrew consent');
    await expect(
      aiService.registerAiUsageControls({
        tenantId,
        recordType: 'invoice',
        recordId: 'inv_1',
        trainingConsent: 'opt_in',
        provenanceRef: {
          tenantId,
          nodeId: node.nodeId,
          sourceType: 'invoice',
          sourceId: 'inv_1',
          sourceVersion: '1',
        },
      })
    ).rejects.toThrow(AiUsageControlsSecurityError);

    // Explicit authorized re-consent ceremony succeeds
    const reconsented = await aiService.registerAiUsageControls({
      tenantId,
      recordType: 'invoice',
      recordId: 'inv_1',
      trainingConsent: 'opt_in',
      purposes: {
        internal_ai_use: 'allowed',
        external_ai_training: 'allowed',
      },
      provenanceRef: {
        tenantId,
        nodeId: node.nodeId,
        sourceType: 'invoice',
        sourceId: 'inv_1',
        sourceVersion: '1',
      },
      reConsentCeremony: {
        confirmed: true,
        ceremonyId: 'reconsent_ceremony_001',
        confirmedBy: tenantId,
      },
    });
    expect(reconsented.status).toBe('active');
    expect(reconsented.trainingConsent).toBe('opt_in');
    expect(reconsented.purposes.external_ai_training).toBe('allowed');
  });

  it('AT-INTEL-ARCHIVE-02: cascades archive revocation transactionally to all child components', async () => {
    const tenantId = 'contractor_cascade_1';
    const reg = await archiveService.registerArchiveRights({
      tenantId,
      contractorUid: tenantId,
      archiveReference: 'archive_with_children',
      allowInternalAi: true,
      components: [
        {
          componentKey: 'comp_quote_1',
          originType: 'contractor_owned',
          category: 'estimate_quote',
        },
        {
          componentKey: 'comp_photo_2',
          originType: 'contractor_owned',
          category: 'photograph',
        },
      ],
    });

    const comp1Id = computeArchiveComponentId(tenantId, reg.archiveId, 'comp_quote_1');
    const comp2Id = computeArchiveComponentId(tenantId, reg.archiveId, 'comp_photo_2');

    const beforeEval = await archiveService.evaluateComponentEligibility({
      tenantId,
      archiveId: reg.archiveId,
      componentId: comp1Id,
      purpose: 'internal_ai_use',
    });
    expect(beforeEval.eligible).toBe(true);

    await archiveService.revokeArchiveRights(tenantId, reg.archiveId, 'Contractor deleted archive');

    const comp1Rights = await rightsService.getDataRightsRecordBySubject(
      tenantId,
      'contractor_archive_component',
      comp1Id
    );
    const comp2Rights = await rightsService.getDataRightsRecordBySubject(
      tenantId,
      'contractor_archive_component',
      comp2Id
    );
    expect(comp1Rights?.status).toBe('revoked');
    expect(comp2Rights?.status).toBe('revoked');

    const afterEval = await archiveService.evaluateComponentEligibility({
      tenantId,
      archiveId: reg.archiveId,
      componentId: comp1Id,
      purpose: 'internal_ai_use',
    });
    expect(afterEval.eligible).toBe(false);
    expect(afterEval.reason).toBe('blocked_by_status');
  });
});
