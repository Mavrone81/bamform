import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture, createUser, grantRole } from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngBytes, realPngDataUrl } from './helpers/image-fixtures';
import { loadFieldEncryptionService } from './helpers/auth-fixtures';

/**
 * PR-041..046/070..077/093/094 — two-stage verification (SAMUEL'S CONFIRMED
 * DECISIONS): stage 1 TEAM_LEADER, stage 2 ENGINEER. S-22 (live HTTP
 * self-approval, complementing the DB-trigger-level `triggers.spec.ts`),
 * step-up (S-07/08 reused), drawn signature encrypted storage, content-bound
 * Ed25519 signature, I-INV-13 (VERIFIED+ARCHIVED in one transaction).
 */
describe('Jobs — POST /jobs/{id}/verify (two-stage approval, PR-041..046/093/094)', () => {
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
    const { jobId } = await createJobFixture(`PM-VERIFY-${randomUUID()}`, 'submitted', {
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    return { jobId, maintainerId };
  }

  async function stepUpVerifier(roleCode: 'TEAM_LEADER' | 'ENGINEER', label: string) {
    const userId = await createUser(label);
    await grantRole(userId, roleCode);
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      userId,
    ]);
    const token = await mintAccessToken(app, userId, [roleCode]);
    return { userId, token };
  }

  it('I-INV-13/PR-042: stage 1 (TEAM_LEADER) advances without archiving; stage 2 (ENGINEER) archives in the SAME transaction — never rests VERIFIED', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl');
    const eng = await stepUpVerifier('ENGINEER', 'eng');

    const stage1 = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(stage1.body.status).toBe('SUBMITTED');

    const afterStage1 = await adminPool.query(
      'SELECT status, current_stage_ordinal, verified_at, archived_at FROM "job" WHERE id = $1',
      [jobId],
    );
    expect(afterStage1.rows[0].status).toBe('submitted');
    expect(afterStage1.rows[0].current_stage_ordinal).toBe(2);
    expect(afterStage1.rows[0].verified_at).toBeNull();
    expect(afterStage1.rows[0].archived_at).toBeNull();

    const stage2 = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(eng.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(stage2.body.status).toBe('ARCHIVED');

    const afterStage2 = await adminPool.query(
      'SELECT status, current_stage_ordinal, verified_at, archived_at FROM "job" WHERE id = $1',
      [jobId],
    );
    expect(afterStage2.rows[0].status).toBe('archived');
    expect(afterStage2.rows[0].current_stage_ordinal).toBeNull();
    // I-INV-13: VERIFIED and ARCHIVED in the same transaction — both
    // timestamps are set together; the job never rested at status='verified'
    // (proved structurally: this is the FIRST read after stage 2, and status
    // is already 'archived', never observed as 'verified').
    expect(afterStage2.rows[0].verified_at).not.toBeNull();
    expect(afterStage2.rows[0].archived_at).not.toBeNull();

    const steps = await adminPool.query(
      'SELECT stage_ordinal, action, actor_id FROM "approval_step" WHERE job_id = $1 ORDER BY acted_at',
      [jobId],
    );
    expect(steps.rows).toEqual([
      { stage_ordinal: 1, action: 'verified', actor_id: tl.userId },
      { stage_ordinal: 2, action: 'verified', actor_id: eng.userId },
    ]);
  });

  it('S-22 (live): the submitter cannot verify their own record — 409 self-approval (INV-05, PR-044, service-layer)', async () => {
    const { jobId, maintainerId } = await makeSubmittedJob();
    // Grant the submitter TEAM_LEADER too, so the role gate passes and the
    // self-approval check is what actually rejects the request.
    await grantRole(maintainerId, 'TEAM_LEADER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      maintainerId,
    ]);
    const token = await mintAccessToken(app, maintainerId, ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(409);
    expect(res.body).toMatchObject({ type: '/errors/self-approval' });

    const jobRow = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(jobRow.rows[0].status).toBe('submitted'); // unchanged
  });

  it('SYS-8: one person holding TEAM_LEADER + ENGINEER cannot supply BOTH verification signatures — stage 2 by the stage-1 verifier is 409', async () => {
    const { jobId } = await makeSubmittedJob();
    // One human with both verifier roles — before slice 15-SYSWIRE they could
    // sign stage 1 AND stage 2 and archive a "two-verifier" record alone.
    const bothId = await createUser('supervisor-both-roles');
    await grantRole(bothId, 'TEAM_LEADER');
    await grantRole(bothId, 'ENGINEER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      bothId,
    ]);
    const token = await mintAccessToken(app, bothId, ['TEAM_LEADER', 'ENGINEER']);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(409);
    expect(res.body).toMatchObject({ type: '/errors/self-approval' });

    // Stage 2 is still open — a DIFFERENT engineer completes it.
    const jobRow = await adminPool.query(
      'SELECT status, current_stage_ordinal FROM "job" WHERE id = $1',
      [jobId],
    );
    expect(jobRow.rows[0]).toEqual({ status: 'submitted', current_stage_ordinal: 2 });
    const eng = await stepUpVerifier('ENGINEER', 'eng-distinct');
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(eng.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
  });

  it("SYS-8 cycle semantics: after a RETURN + resubmit, the previous cycle's stage-1 verifier may verify stage 1 again", async () => {
    const maintainerId = await createUser('maintainer-rework');
    await grantRole(maintainerId, 'MAINTAINER');
    const { jobId } = await createJobFixture(`PM-REWORK-${randomUUID()}`, 'submitted', {
      assignedTo: maintainerId,
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-cycle');
    const otherTl = await stepUpVerifier('TEAM_LEADER', 'tl-returner');
    const maintainerToken = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/return`)
      .set(...authHeader(otherTl.token))
      .send({ reason: 'please recheck the readings' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(maintainerToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    // A fresh submission restarts BOTH stages; the distinct-person rule
    // applies within the CURRENT cycle only — tl's old (superseded) stage-1
    // signature does not block them from signing the reworked content.
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
  });

  it('S-07-equivalent: step-up required — a verifier who has not recently authenticated gets 403 step-up-required', async () => {
    const { jobId } = await makeSubmittedJob();
    const tlId = await createUser('tl-stale');
    await grantRole(tlId, 'TEAM_LEADER');
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() - interval '20 minutes' WHERE id = $1`,
      [tlId],
    );
    const token = await mintAccessToken(app, tlId, ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/step-up-required' });
  });

  it('a verifier not eligible for THIS stage (wrong role) is rejected 403 forbidden', async () => {
    const { jobId } = await makeSubmittedJob(); // currentStageOrdinal = 1 (TEAM_LEADER only)
    const eng = await stepUpVerifier('ENGINEER', 'eng-wrong-stage');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(eng.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  // Slice 26-TWOSTAGE — the OTHER half of the stage gate. The test above
  // proves an ENGINEER cannot do the team leader's first check; this proves a
  // TEAM_LEADER cannot do the engineer's final one, i.e. cannot ARCHIVE. Both
  // directions matter: the owner's process (2026-07-29, steps 5-7) is a
  // maintainer's submission checked by the team leader and then INDEPENDENTLY
  // validated by an engineer, and a single signature must never archive.
  it('slice 26: a TEAM_LEADER cannot sign STAGE 2 — 403, and the record stays SUBMITTED at stage 2 (one signature never archives)', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-stage1');
    const tl2 = await stepUpVerifier('TEAM_LEADER', 'tl-stage2-attempt');

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    // A DIFFERENT team leader, so the SYS-8 distinct-verifier rule (409) is
    // not what rejects this — the stage's role set is.
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl2.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });

    const jobRow = await adminPool.query(
      'SELECT status, current_stage_ordinal, archived_at FROM "job" WHERE id = $1',
      [jobId],
    );
    expect(jobRow.rows[0]).toMatchObject({
      status: 'submitted',
      current_stage_ordinal: 2,
      archived_at: null,
    });
    const steps = await adminPool.query(
      `SELECT count(*)::int AS n FROM "approval_step" WHERE job_id = $1 AND action = 'verified'`,
      [jobId],
    );
    expect(steps.rows[0].n).toBe(1);
  });

  it('rejects a drawnSignature that is not a genuine PNG (magic-byte check, S-30-style) — 422', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-badpng');
    const fakePng = `data:image/png;base64,${Buffer.from('not a real png').toString('base64')}`;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: fakePng })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/attachment-rejected' });

    const stepCount = await adminPool.query(
      'SELECT count(*) FROM "approval_step" WHERE job_id = $1',
      [jobId],
    );
    expect(Number(stepCount.rows[0].count)).toBe(0);
  });

  it('the drawn signature is stored ENCRYPTED — raw column bytes differ from plaintext, and decrypt round-trips to the original PNG', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-encrypt');
    const png = realPngBytes(80);
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: dataUrl })
      .expect(200);

    const row = await adminPool.query(
      'SELECT id, drawn_signature_ct, drawn_signature_dek_version FROM "approval_step" WHERE job_id = $1',
      [jobId],
    );
    const stepId = row.rows[0].id as string;
    const ciphertext: Buffer = row.rows[0].drawn_signature_ct;
    const dekVersion: number = row.rows[0].drawn_signature_dek_version;

    expect(ciphertext).not.toBeNull();
    // Not the plaintext base64 string bytes, and not the raw PNG bytes either.
    expect(ciphertext.equals(Buffer.from(png.toString('base64'), 'utf8'))).toBe(false);
    expect(ciphertext.includes(png)).toBe(false);

    const fieldEncryption = loadFieldEncryptionService();
    const decryptedBase64 = fieldEncryption.decrypt(ciphertext, dekVersion, {
      table: 'approval_step',
      column: 'drawn_signature_ct',
      rowId: stepId,
    });
    expect(Buffer.from(decryptedBase64, 'base64').equals(png)).toBe(true);
  });

  it('the approval_step carries a content_hash + Ed25519 signature, verifiable via GET /records/{id}/integrity', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-integrity');
    const eng = await stepUpVerifier('ENGINEER', 'eng-integrity');

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(eng.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const integrity = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(eng.token))
      .expect(200);

    expect(integrity.body.recordId).toBe(jobId);
    expect(integrity.body.intact).toBe(true);
    expect(integrity.body.signatures).toHaveLength(2);
    for (const sig of integrity.body.signatures) {
      expect(sig.signatureValid).toBe(true);
    }
    expect(integrity.body.signatures[1].hashMatches).toBe(true);
  });

  it('the GET /jobs/{id} response includes approvalSteps, without leaking the encrypted drawn signature', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-read');

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(tl.token))
      .expect(200);

    expect(res.body.approvalSteps).toHaveLength(1);
    expect(res.body.approvalSteps[0]).toMatchObject({ stageOrdinal: 1, action: 'VERIFIED' });
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toMatch(/drawnSignature/i);
  });

  // Slice 26-TWOSTAGE review fix M1. Three copies of the stage caption had
  // drifted apart — the DB's `approval_stage.label`, `RecordReview.tsx`'s
  // STAGE_LABELS and `pdf-html-template.ts`'s signatureBlockLabel — and the
  // archived PDF is a controlled ISO-13485 record that must not misname the
  // stage it records. The label is SNAPSHOTTED onto the step at signing time
  // rather than joined at render time: routes are data (ADR-011) and an
  // administrator relabelling a stage must never retroactively rewrite the
  // caption on a record already archived (the defect slice 23-PDFA exists to
  // remove).
  it('slice 26 M1: each verification step snapshots its stage label at signing time, and GET /jobs exposes it', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-snap');
    const eng = await stepUpVerifier('ENGINEER', 'eng-snap');

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(eng.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(tl.token))
      .expect(200);

    expect(res.body.approvalSteps).toHaveLength(2);
    expect(res.body.approvalSteps[0]).toMatchObject({
      stageOrdinal: 1,
      action: 'VERIFIED',
      stageLabel: 'Verified By (Workshop Team Leader)',
    });
    expect(res.body.approvalSteps[1]).toMatchObject({
      stageOrdinal: 2,
      action: 'VERIFIED',
      stageLabel: 'Verified By (Supervisor / Engineer)',
    });

    // Stored, not derived at read time — and stored VERBATIM from the route
    // configuration that was live when the signature was taken.
    const stored = await adminPool.query(
      'SELECT stage_ordinal, stage_label FROM "approval_step" WHERE job_id = $1 ORDER BY acted_at',
      [jobId],
    );
    expect(stored.rows).toEqual([
      { stage_ordinal: 1, stage_label: 'Verified By (Workshop Team Leader)' },
      { stage_ordinal: 2, stage_label: 'Verified By (Supervisor / Engineer)' },
    ]);
  });

  it('slice 26 M1: relabelling the stage AFTER archiving does not rewrite the archived record’s caption', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-relabel');
    const eng = await stepUpVerifier('ENGINEER', 'eng-relabel');
    for (const who of [tl, eng]) {
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/verify`)
        .set(...authHeader(who.token))
        .send({ drawnSignature: realPngDataUrl() })
        .expect(200);
    }

    // An administrator renames stage 2 (ADR-011 — routes are configuration).
    await adminPool.query(
      `UPDATE "approval_stage" SET label = 'Verified By (Somebody Else Entirely)'
         WHERE stage_ordinal = 2
           AND approval_route_id = (SELECT id FROM "approval_route" WHERE code = 'TWO_STAGE_TL_THEN_ENG')`,
    );
    try {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}`)
        .set(...authHeader(tl.token))
        .expect(200);
      // The already-archived record still reads as it did when it was signed.
      expect(res.body.approvalSteps[1].stageLabel).toBe('Verified By (Supervisor / Engineer)');
    } finally {
      // approval_stage is seed data — resetDatabase() does not truncate it,
      // so this edit must be undone or it leaks into every later test.
      await adminPool.query(
        `UPDATE "approval_stage" SET label = 'Verified By (Supervisor / Engineer)'
           WHERE stage_ordinal = 2
             AND approval_route_id = (SELECT id FROM "approval_route" WHERE code = 'TWO_STAGE_TL_THEN_ENG')`,
      );
    }
  });

  it('verify is idempotent when the client replays the same Idempotency-Key', async () => {
    const { jobId } = await makeSubmittedJob();
    const tl = await stepUpVerifier('TEAM_LEADER', 'tl-idem');
    const key = randomUUID();
    const drawnSignature = realPngDataUrl();

    const first = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature })
      .expect(200);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .set('Idempotency-Key', key)
      .send({ drawnSignature })
      .expect(200);

    expect(second.body).toEqual(first.body);

    const stepCount = await adminPool.query(
      'SELECT count(*) FROM "approval_step" WHERE job_id = $1',
      [jobId],
    );
    expect(Number(stepCount.rows[0].count)).toBe(1);
  });
});
