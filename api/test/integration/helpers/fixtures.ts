import { randomUUID } from 'node:crypto';
import { adminPool } from './db';

/**
 * Minimal fixture builders for the I-INV integration suite. Field encryption
 * (PR-106) does not exist yet (slice 3) — personal-data columns are filled
 * with placeholder bytes so NOT NULL / UNIQUE constraints are satisfied
 * without asserting anything about their (future) ciphertext shape.
 */

function placeholderBytes(label: string): Buffer {
  return Buffer.from(`${label}:${randomUUID()}`, 'utf8');
}

export async function createUser(label = 'user'): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "app_user" ("full_name_ct", "email_ct", "email_bidx", "dek_version")
     VALUES ($1, $2, $3, 1)
     RETURNING id`,
    [
      placeholderBytes(`${label}-name`),
      placeholderBytes(`${label}-email`),
      placeholderBytes(`${label}-bidx`),
    ],
  );
  return result.rows[0].id as string;
}

export async function getSeededApprovalRouteId(): Promise<string> {
  const result = await adminPool.query(
    `SELECT id FROM "approval_route" WHERE code = 'SINGLE_STAGE_TL_OR_ENG'`,
  );
  if (result.rowCount === 0) {
    throw new Error('PR-DBD-09 seed missing: approval_route SINGLE_STAGE_TL_OR_ENG not found');
  }
  return result.rows[0].id as string;
}

export async function createFormTemplate(documentNumber: string): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "form_template" ("document_number", "title") VALUES ($1, $2) RETURNING id`,
    [documentNumber, `Template ${documentNumber}`],
  );
  return result.rows[0].id as string;
}

export async function createAssetType(
  formTemplateId: string,
  approvalRouteId: string,
  code: string,
): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "asset_type" ("code", "name", "form_template_id", "approval_route_id")
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [code, `Asset type ${code}`, formTemplateId, approvalRouteId],
  );
  return result.rows[0].id as string;
}

export async function createAsset(assetTypeId: string, code: string): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "asset" ("code", "asset_type_id", "schedule_anchor_date")
     VALUES ($1, $2, CURRENT_DATE)
     RETURNING id`,
    [code, assetTypeId],
  );
  return result.rows[0].id as string;
}

export interface TemplateRevisionOpts {
  sequenceOrdinal: number;
  status: 'draft' | 'pending_approval' | 'current' | 'superseded' | 'rejected';
  approvedBy?: string | null;
}

export async function createTemplateRevision(
  formTemplateId: string,
  authoredBy: string,
  opts: TemplateRevisionOpts,
): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "template_revision"
       ("form_template_id", "revision_code", "sequence_ordinal", "status",
        "change_description", "standing_content", "authored_by", "authored_at",
        "approved_by", "approved_at")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), $8, CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [
      formTemplateId,
      String(opts.sequenceOrdinal),
      opts.sequenceOrdinal,
      opts.status,
      'initial revision',
      JSON.stringify({}),
      authoredBy,
      opts.approvedBy ?? null,
    ],
  );
  return result.rows[0].id as string;
}

export async function createTemplateMeasurement(
  templateRevisionId: string,
  opts: { lowerLimit?: number | null; upperLimit?: number | null },
): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "template_measurement"
       ("template_revision_id", "description", "spec_type", "lower_limit", "upper_limit",
        "spec_display", "stable_key", "display_order")
     VALUES ($1, $2, 'range', $3, $4, $5, $6, 1)
     RETURNING id`,
    [
      templateRevisionId,
      'Test measurement',
      opts.lowerLimit ?? null,
      opts.upperLimit ?? null,
      'n/a',
      randomUUID(),
    ],
  );
  return result.rows[0].id as string;
}

export interface JobOpts {
  assetId: string;
  templateRevisionId: string;
  approvalRouteId: string;
  jobNumber: string;
  status: string;
  submittedBy?: string | null;
  submittedAt?: Date | null;
  currentStageOrdinal?: number | null;
  archivedAt?: Date | null;
  voidReason?: string | null;
}

export async function createJob(opts: JobOpts): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "job"
       ("job_number", "asset_id", "template_revision_id", "approval_route_id",
        "frequency", "frequency_scope", "due_on", "generated_at", "status",
        "submitted_by", "submitted_at", "current_stage_ordinal", "archived_at", "void_reason")
     VALUES ($1, $2, $3, $4, 'M1', ARRAY['M1']::"frequency_t"[], CURRENT_DATE, now(), $5,
             $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      opts.jobNumber,
      opts.assetId,
      opts.templateRevisionId,
      opts.approvalRouteId,
      opts.status,
      opts.submittedBy ?? null,
      opts.submittedAt ?? null,
      opts.currentStageOrdinal ?? null,
      opts.archivedAt ?? null,
      opts.voidReason ?? null,
    ],
  );
  return result.rows[0].id as string;
}

/** Builds one job (and everything it depends on) in a single call. */
export async function createJobFixture(
  jobNumber: string,
  status = 'assigned',
  extra: Partial<
    Pick<
      JobOpts,
      'submittedBy' | 'submittedAt' | 'currentStageOrdinal' | 'archivedAt' | 'voidReason'
    >
  > = {},
): Promise<{
  jobId: string;
  authorId: string;
  approvalRouteId: string;
}> {
  const authorId = await createUser('author');
  const approvalRouteId = await getSeededApprovalRouteId();
  const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
  const assetTypeId = await createAssetType(formTemplateId, approvalRouteId, `AT-${randomUUID()}`);
  const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
  const revisionId = await createTemplateRevision(formTemplateId, authorId, {
    sequenceOrdinal: 0,
    status: 'current',
  });
  const jobId = await createJob({
    assetId,
    templateRevisionId: revisionId,
    approvalRouteId,
    jobNumber,
    status,
    ...extra,
  });
  return { jobId, authorId, approvalRouteId };
}
