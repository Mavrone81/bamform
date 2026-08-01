import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import Redis from 'ioredis';
import { Worker } from 'bullmq';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createJobFixture,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { createLoginableUser } from './helpers/auth-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';
import { NotificationQueueService } from '../../src/notifications/notification-queue.service';
import { NotificationDispatchService } from '../../src/notifications/notification-dispatch.service';
import { NOTIFICATION_QUEUE_NAME } from '../../src/notifications/notification.tokens';
import { FIELD_ENCRYPTION_SERVICE } from '../../src/crypto/crypto.tokens';
import { VerifierEligibilityService } from '../../src/queue/verifier-eligibility.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { FieldEncryptionService } from '../../src/crypto/field-encryption';
import type { NotificationTransport } from '../../src/notifications/transports/notification-transport';

/**
 * E-10 / PR-077 — escalation timers. `AppModule` (the api process) only
 * ever SCHEDULES/CANCELS (PR-150/151, `NotificationQueueService`); it never
 * runs the consumer (`NotificationWorkerService` is `WorkerModule`-only —
 * see `notifications.module.ts`'s doc comment). Rather than boot a second
 * full Nest app for the worker side, the "matures and fires" test wires a
 * REAL `bullmq` `Worker` directly to a REAL `NotificationDispatchService`
 * pulled from the SAME app's DI container, with a fake/captured transport
 * standing in for `NOTIFICATION_ENABLED=false`'s `NoopNotificationTransport`
 * — proving the actual Redis/BullMQ mechanics end to end without ever
 * emailing anyone (never a real SMTP transport is constructed).
 */
describe('Escalation timers — PR-077/UR-050 (E-10)', () => {
  let app: INestApplication;
  let notificationQueue: NotificationQueueService;
  let approvalRouteId: string;
  let stage1Id: string;
  let stage2Id: string;
  let teamLeaderRoleId: string;

  beforeAll(async () => {
    app = await createTestApp();
    notificationQueue = app.get(NotificationQueueService);
    approvalRouteId = await getSeededApprovalRouteId();
    const stages = await adminPool.query(
      `SELECT id, stage_ordinal FROM "approval_stage" WHERE approval_route_id = $1 ORDER BY stage_ordinal`,
      [approvalRouteId],
    );
    stage1Id = stages.rows[0].id as string;
    stage2Id = stages.rows[1].id as string;
    const role = await adminPool.query(`SELECT id FROM "role" WHERE code = 'TEAM_LEADER'`);
    teamLeaderRoleId = role.rows[0].id as string;
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

  afterEach(async () => {
    // approval_stage is PR-DBD-09 seed data, NOT truncated by resetDatabase()
    // (see helpers/db.ts) — any test that mutates stage 1's escalation
    // config must restore the DELIVERED default so it never bleeds into a
    // later test file sharing this same Postgres instance.
    //
    // That delivered default changed on 2026-07-26: migration
    // 20260726120000_enable_verification_escalation_default sets
    // escalation_hours = 72 (UR-050, resolving the slice-11a finding D
    // contradiction). escalate_to_role_id stays NULL — "notify whoever is
    // currently eligible to verify this stage".
    await adminPool.query(
      `UPDATE "approval_stage" SET escalation_hours = 72, escalate_to_role_id = NULL WHERE id = ANY($1::uuid[])`,
      [[stage1Id, stage2Id]],
    );
  });

  async function makeSubmittableJob() {
    const authorId = await createUser('author');
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
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-ESC-${randomUUID()}`,
      status: 'in_progress',
      assignedTo: maintainerId,
    });
    return { jobId, token };
  }

  async function stepUpTeamLeader() {
    const userId = await createUser('tl-escalation');
    await grantRole(userId, 'TEAM_LEADER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      userId,
    ]);
    const token = await mintAccessToken(app, userId, ['TEAM_LEADER']);
    return { userId, token };
  }

  it('a stage with escalation_hours NULL schedules NOTHING (NULL means "no escalation", not "use a default")', async () => {
    // The NULL semantics are unchanged and still load-bearing — an admin who
    // clears a stage's escalation_hours turns escalation off for that stage.
    // Set it explicitly: since migration 20260726120000 the DELIVERED value is
    // 72, so this case no longer arises from the seed alone.
    await adminPool.query(
      `UPDATE "approval_stage" SET escalation_hours = NULL, escalate_to_role_id = NULL WHERE id = $1`,
      [stage1Id],
    );
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const job = await notificationQueue.getEscalationJob(jobId, 1);
    expect(job).toBeFalsy();
  });

  it('DELIVERED CONFIG (UR-050) — submitting schedules escalation at the 72h default, targeting the eligible verifiers', async () => {
    // Guards the product decision of 2026-07-26 (slice-11a finding D). If a
    // future migration or seed edit silently reverts the delivered route to
    // NULL, escalation goes inert again and this test is what catches it.
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const job = await notificationQueue.getEscalationJob(jobId, 1);
    expect(job).toBeTruthy();
    expect(job!.opts.delay).toBe(72 * 3_600_000);
    // null target = "fall back to whoever is currently eligible to verify"
    expect(job!.data).toMatchObject({ jobId, stageOrdinal: 1, recipientRoleCode: null });
  });

  it('when stage 1 has escalation_hours configured, SUBMITTING schedules a delayed escalation job for the right delay', async () => {
    await adminPool.query(
      `UPDATE "approval_stage" SET escalation_hours = 2, escalate_to_role_id = $1 WHERE id = $2`,
      [teamLeaderRoleId, stage1Id],
    );
    const { jobId, token } = await makeSubmittableJob();

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const job = await notificationQueue.getEscalationJob(jobId, 1);
    expect(job).toBeTruthy();
    expect(job!.opts.delay).toBe(2 * 3_600_000);
    expect(job!.data).toMatchObject({ jobId, stageOrdinal: 1, recipientRoleCode: 'TEAM_LEADER' });
  });

  it('VERIFYING stage 1 cancels its escalation job (PR-077 "cancelled on verification")', async () => {
    await adminPool.query(
      `UPDATE "approval_stage" SET escalation_hours = 5, escalate_to_role_id = $1 WHERE id = $2`,
      [teamLeaderRoleId, stage1Id],
    );
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(await notificationQueue.getEscalationJob(jobId, 1)).toBeTruthy();

    const tl = await stepUpTeamLeader();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const job = await notificationQueue.getEscalationJob(jobId, 1);
    expect(job).toBeFalsy();
  });

  it('RECALLING a submitted job also cancels its pending escalation (leaving the flow entirely, not just this verifier acting)', async () => {
    await adminPool.query(
      `UPDATE "approval_stage" SET escalation_hours = 5, escalate_to_role_id = $1 WHERE id = $2`,
      [teamLeaderRoleId, stage1Id],
    );
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(await notificationQueue.getEscalationJob(jobId, 1)).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/recall`)
      .set(...authHeader(token))
      .expect(200);

    expect(await notificationQueue.getEscalationJob(jobId, 1)).toBeFalsy();
  });

  // ------------------------------------------------------------- SYS-7
  // (system-review-2026-07-27, Important): before slice 15-SYSWIRE the ONLY
  // scheduling call sites were at SUBMIT, for stage 1 — a stage-1 verify
  // cancelled stage 1's timer and scheduled NOTHING for stage 2, so stage 2's
  // 72h escalation config was dead and stage-2 verifiers were never told a
  // record entered their queue.

  it("SYS-7: a stage-1 verify schedules STAGE 2's escalation timer (stage 2 config: 72h default) and cancels stage 1's", async () => {
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(await notificationQueue.getEscalationJob(jobId, 1)).toBeTruthy();

    const tl = await stepUpTeamLeader();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    expect(await notificationQueue.getEscalationJob(jobId, 1)).toBeFalsy();
    const stage2 = await notificationQueue.getEscalationJob(jobId, 2);
    expect(stage2).toBeTruthy();
    expect(stage2!.opts.delay).toBe(72 * 3_600_000);
    expect(stage2!.data).toMatchObject({ jobId, stageOrdinal: 2, recipientRoleCode: null });
  });

  it('SYS-7: stage 2 honours ITS OWN config — a custom escalation_hours and target role on stage 2 are what get scheduled', async () => {
    await adminPool.query(
      `UPDATE "approval_stage" SET escalation_hours = 4, escalate_to_role_id = $1 WHERE id = $2`,
      [teamLeaderRoleId, stage2Id],
    );
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const tl = await stepUpTeamLeader();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const stage2 = await notificationQueue.getEscalationJob(jobId, 2);
    expect(stage2).toBeTruthy();
    expect(stage2!.opts.delay).toBe(4 * 3_600_000);
    expect(stage2!.data).toMatchObject({
      jobId,
      stageOrdinal: 2,
      recipientRoleCode: 'TEAM_LEADER',
    });
  });

  it('SYS-7: stage 2 with escalation_hours NULL schedules nothing (NULL still means "no escalation for this stage")', async () => {
    await adminPool.query(
      `UPDATE "approval_stage" SET escalation_hours = NULL, escalate_to_role_id = NULL WHERE id = $1`,
      [stage2Id],
    );
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const tl = await stepUpTeamLeader();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    expect(await notificationQueue.getEscalationJob(jobId, 2)).toBeFalsy();
  });

  it('SYS-7/UR-063: a stage-1 verify notifies the STAGE-2 cohort (ENGINEERs) that a record entered their queue', async () => {
    const engineerId = await createUser('eng-queue-notify');
    await grantRole(engineerId, 'ENGINEER');
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const tl = await stepUpTeamLeader();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    // Inspect the underlying BullMQ queue directly (the producer service
    // deliberately exposes no listing API).
    const { Queue } = await import('bullmq');
    const Redis = (await import('ioredis')).default;
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    const bull = new Queue(NOTIFICATION_QUEUE_NAME, {
      connection,
      prefix: process.env.QUEUE_PREFIX ?? 'bull',
    });
    try {
      const jobs = await bull.getJobs(['waiting', 'delayed', 'prioritized']);
      const toEngineer = jobs.filter(
        (j) => j.name === 'notification' && j.data.recipientId === engineerId,
      );
      expect(toEngineer).toHaveLength(1);
      expect(toEngineer[0].data).toMatchObject({
        templateCode: 'RECORD_SUBMITTED',
        entityType: 'job',
        entityId: jobId,
      });
    } finally {
      await bull.close();
      await connection.quit();
    }
  });

  it("SYS-7: the FINAL (stage-2) verify cancels stage 2's escalation timer", async () => {
    const { jobId, token } = await makeSubmittableJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const tl = await stepUpTeamLeader();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tl.token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(await notificationQueue.getEscalationJob(jobId, 2)).toBeTruthy();

    const engId = await createUser('eng-final');
    await grantRole(engId, 'ENGINEER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      engId,
    ]);
    const engToken = await mintAccessToken(app, engId, ['ENGINEER']);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    expect(await notificationQueue.getEscalationJob(jobId, 2)).toBeFalsy();
  });

  it(
    'an unverified record past the window FIRES a notification — the dispatch DECISION is recorded ' +
      '(NOTIFICATION_ENABLED off — a captured/fake transport stands in, never a real email)',
    async () => {
      const { jobId } = await createJobFixture(`PM-ESC-FIRE-${randomUUID()}`, 'submitted', {
        submittedAt: new Date(),
        currentStageOrdinal: 1,
      });
      const { userId: recipientId } = await createLoginableUser({
        email: `escalation-recipient-${randomUUID()}@example.com`,
        password: 'correct horse battery staple',
        fullName: 'Escalation Recipient',
        roleCodes: ['TEAM_LEADER'],
      });

      // Schedule directly with a SHORT delay (bypassing the hours->ms
      // conversion real submission would use — hours would make this test
      // wait a real hour) — proves the SAME mechanism `SubmissionService`
      // drives, just with a test-friendly delay.
      await notificationQueue.scheduleEscalation({
        jobId,
        stageOrdinal: 1,
        delayMs: 50,
        recipientRoleCode: 'TEAM_LEADER',
      });

      // A REAL BullMQ Worker, wired to a REAL NotificationDispatchService
      // (pulled from the app's own DI container — same Prisma/field-encryption
      // wiring the actual worker process would use), with a captured FAKE
      // transport (standing in for NOTIFICATION_ENABLED=false's
      // NoopNotificationTransport — never a real SmtpNotificationTransport is
      // constructed anywhere in this test).
      const sent: Array<{ to: string; subject: string; text: string }> = [];
      const fakeTransport: NotificationTransport = {
        kind: 'noop',
        send: async (params) => {
          sent.push(params);
        },
      };
      const dispatch = new NotificationDispatchService(
        app.get(PrismaService),
        app.get<FieldEncryptionService>(FIELD_ENCRYPTION_SERVICE),
        fakeTransport,
        app.get(VerifierEligibilityService),
      );

      const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
      });
      const worker = new Worker(
        NOTIFICATION_QUEUE_NAME,
        async (job) => {
          if (job.name === 'escalation') {
            await dispatch.dispatchEscalation(job.data);
          }
        },
        { connection, prefix: process.env.QUEUE_PREFIX ?? 'bull' },
      );

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('escalation did not fire within 5s')),
            5000,
          );
          worker.on('completed', () => {
            clearTimeout(timer);
            resolve();
          });
          worker.on('failed', (_job, err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        expect(sent).toHaveLength(1);
        expect(sent[0].to).toContain('@example.com'); // decrypted via the established field-decryption path (PR-106)
        expect(sent[0].subject).toContain('overdue');

        const rows = await adminPool.query(
          `SELECT recipient_id, template_code, state, entity_type, entity_id FROM "notification" WHERE entity_id = $1`,
          [jobId],
        );
        expect(rows.rows).toEqual([
          {
            recipient_id: recipientId,
            template_code: 'VERIFICATION_ESCALATED',
            state: 'sent',
            entity_type: 'job',
            entity_id: jobId,
          },
        ]);
      } finally {
        await worker.close();
        if (connection.status !== 'end') {
          await connection.quit();
        }
      }
    },
  );
});
