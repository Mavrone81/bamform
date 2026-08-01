import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SchedulerService } from '../../src/scheduling/scheduler.service';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetType,
  createFormTemplate,
  createScheduleRule,
  createTemplateItem,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

describe('Scheduling engine — PR-050..058 (I-INV-14/15, worker sweep, /assets/{id}/schedule)', () => {
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

  /** An asset whose template's current revision has one active item per `frequencies`. */
  async function makeSchedulableAsset(
    frequencies: Array<'M1' | 'M3' | 'M6' | 'Y'>,
    overrides: {
      leadTimeDays?: number;
      scheduleAnchorDate?: string;
      inactiveFrequencies?: Array<'M1' | 'M3' | 'M6' | 'Y'>;
      assetActive?: boolean;
      assetStatus?: 'active' | 'under_repair' | 'decommissioned';
    } = {},
  ) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
      {
        leadTimeDays: overrides.leadTimeDays,
      },
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      scheduleAnchorDate: overrides.scheduleAnchorDate,
      active: overrides.assetActive,
      status: overrides.assetStatus,
    });
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    for (const frequency of frequencies) {
      await createTemplateItem(revisionId, frequency);
    }
    for (const frequency of overrides.inactiveFrequencies ?? []) {
      await createTemplateItem(revisionId, frequency, { active: false });
    }
    return { assetId, assetTypeId, formTemplateId, revisionId };
  }

  describe('I-INV-14 (PR-052) — idempotent generation', () => {
    it('running the scheduler twice generates no duplicate job', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']);
      const scheduler = app.get(SchedulerService);

      const first = await scheduler.run();
      const second = await scheduler.run();

      expect(first.ran).toBe(true);
      expect(second.ran).toBe(true);
      if (first.ran) expect(first.generated).toBe(1);
      if (second.ran) {
        expect(second.generated).toBe(0);
        expect(second.alreadyExists).toBe(1);
      }

      const jobs = await adminPool.query('SELECT id FROM "job" WHERE asset_id = $1', [assetId]);
      expect(jobs.rowCount).toBe(1);
    });
  });

  describe('I-INV-15 (PR-051) — the Redis lock serialises concurrent runs', () => {
    it('two concurrent scheduler runs generate the job exactly once', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']);
      const scheduler = app.get(SchedulerService);

      const [a, b] = await Promise.all([scheduler.run(), scheduler.run()]);

      const totalGenerated = [a, b].reduce((sum, r) => sum + (r.ran ? r.generated : 0), 0);
      expect(totalGenerated).toBe(1);
      // Proves the lock genuinely excluded one of the two concurrent callers
      // (rather than both happening to race to completion sequentially and
      // each separately no-op via the idempotency check).
      expect([a, b].some((r) => !r.ran)).toBe(true);

      const jobs = await adminPool.query('SELECT id FROM "job" WHERE asset_id = $1', [assetId]);
      expect(jobs.rowCount).toBe(1);
    });
  });

  describe('job materialization filters template items to active=true only (slice-4 stale-row-leak regression guard)', () => {
    it('an inactive item of a subsumed frequency is excluded from frequency_scope', async () => {
      const { assetId } = await makeSchedulableAsset(['M1', 'M6'], { inactiveFrequencies: ['M3'] });
      // Manually install just the 6M rule so this proves JobGenerationService's
      // own active-items filter, independent of the bootstrap's (separate) filter.
      await createScheduleRule(assetId, { frequency: 'M6', intervalMonths: 6 });

      const scheduler = app.get(SchedulerService);
      await scheduler.run();

      // The active M1 item also gets its own auto-bootstrapped M1 rule/job
      // (unrelated to this test) — assert on the M6 job specifically.
      const jobs = await adminPool.query(
        'SELECT frequency_scope::text[] AS frequency_scope FROM "job" WHERE asset_id = $1 AND frequency = $2',
        [assetId, 'M6'],
      );
      expect(jobs.rowCount).toBe(1);
      // M3 divides 6 but its only item is inactive — must not appear.
      expect(jobs.rows[0].frequency_scope).toEqual(['M1', 'M6']);
    });

    it('ScheduleRuleBootstrapService only creates schedule_rule rows for frequencies with an active item', async () => {
      const { assetId } = await makeSchedulableAsset(['M1'], { inactiveFrequencies: ['Y'] });

      const scheduler = app.get(SchedulerService);
      await scheduler.run(); // triggers ensureForAllActiveAssets()

      const rules = await adminPool.query(
        'SELECT frequency FROM "schedule_rule" r JOIN "asset_document" d ON d.id = r.asset_document_id WHERE d.asset_id = $1 ORDER BY r.frequency',
        [assetId],
      );
      expect(rules.rows.map((r) => r.frequency)).toEqual(['M1']);
    });
  });

  describe('U-SCH-05 — a deactivated asset generates no further jobs', () => {
    it('asset.active = false is excluded from the sweep', async () => {
      const { assetId } = await makeSchedulableAsset(['M1'], { assetActive: false });
      // Bootstrap only targets active assets, so seed the rule directly.
      await createScheduleRule(assetId, { frequency: 'M1', intervalMonths: 1 });

      const scheduler = app.get(SchedulerService);
      await scheduler.run();

      const jobs = await adminPool.query('SELECT id FROM "job" WHERE asset_id = $1', [assetId]);
      expect(jobs.rowCount).toBe(0);
    });

    it('asset.status = under_repair is excluded from the sweep', async () => {
      const { assetId } = await makeSchedulableAsset(['M1'], { assetStatus: 'under_repair' });
      await createScheduleRule(assetId, { frequency: 'M1', intervalMonths: 1 });

      const scheduler = app.get(SchedulerService);
      await scheduler.run();

      const jobs = await adminPool.query('SELECT id FROM "job" WHERE asset_id = $1', [assetId]);
      expect(jobs.rowCount).toBe(0);
    });
  });

  describe('lead time (PR-057) — per-asset-type override', () => {
    it('a rule due beyond the lead-time window is not generated yet', async () => {
      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 90);
      const { assetId } = await makeSchedulableAsset(['M1'], {
        leadTimeDays: 30,
        scheduleAnchorDate: farFuture.toISOString().slice(0, 10),
      });

      const scheduler = app.get(SchedulerService);
      await scheduler.run();

      const jobs = await adminPool.query('SELECT id FROM "job" WHERE asset_id = $1', [assetId]);
      expect(jobs.rowCount).toBe(0);
    });

    it('a wider per-asset-type lead time brings a further-out due date into scope', async () => {
      const in60Days = new Date();
      in60Days.setDate(in60Days.getDate() + 60);
      const { assetId } = await makeSchedulableAsset(['M1'], {
        leadTimeDays: 90,
        scheduleAnchorDate: in60Days.toISOString().slice(0, 10),
      });

      const scheduler = app.get(SchedulerService);
      await scheduler.run();

      const jobs = await adminPool.query('SELECT id FROM "job" WHERE asset_id = $1', [assetId]);
      expect(jobs.rowCount).toBe(1);
    });
  });

  describe('cascade_override wiring (PR-054, U-CAS-06) — real standing_content -> real frequency_scope', () => {
    it('with cascade_override set on the current revision, the generated job frequency_scope equals the override, not the computed cascade', async () => {
      const authorId = await createUser('author');
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
      const revisionId = await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
        // M6 divides evenly into M1/M3/M6, so the COMPUTED cascade for an M6 job
        // would be {M1,M3,M6}. The override below deliberately excludes M3 to
        // prove it's the override — not the divisibility rule — driving the result.
        standingContent: { cascadeOverride: { M6: ['M1', 'M6'] } },
      });
      await createTemplateItem(revisionId, 'M1');
      await createTemplateItem(revisionId, 'M3');
      await createTemplateItem(revisionId, 'M6');
      await createScheduleRule(assetId, { frequency: 'M6', intervalMonths: 6 });

      const scheduler = app.get(SchedulerService);
      await scheduler.run();

      const jobs = await adminPool.query(
        'SELECT frequency_scope::text[] AS frequency_scope FROM "job" WHERE asset_id = $1 AND frequency = $2',
        [assetId, 'M6'],
      );
      expect(jobs.rowCount).toBe(1);
      expect(jobs.rows[0].frequency_scope).toEqual(['M1', 'M6']);
    });

    it('with no cascade_override, the normal computed cascade is used (control case)', async () => {
      const authorId = await createUser('author');
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
      const revisionId = await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
        standingContent: {}, // no cascade_override key at all
      });
      await createTemplateItem(revisionId, 'M1');
      await createTemplateItem(revisionId, 'M3');
      await createTemplateItem(revisionId, 'M6');
      await createScheduleRule(assetId, { frequency: 'M6', intervalMonths: 6 });

      const scheduler = app.get(SchedulerService);
      await scheduler.run();

      const jobs = await adminPool.query(
        'SELECT frequency_scope::text[] AS frequency_scope FROM "job" WHERE asset_id = $1 AND frequency = $2',
        [assetId, 'M6'],
      );
      expect(jobs.rowCount).toBe(1);
      // Without an override, M3 divides 6 so the computed cascade includes it.
      expect(jobs.rows[0].frequency_scope).toEqual(['M1', 'M3', 'M6']);
    });
  });

  describe('GET/PUT /assets/{assetId}/schedule (PR-058, UR-023/UR-025)', () => {
    async function engineerToken(): Promise<string> {
      const userId = await createUser('engineer');
      await grantRole(userId, 'ENGINEER');
      return mintAccessToken(app, userId, ['ENGINEER']);
    }

    it('rejects an unauthenticated request', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']);
      await request(app.getHttpServer()).get(`/api/v1/assets/${assetId}/schedule`).expect(401);
    });

    it('GET lazily bootstraps and returns one row per active-item frequency', async () => {
      const { assetId } = await makeSchedulableAsset(['M1', 'M3']);
      const token = await engineerToken();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200);

      expect(res.body.map((r: { frequency: string }) => r.frequency).sort()).toEqual(['M1', 'M3']);
    });

    it('PUT adjusts next_due_on and records a mandatory reason to the audit trail', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']);
      const token = await engineerToken();

      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200); // bootstraps the M1 row

      const res = await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .send({
          frequency: 'M1',
          nextDueOn: '2027-01-01',
          adjustedReason: 'Line shut down for retooling',
        })
        .expect(200);

      expect(res.body).toMatchObject({ frequency: 'M1', nextDueOn: '2027-01-01' });

      const audit = await adminPool.query(
        `SELECT action FROM "audit_event" WHERE entity_type = 'schedule_rule' AND entity_id = $1`,
        [res.body.id],
      );
      expect(audit.rows.some((r) => r.action === 'update')).toBe(true);
    });

    it('GET reflects a non-null last_completed_on once one exists (not just the freshly-bootstrapped null default)', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']);
      const token = await engineerToken();
      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200); // bootstraps the M1 row (last_completed_on null by default)

      await adminPool.query(
        `UPDATE "schedule_rule" SET last_completed_on = '2026-01-15' WHERE asset_document_id IN (SELECT id FROM "asset_document" WHERE asset_id = $1) AND frequency = 'M1'`,
        [assetId],
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200);

      expect(res.body.find((r: { frequency: string }) => r.frequency === 'M1')).toMatchObject({
        lastCompletedOn: '2026-01-15',
      });
    });

    it('PUT for a frequency with no existing schedule_rule row is a 404 (not a silent create)', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']); // only M1 gets bootstrapped
      const token = await engineerToken();
      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200);

      await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .send({ frequency: 'Y', nextDueOn: '2027-01-01', adjustedReason: 'No Y rule exists yet' })
        .expect(404);
    });

    it('a user scoped to the SAME area as the asset is allowed through (assertInScope in-scope branch)', async () => {
      const area = await createArea(`C-${randomUUID()}`);
      const authorId = await createUser('author3');
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, { areaId: area });
      await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });

      const userId = await createUser('scoped-in-area');
      await grantRole(userId, 'ENGINEER');
      await scopeUserToArea(userId, area);
      const token = await mintAccessToken(app, userId, ['ENGINEER']);

      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200);
    });

    it('U-SCH-06: PUT without a reason (or too short) is rejected 422', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']);
      const token = await engineerToken();
      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200);

      await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .send({ frequency: 'M1', nextDueOn: '2027-01-01', adjustedReason: 'short' })
        .expect(422);

      await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .send({ frequency: 'M1', nextDueOn: '2027-01-01' })
        .expect(422);
    });

    it('a MAINTAINER is forbidden from adjusting the schedule (permission matrix §4.1)', async () => {
      const { assetId } = await makeSchedulableAsset(['M1']);
      const userId = await createUser('maintainer');
      await grantRole(userId, 'MAINTAINER');
      const token = await mintAccessToken(app, userId, ['MAINTAINER']);

      await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .send({ frequency: 'M1', nextDueOn: '2027-01-01', adjustedReason: 'Valid reason text' })
        .expect(403);
    });

    it("GET for an asset outside the caller's area scope is 403 out-of-scope, not 404", async () => {
      const areaA = await createArea(`A-${randomUUID()}`);
      const areaB = await createArea(`B-${randomUUID()}`);
      const authorId = await createUser('author2');
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, { areaId: areaB });
      await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });

      const userId = await createUser('scoped');
      await grantRole(userId, 'ENGINEER');
      await scopeUserToArea(userId, areaA);
      const token = await mintAccessToken(app, userId, ['ENGINEER']);

      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(403);
    });

    it('404s for an unknown asset', async () => {
      const token = await engineerToken();
      await request(app.getHttpServer())
        .get(`/api/v1/assets/${randomUUID()}/schedule`)
        .set(...authHeader(token))
        .expect(404);
    });
  });
});
