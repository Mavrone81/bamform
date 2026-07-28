import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJobFixture,
  createScheduleRule,
  createUser,
  createTemplateRevision,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * Slice 18-WORKFLOW §3 — the PLANNER role.
 *
 * Owner decisions (2026-07-28): the code is `PLANNER`, NOT "SCHEDULER" (that
 * word already names the background worker), and permissions are ADDITIVE —
 * TEAM_LEADER, ENGINEER and ADMIN keep every right they hold today.
 *
 * This spec is the enforcement of "ADD, never remove": each gained right is
 * asserted for PLANNER *and* re-asserted for the incumbents, so a future edit
 * that swaps a role list instead of extending it fails here.
 */
describe('PLANNER role (slice 18-WORKFLOW §3)', () => {
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

  async function userWithRole(role: string, label = role.toLowerCase()) {
    const id = await createUser(`${label}-${randomUUID().slice(0, 8)}`);
    await grantRole(id, role);
    return { id, token: await mintAccessToken(app, id, [role]) };
  }

  // ------------------------------------------------------------- seeding

  it('is seeded by migration, idempotently, alongside the original six roles', async () => {
    const rows = await adminPool.query(
      `SELECT "code", "name", "description" FROM "role" ORDER BY "code"`,
    );
    expect(rows.rows.map((r) => r.code)).toEqual([
      'ADMIN',
      'AUDITOR',
      'DOC_CONTROLLER',
      'ENGINEER',
      'MAINTAINER',
      'PLANNER',
      'TEAM_LEADER',
    ]);
    const plannerRow = rows.rows.find((r) => r.code === 'PLANNER');
    expect(plannerRow.name).toBe('Planner');
    expect(plannerRow.description).toMatch(/plans the PM schedule and raises work/);
  });

  it('appears in the server-driven role catalogue GET /roles, so the admin role picker offers it with no client change', async () => {
    const admin = await userWithRole('ADMIN');
    const res = await request(app.getHttpServer())
      .get('/api/v1/roles')
      .set(...authHeader(admin.token))
      .expect(200);
    const codes = (res.body.data as Array<{ code: string }>).map((r) => r.code);
    expect(codes).toContain('PLANNER');
  });

  it('is assignable to a user through the ADMIN user-administration path', async () => {
    const admin = await userWithRole('ADMIN');
    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(admin.token))
      .send({
        employeeId: `EMP-${randomUUID().slice(0, 8)}`,
        fullName: 'Pat Planner',
        email: `planner-${randomUUID().slice(0, 8)}@example.test`,
        password: 'a-long-enough-password-1',
        roleCodes: ['PLANNER'],
      })
      .expect(201);
    expect(res.body.roles).toEqual(['PLANNER']);
  });

  // ------------------------------------------------- rights GAINED (§3)

  it('PUT /assets/{id}/schedule — PLANNER may adjust the plan, and TEAM_LEADER/ENGINEER/ADMIN still may', async () => {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
    await createScheduleRule(assetId, {
      frequency: 'M1',
      intervalMonths: 1,
      anchorDate: '2026-01-01',
      nextDueOn: '2026-09-01',
    });

    for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN']) {
      const actor = await userWithRole(role);
      await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(actor.token))
        .send({
          frequency: 'M1',
          nextDueOn: '2026-10-01',
          adjustedReason: `rescheduled by ${role} during the shutdown window`,
        })
        .expect(200);
    }
    for (const role of ['MAINTAINER', 'DOC_CONTROLLER', 'AUDITOR']) {
      const actor = await userWithRole(role);
      await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(actor.token))
        .send({
          frequency: 'M1',
          nextDueOn: '2026-11-01',
          adjustedReason: 'this should never be applied at all',
        })
        .expect(403);
    }
  });

  it('GET /assets/{id}/schedule stays open to every authenticated role — nobody lost read access', async () => {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);

    for (const role of [
      'PLANNER',
      'MAINTAINER',
      'TEAM_LEADER',
      'ENGINEER',
      'DOC_CONTROLLER',
      'ADMIN',
      'AUDITOR',
    ]) {
      const actor = await userWithRole(role);
      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(actor.token))
        .expect(200);
    }
  });

  it('POST /jobs/{id}/assign — PLANNER may assign, and TEAM_LEADER/ENGINEER/ADMIN still may', async () => {
    const maintainer = await userWithRole('MAINTAINER');

    for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN']) {
      const { jobId } = await createJobFixture(`PM-ASSIGN-${randomUUID()}`, 'scheduled');
      const actor = await userWithRole(role);
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/assign`)
        .set(...authHeader(actor.token))
        .send({ assigneeId: maintainer.id })
        .expect(200);
    }
    for (const role of ['MAINTAINER', 'DOC_CONTROLLER', 'AUDITOR']) {
      const { jobId } = await createJobFixture(`PM-ASSIGN-${randomUUID()}`, 'scheduled');
      const actor = await userWithRole(role);
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/assign`)
        .set(...authHeader(actor.token))
        .send({ assigneeId: maintainer.id })
        .expect(403);
    }
  });

  // ------------------------------------- SEPARATION OF DUTIES (§3, hard)

  it('PLANNER may NOT verify — it is not on any approval stage, and the endpoint refuses it 403', async () => {
    const maintainer = await userWithRole('MAINTAINER');
    const { jobId } = await createJobFixture(`PM-PLANVERIFY-${randomUUID()}`, 'submitted', {
      assignedTo: maintainer.id,
      submittedBy: maintainer.id,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    const plannerUser = await userWithRole('PLANNER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      plannerUser.id,
    ]);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(plannerUser.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(403);

    // ...and the reason is structural, not just a route annotation: PLANNER
    // is on NO approval stage, so even a route change could not let it sign.
    const stageRoles = await adminPool.query(
      `SELECT r."code" FROM "approval_stage_role" sr JOIN "role" r ON r."id" = sr."role_id"`,
    );
    expect(stageRoles.rows.map((r) => r.code)).not.toContain('PLANNER');

    const steps = await adminPool.query('SELECT count(*) FROM "approval_step" WHERE job_id = $1', [
      jobId,
    ]);
    expect(Number(steps.rows[0].count)).toBe(0);
  });

  it('PLANNER may NOT record results or submit — recording is MAINTAINER/TEAM_LEADER/ENGINEER (unchanged)', async () => {
    const authorId = await createUser('author-planner-record');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    await createAsset(assetTypeId, `AS-${randomUUID()}`);
    await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });

    const plannerUser = await userWithRole('PLANNER');
    const { jobId } = await createJobFixture(`PM-PLANREC-${randomUUID()}`, 'in_progress', {
      assignedTo: plannerUser.id,
    });

    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${randomUUID()}`)
      .set(...authHeader(plannerUser.token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(plannerUser.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(403);
  });

  /**
   * Review finding X-1 (Critical). Adding PLANNER to `JOB_VIEW_ALL_ROLES`
   * silently granted it `POST /records/export` (a ZIP of PDFs that
   * `pdf-record-assembly.service.ts` renders with DECRYPTED signatory names
   * and drawn-signature IMAGES) and the whole `/reports/*` surface, because
   * those controllers annotated themselves with that constant. Measured
   * before the fix: `GET /reports/compliance` 200 for PLANNER, 403 for
   * MAINTAINER.
   *
   * The route annotations now use `ORG_REPORTING_ROLES`. This asserts the
   * behaviour at the HTTP layer, in both directions — PLANNER refused, every
   * incumbent still admitted — so the split cannot be undone silently even if
   * someone edits the contract inventory.
   */
  describe('X-1 — PLANNER holds NO bulk export or reporting right', () => {
    const BULK_GETS = [
      '/api/v1/reports/compliance',
      '/api/v1/reports/overdue',
      '/api/v1/reports/pending',
    ];

    it('every /reports/* endpoint refuses PLANNER 403', async () => {
      const plannerUser = await userWithRole('PLANNER');
      for (const path of BULK_GETS) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set(...authHeader(plannerUser.token));
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
      // measurements needs query params; the ROLE gate fires first, so a
      // 403 here proves the gate rather than the validation.
      await request(app.getHttpServer())
        .get('/api/v1/reports/measurements')
        .set(...authHeader(plannerUser.token))
        .expect(403);
    });

    it('POST /records/export refuses PLANNER 403 — no ZIP of decrypted signatures', async () => {
      const plannerUser = await userWithRole('PLANNER');
      await request(app.getHttpServer())
        .post('/api/v1/records/export')
        .set(...authHeader(plannerUser.token))
        .send({ filters: {} })
        .expect(403);
    });

    it('the export status and download endpoints refuse PLANNER 403', async () => {
      const plannerUser = await userWithRole('PLANNER');
      const id = randomUUID();
      await request(app.getHttpServer())
        .get(`/api/v1/exports/${id}`)
        .set(...authHeader(plannerUser.token))
        .expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/exports/${id}/download`)
        .set(...authHeader(plannerUser.token))
        .expect(403);
    });

    it('ADDITIVE in the other direction — every role that could report/export before still can', async () => {
      for (const role of ['TEAM_LEADER', 'ENGINEER', 'DOC_CONTROLLER', 'ADMIN', 'AUDITOR']) {
        const actor = await userWithRole(role);
        for (const path of BULK_GETS) {
          const res = await request(app.getHttpServer())
            .get(path)
            .set(...authHeader(actor.token));
          expect({ role, path, status: res.status }).toEqual({ role, path, status: 200 });
        }
        // 422 = past the role gate, refused on the empty filter body.
        const exportRes = await request(app.getHttpServer())
          .post('/api/v1/records/export')
          .set(...authHeader(actor.token))
          .send({});
        expect({ role, status: exportRes.status }).toEqual({ role, status: 422 });
      }
    });

    it('PLANNER keeps the per-row archive READ it legitimately needs (the split cost it nothing it should have)', async () => {
      const maintainer = await userWithRole('MAINTAINER');
      const { jobId } = await createJobFixture(`PM-PLANREAD-${randomUUID()}`, 'submitted', {
        assignedTo: maintainer.id,
        submittedBy: maintainer.id,
        submittedAt: new Date(),
        currentStageOrdinal: 1,
      });
      const plannerUser = await userWithRole('PLANNER');
      await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}`)
        .set(...authHeader(plannerUser.token))
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/jobs')
        .set(...authHeader(plannerUser.token))
        .expect(200);
    });
  });

  it('PLANNER is not an administrator — user administration stays ADMIN-only', async () => {
    const plannerUser = await userWithRole('PLANNER');
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set(...authHeader(plannerUser.token))
      .expect(403);
  });
});
