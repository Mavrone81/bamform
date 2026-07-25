import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createTemplateItem,
  createTemplateMeasurement,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { createLoginableUser } from './helpers/auth-fixtures';

/**
 * PR-API-22/23, PR-059 — `GET /sync/bootstrap`: embeds the complete frozen
 * template revision per job (offline render, no further call) and is
 * area+assignee scoped (reuses `JobAccessService`, slice 4/6).
 */
describe('Sync — GET /sync/bootstrap', () => {
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

  async function buildScenario(opts: { areaId?: string | null } = {}) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      areaId: opts.areaId ?? null,
    });
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
      standingContent: { safety: 'Lock out / tag out', ppe: ['gloves', 'safety glasses'] },
    });
    const activeItemId = await createTemplateItem(revisionId, 'M1', { itemNo: 1, active: true });
    await createTemplateItem(revisionId, 'M1', { itemNo: 2, active: false });
    const measurementId = await createTemplateMeasurement(revisionId, {
      lowerLimit: 5,
      upperLimit: 24,
    });

    // `createLoginableUser` (not the plain `createUser` fixture) — this
    // user is the CALLER in every test below, and `GET /sync/bootstrap`
    // decrypts its own `user` field via `AuthService#me` (real AES-256-GCM,
    // PR-106/107), unlike every other job read path (`mappers.ts` never
    // decrypts `*Name` fields) — `createUser`'s placeholder bytes are not
    // valid ciphertext and fail AEAD decryption.
    const { userId: maintainerId } = await createLoginableUser({
      email: `maintainer-${randomUUID()}@example.test`,
      password: 'correct horse battery staple 1',
      roleCodes: ['MAINTAINER'],
    });

    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-TEST-${randomUUID()}`,
      status: 'assigned',
      assignedTo: maintainerId,
    });

    return { jobId, assetId, activeItemId, measurementId, maintainerId, formTemplateId };
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/sync/bootstrap').expect(401);
  });

  it('PR-API-22: embeds the COMPLETE frozen revision — active items/measurements with full spec, standing content, no further call needed', async () => {
    const { jobId, activeItemId, measurementId, maintainerId } = await buildScenario();
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.serverTime).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ id: maintainerId, roles: ['MAINTAINER'] });
    expect(res.body.syncToken).toEqual(expect.any(String));

    const job = res.body.jobs.find((j: { id: string }) => j.id === jobId);
    expect(job).toBeDefined();

    // Only the ACTIVE item is present (the inactive one must not resurface).
    expect(job.templateRevision.items).toHaveLength(1);
    expect(job.templateRevision.items[0]).toMatchObject({
      id: activeItemId,
      itemNo: 1,
      frequency: 'M1',
      instruction: expect.any(String),
      mandatory: expect.any(Boolean),
    });

    expect(job.templateRevision.measurements).toHaveLength(1);
    expect(job.templateRevision.measurements[0]).toMatchObject({
      id: measurementId,
      specType: 'RANGE',
      lowerLimit: 5,
      upperLimit: 24,
      specDisplay: expect.any(String),
    });

    // Standing content (safety/PPE) — everything needed to render offline.
    expect(job.templateRevision.standingContent).toMatchObject({
      safety: 'Lock out / tag out',
      ppe: ['gloves', 'safety glasses'],
    });

    // Result/part/attachment/approval collections present (even if empty) —
    // the "current recorded results" half of PR-059.
    expect(job.itemResults).toEqual([]);
    expect(job.measurementResults).toEqual([]);
    expect(job.partsUsed).toEqual([]);
  });

  it('a bad `since` value is rejected 422', async () => {
    const { maintainerId } = await buildScenario();
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/sync/bootstrap?since=not-a-date')
      .set(...authHeader(token))
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
  });

  describe('area + assignee scope (PR-API-10, reusing JobAccessService)', () => {
    it('a user scoped to area A does not receive a job in area B', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);

      const { jobId: jobInA, assetId: assetInA } = await buildScenario({ areaId: areaA });
      const authorId = await createUser('author-2');
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetInB = await createAsset(assetTypeId, `AS-${randomUUID()}`, { areaId: areaB });
      const revisionId = await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      const jobInB = await createJob({
        assetId: assetInB,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `PM-TEST-${randomUUID()}`,
        status: 'assigned',
      });
      void assetInA;

      // TEAM_LEADER has broad job visibility (view-all-in-scope), scoped to area A only.
      const { userId: teamLeaderId } = await createLoginableUser({
        email: `team-leader-${randomUUID()}@example.test`,
        password: 'correct horse battery staple 1',
        roleCodes: ['TEAM_LEADER'],
      });
      await scopeUserToArea(teamLeaderId, areaA);
      const token = await mintAccessToken(app, teamLeaderId, ['TEAM_LEADER']);

      const res = await request(app.getHttpServer())
        .get('/api/v1/sync/bootstrap')
        .set(...authHeader(token))
        .expect(200);

      const ids: string[] = res.body.jobs.map((j: { id: string }) => j.id);
      expect(ids).toContain(jobInA);
      expect(ids).not.toContain(jobInB);
    });

    it('a MAINTAINER (no broad visibility) only receives jobs assigned to them, even within their area', async () => {
      const { jobId, maintainerId } = await buildScenario();

      // A second job in the SAME (unscoped) area, assigned to someone else.
      const otherMaintainerId = await createUser('other-maintainer');
      await grantRole(otherMaintainerId, 'MAINTAINER');
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId2 = await createAsset(assetTypeId, `AS-${randomUUID()}`);
      const authorId = await createUser('author-3');
      const revisionId = await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      const otherJobId = await createJob({
        assetId: assetId2,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `PM-TEST-${randomUUID()}`,
        status: 'assigned',
        assignedTo: otherMaintainerId,
      });

      const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
      const res = await request(app.getHttpServer())
        .get('/api/v1/sync/bootstrap')
        .set(...authHeader(token))
        .expect(200);

      const ids: string[] = res.body.jobs.map((j: { id: string }) => j.id);
      expect(ids).toContain(jobId);
      expect(ids).not.toContain(otherJobId);
    });
  });
});
