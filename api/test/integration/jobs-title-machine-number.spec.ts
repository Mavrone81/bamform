import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
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
 * Slice 31-TITLEBLANK — `PUT /jobs/{jobId}/title-machine-number` and the
 * submit-time gate that makes it mean something.
 *
 * The problem this closes: eight of the twelve controlled templates carry a
 * blank in their TITLE, the only value that could fill it lived on
 * `asset_document.machine_number` (admin-set, once, at tag time), and the
 * owner ruled that wrong — on paper the technician writes it, per record. With
 * the migration no longer setting the admin value, nothing filled the blank at
 * all and a printed record would have shown it empty forever.
 */
describe('Jobs — PUT /jobs/{jobId}/title-machine-number (slice 31-TITLEBLANK)', () => {
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

  const FILLABLE = 'BESi Die Attach Preventive Maintenance Record ED____';
  const PRINTED = 'Epoxy Dispenser EP01 Preventive Maintenance Record';

  async function createTitledTemplate(title: string): Promise<string> {
    const result = await adminPool.query(
      `INSERT INTO "form_template" ("document_number", "title") VALUES ($1, $2) RETURNING id`,
      [`DOC-${randomUUID()}`, title],
    );
    return result.rows[0].id as string;
  }

  /** One job on a template with the given title, assigned to a MAINTAINER,
   * with exactly one mandatory item so the completeness gate can be satisfied
   * independently of the title gate. */
  async function makeJob(
    title: string,
    status: 'assigned' | 'in_progress' | 'submitted' = 'in_progress',
  ) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createTitledTemplate(title);
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
    const itemId = await createTemplateItem(revisionId, 'M1', { itemNo: 1 });

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
    return { jobId, itemId, token, maintainerId, assetId, formTemplateId };
  }

  function put(
    jobId: string,
    token: string,
    body: Record<string, unknown>,
    idempotencyKey = randomUUID(),
  ) {
    return request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/title-machine-number`)
      .set(...authHeader(token))
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  async function recordItem(jobId: string, itemId: string, token: string) {
    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);
  }

  // ------------------------------------------------------------- capture

  it('records the value and returns it on the job', async () => {
    const { jobId, token } = await makeJob(FILLABLE);

    const res = await put(jobId, token, { titleMachineNumber: '01' }).expect(200);
    expect(res.body).toMatchObject({ id: jobId, titleMachineNumber: '01' });

    const read = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    expect(read.body.titleMachineNumber).toBe('01');
    // Derived per response from the frozen revision's title, never stored.
    expect(read.body.titleHasFillableRun).toBe(true);
  });

  it('reports titleHasFillableRun false for a title with the number already printed', async () => {
    const { jobId, token } = await makeJob(PRINTED);
    const read = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    expect(read.body.titleHasFillableRun).toBe(false);
  });

  it('starts NULL — never pre-filled from the machine code', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    const read = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    expect(read.body.titleMachineNumber).toBeNull();
  });

  it('trims the value', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    const res = await put(jobId, token, { titleMachineNumber: '  01  ' }).expect(200);
    expect(res.body.titleMachineNumber).toBe('01');
  });

  /**
   * UNVERSIONED, exactly like `PUT /jobs/{jobId}/parts/{partId}`. This is the
   * property the offline client depends on (`versioned: false`), so it is
   * pinned rather than left implicit: a route that started bumping
   * `draftVersion` would silently put the client's prediction behind reality
   * and 409 the technician's next checklist entry.
   */
  it('does NOT bump draftVersion and does NOT change status — it is an unversioned capture', async () => {
    const { jobId, token } = await makeJob(FILLABLE, 'assigned');
    const before = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);

    const res = await put(jobId, token, { titleMachineNumber: '01' }).expect(200);

    expect(res.body.draftVersion).toBe(before.body.draftVersion);
    expect(res.body.status).toBe('ASSIGNED');
  });

  it('an explicit null CLEARS a mistyped value', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    await put(jobId, token, { titleMachineNumber: '01' }).expect(200);
    const res = await put(jobId, token, { titleMachineNumber: null }).expect(200);
    expect(res.body.titleMachineNumber).toBeNull();
  });

  it.each([{ titleMachineNumber: '' }, { titleMachineNumber: '   ' }, {}])(
    'rejects %j — nothing empty or absent reaches a controlled title',
    async (body) => {
      const { jobId, token } = await makeJob(FILLABLE);
      const res = await put(jobId, token, body).expect(422);
      expect(res.body.type).toBe('/errors/validation-failed');
    },
  );

  it('rejects a value over 50 characters', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    await put(jobId, token, { titleMachineNumber: 'x'.repeat(51) }).expect(422);
  });

  it('requires an Idempotency-Key (PR-API-16 — this route is outbox-reachable)', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    const res = await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/title-machine-number`)
      .set(...authHeader(token))
      .send({ titleMachineNumber: '01' })
      .expect(422);
    expect(res.body.detail).toMatch(/Idempotency-Key/i);
  });

  it('replays the SAME key + body as the cached response, and refuses the same key with a DIFFERENT body', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    const key = randomUUID();
    const first = await put(jobId, token, { titleMachineNumber: '01' }, key).expect(200);
    const replay = await put(jobId, token, { titleMachineNumber: '01' }, key).expect(200);
    expect(replay.body.draftVersion).toBe(first.body.draftVersion);

    const mismatch = await put(jobId, token, { titleMachineNumber: '02' }, key).expect(422);
    expect(mismatch.body.type).toBe('/errors/idempotency-mismatch');
  });

  it('IGNORES If-Match — the route is unversioned, so a stale header cannot wedge the technician', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    const res = await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/title-machine-number`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '999')
      .send({ titleMachineNumber: '01' })
      .expect(200);
    expect(res.body.titleMachineNumber).toBe('01');
  });

  it('refuses capture once the record has left the technician’s hands (SUBMITTED)', async () => {
    const { jobId, token } = await makeJob(FILLABLE, 'submitted');
    const res = await put(jobId, token, { titleMachineNumber: '01' }).expect(409);
    expect(res.body.type).toBe('/errors/invalid-transition');
  });

  /**
   * Ruling 7 / INV-09. An archived record must keep the title it was signed
   * under. Both layers are asserted: the API route refuses, and the database
   * refuses even a direct write — `prevent_archived_job_update()` compares
   * `to_jsonb(OLD) - ARRAY[<annotation columns>]`, so this column added long
   * after that trigger was written is protected with no trigger change.
   */
  describe('an archived record keeps the title it was signed under', () => {
    async function makeArchivedJob() {
      const authorId = await createUser('author');
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createTitledTemplate(FILLABLE);
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
      const maintainerId = await createUser('maintainer');
      await grantRole(maintainerId, 'MAINTAINER');
      const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
      const jobId = await createJob({
        assetId,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `PM-TEST-${randomUUID()}`,
        status: 'archived',
        assignedTo: maintainerId,
        archivedAt: new Date(),
      });
      return { jobId, token };
    }

    it('the API refuses with /errors/record-immutable', async () => {
      const { jobId, token } = await makeArchivedJob();
      const res = await put(jobId, token, { titleMachineNumber: '01' }).expect(409);
      expect(res.body.type).toBe('/errors/record-immutable');
    });

    it('the DATABASE refuses too — INV-09 covers a column added after the trigger', async () => {
      const { jobId } = await makeArchivedJob();
      await expect(
        adminPool.query(`UPDATE "job" SET "title_machine_number" = '01' WHERE id = $1`, [jobId]),
      ).rejects.toThrow(/archived and immutable/i);
    });
  });

  it('the DATABASE backstops the length/emptiness bounds too (job_title_machine_number_chk)', async () => {
    const { jobId } = await makeJob(FILLABLE);
    await expect(
      adminPool.query(`UPDATE "job" SET "title_machine_number" = '   ' WHERE id = $1`, [jobId]),
    ).rejects.toThrow(/job_title_machine_number_chk/i);
    await expect(
      adminPool.query(`UPDATE "job" SET "title_machine_number" = $2 WHERE id = $1`, [
        jobId,
        'x'.repeat(51),
      ]),
    ).rejects.toThrow(/job_title_machine_number_chk/i);
  });

  it('writes an audit_event carrying the change in both directions', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    await put(jobId, token, { titleMachineNumber: '01' }).expect(200);
    await put(jobId, token, { titleMachineNumber: '02' }).expect(200);

    const rows = await adminPool.query(
      `SELECT action, before, after FROM "audit_event"
        WHERE entity_type = 'job' AND entity_id = $1
        ORDER BY occurred_at ASC`,
      [jobId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      action: 'create',
      before: null,
      after: { titleMachineNumber: '01' },
    });
    expect(rows.rows[1]).toMatchObject({
      action: 'update',
      before: { titleMachineNumber: '01' },
      after: { titleMachineNumber: '02' },
    });
  });

  // --------------------------------------------------- the submit-time gate

  describe('required at SUBMIT, optional while drafting', () => {
    it('refuses a submission whose title has a blank that was never filled, NAMING the field', async () => {
      const { jobId, itemId, token } = await makeJob(FILLABLE);
      await recordItem(jobId, itemId, token);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/submit`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ drawnSignature: realPngDataUrl() })
        .expect(422);

      expect(res.body.type).toBe('/errors/incomplete-record');
      // The message names the field AS IT IS PRINTED on the form, not just
      // its API name — that is what a technician can act on.
      expect(res.body.detail).toContain(FILLABLE);
      expect(res.body.errors).toEqual([
        expect.objectContaining({ pointer: '/titleMachineNumber', code: 'REQUIRED' }),
      ]);

      // Nothing was committed: the record is still theirs to finish.
      const read = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}`)
        .set(...authHeader(token))
        .expect(200);
      expect(read.body.status).toBe('IN_PROGRESS');
      expect(read.body.approvalSteps).toHaveLength(0);
    });

    it('accepts the submission once the blank is filled', async () => {
      const { jobId, itemId, token } = await makeJob(FILLABLE);
      await recordItem(jobId, itemId, token);
      await put(jobId, token, { titleMachineNumber: '01' }).expect(200);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/submit`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ drawnSignature: realPngDataUrl() })
        .expect(200);
      expect(res.body.status).toBe('SUBMITTED');
      expect(res.body.titleMachineNumber).toBe('01');
    });

    it('never demands one for a title with no blank — an EP01 form is submittable as it always was', async () => {
      const { jobId, itemId, token } = await makeJob(PRINTED);
      await recordItem(jobId, itemId, token);

      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/submit`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ drawnSignature: realPngDataUrl() })
        .expect(200);
    });

    it('a value CLEARED back to null before submit blocks it again', async () => {
      const { jobId, itemId, token } = await makeJob(FILLABLE);
      await recordItem(jobId, itemId, token);
      await put(jobId, token, { titleMachineNumber: '01' }).expect(200);
      await put(jobId, token, { titleMachineNumber: null }).expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/submit`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ drawnSignature: realPngDataUrl() })
        .expect(422);
    });
  });

  // ------------------------------------------------------------ offline path

  it('applies through the offline outbox, the same as any other captured field', async () => {
    const { jobId, token } = await makeJob(FILLABLE);
    const mutationId = randomUUID();

    const res = await request(app.getHttpServer())
      .post('/api/v1/sync/outbox')
      .set(...authHeader(token))
      .send({
        mutations: [
          {
            id: mutationId,
            sequence: 1,
            method: 'PUT',
            path: `/jobs/${jobId}/title-machine-number`,
            body: { titleMachineNumber: '01' },
          },
        ],
      })
      .expect(200);

    expect(res.body.results).toEqual([{ id: mutationId, status: 200, applied: true }]);
    const read = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    expect(read.body.titleMachineNumber).toBe('01');
  });

  it('surfaces an invalid outbox body as that mutation’s problem, without blocking the batch (PR-API-24)', async () => {
    const { jobId, itemId, token } = await makeJob(FILLABLE);
    const badId = randomUUID();
    const goodId = randomUUID();

    const res = await request(app.getHttpServer())
      .post('/api/v1/sync/outbox')
      .set(...authHeader(token))
      .send({
        mutations: [
          {
            id: badId,
            sequence: 1,
            method: 'PUT',
            path: `/jobs/${jobId}/title-machine-number`,
            body: { titleMachineNumber: '' },
          },
          {
            id: goodId,
            sequence: 2,
            method: 'PUT',
            path: `/jobs/${jobId}/items/${itemId}`,
            body: { status: 'DONE' },
          },
        ],
      })
      .expect(200);

    expect(res.body.results[0]).toMatchObject({ id: badId, status: 422, applied: false });
    expect(res.body.results[1]).toMatchObject({ id: goodId, status: 200, applied: true });
  });
});
