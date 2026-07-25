import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
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

/** PR-030 — job read/list: area/role scoping, overdue derivation, frozen-revision content. */
describe('Jobs — GET /jobs, GET /jobs/{id}', () => {
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

  async function makeJobStack(opts: { areaId?: string | null } = {}) {
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
    });
    await createTemplateItem(revisionId, 'M1', { itemNo: 1 });
    await createTemplateMeasurement(revisionId, { lowerLimit: 5, upperLimit: 24 });
    return { authorId, approvalRouteId, assetId, revisionId };
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/jobs').expect(401);
  });

  it('GET /jobs/{id} 404s for an unknown id', async () => {
    const userId = await createUser('eng');
    await grantRole(userId, 'ENGINEER');
    const token = await mintAccessToken(app, userId, ['ENGINEER']);
    await request(app.getHttpServer())
      .get(`/api/v1/jobs/${randomUUID()}`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('GET /jobs/{id} returns the frozen revision with only ACTIVE items/measurements', async () => {
    const { assetId, revisionId } = await makeJobStack();
    await createTemplateItem(revisionId, 'M1', { itemNo: 99, active: false });

    const userId = await createUser('eng');
    await grantRole(userId, 'ENGINEER');
    const token = await mintAccessToken(app, userId, ['ENGINEER']);
    const approvalRouteId = await getSeededApprovalRouteId();
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-TEST-${randomUUID()}`,
      status: 'assigned',
      assignedTo: userId,
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.status).toBe('ASSIGNED');
    expect(res.body.templateRevision.items).toHaveLength(1);
    expect(res.body.templateRevision.items[0].itemNo).toBe(1);
    expect(res.body.templateRevision.measurements).toHaveLength(1);
    expect(res.body.itemResults).toEqual([]);
  });

  it('overdue is DERIVED (non-negotiable #12): a past-due open job reports overdue=true', async () => {
    const { assetId, revisionId } = await makeJobStack();
    const userId = await createUser('eng');
    await grantRole(userId, 'ENGINEER');
    const token = await mintAccessToken(app, userId, ['ENGINEER']);
    const approvalRouteId = await getSeededApprovalRouteId();
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-TEST-${randomUUID()}`,
      status: 'assigned',
    });
    // Force due_on into the past directly (createJob defaults to CURRENT_DATE).
    await adminPool.query(
      `UPDATE "job" SET due_on = CURRENT_DATE - INTERVAL '5 days' WHERE id = $1`,
      [jobId],
    );

    const res = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    expect(res.body.overdue).toBe(true);

    const list = await request(app.getHttpServer())
      .get('/api/v1/jobs?overdue=true')
      .set(...authHeader(token))
      .expect(200);
    expect(list.body.data.map((j: { id: string }) => j.id)).toContain(jobId);
  });

  describe('role-driven visibility (API_SPECIFICATION.md §4.1)', () => {
    it('a MAINTAINER sees only jobs assigned to them in the collection', async () => {
      const { assetId, revisionId } = await makeJobStack();
      const approvalRouteId = await getSeededApprovalRouteId();
      const maintainerId = await createUser('maintainer');
      await grantRole(maintainerId, 'MAINTAINER');
      const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

      const ownJobId = await createJob({
        assetId,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `PM-OWN-${randomUUID()}`,
        status: 'assigned',
        assignedTo: maintainerId,
      });
      // A distinct asset — `job` has a unique constraint on
      // (asset_id, frequency_scope, due_on) (I-INV-14), so a second job for
      // the SAME asset on the same (default) due date would collide.
      const otherStack = await makeJobStack();
      const otherUserId = await createUser('other-maintainer');
      await createJob({
        assetId: otherStack.assetId,
        templateRevisionId: otherStack.revisionId,
        approvalRouteId,
        jobNumber: `PM-OTHER-${randomUUID()}`,
        status: 'assigned',
        assignedTo: otherUserId,
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/jobs?limit=100')
        .set(...authHeader(token))
        .expect(200);
      const ids = res.body.data.map((j: { id: string }) => j.id);
      expect(ids).toEqual([ownJobId]);
    });

    it('a TEAM_LEADER sees all jobs in their area scope, not just their own', async () => {
      const { assetId, revisionId } = await makeJobStack();
      const approvalRouteId = await getSeededApprovalRouteId();
      const teamLeaderId = await createUser('tl');
      await grantRole(teamLeaderId, 'TEAM_LEADER');
      const token = await mintAccessToken(app, teamLeaderId, ['TEAM_LEADER']);

      const maintainerId = await createUser('maintainer2');
      const jobId = await createJob({
        assetId,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `PM-ASSIGNED-${randomUUID()}`,
        status: 'assigned',
        assignedTo: maintainerId,
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/jobs?limit=100')
        .set(...authHeader(token))
        .expect(200);
      expect(res.body.data.map((j: { id: string }) => j.id)).toContain(jobId);
    });

    it('a MAINTAINER requesting a job not assigned to them gets 403 forbidden', async () => {
      const { assetId, revisionId } = await makeJobStack();
      const approvalRouteId = await getSeededApprovalRouteId();
      const ownerId = await createUser('owner');
      const jobId = await createJob({
        assetId,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `PM-NOTMINE-${randomUUID()}`,
        status: 'assigned',
        assignedTo: ownerId,
      });

      const otherId = await createUser('not-owner');
      await grantRole(otherId, 'MAINTAINER');
      const token = await mintAccessToken(app, otherId, ['MAINTAINER']);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}`)
        .set(...authHeader(token))
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/forbidden' });
    });
  });

  describe('area scoping (PR-API-10, ADR-005)', () => {
    it("GET /jobs/{id} for a job outside the caller's area scope is 403 out-of-scope", async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const { assetId, revisionId } = await makeJobStack({ areaId: areaB });
      const approvalRouteId = await getSeededApprovalRouteId();
      const jobId = await createJob({
        assetId,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `PM-AREAB-${randomUUID()}`,
        status: 'assigned',
      });

      const scopedUserId = await createUser('scoped');
      await grantRole(scopedUserId, 'ENGINEER');
      await scopeUserToArea(scopedUserId, areaA);
      const token = await mintAccessToken(app, scopedUserId, ['ENGINEER']);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}`)
        .set(...authHeader(token))
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/out-of-scope' });
    });

    it("a user scoped to one area only sees that area's jobs in the collection", async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const stackA = await makeJobStack({ areaId: areaA });
      const stackB = await makeJobStack({ areaId: areaB });
      const approvalRouteId = await getSeededApprovalRouteId();

      const jobInA = await createJob({
        assetId: stackA.assetId,
        templateRevisionId: stackA.revisionId,
        approvalRouteId,
        jobNumber: `PM-INA-${randomUUID()}`,
        status: 'assigned',
      });
      await createJob({
        assetId: stackB.assetId,
        templateRevisionId: stackB.revisionId,
        approvalRouteId,
        jobNumber: `PM-INB-${randomUUID()}`,
        status: 'assigned',
      });

      const scopedUserId = await createUser('scoped2');
      await grantRole(scopedUserId, 'ENGINEER');
      await scopeUserToArea(scopedUserId, areaA);
      const token = await mintAccessToken(app, scopedUserId, ['ENGINEER']);

      const res = await request(app.getHttpServer())
        .get('/api/v1/jobs?limit=100')
        .set(...authHeader(token))
        .expect(200);
      const ids = res.body.data.map((j: { id: string }) => j.id);
      expect(ids).toEqual([jobInA]);
    });
  });
});
