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
import { realPngBytes, realPngDataUrl } from './helpers/image-fixtures';

/**
 * Slice 18-WORKFLOW §1 — the PERFORMER's drawn signature at submit.
 *
 * The owner's process (2026-07-28), step 3: "Completed work — team member
 * will sign and submit to team lead for checks". Until this slice submit
 * recorded who and when in the hash-chained audit but captured no signature:
 * the paper forms carry three, the system captured two.
 *
 * The signature is stored as a STAGE-0 `approval_step` with
 * `action = 'submitted'` — the mechanism slice 7 built for verifiers,
 * unchanged: PNG magic-byte validated, field-encrypted with AAD bound to
 * (table, column, rowId), `dek_version` recorded, content-bound by an
 * Ed25519 signature over the canonical record (which includes the step
 * itself). See slice-18-workflow-report.md §1 for why stage-0 rather than
 * `job` columns.
 */
describe('Jobs — POST /jobs/{id}/submit performer signature (slice 18-WORKFLOW §1)', () => {
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

  async function makeReadyToSubmitJob() {
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
    const templateItemId = await createTemplateItem(revisionId, 'M1', { itemNo: 1 });

    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-SIG-${randomUUID()}`,
      status: 'in_progress',
      assignedTo: maintainerId,
    });

    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);

    return { jobId, token, maintainerId };
  }

  it('rejects a submission with NO drawn signature — 422, and the job stays IN_PROGRESS', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({})
      .expect(422);

    const row = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(row.rows[0].status).toBe('in_progress');
    const steps = await adminPool.query('SELECT count(*) FROM "approval_step" WHERE job_id = $1', [
      jobId,
    ]);
    expect(Number(steps.rows[0].count)).toBe(0);
  });

  it('rejects a drawnSignature that is not a genuine PNG (magic-byte check, S-30-style) — 422, nothing written', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    const fakePng = `data:image/png;base64,${Buffer.from('not a real png at all').toString('base64')}`;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: fakePng })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/attachment-rejected' });

    const row = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(row.rows[0].status).toBe('in_progress');
    const steps = await adminPool.query('SELECT count(*) FROM "approval_step" WHERE job_id = $1', [
      jobId,
    ]);
    expect(Number(steps.rows[0].count)).toBe(0);
  });

  it('a signed submission writes a stage-0 SUBMITTED approval_step whose drawn signature is ENCRYPTED at rest', async () => {
    const { jobId, token, maintainerId } = await makeReadyToSubmitJob();
    const png = realPngBytes(120);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: `data:image/png;base64,${png.toString('base64')}` })
      .expect(200);
    expect(res.body.status).toBe('SUBMITTED');

    const step = await adminPool.query(
      `SELECT "stage_ordinal", "action", "actor_id", "actor_role_code", "drawn_signature_ct",
              "drawn_signature_dek_version", "content_hash", "signature", "signing_key_id"
         FROM "approval_step" WHERE job_id = $1`,
      [jobId],
    );
    expect(step.rowCount).toBe(1);
    const row = step.rows[0];
    expect(row.stage_ordinal).toBe(0);
    expect(row.action).toBe('submitted');
    expect(row.actor_id).toBe(maintainerId);
    expect(row.actor_role_code).toBe('MAINTAINER');
    // Field-encrypted (PR-106): the stored bytes are NOT the plaintext PNG.
    expect(Buffer.isBuffer(row.drawn_signature_ct)).toBe(true);
    expect(Buffer.from(row.drawn_signature_ct).equals(png)).toBe(false);
    expect(row.drawn_signature_dek_version).toBe(1);
    // Content-bound: a real Ed25519 signature over a real content hash.
    expect(Buffer.from(row.content_hash)).toHaveLength(32);
    expect(Buffer.from(row.signature).length).toBeGreaterThan(0);
    expect(typeof row.signing_key_id).toBe('string');
  });

  it('the performer signature is CONTENT-BOUND — /integrity verifies it, and it breaks if the record is altered underneath', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const adminId = await createUser('integrity-admin');
    await grantRole(adminId, 'ADMIN');
    const adminToken = await mintAccessToken(app, adminId, ['ADMIN']);

    const before = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(adminToken))
      .expect(200);
    expect(before.body.intact).toBe(true);
    expect(before.body.signatures).toHaveLength(1);
    expect(before.body.signatures[0]).toMatchObject({ hashMatches: true, signatureValid: true });

    // S-10-style tamper: change a recorded result directly in the database.
    await adminPool.query(`UPDATE "item_result" SET status = 'not_done' WHERE job_id = $1`, [
      jobId,
    ]);

    const after = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(adminToken))
      .expect(200);
    expect(after.body.intact).toBe(false);
    expect(after.body.signatures[0].signatureValid).toBe(true); // the stored pair is self-consistent
    expect(after.body.signatures[0].hashMatches).toBe(false); // ...but no longer describes the record
  });

  it('the PERFORMER step never blocks verification (INV-05/SYS-8 gate on `verified` only) and the verifier signature binds it', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const tlId = await createUser('tl-after-perf');
    await grantRole(tlId, 'TEAM_LEADER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      tlId,
    ]);
    const tlToken = await mintAccessToken(app, tlId, ['TEAM_LEADER']);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const steps = await adminPool.query(
      `SELECT "stage_ordinal", "action" FROM "approval_step" WHERE job_id = $1 ORDER BY "acted_at"`,
      [jobId],
    );
    expect(steps.rows.map((r) => `${r.action}@${r.stage_ordinal}`)).toEqual([
      'submitted@0',
      'verified@1',
    ]);

    // The verifier's canonical content INCLUDES the performer's step, so the
    // performer's signing event cannot be rewritten without breaking the
    // verifier's signature too. Deleting it is enough to prove the binding.
    const adminId = await createUser('integrity-admin-2');
    await grantRole(adminId, 'ADMIN');
    const adminToken = await mintAccessToken(app, adminId, ['ADMIN']);
    await adminPool.query(
      `DELETE FROM "approval_step" WHERE job_id = $1 AND "action" = 'submitted'`,
      [jobId],
    );
    const after = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(adminToken))
      .expect(200);
    expect(after.body.intact).toBe(false);
    expect(after.body.signatures[0].hashMatches).toBe(false);
  });

  it('a re-submission after a RETURN captures a FRESH performer signature (a second stage-0 step)', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const tlId = await createUser('tl-returner');
    await grantRole(tlId, 'TEAM_LEADER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      tlId,
    ]);
    const tlToken = await mintAccessToken(app, tlId, ['TEAM_LEADER']);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/return`)
      .set(...authHeader(tlToken))
      .send({ reason: 'please recheck the readings' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl(140) })
      .expect(200);

    const steps = await adminPool.query(
      `SELECT "action" FROM "approval_step" WHERE job_id = $1 ORDER BY "acted_at"`,
      [jobId],
    );
    expect(steps.rows.map((r) => r.action)).toEqual(['submitted', 'returned', 'submitted']);
  });

  it('CR-5 — no audit_event payload for the submission carries the signature bytes', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    const png = realPngBytes(120);
    const base64 = png.toString('base64');
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: `data:image/png;base64,${base64}` })
      .expect(200);

    const events = await adminPool.query(
      `SELECT "before"::text AS b, "after"::text AS a FROM "audit_event" WHERE "entity_id" = $1`,
      [jobId],
    );
    expect(events.rowCount).toBeGreaterThan(0);
    for (const row of events.rows) {
      const blob = `${row.b ?? ''}${row.a ?? ''}`;
      expect(blob).not.toContain(base64);
      expect(blob.toLowerCase()).not.toContain('drawnsignature');
      expect(blob.toLowerCase()).not.toContain('drawn_signature');
    }
  });

  it('INV-09 — the submission and its audit event share ONE transaction: a rejected submission writes neither', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    const auditBefore = await adminPool.query(
      `SELECT count(*) FROM "audit_event" WHERE "entity_id" = $1`,
      [jobId],
    );

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: 'data:image/png;base64,' + Buffer.from('nope').toString('base64') })
      .expect(422);

    const auditAfter = await adminPool.query(
      `SELECT count(*) FROM "audit_event" WHERE "entity_id" = $1`,
      [jobId],
    );
    expect(Number(auditAfter.rows[0].count)).toBe(Number(auditBefore.rows[0].count));
  });

  it('idempotent replay: the SAME key + SAME signature replays; the stage-0 step is written once', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    const key = randomUUID();
    const signature = realPngDataUrl();

    const first = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: signature })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: signature })
      .expect(200);
    expect(second.body.id).toBe(first.body.id);

    const steps = await adminPool.query('SELECT count(*) FROM "approval_step" WHERE job_id = $1', [
      jobId,
    ]);
    expect(Number(steps.rows[0].count)).toBe(1);
  });
});
