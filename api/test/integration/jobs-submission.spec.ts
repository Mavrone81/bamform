import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createTemplateItem,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * PR-045/UR-039/ADR-013 — the submission completeness gate. This is the
 * scenario the brief calls out for explicit RED-first TDD: written and run
 * failing (404 — no `/submit` handler existed) BEFORE `SubmissionService`/
 * `JobsController#submit` were implemented; green afterwards. See
 * slice-6-report.md for the transcript.
 */
describe('Jobs — POST /jobs/{id}/submit (PR-045 completeness gate)', () => {
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

  async function makeJobWithItems(
    status: 'assigned' | 'in_progress',
    itemOpts: Array<{ mandatory: boolean }>,
  ) {
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
    });

    const itemIds: string[] = [];
    for (let i = 0; i < itemOpts.length; i += 1) {
      const id = await createTemplateItem(revisionId, 'M1', { itemNo: i + 1 });
      itemIds.push(id);
      if (!itemOpts[i].mandatory) {
        await adminPool.query('UPDATE "template_item" SET mandatory = false WHERE id = $1', [id]);
      }
    }

    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-TEST-${randomUUID()}`,
      status,
      assignedTo: maintainerId,
    });

    return { jobId, itemIds, token };
  }

  it('rejects submission with outstanding mandatory items, listing them (PR-API-13)', async () => {
    const { jobId, itemIds, token } = await makeJobWithItems('in_progress', [
      { mandatory: true },
      { mandatory: true },
    ]);
    // Record only the first item — the second remains outstanding.
    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${itemIds[0]}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(422);

    expect(res.body).toMatchObject({ type: '/errors/incomplete-record' });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].pointer).toBe('/items/2');

    const jobRow = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(jobRow.rows[0].status).toBe('in_progress'); // unchanged
  });

  it('non-mandatory items never block submission', async () => {
    const { jobId, itemIds, token } = await makeJobWithItems('in_progress', [
      { mandatory: true },
      { mandatory: false },
    ]);
    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${itemIds[0]}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
  });

  it('submits successfully once every mandatory item has a result, writing audit_event', async () => {
    const { jobId, itemIds, token } = await makeJobWithItems('in_progress', [{ mandatory: true }]);
    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${itemIds[0]}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'NOT_DONE', remark: 'jammed, escalated' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    expect(res.body.status).toBe('SUBMITTED');

    const jobRow = await adminPool.query(
      'SELECT status, submitted_by, submitted_at, current_stage_ordinal FROM "job" WHERE id = $1',
      [jobId],
    );
    expect(jobRow.rows[0].status).toBe('submitted');
    expect(jobRow.rows[0].submitted_at).not.toBeNull();
    expect(jobRow.rows[0].current_stage_ordinal).toBe(1);

    const audit = await adminPool.query(
      `SELECT action, before, after FROM "audit_event" WHERE entity_type = 'job' AND entity_id = $1 AND action = 'state_change'`,
      [jobId],
    );
    expect(audit.rows[0]).toMatchObject({ action: 'state_change' });
  });

  it('a NOT_DONE result still satisfies the gate (PR-045 asks whether the item was addressed, not the outcome)', async () => {
    const { jobId, itemIds, token } = await makeJobWithItems('in_progress', [{ mandatory: true }]);
    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${itemIds[0]}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'NOT_APPLICABLE' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
  });

  it('rejects submission of a job that is still ASSIGNED (no results recorded yet)', async () => {
    const { jobId, token } = await makeJobWithItems('assigned', [{ mandatory: true }]);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(409);
    expect(res.body).toMatchObject({ type: '/errors/invalid-transition' });
  });

  it('rejects submitting an already-SUBMITTED job', async () => {
    const { jobId, token } = await makeJobWithItems('in_progress', []);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(409);
    expect(res.body).toMatchObject({ type: '/errors/invalid-transition' });
  });

  it('submit is idempotent when the client replays the same Idempotency-Key (with a re-drawn signature — the only replay a real client produces)', async () => {
    const { jobId, token } = await makeJobWithItems('in_progress', []);
    const key = randomUUID();

    const first = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: realPngDataUrl(100) })
      .expect(200);

    // Slice 18-WORKFLOW review, X-2: the signature is never persisted on the
    // device, so a SYS-14 retry under the persisted key always carries
    // freshly drawn bytes. Resending the identical fixture pinned a scenario
    // the real client cannot produce.
    const second = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: realPngDataUrl(180) })
      .expect(200);

    expect(second.body).toEqual(first.body);
  });
});
