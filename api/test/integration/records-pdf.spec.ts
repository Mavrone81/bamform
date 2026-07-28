import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture, createTemplateItem, createUser, grantRole } from './helpers/fixtures';
import { createLoginableUser } from './helpers/auth-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { createTestWorkerApp } from './helpers/worker-app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * Real PDF text extraction (pdf.js under the hood) — a raw byte/substring
 * search does NOT work against a Chromium-rendered PDF: content streams are
 * FlateDecode-compressed AND text is shown via embedded-font glyph indices
 * (a ToUnicode CMap resolves them back to characters), not literal ASCII
 * bytes (verified empirically — see slice-12-report.md).
 *
 * `pdf-parse`'s underlying `pdfjs-dist` "legacy" build falls back to a
 * dynamic `import()` for its fake/no-worker path in Node, which Jest's
 * default CommonJS VM refuses ("A dynamic import callback was invoked
 * without --experimental-vm-modules") — `api/package.json`'s
 * `test:integration` script sets `NODE_OPTIONS=--experimental-vm-modules`
 * for exactly this reason; running this file directly with plain `jest`
 * (bypassing that npm script) will fail these two assertions with that
 * error, not a false negative about the render pipeline itself.
 */
async function extractPdfText(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: pdf });
  const result = await parser.getText();
  return result.text;
}

/**
 * E-11 (docs/TEST_PLAN.md) — PR-116/117/118, UR-056/057. Real two-process
 * topology: `app` (api, enqueues + awaits) and `workerApp` (the real
 * `WorkerModule` — `PdfWorkerService`'s BullMQ `Worker` actually launches
 * Chromium here, PR-117). If Chromium genuinely cannot launch in this
 * environment, these tests FAIL LOUDLY (timeout/launch error) rather than
 * being silently skipped — per slice-12-brief.md's instruction not to fake
 * a pass.
 */
describe('GET /records/{recordId}/pdf (E-11, PR-116/117/118)', () => {
  let app: INestApplication;
  let workerApp: INestApplicationContext;

  beforeAll(async () => {
    app = await createTestApp();
    workerApp = await createTestWorkerApp();
  }, 60_000);

  afterAll(async () => {
    await workerApp.close();
    await app.close();
    await closeAll();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  async function makeArchivedRecord() {
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const { jobId } = await createJobFixture(`PM-PDF-${randomUUID()}`, 'submitted', {
      assignedTo: maintainerId,
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });

    // `createLoginableUser` (not the plain `createUser`) — these two are
    // verifiers whose NAME `pdf-record-assembly.service.ts` decrypts and
    // embeds in the signature block (UR-057); `createUser`'s placeholder
    // `full_name_ct` bytes are not real AES-GCM ciphertext and would fail
    // to decrypt (that fixture predates field encryption — see its header).
    const { userId: tlId } = await createLoginableUser({
      email: `tl-${randomUUID()}@example.test`,
      password: 'correct horse battery staple 1',
      fullName: 'Terri Leader',
      roleCodes: ['TEAM_LEADER'],
    });
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      tlId,
    ]);
    const tlToken = await mintAccessToken(app, tlId, ['TEAM_LEADER']);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const { userId: engId } = await createLoginableUser({
      email: `eng-${randomUUID()}@example.test`,
      password: 'correct horse battery staple 2',
      fullName: 'Eugene Engineer',
      roleCodes: ['ENGINEER'],
    });
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      engId,
    ]);
    const engToken = await mintAccessToken(app, engId, ['ENGINEER']);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    return { jobId, maintainerId, tlId, engId };
  }

  /**
   * Slice 18-WORKFLOW review, finding X-3. `makeArchivedRecord` above seeds
   * the job straight to `submitted` status, so every other test in this file
   * renders a record with NO stage-0 performer step — which is exactly why
   * the PDF printing "Stage 0 — SUBMITTED" went unnoticed. This builds the
   * record through the REAL submit path so the performer's signature block
   * is actually on the page.
   */
  async function makeArchivedRecordViaRealSubmit() {
    const { userId: performerId } = await createLoginableUser({
      email: `perf-${randomUUID()}@example.test`,
      password: 'correct horse battery staple 0',
      fullName: 'Pat Performer',
      roleCodes: ['MAINTAINER'],
    });
    const { jobId, revisionId } = await createJobFixture(
      `PM-PDF-REAL-${randomUUID()}`,
      'in_progress',
      {
        assignedTo: performerId,
      },
    );
    const templateItemId = await createTemplateItem(revisionId, 'M1', { itemNo: 1 });
    const performerToken = await mintAccessToken(app, performerId, ['MAINTAINER']);

    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
      .set(...authHeader(performerToken))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(performerToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    for (const [role, name, pw] of [
      ['TEAM_LEADER', 'Terri Leader', 'correct horse battery staple 1'],
      ['ENGINEER', 'Eugene Engineer', 'correct horse battery staple 2'],
    ] as const) {
      const { userId } = await createLoginableUser({
        email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
        password: pw,
        fullName: name,
        roleCodes: [role],
      });
      await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
        userId,
      ]);
      const token = await mintAccessToken(app, userId, [role]);
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/verify`)
        .set(...authHeader(token))
        .send({ drawnSignature: realPngDataUrl() })
        .expect(200);
    }

    return { jobId, performerId, performerToken };
  }

  it('X-3: the controlled record captions the performer block "Maintenance Performed By", never "Stage 0"', async () => {
    const { jobId, performerToken } = await makeArchivedRecordViaRealSubmit();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(performerToken))
      .expect(200);
    const text = await extractPdfText(Buffer.from(res.body as Buffer));

    expect(text).toContain('Maintenance Performed By');
    expect(text).toContain('Pat Performer');
    // The defect this test exists for.
    expect(text).not.toContain('Stage 0');
    // The verifier blocks read as the paper form does too.
    expect(text).toContain('Verified By (Workshop Team Leader)');
    expect(text).toContain('Verified By (Engineer)');
    expect(text).not.toContain('Stage 1 — VERIFIED');
  }, 60_000);

  it('X-3: a SUBMITTED-but-unverified record (newly PDF-renderable since slice 18) reads correctly on its own', async () => {
    const { userId: performerId } = await createLoginableUser({
      email: `perf-solo-${randomUUID()}@example.test`,
      password: 'correct horse battery staple 3',
      fullName: 'Sam Solo',
      roleCodes: ['MAINTAINER'],
    });
    const { jobId, revisionId } = await createJobFixture(
      `PM-PDF-SOLO-${randomUUID()}`,
      'in_progress',
      {
        assignedTo: performerId,
      },
    );
    const templateItemId = await createTemplateItem(revisionId, 'M1', { itemNo: 1 });
    const token = await mintAccessToken(app, performerId, ['MAINTAINER']);
    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(200);
    const text = await extractPdfText(Buffer.from(res.body as Buffer));
    expect(text).toContain('Maintenance Performed By');
    expect(text).toContain('Sam Solo');
    expect(text).not.toContain('Stage 0');
  }, 60_000);

  it('renders a real PDF (magic bytes %PDF-) for an archived record', async () => {
    const { jobId, maintainerId } = await makeArchivedRecord();
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(200);

    expect(res.headers['content-type']).toContain('application/pdf');
    const bytes = res.body as Buffer;
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 30_000);

  it('the footer digest matches GET /records/{recordId}/integrity for the SAME record (PR-118 — reused, not invented)', async () => {
    const { jobId, maintainerId } = await makeArchivedRecord();
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    const stepRow = await adminPool.query(
      `SELECT encode(content_hash, 'hex') AS hex FROM "approval_step" WHERE job_id = $1 ORDER BY acted_at DESC LIMIT 1`,
      [jobId],
    );
    const expectedDigestHex: string = stepRow.rows[0].hex;

    const integrityRes = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(token))
      .expect(200);
    expect(integrityRes.body.intact).toBe(true);

    const pdfRes = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(200);

    const pdfText = await extractPdfText(Buffer.from(pdfRes.body as Buffer));
    expect(pdfText).toContain(expectedDigestHex);
    expect(pdfText).toContain(jobId);
  }, 30_000);

  it('tampering the record (post-archive) changes the digest embedded in a freshly rendered PDF footer', async () => {
    const { jobId, maintainerId } = await makeArchivedRecord();
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    const beforeRes = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(200);
    const beforeText = await extractPdfText(Buffer.from(beforeRes.body as Buffer));

    // Directly tamper the stored content_hash (S-10 attack shape) — a NEW
    // render must reflect the (now-tampered) stored value, since PR-118
    // reuses the approval_step row verbatim rather than recomputing a fresh
    // "correct" hash.
    await adminPool.query(
      `UPDATE "approval_step" SET content_hash = digest('tampered-for-pdf-footer-test', 'sha256') WHERE job_id = $1`,
      [jobId],
    );
    const tamperedHex = createHash('sha256').update('tampered-for-pdf-footer-test').digest('hex');

    const afterRes = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(200);
    const afterText = await extractPdfText(Buffer.from(afterRes.body as Buffer));

    expect(afterText).toContain(tamperedHex);
    expect(afterText).not.toContain(beforeText.match(/[0-9a-f]{64}/)?.[0] ?? '__no_match__');
  }, 30_000);

  it('I-VOID-11 (slice 17): a voided-archived record renders the VOID marking — reason, voider name and the footer void line — over the untouched content', async () => {
    const { jobId, maintainerId } = await makeArchivedRecord();

    const { userId: adminId } = await createLoginableUser({
      email: `admin-${randomUUID()}@example.test`,
      password: 'correct horse battery staple 3',
      fullName: 'Ada Admin',
      roleCodes: ['ADMIN'],
    });
    const adminToken = await mintAccessToken(app, adminId, ['ADMIN']);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(adminToken))
      .send({ reason: 'Raised against the wrong machine entirely' })
      .expect(200);

    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const pdfText = await extractPdfText(Buffer.from(res.body as Buffer));
    expect(pdfText).toContain('RECORD VOID');
    expect(pdfText).toContain('Raised against the wrong machine entirely');
    expect(pdfText).toContain('Ada Admin');
    expect(pdfText).toContain('VOIDED');
    // The untouched record content still renders (integrity digest of the
    // most recent step — the void step — and the record id).
    const stepRow = await adminPool.query(
      `SELECT encode(content_hash, 'hex') AS hex FROM "approval_step" WHERE job_id = $1 ORDER BY acted_at DESC LIMIT 1`,
      [jobId],
    );
    expect(pdfText).toContain(stepRow.rows[0].hex);
    expect(pdfText).toContain(jobId);
  }, 30_000);

  it('404s for a record that does not exist', async () => {
    const someone = await createUser('reader');
    await grantRole(someone, 'ADMIN');
    const token = await mintAccessToken(app, someone, ['ADMIN']);

    await request(app.getHttpServer())
      .get(`/api/v1/records/${randomUUID()}/pdf`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('409s (pdf-not-yet-available) for a job that has never been through approval', async () => {
    const { jobId } = await createJobFixture(`PM-PDF-NOAPPROVAL-${randomUUID()}`, 'in_progress');
    const someone = await createUser('reader-2');
    await grantRole(someone, 'ADMIN');
    const token = await mintAccessToken(app, someone, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(409);
    expect(res.body.type).toBe('/errors/pdf-not-yet-available');
  });

  it('403s (out-of-scope) for a MAINTAINER who is not the assignee (S-19-style IDOR check)', async () => {
    const { jobId } = await makeArchivedRecord();
    const otherMaintainer = await createUser('other-maintainer');
    await grantRole(otherMaintainer, 'MAINTAINER');
    const token = await mintAccessToken(app, otherMaintainer, ['MAINTAINER']);

    await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/pdf`)
      .set(...authHeader(token))
      .expect(403);
  });
});
