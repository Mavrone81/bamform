import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture, createUser, grantRole } from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/** PR-046/074/075 — return/recall/void, each a content-bound-signed approval_step. */
describe('Jobs — return/recall/void (PR-046/074/075)', () => {
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

  async function makeSubmittedJob() {
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const { jobId } = await createJobFixture(`PM-XFER-${randomUUID()}`, 'submitted', {
      assignedTo: maintainerId,
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    return { jobId, maintainerId };
  }

  async function verifierToken(roleCode: 'TEAM_LEADER' | 'ENGINEER' | 'ADMIN', label: string) {
    const userId = await createUser(label);
    await grantRole(userId, roleCode);
    const token = await mintAccessToken(app, userId, [roleCode]);
    return { userId, token };
  }

  describe('POST /jobs/{id}/return', () => {
    it('U-STM-06: rejects a reason under 10 characters', async () => {
      const { jobId } = await makeSubmittedJob();
      const { token } = await verifierToken('TEAM_LEADER', 'tl-return-short');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/return`)
        .set(...authHeader(token))
        .send({ reason: 'too short' })
        .expect(422);
      expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
    });

    it('moves SUBMITTED -> IN_PROGRESS, resets the stage, preserves results, signs and audits', async () => {
      const { jobId } = await makeSubmittedJob();
      const { userId, token } = await verifierToken('ENGINEER', 'eng-return');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/return`)
        .set(...authHeader(token))
        .send({ reason: 'Missing torque reading on item 3' })
        .expect(200);
      expect(res.body.status).toBe('IN_PROGRESS');

      const jobRow = await adminPool.query(
        'SELECT status, current_stage_ordinal FROM "job" WHERE id = $1',
        [jobId],
      );
      expect(jobRow.rows[0].status).toBe('in_progress');
      expect(jobRow.rows[0].current_stage_ordinal).toBeNull();

      const step = await adminPool.query(
        'SELECT action, actor_id, reason, content_hash, signature, signing_key_id FROM "approval_step" WHERE job_id = $1',
        [jobId],
      );
      expect(step.rows[0]).toMatchObject({
        action: 'returned',
        actor_id: userId,
        reason: 'Missing torque reading on item 3',
      });
      expect(step.rows[0].content_hash).not.toBeNull();
      expect(step.rows[0].signature).not.toBeNull();

      const audit = await adminPool.query(
        `SELECT action, before, after FROM "audit_event" WHERE entity_type = 'job' AND entity_id = $1 AND action = 'state_change' ORDER BY sequence DESC LIMIT 1`,
        [jobId],
      );
      expect(audit.rows[0].after).toMatchObject({ status: 'IN_PROGRESS' });
    });
  });

  describe('POST /jobs/{id}/recall', () => {
    it('PR-075: only the submitter may recall — a different MAINTAINER is rejected 403', async () => {
      const { jobId } = await makeSubmittedJob();
      const otherId = await createUser('other-maintainer');
      await grantRole(otherId, 'MAINTAINER');
      const token = await mintAccessToken(app, otherId, ['MAINTAINER']);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/recall`)
        .set(...authHeader(token))
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/forbidden' });
    });

    it('the submitter recalls their own SUBMITTED job back to IN_PROGRESS', async () => {
      const { jobId, maintainerId } = await makeSubmittedJob();
      const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/recall`)
        .set(...authHeader(token))
        .expect(200);
      expect(res.body.status).toBe('IN_PROGRESS');

      const jobRow = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
      expect(jobRow.rows[0].status).toBe('in_progress');

      const step = await adminPool.query(
        'SELECT action, actor_id FROM "approval_step" WHERE job_id = $1',
        [jobId],
      );
      expect(step.rows[0]).toMatchObject({ action: 'recalled', actor_id: maintainerId });
    });

    it('rejects recall of a job that is not SUBMITTED (already IN_PROGRESS)', async () => {
      const maintainerId = await createUser('maintainer-noop');
      await grantRole(maintainerId, 'MAINTAINER');
      const { jobId } = await createJobFixture(`PM-RECALL-${randomUUID()}`, 'in_progress', {
        assignedTo: maintainerId,
      });
      const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/recall`)
        .set(...authHeader(token))
        .expect(409);
      expect(res.body).toMatchObject({ type: '/errors/invalid-transition' });
    });
  });

  describe('POST /jobs/{id}/void', () => {
    it('U-STM-05: rejects a reason under 10 characters', async () => {
      const { jobId } = await makeSubmittedJob();
      const { token } = await verifierToken('ADMIN', 'admin-void-short');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/void`)
        .set(...authHeader(token))
        .send({ reason: 'nope' })
        .expect(422);
      expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
    });

    it('voids a SUBMITTED job — record remains visible/queryable with status VOIDED (PR-046, not a delete)', async () => {
      const { jobId } = await makeSubmittedJob();
      const { userId, token } = await verifierToken('ADMIN', 'admin-void');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/void`)
        .set(...authHeader(token))
        .send({ reason: 'Asset decommissioned mid-task' })
        .expect(200);
      expect(res.body.status).toBe('VOIDED');

      // Still fetchable — never deleted.
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}`)
        .set(...authHeader(token))
        .expect(200);
      expect(getRes.body.status).toBe('VOIDED');

      const jobRow = await adminPool.query(
        'SELECT status, void_reason, voided_by FROM "job" WHERE id = $1',
        [jobId],
      );
      expect(jobRow.rows[0]).toMatchObject({
        status: 'voided',
        void_reason: 'Asset decommissioned mid-task',
        voided_by: userId,
      });
    });

    it('U-STM-03 (amended, slice 17): void from ARCHIVED is ADMIN-only — a TEAM_LEADER is refused 403 and the record is untouched', async () => {
      // The owner's 2026-07-27 decision made ARCHIVED -> VOIDED legal (the
      // annotation transition) — see approval-void-post-archive.spec.ts for
      // the full post-archive suite (I-VOID-01..10). What this spec keeps
      // pinning: the PRE-archive role set gains nothing — a non-ADMIN
      // verifier role cannot void an archived record.
      const { jobId } = await createJobFixture(`PM-VOID-ARCHIVED-${randomUUID()}`, 'archived', {
        archivedAt: new Date(),
      });
      const { token } = await verifierToken('TEAM_LEADER', 'tl-void-archived');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/void`)
        .set(...authHeader(token))
        .send({ reason: 'attempting a post-archive void without ADMIN' })
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/forbidden' });

      const jobRow = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
      expect(jobRow.rows[0].status).toBe('archived');
    });

    it('void is legal from SCHEDULED (before any capture begins)', async () => {
      const { jobId } = await createJobFixture(`PM-VOID-SCHEDULED-${randomUUID()}`, 'scheduled');
      const { token } = await verifierToken('TEAM_LEADER', 'tl-void-scheduled');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/void`)
        .set(...authHeader(token))
        .send({ reason: 'Machine decommissioned before job started' })
        .expect(200);
      expect(res.body.status).toBe('VOIDED');
    });
  });
});
