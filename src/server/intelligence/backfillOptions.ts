export const PERMITTED_BACKFILL_COLLECTIONS = ['jobs', 'properties'] as const;
export type PermittedBackfillCollection = typeof PERMITTED_BACKFILL_COLLECTIONS[number];

export class BackfillValidationError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BackfillValidationError';
  }
}

export interface ValidatedAdminBackfillOptions {
  batchSize: number;
  dryRun: boolean;
  maxCostUsd: number;
  cursor?: string;
  collection: PermittedBackfillCollection;
  targetTaskType?: 'job_extraction' | 'property_rollup';
  tenantId?: string;
}

const PERMITTED_TASK_TYPES = new Set(['job_extraction', 'property_rollup']);

/**
 * Strictly parses admin backfill parameters at the route and engine boundaries:
 * - `dryRun`: defaults to `true` if omitted; if provided, MUST be strictly `boolean` (rejects `"false"`, `0`, `"0"`, etc.)
 * - `collection`: defaults to `'jobs'` if omitted; MUST be strictly in `['jobs', 'properties']`
 * - `batchSize` & `maxCostUsd`: strictly finite numeric bounds
 */
export function parseAdminBackfillOptions(raw: Record<string, any> = {}): ValidatedAdminBackfillOptions {
  const input = raw && typeof raw === 'object' ? raw : {};

  let dryRun = true;
  if (input.dryRun !== undefined) {
    if (typeof input.dryRun !== 'boolean') {
      throw new BackfillValidationError(
        `Invalid 'dryRun' parameter: expected strict boolean (true or false), received ${typeof input.dryRun}`
      );
    }
    dryRun = input.dryRun;
  }

  let collection: PermittedBackfillCollection = 'jobs';
  if (input.collection !== undefined) {
    if (
      typeof input.collection !== 'string' ||
      !(PERMITTED_BACKFILL_COLLECTIONS as readonly string[]).includes(input.collection)
    ) {
      throw new BackfillValidationError(
        `Invalid 'collection' parameter: '${String(input.collection)}' is not in permitted allowlist (${PERMITTED_BACKFILL_COLLECTIONS.join(', ')})`
      );
    }
    collection = input.collection as PermittedBackfillCollection;
  }

  let batchSize = 50;
  if (input.batchSize !== undefined) {
    if (typeof input.batchSize !== 'number' || !Number.isFinite(input.batchSize) || input.batchSize <= 0) {
      throw new BackfillValidationError(`Invalid 'batchSize' parameter: must be a positive finite number`);
    }
    batchSize = Math.min(500, Math.max(1, Math.floor(input.batchSize)));
  }

  let maxCostUsd = 5.0;
  if (input.maxCostUsd !== undefined) {
    if (typeof input.maxCostUsd !== 'number' || !Number.isFinite(input.maxCostUsd) || input.maxCostUsd < 0) {
      throw new BackfillValidationError(`Invalid 'maxCostUsd' parameter: must be a non-negative finite number`);
    }
    maxCostUsd = Math.min(100.0, input.maxCostUsd);
  }

  let targetTaskType: 'job_extraction' | 'property_rollup' | undefined = undefined;
  if (input.targetTaskType !== undefined) {
    if (typeof input.targetTaskType !== 'string' || !PERMITTED_TASK_TYPES.has(input.targetTaskType)) {
      throw new BackfillValidationError(
        `Invalid 'targetTaskType': '${String(input.targetTaskType)}' is not permitted`
      );
    }
    targetTaskType = input.targetTaskType as 'job_extraction' | 'property_rollup';
  }

  const cursor = typeof input.cursor === 'string' && input.cursor.trim() ? input.cursor.trim() : undefined;
  const tenantId = typeof input.tenantId === 'string' && input.tenantId.trim() ? input.tenantId.trim() : undefined;

  return {
    batchSize,
    dryRun,
    maxCostUsd,
    cursor,
    collection,
    targetTaskType,
    tenantId,
  };
}
