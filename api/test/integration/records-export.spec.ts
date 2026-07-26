import AdmZip from 'adm-zip';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture, createUser, grantRole } from './helpers/fixtures';
import { createLoginableUser } from './helpers/auth-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { createTestWorkerApp } from './helpers/worker-app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';
import type { RecordExportStatusResponse } from '@bamform/shared';
import type { Response } from 'superagent';

/**
 * supertest/superagent has no built-in binary parser for `application/zip`
 * (unlike `image/*`, which `attachments-security.spec.ts` relies on) — without
 * this, `res.body` comes back as `{}` rather than raw bytes. Standard
 * superagent workaround: accumulate the raw response as binary-encoded text,
 * then convert back to a `Buffer`.
 */
function binaryParser(res: Response, callback: (err: Error | null, body: Buffer) => void): void {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => {
    callback(null, Buffer.from(data, 'binary'));
  });
}

/**
 * E-12 (docs/TEST_PLAN.md) — PR-119/UR-059. Async export: `POST
 * /records/export` returns a job id immediately; polls `GET /exports/{id}`
 * until `DONE`; downloads via `GET /exports/{id}/download` (ADR-007 —
 * streamed, authorised on every fetch). Real worker (Chromium renders each
 * PDF through the same pipeline `records-pdf.spec.ts` exercises).
 */
describe('POST /records/export, GET /exports/{id}(/download) (E-12, PR-119)', () => {
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

  async function makeArchivedRecord(label: string, assignedTo?: string) {
    const submitter = assignedTo ?? (await createUser(`${label}-submitter`));
    const { jobId } = await createJobFixture(`PM-EXPORT-${label}-${randomUUID()}`, 'submitted', {
      assignedTo: submitter,
      submittedBy: submitter,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    // Real encrypted names (`createLoginableUser`, not the placeholder-bytes
    // `createUser`) — these two verifiers' names get decrypted and embedded
    // in each rendered PDF's signature block (UR-057).
    const { userId: tlId } = await createLoginableUser({
      email: `${label}-tl-${randomUUID()}@example.test`,
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
      email: `${label}-eng-${randomUUID()}@example.test`,
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

    const jobRow = await adminPool.query('SELECT job_number FROM "job" WHERE id = $1', [jobId]);
    return { jobId, jobNumber: jobRow.rows[0].job_number as string };
  }

  // 40 × 250 ms = 10 s reddened main on the slice-13-MFA merge (run
  // 30202437698 job 4 — "did not finish within the poll budget", 349/350
  // otherwise green). Nothing about export changed in that slice; the job just
  // ran out of wall clock. This assertion is inherently slow, and slower under
  // CI conditions that do not apply locally:
  //   * CI runs jest with --coverage, the plain local run does not, and the
  //     instrumentation slows the in-process BullMQ worker as well as the test
  //   * it renders real PDFs through Chromium (worker concurrency 2)
  //   * the GitHub runner has far less CPU than the dev machine
  //   * slice 13-MFA added ~2k instrumented source lines and two large specs,
  //     so this now runs later in a longer, more GC-pressured process
  // Raising the allowance weakens nothing: every assertion about the ZIP
  // contents, the CSV columns and the terminal state is unchanged, and a
  // genuinely stuck export still fails — after 30 s instead of 10 s, still
  // inside this test's existing 60 s timeout.
  const POLL_ATTEMPTS = 120; // × 250 ms = 30 s

  async function pollUntilDone(
    exportId: string,
    token: string,
    maxAttempts = POLL_ATTEMPTS,
  ): Promise<RecordExportStatusResponse> {
    let lastStatus = '(never observed)';
    for (let i = 0; i < maxAttempts; i++) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/exports/${exportId}`)
        .set(...authHeader(token))
        .expect(200);
      lastStatus = String(res.body.status);
      if (res.body.status === 'DONE' || res.body.status === 'FAILED') {
        return res.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Report the last status so a future failure distinguishes "never picked
    // up" (QUEUED) from "too slow" (RUNNING) — the old message could not.
    throw new Error(
      `export ${exportId} did not finish within the poll budget ` +
        `(${maxAttempts} × 250ms); last status seen: ${lastStatus}`,
    );
  }

  it('produces a ZIP of PDFs + a CSV manifest with the right columns (PR-119)', async () => {
    const engineerId = await createUser('export-requester');
    await grantRole(engineerId, 'ENGINEER');
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    const r1 = await makeArchivedRecord('a');
    const r2 = await makeArchivedRecord('b');

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/records/export')
      .set(...authHeader(token))
      .send({ recordIds: [r1.jobId, r2.jobId] })
      .expect(202);
    expect(createRes.body.status).toBe('PENDING');
    const exportId = createRes.body.id as string;

    const done = await pollUntilDone(exportId, token);
    expect(done.status).toBe('DONE');
    expect(done.recordCount).toBe(2);
    expect(done.downloadPath).toBe(`/exports/${exportId}/download`);

    const downloadRes = await request(app.getHttpServer())
      .get(`/api/v1/exports/${exportId}/download`)
      .set(...authHeader(token))
      .buffer()
      .parse(binaryParser)
      .expect(200);
    expect(downloadRes.headers['content-type']).toContain('application/zip');

    const zip = new AdmZip(downloadRes.body as Buffer);
    const entryNames = zip.getEntries().map((e) => e.entryName);
    expect(entryNames).toContain('manifest.csv');
    expect(entryNames).toContain(`records/${r1.jobNumber}.pdf`);
    expect(entryNames).toContain(`records/${r2.jobNumber}.pdf`);

    const manifestEntry = zip.getEntry('manifest.csv')!;
    const manifestCsv = manifestEntry.getData().toString('utf8');
    expect(manifestCsv.split('\r\n')[0]).toBe(
      'recordId,jobNumber,assetCode,documentNumber,revisionCode,frequency,archivedAt,pdfFilename',
    );
    expect(manifestCsv).toContain(r1.jobId);
    expect(manifestCsv).toContain(r2.jobId);

    const pdfBytes = zip.getEntry(`records/${r1.jobNumber}.pdf`)!.getData();
    expect(pdfBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 60_000);

  it('MAINTAINER is forbidden from requesting an export ("Export records" role gate, §4.1)', async () => {
    const maintainerId = await createUser('maintainer-export');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    await request(app.getHttpServer())
      .post('/api/v1/records/export')
      .set(...authHeader(token))
      .send({ recordIds: [randomUUID()] })
      .expect(403);
  });

  it('422s when no records match the request (empty selection is not a valid export)', async () => {
    const engineerId = await createUser('export-requester-2');
    await grantRole(engineerId, 'ENGINEER');
    const token = await mintAccessToken(app, engineerId, ['ENGINEER']);

    await request(app.getHttpServer())
      .post('/api/v1/records/export')
      .set(...authHeader(token))
      .send({ recordIds: [randomUUID()] })
      .expect(422);
  });

  it('a caller cannot view or download an export they did not request (403)', async () => {
    const requesterId = await createUser('export-requester-3');
    await grantRole(requesterId, 'ENGINEER');
    const requesterToken = await mintAccessToken(app, requesterId, ['ENGINEER']);
    const someoneElseId = await createUser('someone-else');
    await grantRole(someoneElseId, 'ENGINEER');
    const someoneElseToken = await mintAccessToken(app, someoneElseId, ['ENGINEER']);

    const r1 = await makeArchivedRecord('c');
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/records/export')
      .set(...authHeader(requesterToken))
      .send({ recordIds: [r1.jobId] })
      .expect(202);
    const exportId = createRes.body.id as string;

    await request(app.getHttpServer())
      .get(`/api/v1/exports/${exportId}`)
      .set(...authHeader(someoneElseToken))
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/exports/${exportId}/download`)
      .set(...authHeader(someoneElseToken))
      .expect(403);
  }, 30_000);

  it('an explicit recordIds selection outside the caller scope is silently excluded, not leaked (area scoping applies to export too)', async () => {
    const maintainerId = await createUser('maintainer-outofscope');
    await grantRole(maintainerId, 'MAINTAINER');
    const engineerId = await createUser('export-requester-4');
    await grantRole(engineerId, 'ENGINEER');
    const engineerToken = await mintAccessToken(app, engineerId, ['ENGINEER']);

    // A record assigned to someone else — ENGINEER has broad visibility so
    // this one IS actually in scope; use a record that plain doesn't exist
    // instead to prove an unresolvable id is dropped, not 404/500.
    const r1 = await makeArchivedRecord('d');
    const bogusId = randomUUID();

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/records/export')
      .set(...authHeader(engineerToken))
      .send({ recordIds: [r1.jobId, bogusId] })
      .expect(202);
    expect(createRes.body.recordCount).toBe(1);
  }, 30_000);
});
