import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * E-13 (docs/TEST_PLAN.md) — `GET /reports/measurements`, UR-070. Readings
 * are cleartext by design (ADR-004), so the trend is a direct SQL/Prisma
 * aggregation — this suite builds two DIFFERENT template revisions sharing
 * the SAME `stable_key` (the whole point of UR-070: trend across
 * revisions), each with a `measurement_result`, and asserts the series
 * joins them correctly.
 */
describe('GET /reports/measurements (E-13, UR-070)', () => {
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

  async function seedTrend() {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-TREND-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const areaId = await createArea(`AREA-TREND-${randomUUID()}`);
    const assetId = await createAsset(assetTypeId, `AS-TREND-${randomUUID()}`, { areaId });
    const author = await createUser('author');
    const stableKey = randomUUID();

    // Only one 'current' revision per template is allowed
    // (template_revision_one_current_per_template_uidx, INV-01) — revisionA
    // is superseded by revisionB below, matching real lifecycle semantics.
    const revisionA = await createTemplateRevision(formTemplateId, author, {
      sequenceOrdinal: 0,
      status: 'superseded',
    });
    const measurementA = await insertMeasurement(revisionA, stableKey, {
      lowerLimit: 10,
      upperLimit: 20,
    });
    const jobA = await createJob({
      assetId,
      templateRevisionId: revisionA,
      approvalRouteId,
      jobNumber: `PM-TREND-A-${randomUUID()}`,
      status: 'archived',
      dueOn: '2026-01-01',
      archivedAt: new Date('2026-01-01'),
    });
    await insertMeasurementResult(jobA, measurementA, author, '15', new Date('2026-01-01'));

    const revisionB = await createTemplateRevision(formTemplateId, author, {
      sequenceOrdinal: 1,
      status: 'current',
    });
    const measurementB = await insertMeasurement(revisionB, stableKey, {
      lowerLimit: 10,
      upperLimit: 20,
    });
    const jobB = await createJob({
      assetId,
      templateRevisionId: revisionB,
      approvalRouteId,
      jobNumber: `PM-TREND-B-${randomUUID()}`,
      status: 'archived',
      dueOn: '2026-06-01',
      archivedAt: new Date('2026-06-01'),
    });
    await insertMeasurementResult(jobB, measurementB, author, '25', new Date('2026-06-01'));

    return { assetId, areaId, stableKey };
  }

  async function insertMeasurement(
    revisionId: string,
    stableKey: string,
    opts: { lowerLimit: number; upperLimit: number },
  ): Promise<string> {
    const result = await adminPool.query(
      `INSERT INTO "template_measurement"
         ("template_revision_id", "description", "unit", "spec_type", "lower_limit", "upper_limit",
          "spec_display", "stable_key", "display_order")
       VALUES ($1, 'Trend measurement', 'C', 'range', $2, $3, '10-20 C', $4, 1)
       RETURNING id`,
      [revisionId, opts.lowerLimit, opts.upperLimit, stableKey],
    );
    return result.rows[0].id as string;
  }

  async function insertMeasurementResult(
    jobId: string,
    templateMeasurementId: string,
    recordedBy: string,
    readingNumeric: string,
    recordedAt: Date,
  ): Promise<void> {
    await adminPool.query(
      `INSERT INTO "measurement_result"
         ("job_id", "template_measurement_id", "reading_numeric", "judgement", "recorded_by",
          "client_recorded_at", "recorded_at")
       VALUES ($1, $2, $3, 'pass', $4, $5, $5)`,
      [jobId, templateMeasurementId, readingNumeric, recordedBy, recordedAt],
    );
  }

  it('returns the trend series for an asset+stableKey ACROSS revisions, ordered by time', async () => {
    const { assetId, stableKey } = await seedTrend();
    const engineerId = await createUser('engineer-trend');
    await grantRole(engineerId, 'ENGINEER');
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/measurements')
      .query({ assetId, stableKey })
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.points).toHaveLength(2);
    expect(res.body.points[0].reading).toBe(15);
    expect(res.body.points[0].revisionCode).toBe('0');
    expect(res.body.points[1].reading).toBe(25);
    expect(res.body.points[1].revisionCode).toBe('1');
    expect(res.body.lowerLimit).toBe(10);
    expect(res.body.upperLimit).toBe(20);
  });

  it('restricts to a date range', async () => {
    const { assetId, stableKey } = await seedTrend();
    const engineerId = await createUser('engineer-trend-2');
    await grantRole(engineerId, 'ENGINEER');
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/measurements')
      .query({ assetId, stableKey, from: '2026-05-01', to: '2026-12-31' })
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.points).toHaveLength(1);
    expect(res.body.points[0].reading).toBe(25);
  });

  it('404s for an asset that does not exist', async () => {
    const engineerId = await createUser('engineer-trend-3');
    await grantRole(engineerId, 'ENGINEER');
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    await request(app.getHttpServer())
      .get('/api/v1/reports/measurements')
      .query({ assetId: randomUUID(), stableKey: 'x' })
      .set(...authHeader(token))
      .expect(404);
  });

  it('403s (out-of-scope) when the asset is outside the caller area scope', async () => {
    const { assetId, stableKey } = await seedTrend();
    const engineerId = await createUser('engineer-trend-4');
    await grantRole(engineerId, 'ENGINEER');
    const otherArea = await createArea(`AREA-OTHER-${randomUUID()}`);
    await scopeUserToArea(engineerId, otherArea);
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    await request(app.getHttpServer())
      .get('/api/v1/reports/measurements')
      .query({ assetId, stableKey })
      .set(...authHeader(token))
      .expect(403);
  });

  it('MAINTAINER is forbidden from the reports surface (not in JOB_VIEW_ALL_ROLES)', async () => {
    const { assetId, stableKey } = await seedTrend();
    const maintainerId = await createUser('maintainer-reports');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    await request(app.getHttpServer())
      .get('/api/v1/reports/measurements')
      .query({ assetId, stableKey })
      .set(...authHeader(token))
      .expect(403);
  });
});
