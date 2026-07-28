import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { RECORD_SIGNING_SERVICE } from '../../src/crypto/crypto.tokens';
import type { RecordSigningService } from '../../src/crypto/record-signer';
import { NotificationQueueService } from '../../src/notifications/notification-queue.service';
import { SchedulerService } from '../../src/scheduling/scheduler.service';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createJobFixture,
  createTemplateItem,
  createTemplateMeasurement,
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
 * Slice 17-VOID (I-VOID-01..10, docs/TEST_PLAN.md §6.1) — the owner's
 * 2026-07-27 decision: "If wrong machine, void the form. Void is also
 * possible after the full process is completed."
 *
 * The single most important assertion in this file is I-VOID-02: voiding an
 * ARCHIVED record leaves every byte of the double-signed record content —
 * results, approval steps, stored content hashes, Ed25519 signatures —
 * IDENTICAL, and the stored signatures still verify afterwards. Void is an
 * annotation about the record, never an edit of it.
 */
describe('POST /jobs/{id}/void from ARCHIVED — annotation, immutability, schedule recompute (slice 17)', () => {
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

  // ---------------------------------------------------------------- helpers

  async function makeUsers() {
    const tlId = await createUser('tl');
    await grantRole(tlId, 'TEAM_LEADER');
    const engId = await createUser('eng');
    await grantRole(engId, 'ENGINEER');
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const adminId = await createUser('admin');
    await grantRole(adminId, 'ADMIN');
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = ANY($1::uuid[])`,
      [[tlId, engId]],
    );
    return {
      tlId,
      engId,
      maintainerId,
      adminId,
      tlToken: await mintAccessToken(app, tlId, ['TEAM_LEADER']),
      engToken: await mintAccessToken(app, engId, ['ENGINEER']),
      maintainerToken: await mintAccessToken(app, maintainerId, ['MAINTAINER']),
      adminToken: await mintAccessToken(app, adminId, ['ADMIN']),
    };
  }

  /** A SUBMITTED fixture job driven through both verify stages to ARCHIVED via real HTTP. */
  async function makeArchivedJob(users: Awaited<ReturnType<typeof makeUsers>>) {
    const { jobId, assetId } = await createJobFixture(`PM-VOID17-${randomUUID()}`, 'submitted', {
      assignedTo: users.maintainerId,
      submittedBy: users.maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    const server = app.getHttpServer();
    await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    const final = await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(final.body.status).toBe('ARCHIVED');
    return { jobId, assetId };
  }

  /** Asset with an active M1 schedule (bootstrapped by the scheduler's first tick). */
  async function makeSchedulableAsset(frequencies: Array<'M1' | 'M3' | 'M6' | 'Y'> = ['M1']) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
      {
        leadTimeDays: 90,
      },
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const itemIds: string[] = [];
    for (const frequency of frequencies) {
      itemIds.push(await createTemplateItem(revisionId, frequency));
    }
    return { assetId, revisionId, itemIds };
  }

  /** Drives one generated job through assign → record → submit → 2-stage verify via real HTTP. */
  async function completeJob(
    jobId: string,
    itemIds: string[],
    users: Awaited<ReturnType<typeof makeUsers>>,
  ) {
    const server = app.getHttpServer();
    await request(server)
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(users.tlToken))
      .send({ assigneeId: users.maintainerId })
      .expect(200);
    for (const templateItemId of itemIds) {
      await request(server)
        .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
        .set(...authHeader(users.maintainerToken))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'DONE' })
        .expect(200);
    }
    await request(server)
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(users.maintainerToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    const final = await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(final.body.status).toBe('ARCHIVED');
  }

  /**
   * A record whose EVERY child table is populated — items, a measurement, a
   * part and an attachment — driven through capture and both verify stages
   * so the byte-identity proof in I-VOID-02 compares real content, not empty
   * sets (review V-2). Items/measurement/part go through the real HTTP
   * capture endpoints; the attachment row is inserted directly (`received`,
   * with a real sha256) — the claim under test is that void changes no child
   * byte, not the upload flow, and the row is signed into the canonical
   * record at verify time like any other.
   */
  async function makeContentBearingArchivedJob(users: Awaited<ReturnType<typeof makeUsers>>) {
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
    const itemIds = [
      await createTemplateItem(revisionId, 'M1'),
      await createTemplateItem(revisionId, 'M1'),
    ];
    const measurementId = await createTemplateMeasurement(revisionId, {
      lowerLimit: 10,
      upperLimit: 30,
    });
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-VOID17C-${randomUUID()}`,
      status: 'assigned',
      assignedTo: users.maintainerId,
    });

    const server = app.getHttpServer();
    await request(server)
      .put(`/api/v1/jobs/${jobId}/items/${itemIds[0]}`)
      .set(...authHeader(users.maintainerToken))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE', remark: 'belts within tolerance' })
      .expect(200);
    await request(server)
      .put(`/api/v1/jobs/${jobId}/items/${itemIds[1]}`)
      .set(...authHeader(users.maintainerToken))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'NOT_APPLICABLE', remark: 'guard removed on this variant' })
      .expect(200);
    await request(server)
      .put(`/api/v1/jobs/${jobId}/measurements/${measurementId}`)
      .set(...authHeader(users.maintainerToken))
      .set('Idempotency-Key', randomUUID())
      .send({ readingNumeric: 24.75 })
      .expect(200);
    await request(server)
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set(...authHeader(users.maintainerToken))
      .set('Idempotency-Key', randomUUID())
      .send({ partNo: 'GRS-100', description: 'Grease cartridge', quantity: 2 })
      .expect(201);
    await adminPool.query(
      `INSERT INTO "attachment"
         ("job_id", "object_key", "original_filename", "content_type", "byte_size",
          "sha256", "uploaded_by", "uploaded_at", "upload_state")
       VALUES ($1, $2, 'evidence.png', 'image/png', 2048, digest($3, 'sha256'), $4, now(), 'received')`,
      [jobId, `attachments/${jobId}/${randomUUID()}`, randomUUID(), users.maintainerId],
    );

    await request(server)
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(users.maintainerToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    const final = await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(final.body.status).toBe('ARCHIVED');
    return { jobId, assetId };
  }

  /**
   * The record CONTENT of a job + children + approval steps — every column of
   * every table named, via `to_jsonb` whole-row capture (review V-2: a
   * hand-kept column list can silently drift as columns are added; whole-row
   * jsonb cannot). Only the job row subtracts the four annotation columns +
   * `updated_at`; approval steps and children are compared in FULL, including
   * `drawn_signature_ct`/`drawn_signature_dek_version`, `source_ip`,
   * `step_up_verified_at` and timestamps.
   */
  async function snapshotRecordContent(jobId: string) {
    const job = await adminPool.query(
      `SELECT to_jsonb(j) - 'status' - 'void_reason' - 'voided_by' - 'voided_at' - 'updated_at' AS content
       FROM "job" j WHERE id = $1`,
      [jobId],
    );
    const steps = await adminPool.query(
      `SELECT to_jsonb(s) AS row,
              encode(content_hash, 'hex') AS content_hash_hex,
              encode(signature, 'hex') AS signature_hex
       FROM "approval_step" s WHERE job_id = $1 ORDER BY id`,
      [jobId],
    );
    const children: Record<string, unknown[]> = {};
    for (const table of ['item_result', 'measurement_result', 'part_used', 'attachment']) {
      const rows = await adminPool.query(
        `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE job_id = $1 ORDER BY id`,
        [jobId],
      );
      children[table] = rows.rows.map((r) => r.row);
    }
    return {
      job: job.rows[0].content,
      steps: steps.rows as Array<{
        row: Record<string, unknown>;
        content_hash_hex: string;
        signature_hex: string;
      }>,
      children,
    };
  }

  /** Sum the compliance report's per-area rows into one comparable total. */
  function complianceTotals(rows: Array<Record<string, number>>) {
    return rows.reduce(
      (acc, row) => ({
        due: acc.due + row.dueCount,
        onTime: acc.onTime + row.completedOnTimeCount,
        late: acc.late + row.completedLateCount,
        notCompleted: acc.notCompleted + row.notCompletedCount,
      }),
      { due: 0, onTime: 0, late: 0, notCompleted: 0 },
    );
  }

  // ------------------------------------------------------------------ tests

  it('I-VOID-01: ADMIN voids an ARCHIVED job — annotation persisted, signed approval step appended, audited in-txn, idempotency replays', async () => {
    const users = await makeUsers();
    const { jobId } = await makeArchivedJob(users);
    const idempotencyKey = randomUUID();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(users.adminToken))
      .set('Idempotency-Key', idempotencyKey)
      .send({ reason: 'Raised against the wrong machine — decision 2026-07-27' })
      .expect(200);
    expect(res.body.status).toBe('VOIDED');
    expect(res.body.voidReason).toBe('Raised against the wrong machine — decision 2026-07-27');
    expect(res.body.voidedAt).toEqual(expect.any(String));

    const jobRow = await adminPool.query(
      `SELECT status, void_reason, voided_by, voided_at, archived_at FROM "job" WHERE id = $1`,
      [jobId],
    );
    expect(jobRow.rows[0]).toMatchObject({
      status: 'voided',
      void_reason: 'Raised against the wrong machine — decision 2026-07-27',
      voided_by: users.adminId,
    });
    expect(jobRow.rows[0].voided_at).not.toBeNull();
    // The archive timestamps are part of the untouched record — NOT cleared.
    expect(jobRow.rows[0].archived_at).not.toBeNull();

    const voidStep = await adminPool.query(
      `SELECT actor_id, reason, content_hash, signature, signing_key_id FROM "approval_step"
       WHERE job_id = $1 AND action = 'voided'`,
      [jobId],
    );
    expect(voidStep.rowCount).toBe(1);
    expect(voidStep.rows[0].actor_id).toBe(users.adminId);
    expect(voidStep.rows[0].content_hash).not.toBeNull();
    expect(voidStep.rows[0].signature).not.toBeNull();

    const audit = await adminPool.query(
      `SELECT before, after FROM "audit_event"
       WHERE entity_type = 'job' AND entity_id = $1 AND action = 'state_change'`,
      [jobId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].before).toMatchObject({ status: 'ARCHIVED' });
    expect(audit.rows[0].after).toMatchObject({ status: 'VOIDED', postArchive: true });

    // Idempotent replay: same key, same body — no second step, no second audit.
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(users.adminToken))
      .set('Idempotency-Key', idempotencyKey)
      .send({ reason: 'Raised against the wrong machine — decision 2026-07-27' })
      .expect(200);
    expect(replay.body.status).toBe('VOIDED');
    const stepsAfter = await adminPool.query(
      `SELECT count(*)::int AS n FROM "approval_step" WHERE job_id = $1 AND action = 'voided'`,
      [jobId],
    );
    expect(stepsAfter.rows[0].n).toBe(1);
  });

  it('I-VOID-02 (the heart of the slice): voiding an archived record changes NO byte of the signed content, and every stored Ed25519 signature STILL VERIFIES', async () => {
    const users = await makeUsers();
    // V-2: a CONTENT-BEARING record — the byte-identity claims below must be
    // earned against real rows, not empty sets.
    const { jobId } = await makeContentBearingArchivedJob(users);
    const signer = app.get<RecordSigningService>(RECORD_SIGNING_SERVICE);

    const before = await snapshotRecordContent(jobId);
    // Fixture sanity (V-2): every table this test claims to compare is
    // actually populated — this test can never silently regress to comparing
    // empty sets.
    expect(before.children.item_result.length).toBe(2);
    expect(before.children.measurement_result.length).toBe(1);
    expect(before.children.part_used.length).toBe(1);
    expect(before.children.attachment.length).toBe(1);
    // Three signatures since slice 18-WORKFLOW: the PERFORMER's stage-0
    // `submitted` step plus the two verification stages. (Before that slice
    // submit created no approval_step at all.)
    expect(before.steps.length).toBe(3);
    // All three carry an encrypted drawn signature — the snapshot's
    // whole-row jsonb therefore includes drawn_signature_ct in the comparison.
    const drawnBefore = before.steps.filter((s) => s.row.drawn_signature_ct != null);
    expect(drawnBefore.length).toBe(3);

    // Sanity: the freshly archived record's signatures verify BEFORE void.
    for (const step of before.steps) {
      expect(
        signer.verify(
          Buffer.from(step.content_hash_hex, 'hex'),
          Buffer.from(step.signature_hex, 'hex'),
        ),
      ).toBe(true);
    }

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(users.adminToken))
      .send({ reason: 'Wrong asset — PM belongs to the sibling machine' })
      .expect(200);

    const after = await snapshotRecordContent(jobId);

    // 1. The job row's record content (everything but the annotation columns)
    //    is IDENTICAL.
    expect(after.job).toEqual(before.job);
    // 2. Every child record row is byte-identical — EVERY column, whole-row
    //    jsonb (item results incl. remarks, the measurement reading, the
    //    part, the attachment sha256).
    expect(after.children).toEqual(before.children);
    // 3. Every pre-void approval step is byte-identical across ALL columns —
    //    including drawn_signature_ct/drawn_signature_dek_version, actor,
    //    role, source_ip, step_up_verified_at, timestamps, content_hash and
    //    signature; exactly ONE new step (the void) was appended.
    expect(after.steps.length).toBe(before.steps.length + 1);
    const preVoidStepsAfter = after.steps.filter((s) => s.row.action !== 'voided');
    expect(preVoidStepsAfter).toEqual(before.steps);
    // 4. THE test: the stored signatures (including both verification
    //    signatures) still verify against their stored content hashes.
    for (const step of after.steps) {
      expect(
        signer.verify(
          Buffer.from(step.content_hash_hex, 'hex'),
          Buffer.from(step.signature_hex, 'hex'),
        ),
      ).toBe(true);
    }

    // 5. The integrity endpoint tells the truth: signatures valid AND the
    //    record is declared void.
    const integrity = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(users.adminToken))
      .expect(200);
    expect(integrity.body.intact).toBe(true);
    expect(integrity.body.voided).toBe(true);
    expect(integrity.body.voidReason).toBe('Wrong asset — PM belongs to the sibling machine');
    expect(integrity.body.voidedAt).toEqual(expect.any(String));
    expect(integrity.body.signatures.length).toBe(after.steps.length);
    for (const sig of integrity.body.signatures) {
      expect(sig.signatureValid).toBe(true);
      expect(sig.hashMatches).toBe(true);
    }
  });

  it('I-VOID-03: post-archive void is ADMIN-only — TEAM_LEADER and ENGINEER get 403 and the record is untouched', async () => {
    const users = await makeUsers();
    const { jobId } = await makeArchivedJob(users);

    for (const token of [users.tlToken, users.engToken]) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/void`)
        .set(...authHeader(token))
        .send({ reason: 'attempting a post-archive void without ADMIN' })
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/forbidden' });
    }

    const jobRow = await adminPool.query(`SELECT status FROM "job" WHERE id = $1`, [jobId]);
    expect(jobRow.rows[0].status).toBe('archived');
  });

  it('I-VOID-04: a voided-archived job accepts NO further mutation — every write endpoint rejects, and the DB trigger backstops direct UPDATEs', async () => {
    const users = await makeUsers();
    const { jobId } = await makeArchivedJob(users);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(users.adminToken))
      .send({ reason: 'Voided after archive for the immutability test' })
      .expect(200);

    const server = app.getHttpServer();
    const itemRow = await adminPool.query(
      `SELECT template_item_id FROM "item_result" WHERE job_id = $1 LIMIT 1`,
      [jobId],
    );
    // The fixture job has no item results; use a random template item id —
    // the status gate must reject before any per-item existence concern.
    const templateItemId = (itemRow.rows[0]?.template_item_id as string) ?? randomUUID();

    const attempts: Array<{ name: string; run: () => request.Test }> = [
      {
        name: 'item result',
        run: () =>
          request(server)
            .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
            .set(...authHeader(users.maintainerToken))
            .set('Idempotency-Key', randomUUID())
            .send({ status: 'DONE' }),
      },
      {
        name: 'part',
        run: () =>
          request(server)
            .post(`/api/v1/jobs/${jobId}/parts`)
            .set(...authHeader(users.maintainerToken))
            .set('Idempotency-Key', randomUUID())
            .send({ description: 'sneaky part', quantity: 1 }),
      },
      {
        name: 'submit',
        run: () =>
          request(server)
            .post(`/api/v1/jobs/${jobId}/submit`)
            .set(...authHeader(users.maintainerToken))
            .send({ drawnSignature: realPngDataUrl() }),
      },
      {
        name: 'assign',
        run: () =>
          request(server)
            .post(`/api/v1/jobs/${jobId}/assign`)
            .set(...authHeader(users.tlToken))
            .send({ assigneeId: users.maintainerId }),
      },
      {
        name: 'verify',
        run: () =>
          request(server)
            .post(`/api/v1/jobs/${jobId}/verify`)
            .set(...authHeader(users.tlToken))
            .send({ drawnSignature: realPngDataUrl() }),
      },
      {
        name: 'return',
        run: () =>
          request(server)
            .post(`/api/v1/jobs/${jobId}/return`)
            .set(...authHeader(users.tlToken))
            .send({ reason: 'attempting return of a voided record' }),
      },
      {
        name: 'recall',
        run: () =>
          request(server)
            .post(`/api/v1/jobs/${jobId}/recall`)
            .set(...authHeader(users.maintainerToken)),
      },
      {
        name: 're-void',
        run: () =>
          request(server)
            .post(`/api/v1/jobs/${jobId}/void`)
            .set(...authHeader(users.adminToken))
            .send({ reason: 'attempting to void a voided record twice' }),
      },
    ];
    for (const attempt of attempts) {
      const res = await attempt.run();
      // Every write path must refuse: 409 invalid-transition.
      expect({ name: attempt.name, status: res.status }).toEqual({
        name: attempt.name,
        status: 409,
      });
    }

    // DB backstop (SYS-18 closed): even a direct UPDATE on the voided row raises.
    await expect(
      adminPool.query(`UPDATE "job" SET due_on = CURRENT_DATE + 1 WHERE id = $1`, [jobId]),
    ).rejects.toThrow(/voided and immutable/i);
    await expect(
      adminPool.query(`UPDATE "job" SET status = 'archived' WHERE id = $1`, [jobId]),
    ).rejects.toThrow(/voided and immutable/i);
  });

  it('I-VOID-05: the DB trigger permits ONLY the pure annotation — an archived->voided UPDATE that also alters content, or omits the annotation fields, raises', async () => {
    const users = await makeUsers();
    const { jobId } = await makeArchivedJob(users);

    // Annotation transition that ALSO edits record content — rejected.
    await expect(
      adminPool.query(
        `UPDATE "job" SET status = 'voided', void_reason = 'looks like a legit void', voided_by = $2, voided_at = now(), due_on = CURRENT_DATE + 30
         WHERE id = $1`,
        [jobId, users.adminId],
      ),
    ).rejects.toThrow(/archived and immutable/i);

    // Status flip without the mandatory annotation fields — rejected.
    await expect(
      adminPool.query(
        `UPDATE "job" SET status = 'voided', void_reason = 'missing actor + timestamp' WHERE id = $1`,
        [jobId],
      ),
    ).rejects.toThrow(/archived and immutable/i);

    // Any other archived UPDATE still raises exactly as before (I-INV-07).
    await expect(
      adminPool.query(`UPDATE "job" SET due_on = CURRENT_DATE + 1 WHERE id = $1`, [jobId]),
    ).rejects.toThrow(/archived and immutable/i);

    const jobRow = await adminPool.query(`SELECT status FROM "job" WHERE id = $1`, [jobId]);
    expect(jobRow.rows[0].status).toBe('archived');
  });

  it('I-VOID-06: the archive still SURFACES a voided record — search finds it (filterable), the record read works — while reports exclude it', async () => {
    const users = await makeUsers();
    const { jobId, assetId } = await makeArchivedJob(users);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(users.adminToken))
      .send({ reason: 'Voided after archive — auditor-visibility test' })
      .expect(200);

    const server = app.getHttpServer();

    // Default archive search: the voided record is FOUND (an auditor must
    // see voids, not lose them), reported with status VOIDED.
    const all = await request(server)
      .get(`/api/v1/records?assetId=${assetId}`)
      .set(...authHeader(users.adminToken))
      .expect(200);
    expect(all.body.data.map((r: { id: string }) => r.id)).toContain(jobId);
    expect(all.body.data.find((r: { id: string }) => r.id === jobId).status).toBe('VOIDED');

    // voided=true → only voided; voided=false → excludes it.
    const onlyVoided = await request(server)
      .get(`/api/v1/records?assetId=${assetId}&voided=true`)
      .set(...authHeader(users.adminToken))
      .expect(200);
    expect(onlyVoided.body.data.map((r: { id: string }) => r.id)).toEqual([jobId]);
    const excluded = await request(server)
      .get(`/api/v1/records?assetId=${assetId}&voided=false`)
      .set(...authHeader(users.adminToken))
      .expect(200);
    expect(excluded.body.data.map((r: { id: string }) => r.id)).not.toContain(jobId);

    // The single-record read still serves it (with the annotation).
    const record = await request(server)
      .get(`/api/v1/records/${jobId}`)
      .set(...authHeader(users.adminToken))
      .expect(200);
    expect(record.body.status).toBe('VOIDED');
    expect(record.body.voidReason).toBe('Voided after archive — auditor-visibility test');

    // Compliance (V-1): a voided row is EXCLUDED from the aggregation
    // entirely — never "completed", and never a permanent notCompleted
    // either. The owner's rule is "as if that PM never happened": between
    // the void and the next scheduler tick the period is simply absent;
    // once the replacement generates, THAT row represents the period
    // (I-VOID-12 covers the post-replacement half).
    const compliance = await request(server)
      .get(`/api/v1/reports/compliance`)
      .set(...authHeader(users.adminToken))
      .expect(200);
    const totals = complianceTotals(compliance.body.rows);
    expect(totals).toEqual({ due: 0, onTime: 0, late: 0, notCompleted: 0 });
  });

  it('I-VOID-12 (V-1): after the replacement is completed, compliance counts ONE period, completed — the voided row never double-counts it', async () => {
    const { assetId, itemIds } = await makeSchedulableAsset(['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);

    // Cycle: generate → complete → ADMIN voids → tick regenerates the SAME
    // period → complete the replacement.
    await scheduler.run();
    const jobs1 = await adminPool.query(`SELECT id FROM "job" WHERE asset_id = $1`, [assetId]);
    const firstJobId = jobs1.rows[0].id as string;
    await completeJob(firstJobId, itemIds, users);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${firstJobId}/void`)
      .set(...authHeader(users.adminToken))
      .send({ reason: 'Wrong machine — void, then complete the replacement' })
      .expect(200);
    const regen = await scheduler.run();
    expect(regen.ran && regen.generated).toBe(1);
    const jobs2 = await adminPool.query(`SELECT id FROM "job" WHERE asset_id = $1 AND id <> $2`, [
      assetId,
      firstJobId,
    ]);
    const replacementId = jobs2.rows[0].id as string;
    await completeJob(replacementId, itemIds, users);

    // The reviewer's P5 scenario: before the V-1 fix this read
    // due=2, completed=1, notCompleted=1 — a fully-completed period stuck at
    // 50% compliance forever. The truth: ONE period, completed.
    const compliance = await request(app.getHttpServer())
      .get(`/api/v1/reports/compliance`)
      .set(...authHeader(users.adminToken))
      .expect(200);
    const totals = complianceTotals(compliance.body.rows);
    expect(totals.due).toBe(1);
    expect(totals.onTime + totals.late).toBe(1);
    expect(totals.notCompleted).toBe(0);
  });

  it('I-VOID-07 (flagship e2e): complete → schedule advanced → ADMIN voids → next_due_on recomputed to the voided job’s own due date → next tick generates the replacement', async () => {
    const { assetId, itemIds } = await makeSchedulableAsset(['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);

    // Tick 1: bootstrap + first job.
    const first = await scheduler.run();
    expect(first.ran && first.generated).toBe(1);
    const jobs1 = await adminPool.query(`SELECT id, due_on FROM "job" WHERE asset_id = $1`, [
      assetId,
    ]);
    const firstJobId = jobs1.rows[0].id as string;
    const firstDueOn = jobs1.rows[0].due_on as Date;

    await completeJob(firstJobId, itemIds, users);
    const advanced = await adminPool.query(
      `SELECT last_completed_on, next_due_on FROM "schedule_rule" WHERE asset_id = $1 AND frequency = 'M1'`,
      [assetId],
    );
    expect(advanced.rows[0].last_completed_on).not.toBeNull();
    expect((advanced.rows[0].next_due_on as Date).getTime()).toBeGreaterThan(firstDueOn.getTime());

    // ADMIN voids the archived job — the schedule must recompute IN THE SAME
    // TRANSACTION as if that completion never happened. No earlier valid
    // completion exists, so next_due_on reverts to the voided job's own
    // original due date and last_completed_on clears.
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${firstJobId}/void`)
      .set(...authHeader(users.adminToken))
      .send({ reason: 'Wrong machine — the PM never actually happened here' })
      .expect(200);

    const recomputed = await adminPool.query(
      `SELECT last_completed_on, next_due_on FROM "schedule_rule" WHERE asset_id = $1 AND frequency = 'M1'`,
      [assetId],
    );
    expect(recomputed.rows[0].last_completed_on).toBeNull();
    expect((recomputed.rows[0].next_due_on as Date).toISOString()).toBe(firstDueOn.toISOString());

    // The recompute is audited per rule, mirroring the forward cascade.
    const audit = await adminPool.query(
      `SELECT after FROM "audit_event"
       WHERE entity_type = 'schedule_rule' AND entity_id = $1 AND action = 'update'
       ORDER BY sequence DESC LIMIT 1`,
      [assetId],
    );
    expect(audit.rows[0].after).toMatchObject({
      frequency: 'M1',
      causedByJobId: firstJobId,
      cause: 'post_archive_void_recompute',
    });

    // THE assertion this slice exists for: the next tick generates the
    // replacement job for the SAME period — the voided row no longer
    // occupies (asset_id, frequency_scope, due_on).
    const next = await scheduler.run();
    expect(next.ran && next.generated).toBe(1);
    const jobs2 = await adminPool.query(
      `SELECT id, due_on, status FROM "job" WHERE asset_id = $1 ORDER BY generated_at`,
      [assetId],
    );
    expect(jobs2.rowCount).toBe(2);
    const replacement = jobs2.rows.find((r) => r.id !== firstJobId)!;
    expect(replacement.status).toBe('scheduled');
    expect((replacement.due_on as Date).toISOString()).toBe(firstDueOn.toISOString());
  });

  it('I-VOID-08: recompute derives from the most recent STILL-VALID completion when one exists', async () => {
    const { assetId, itemIds } = await makeSchedulableAsset(['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);

    // Cycle 1: generate + complete.
    await scheduler.run();
    const jobs1 = await adminPool.query(`SELECT id FROM "job" WHERE asset_id = $1`, [assetId]);
    const firstJobId = jobs1.rows[0].id as string;
    await completeJob(firstJobId, itemIds, users);
    const afterFirst = await adminPool.query(
      `SELECT last_completed_on, next_due_on FROM "schedule_rule" WHERE asset_id = $1 AND frequency = 'M1'`,
      [assetId],
    );
    const firstCompletionOn = afterFirst.rows[0].last_completed_on as Date;
    const nextDueAfterFirst = afterFirst.rows[0].next_due_on as Date;

    // Cycle 2: generate + complete the successor.
    await scheduler.run();
    const jobs2 = await adminPool.query(`SELECT id FROM "job" WHERE asset_id = $1 AND id <> $2`, [
      assetId,
      firstJobId,
    ]);
    const secondJobId = jobs2.rows[0].id as string;
    await completeJob(secondJobId, itemIds, users);

    // Void the SECOND completion — the schedule must fall back to the FIRST
    // (still-valid) completion: identical last_completed_on/next_due_on to
    // the state right after cycle 1.
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${secondJobId}/void`)
      .set(...authHeader(users.adminToken))
      .send({ reason: 'Second cycle voided — recompute falls back to cycle 1' })
      .expect(200);

    const recomputed = await adminPool.query(
      `SELECT last_completed_on, next_due_on FROM "schedule_rule" WHERE asset_id = $1 AND frequency = 'M1'`,
      [assetId],
    );
    expect((recomputed.rows[0].last_completed_on as Date).toISOString()).toBe(
      firstCompletionOn.toISOString(),
    );
    expect((recomputed.rows[0].next_due_on as Date).toISOString()).toBe(
      nextDueAfterFirst.toISOString(),
    );
  });

  it('I-VOID-09: a PRE-archive void no longer blocks its period either — the next tick regenerates the job (owner decision 1)', async () => {
    const { assetId } = await makeSchedulableAsset(['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);

    await scheduler.run();
    const jobs1 = await adminPool.query(`SELECT id, due_on FROM "job" WHERE asset_id = $1`, [
      assetId,
    ]);
    const firstJobId = jobs1.rows[0].id as string;
    const dueOn = jobs1.rows[0].due_on as Date;

    // TEAM_LEADER voids the freshly generated (SCHEDULED) job — existing
    // pre-archive role set, unchanged by this slice.
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${firstJobId}/void`)
      .set(...authHeader(users.tlToken))
      .send({ reason: 'Generated for the wrong machine entirely' })
      .expect(200);

    // Before slice 17 this tick reported "exists" forever (SYS-19). Now the
    // voided row no longer occupies the period.
    const next = await scheduler.run();
    expect(next.ran && next.generated).toBe(1);
    const jobs2 = await adminPool.query(
      `SELECT id, due_on, status FROM "job" WHERE asset_id = $1 AND id <> $2`,
      [assetId, firstJobId],
    );
    expect(jobs2.rowCount).toBe(1);
    expect(jobs2.rows[0].status).toBe('scheduled');
    expect((jobs2.rows[0].due_on as Date).toISOString()).toBe(dueOn.toISOString());
  });

  it('I-VOID-10: escalation timers — none exist for an archived job, and the post-archive void leaves none behind (proved no-op, slice-11a interaction)', async () => {
    const users = await makeUsers();
    const { jobId } = await makeArchivedJob(users);
    const queue = app.get(NotificationQueueService);

    // Final verify already cancelled the timers — prove none exist at archive.
    expect(await queue.getEscalationJob(jobId, 1)).toBeFalsy();
    expect(await queue.getEscalationJob(jobId, 2)).toBeFalsy();

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(users.adminToken))
      .send({ reason: 'Post-archive void with no timers to cancel' })
      .expect(200);

    expect(await queue.getEscalationJob(jobId, 1)).toBeFalsy();
    expect(await queue.getEscalationJob(jobId, 2)).toBeFalsy();
  });
});
