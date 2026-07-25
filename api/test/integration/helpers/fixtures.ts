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

export async function grantRole(userId: string, roleCode: string): Promise<void> {
  await adminPool.query(
    `INSERT INTO "user_role" ("user_id", "role_id", "granted_by")
     SELECT $1, "id", $1 FROM "role" WHERE "code" = $2`,
    [userId, roleCode],
  );
}

export async function scopeUserToArea(userId: string, areaId: string): Promise<void> {
  await adminPool.query(`INSERT INTO "user_area_scope" ("user_id", "area_id") VALUES ($1, $2)`, [
    userId,
    areaId,
  ]);
}

export async function createArea(
  code: string,
  opts: { parentId?: string | null } = {},
): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "area" ("code", "name", "parent_id") VALUES ($1, $2, $3) RETURNING id`,
    [code, `Area ${code}`, opts.parentId ?? null],
  );
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
  opts: { leadTimeDays?: number } = {},
): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "asset_type" ("code", "name", "form_template_id", "approval_route_id", "lead_time_days")
     VALUES ($1, $2, $3, $4, COALESCE($5, 30))
     RETURNING id`,
    [code, `Asset type ${code}`, formTemplateId, approvalRouteId, opts.leadTimeDays ?? null],
  );
  return result.rows[0].id as string;
}

export interface AssetOpts {
  scheduleAnchorDate?: string; // 'YYYY-MM-DD'; defaults to CURRENT_DATE
  status?: 'active' | 'under_repair' | 'decommissioned';
  active?: boolean;
  areaId?: string | null;
}

export async function createAsset(
  assetTypeId: string,
  code: string,
  opts: AssetOpts = {},
): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "asset"
       ("code", "asset_type_id", "schedule_anchor_date", "status", "active", "area_id")
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), COALESCE($4::"asset_status_t", 'active'), COALESCE($5, true), $6)
     RETURNING id`,
    [
      code,
      assetTypeId,
      opts.scheduleAnchorDate ?? null,
      opts.status ?? null,
      opts.active ?? null,
      opts.areaId ?? null,
    ],
  );
  return result.rows[0].id as string;
}

export interface TemplateRevisionOpts {
  sequenceOrdinal: number;
  status: 'draft' | 'pending_approval' | 'current' | 'superseded' | 'rejected';
  approvedBy?: string | null;
  standingContent?: Record<string, unknown>;
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
      JSON.stringify(opts.standingContent ?? {}),
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

export type FrequencyLetter = 'M1' | 'M3' | 'M6' | 'Y';

export async function createTemplateItem(
  templateRevisionId: string,
  frequency: FrequencyLetter,
  opts: { active?: boolean; itemNo?: number } = {},
): Promise<string> {
  const itemNo = opts.itemNo ?? Math.floor(Math.random() * 1_000_000);
  const result = await adminPool.query(
    `INSERT INTO "template_item"
       ("template_revision_id", "item_no", "frequency", "instruction", "stable_key",
        "display_order", "active")
     VALUES ($1, $2, $3::"frequency_t", $4, $5, $2, COALESCE($6, true))
     RETURNING id`,
    [templateRevisionId, itemNo, frequency, `Item ${itemNo}`, randomUUID(), opts.active ?? null],
  );
  return result.rows[0].id as string;
}

export interface ScheduleRuleOpts {
  frequency: FrequencyLetter;
  intervalMonths: number;
  anchorDate?: string; // 'YYYY-MM-DD'
  nextDueOn?: string; // 'YYYY-MM-DD'; defaults to anchorDate
  lastCompletedOn?: string | null;
  active?: boolean;
}

export async function createScheduleRule(assetId: string, opts: ScheduleRuleOpts): Promise<string> {
  const anchor = opts.anchorDate ?? '2026-01-01';
  const result = await adminPool.query(
    `INSERT INTO "schedule_rule"
       ("asset_id", "frequency", "interval_months", "anchor_date", "next_due_on",
        "last_completed_on", "active")
     VALUES ($1, $2::"frequency_t", $3, $4::date, COALESCE($5::date, $4::date), $6::date, COALESCE($7, true))
     RETURNING id`,
    [
      assetId,
      opts.frequency,
      opts.intervalMonths,
      anchor,
      opts.nextDueOn ?? null,
      opts.lastCompletedOn ?? null,
      opts.active ?? null,
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
  assignedTo?: string | null;
  submittedBy?: string | null;
  submittedAt?: Date | null;
  currentStageOrdinal?: number | null;
  archivedAt?: Date | null;
  voidReason?: string | null;
  draftVersion?: number;
}

export async function createJob(opts: JobOpts): Promise<string> {
  const result = await adminPool.query(
    `INSERT INTO "job"
       ("job_number", "asset_id", "template_revision_id", "approval_route_id",
        "frequency", "frequency_scope", "due_on", "generated_at", "status", "assigned_to",
        "submitted_by", "submitted_at", "current_stage_ordinal", "archived_at", "void_reason",
        "draft_version")
     VALUES ($1, $2, $3, $4, 'M1', ARRAY['M1']::"frequency_t"[], CURRENT_DATE, now(), $5, $6,
             $7, $8, $9, $10, $11, COALESCE($12, 0))
     RETURNING id`,
    [
      opts.jobNumber,
      opts.assetId,
      opts.templateRevisionId,
      opts.approvalRouteId,
      opts.status,
      opts.assignedTo ?? null,
      opts.submittedBy ?? null,
      opts.submittedAt ?? null,
      opts.currentStageOrdinal ?? null,
      opts.archivedAt ?? null,
      opts.voidReason ?? null,
      opts.draftVersion ?? null,
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
      | 'assignedTo'
      | 'submittedBy'
      | 'submittedAt'
      | 'currentStageOrdinal'
      | 'archivedAt'
      | 'voidReason'
      | 'draftVersion'
    >
  > = {},
): Promise<{
  jobId: string;
  authorId: string;
  approvalRouteId: string;
  assetId: string;
  revisionId: string;
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
  return { jobId, authorId, approvalRouteId, assetId, revisionId };
}
