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

  /**
   * SYS-14 / PR-062 — the LOST-RESPONSE RETRY, which is the only replay a
   * real client can produce for this endpoint.
   *
   * Review finding X-2: the original test here resent the SAME
   * `realPngDataUrl()` bytes, which no real client can do. `submitJob`
   * persists the idempotency key BEFORE the request and KEEPS it when the
   * transport throws (`sync-engine.ts`), while the signature is deliberately
   * never persisted — so a retry after a dropped response ALWAYS carries
   * freshly drawn, different PNG bytes. This test now exercises that case.
   */
  it('SYS-14: the same key with a DIFFERENT signature replays the committed submission — it does not 422', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    const key = randomUUID();
    // Two genuinely different PNGs — a person cannot redraw the same bytes.
    const firstSignature = realPngDataUrl(100);
    const secondSignature = realPngDataUrl(180);
    expect(secondSignature).not.toBe(firstSignature);

    const first = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: firstSignature })
      .expect(200);

    // The response to the first attempt was "lost"; the technician re-signs
    // and retries under the SAME persisted key.
    const second = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: secondSignature })
      .expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe('SUBMITTED');

    // Applied exactly once: one stage-0 step, one state-change audit event.
    const steps = await adminPool.query(
      'SELECT id FROM "approval_step" WHERE job_id = $1 AND action = $2',
      [jobId, 'submitted'],
    );
    expect(steps.rowCount).toBe(1);
    const events = await adminPool.query(
      `SELECT count(*) FROM "audit_event" WHERE "entity_id" = $1 AND "action" = 'state_change'`,
      [jobId],
    );
    expect(Number(events.rows[0].count)).toBe(1);
  });

  it('the replayed signature is DISCARDED — the stored signature is the one that was content-bound', async () => {
    const { jobId, token } = await makeReadyToSubmitJob();
    const key = randomUUID();
    const firstPng = realPngBytes(100);
    const secondPng = realPngBytes(180);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: `data:image/png;base64,${firstPng.toString('base64')}` })
      .expect(200);
    const before = await adminPool.query(
      `SELECT "id", "drawn_signature_ct", "content_hash" FROM "approval_step"
        WHERE job_id = $1 AND action = 'submitted'`,
      [jobId],
    );

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: `data:image/png;base64,${secondPng.toString('base64')}` })
      .expect(200);
    const after = await adminPool.query(
      `SELECT "id", "drawn_signature_ct", "content_hash" FROM "approval_step"
        WHERE job_id = $1 AND action = 'submitted'`,
      [jobId],
    );

    // Byte-identical: a replay writes nothing, so the second signature can
    // never substitute for the one the Ed25519 signature commits to.
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].id).toBe(before.rows[0].id);
    expect(
      Buffer.from(after.rows[0].drawn_signature_ct).equals(
        Buffer.from(before.rows[0].drawn_signature_ct),
      ),
    ).toBe(true);
    expect(
      Buffer.from(after.rows[0].content_hash).equals(Buffer.from(before.rows[0].content_hash)),
    ).toBe(true);
  });

  it('a DIFFERENT job under the same key is still a genuine mismatch — 422', async () => {
    const a = await makeReadyToSubmitJob();
    const b = await makeReadyToSubmitJob();
    const key = randomUUID();

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${a.jobId}/submit`)
      .set(...authHeader(a.token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    // The jobId is still part of the fingerprint — dropping the signature
    // from it did not make the key a wildcard.
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${b.jobId}/submit`)
      .set(...authHeader(b.token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature: realPngDataUrl() })
      .expect(422);
    expect(res.body.type).toBe('/errors/idempotency-mismatch');
  });
});
