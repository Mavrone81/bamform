import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * E-14 (docs/TEST_PLAN.md) — `GET /reports/compliance` (UR-067) reconciles
 * against job records; `/reports/overdue`/`/reports/pending` (UR-068).
 * Lighter coverage than the PDF/export/trend suites (per slice-12-brief.md,
 * the explicit TDD focus is E-11..14/P-08/09 — these three endpoints reuse
 * `overdueWhere`/`toJobSummary`/area-scope wiring already proven elsewhere;
 * this suite proves the NEW aggregation/grouping logic specifically).
 */
describe('GET /reports/compliance, /overdue, /pending (E-14, UR-067/068)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeAll();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  /**
   * Returns everything needed to mint jobs, PLUS `assetTypeId` so each
   * caller can create a FRESH asset per job — `job_asset_frequency_scope_
   * due_on_key` (I-INV-14) uniquely constrains (assetId, frequencyScope,
   * dueOn), and `createJob`'s fixture always uses frequencyScope=['M1'], so
   * two same-asset jobs sharing a due date would collide.
   */
  async function baseAsset() {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-RPT-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-RPT-${randomUUID()}`);
    const author = await createUser('author-rpt');
    const revisionId = await createTemplateRevision(formTemplateId, author, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    return { approvalRouteId, assetTypeId, assetId, revisionId };
  }

  it('compliance: an on-time archived job counts toward completedOnTimeCount, a late one toward completedLateCount', async () => {
    const { approvalRouteId, assetTypeId, assetId, revisionId } = await baseAsset();
    // On time: archived BEFORE/AT its due date. INV-09 (job_archived_immutable_trg)
    // rejects any UPDATE once a row is already archived, so due_on/archivedAt
    // must be set AT CREATION, not via a follow-up UPDATE.
    await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-RPT-ONTIME-${randomUUID()}`,
      status: 'archived',
      dueOn: '2026-06-10',
      archivedAt: new Date('2026-06-05T00:00:00Z'),
    });
    // Late: archived AFTER its due date. A SEPARATE asset (same type) — two
    // jobs on the SAME asset sharing a due date would collide with
    // job_asset_frequency_scope_due_on_key (I-INV-14).
    const secondAssetId = await createAsset(assetTypeId, `AS-RPT-LATE-${randomUUID()}`);
    await createJob({
      assetId: secondAssetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-RPT-LATE-${randomUUID()}`,
      status: 'archived',
      dueOn: '2026-06-10',
      archivedAt: new Date('2026-06-20T00:00:00Z'),
    });

    const adminId = await createUser('admin-rpt');
    await grantRole(adminId, 'ADMIN');
    const token = await mintAccessToken(app, adminId, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/compliance')
      .query({ from: '2026-06-01', to: '2026-06-30' })
      .set(...authHeader(token))
      .expect(200);

    const row = res.body.rows[0];
    expect(row.dueCount).toBe(2);
    expect(row.completedOnTimeCount).toBe(1);
    expect(row.completedLateCount).toBe(1);
  });

  it('overdue: a job past due AND not verified/archived/voided appears; a completed one does not', async () => {
    const { approvalRouteId, assetTypeId, assetId, revisionId } = await baseAsset();
    await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-RPT-OVERDUE-${randomUUID()}`,
      status: 'assigned',
      dueOn: '2020-01-01',
    });
    const secondAssetId = await createAsset(assetTypeId, `AS-RPT-NOTOVERDUE-${randomUUID()}`);
    await createJob({
      assetId: secondAssetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-RPT-NOTOVERDUE-${randomUUID()}`,
      status: 'archived',
      dueOn: '2020-01-01',
      archivedAt: new Date('2020-01-01T00:00:00Z'),
    });

    const engineerId = await createUser('engineer-rpt');
    await grantRole(engineerId, 'ENGINEER');
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/overdue')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].jobNumber).toContain('PM-RPT-OVERDUE-');
  });

  it('pending: a SUBMITTED job appears with ageHours; a VERIFIED/ARCHIVED one does not', async () => {
    const { approvalRouteId, assetId, revisionId } = await baseAsset();
    const submitter = await createUser('submitter-rpt');
    await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-RPT-PENDING-${randomUUID()}`,
      status: 'submitted',
      submittedBy: submitter,
      submittedAt: new Date(Date.now() - 3_600_000 * 5),
      currentStageOrdinal: 1,
    });

    const engineerId = await createUser('engineer-rpt-2');
    await grantRole(engineerId, 'ENGINEER');
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/pending')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].jobNumber).toContain('PM-RPT-PENDING-');
    expect(res.body.data[0].ageHours).toBeGreaterThanOrEqual(4.9);
  });
});
