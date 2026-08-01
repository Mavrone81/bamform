import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SchedulerService } from '../../src/scheduling/scheduler.service';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetDocument,
  createAssetType,
  createFormTemplate,
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
 * Slice 27-ASSETDOC review addition. Pins BOTH of
 * `VoidScheduleRecomputeService`s document scopings independently — neither
 * was pinned by `cross-document-schedule.spec.ts`, which passes with both
 * reverted to `assetId`.
 */
describe('void recompute must not reach across documents (slice 27)', () => {
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

  async function seedTwoDocuments() {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const assetTypeId = await createAssetType(
      await createFormTemplate(`DOC-UNUSED-${randomUUID()}`),
      approvalRouteId,
      `AT-${randomUUID()}`,
      { leadTimeDays: 90 },
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      skipDefaultDocument: true,
    });
    async function tagDocument(label: string) {
      const templateId = await createFormTemplate(`DOC-${label}-${randomUUID()}`);
      const revisionId = await createTemplateRevision(templateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      const itemIds = [await createTemplateItem(revisionId, 'M1')];
      const id = await createAssetDocument(assetId, templateId);
      return { id, templateId, revisionId, itemIds };
    }
    return { assetId, docA: await tagDocument('A'), docB: await tagDocument('B') };
  }

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
      [[tlId, engId, adminId]],
    );
    return {
      maintainerId,
      tlToken: await mintAccessToken(app, tlId, ['TEAM_LEADER']),
      engToken: await mintAccessToken(app, engId, ['ENGINEER']),
      maintainerToken: await mintAccessToken(app, maintainerId, ['MAINTAINER']),
      adminToken: await mintAccessToken(app, adminId, ['ADMIN']),
    };
  }

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
    await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
  }

  async function ruleFor(assetDocumentId: string) {
    const r = await adminPool.query(
      `SELECT last_completed_on, next_due_on FROM "schedule_rule"
        WHERE asset_document_id = $1 AND frequency = 'M1'::"frequency_t"`,
      [assetDocumentId],
    );
    expect(r.rowCount).toBe(1);
    return r.rows[0] as { last_completed_on: Date | null; next_due_on: Date };
  }

  async function jobIdFor(assetDocumentId: string) {
    const r = await adminPool.query(
      `SELECT id FROM "job" WHERE asset_document_id = $1 AND status <> 'voided'`,
      [assetDocumentId],
    );
    expect(r.rowCount).toBe(1);
    return r.rows[0].id as string;
  }

  it("voiding A's job must not clobber B's already-advanced schedule (RULE scoping)", async () => {
    const { docA, docB } = await seedTwoDocuments();
    const users = await makeUsers();
    const tick = await app.get(SchedulerService).run();
    expect(tick.ran && tick.generated).toBe(2);

    // B is completed FIRST, so B's rule is advanced and stamped.
    await completeJob(await jobIdFor(docB.id), docB.itemIds, users);
    const beforeB = await ruleFor(docB.id);
    expect(beforeB.last_completed_on).not.toBeNull();

    // Then A is completed and immediately voided.
    const aJobId = await jobIdFor(docA.id);
    await completeJob(aJobId, docA.itemIds, users);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${aJobId}/void`)
      .set(...authHeader(users.adminToken))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Raised against the wrong document — reviewer probe' })
      .expect(200);

    const afterB = await ruleFor(docB.id);
    expect(afterB.last_completed_on).toEqual(beforeB.last_completed_on);
    expect(afterB.next_due_on).toEqual(beforeB.next_due_on);
  });

  it("voiding A's job must not credit A's schedule with B's completion (PRIOR scoping)", async () => {
    const { docA, docB } = await seedTwoDocuments();
    const users = await makeUsers();
    const tick = await app.get(SchedulerService).run();
    expect(tick.ran && tick.generated).toBe(2);

    // B completes first (an ARCHIVED job on the SIBLING document).
    await completeJob(await jobIdFor(docB.id), docB.itemIds, users);
    // A completes, then is voided. A now has NO valid completion of its own.
    const aJobId = await jobIdFor(docA.id);
    await completeJob(aJobId, docA.itemIds, users);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${aJobId}/void`)
      .set(...authHeader(users.adminToken))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Raised against the wrong document — reviewer probe' })
      .expect(200);

    const afterA = await ruleFor(docA.id);
    // The ONLY correct answer: no valid completion remains for document A.
    expect(afterA.last_completed_on).toBeNull();
  });
});
