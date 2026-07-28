import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createDelegation,
  createJobFixture,
  createUser,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * PR-073/076/081/UR-049 — `GET /queue`. Uses the plain `createUser` fixture
 * (unlike `delegations.spec.ts`) because `QueueEntry`/`toJobSummary` never
 * decrypt a name (see `queue.mapper.ts`'s doc comment) — nothing here
 * touches `full_name_ct`/`email_ct`, so the placeholder-bytes fixture is
 * fine.
 */
describe('Queue — GET /queue (PR-073/076/081, UR-049)', () => {
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

  async function submittedJob(opts: { submittedBy?: string; areaId?: string | null } = {}) {
    const maintainerId = opts.submittedBy ?? (await createUser('maintainer'));
    if (!opts.submittedBy) await grantRole(maintainerId, 'MAINTAINER');
    const fixture = await createJobFixture(`PM-QUEUE-${randomUUID()}`, 'submitted', {
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    if (opts.areaId) {
      await adminPool.query('UPDATE "asset" SET area_id = $1 WHERE id = $2', [
        opts.areaId,
        fixture.assetId,
      ]);
    }
    return { ...fixture, submittedBy: maintainerId };
  }

  async function stepUpUser(label: string, roleCodes: string[]) {
    const userId = await createUser(label);
    for (const role of roleCodes) await grantRole(userId, role);
    const token = await mintAccessToken(app, userId, roleCodes);
    return { userId, token };
  }

  it('PR-073: returns a SUBMITTED job to a caller who holds an eligible role for the current stage', async () => {
    const { jobId } = await submittedJob();
    const tl = await stepUpUser('tl-queue', ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(tl.token))
      .expect(200);

    expect(res.body.data.map((e: { id: string }) => e.id)).toContain(jobId);
    const entry = res.body.data.find((e: { id: string }) => e.id === jobId);
    expect(entry.onBehalfOf).toBeNull();
    expect(typeof entry.ageHours).toBe('number');
    expect(typeof entry.escalated).toBe('boolean');
  });

  it("PR-073: excludes the job from the SUBMITTER's own queue (cannot verify own work)", async () => {
    const submitter = await stepUpUser('submitter-tl', ['TEAM_LEADER']);
    const { jobId } = await submittedJob({ submittedBy: submitter.userId });

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(submitter.token))
      .expect(200);

    expect(res.body.data.map((e: { id: string }) => e.id)).not.toContain(jobId);
  });

  it('a non-verifier (MAINTAINER only) gets an empty queue — not an error', async () => {
    await submittedJob();
    const maintainer = await stepUpUser('maint-queue', ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(maintainer.token))
      .expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('PR-API-10 area scoping: a TEAM_LEADER scoped to a DIFFERENT area does not see the job', async () => {
    const areaA = await createArea(`AREA-A-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`AREA-B-${randomUUID().slice(0, 8)}`);
    const { jobId } = await submittedJob({ areaId: areaA });

    const tl = await stepUpUser('tl-scoped', ['TEAM_LEADER']);
    await scopeUserToArea(tl.userId, areaB);

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(tl.token))
      .expect(200);
    expect(res.body.data.map((e: { id: string }) => e.id)).not.toContain(jobId);
  });

  it("PR-076: an active delegator's eligible job appears in the delegate's queue, tagged onBehalfOf", async () => {
    const delegator = await stepUpUser('delegator-queue', ['ENGINEER']);
    const { jobId } = await submittedJob(); // stage 1 = TEAM_LEADER only (two-stage route) — use stage matching ENGINEER instead below
    // Stage 1 of the seeded two-stage route is TEAM_LEADER-only; re-target
    // this job to stage 2 (ENGINEER) so the delegator's ENGINEER role is
    // actually the one under test — advances currentStageOrdinal directly
    // (fixture-level, mirroring approval-delegation.spec.ts's own pattern).
    await adminPool.query('UPDATE "job" SET current_stage_ordinal = 2 WHERE id = $1', [jobId]);

    const admin = await createUser('admin-deleg-queue');
    await createDelegation(
      delegator.userId,
      (await stepUpUser('delegate-queue', ['MAINTAINER'])).userId,
      admin,
      {
        validFrom: new Date(Date.now() - 3600_000),
        validTo: new Date(Date.now() + 3600_000),
      },
    );

    // Re-derive the delegate's token (stepUpUser above created it with MAINTAINER only, no eligible role of their own — the point: they see it ONLY via delegation).
    const delegateRow = await adminPool.query(
      `SELECT delegate_id FROM "delegation" WHERE delegator_id = $1`,
      [delegator.userId],
    );
    const delegateId = delegateRow.rows[0].delegate_id as string;
    const delegateToken = await mintAccessToken(app, delegateId, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(delegateToken))
      .expect(200);

    const entry = res.body.data.find((e: { id: string }) => e.id === jobId);
    expect(entry).toBeDefined();
    expect(entry.onBehalfOf).toBe(delegator.userId);
  });

  it('PR-076: EXCLUDES the delegated job once the delegation is REVOKED (resolved at request time)', async () => {
    const delegator = await stepUpUser('delegator-revoked-q', ['ENGINEER']);
    const { jobId } = await submittedJob();
    await adminPool.query('UPDATE "job" SET current_stage_ordinal = 2 WHERE id = $1', [jobId]);

    const delegate = await stepUpUser('delegate-revoked-q', ['MAINTAINER']);
    const admin = await createUser('admin-deleg-revoked-q');
    await createDelegation(delegator.userId, delegate.userId, admin, {
      validFrom: new Date(Date.now() - 3600_000),
      validTo: new Date(Date.now() + 3600_000),
      revokedAt: new Date(),
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(delegate.token))
      .expect(200);
    expect(res.body.data.map((e: { id: string }) => e.id)).not.toContain(jobId);
  });

  it('PR-076: EXCLUDES the delegated job once the delegation window has EXPIRED', async () => {
    const delegator = await stepUpUser('delegator-expired-q', ['ENGINEER']);
    const { jobId } = await submittedJob();
    await adminPool.query('UPDATE "job" SET current_stage_ordinal = 2 WHERE id = $1', [jobId]);

    const delegate = await stepUpUser('delegate-expired-q', ['MAINTAINER']);
    const admin = await createUser('admin-deleg-expired-q');
    await createDelegation(delegator.userId, delegate.userId, admin, {
      validFrom: new Date(Date.now() - 48 * 3600_000),
      validTo: new Date(Date.now() - 24 * 3600_000),
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(delegate.token))
      .expect(200);
    expect(res.body.data.map((e: { id: string }) => e.id)).not.toContain(jobId);
  });

  // ---- Slice 26-TWOSTAGE: the queue must say WHICH stage a record awaits ---
  //
  // Against the REAL delivered route (`TWO_STAGE_TL_THEN_ENG`), not a fixture
  // route: the labels and the stage count come from the seed/migration chain,
  // so this fails if anyone reconfigures the route back to one stage.

  it('slice 26: a stage-1 entry reports stage 1 of 2 with the seeded team-leader label', async () => {
    const { jobId } = await submittedJob();
    const tl = await stepUpUser('tl-stage-label', ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(tl.token))
      .expect(200);

    const entry = res.body.data.find((e: { id: string }) => e.id === jobId);
    expect(entry).toBeTruthy();
    expect(entry.stageOrdinal).toBe(1);
    expect(entry.stageCount).toBe(2);
    expect(entry.stageLabel).toBe('Verified By (Workshop Team Leader)');
  });

  it('slice 26: a stage-2 entry reports stage 2 of 2 with the seeded engineer label — and never reaches the team leader', async () => {
    const { jobId } = await submittedJob();
    await adminPool.query('UPDATE "job" SET current_stage_ordinal = 2 WHERE id = $1', [jobId]);
    const eng = await stepUpUser('eng-stage-label', ['ENGINEER']);
    const tl = await stepUpUser('tl-not-stage-2', ['TEAM_LEADER']);
    // Review fix m3 — a CONTROL job still at stage 1, so the "the stage-2 job
    // is not in the team leader's queue" assertion below cannot pass merely
    // because that queue came back empty for some unrelated reason.
    const { jobId: stage1JobId } = await submittedJob();

    const engRes = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(eng.token))
      .expect(200);
    const entry = engRes.body.data.find((e: { id: string }) => e.id === jobId);
    expect(entry).toBeTruthy();
    expect(entry.stageOrdinal).toBe(2);
    expect(entry.stageCount).toBe(2);
    expect(entry.stageLabel).toBe('Verified By (Supervisor / Engineer)');

    const tlRes = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(tl.token))
      .expect(200);
    const tlIds = tlRes.body.data.map((e: { id: string }) => e.id);
    expect(tlIds).toContain(stage1JobId); // the queue is working…
    expect(tlIds).not.toContain(jobId); // …and it still excludes the stage-2 record
  });
});
