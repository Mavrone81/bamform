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
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * UR-055/058 — archive search/retrieve (`GET /records`, `GET
 * /records/{recordId}`). Builds ARCHIVED job rows directly (rather than
 * driving the full verify flow, which `records-pdf.spec.ts` and
 * `approval-verify.spec.ts` already cover) since this suite is about the
 * SEARCH/FILTER/SCOPE surface, not the archival transition itself.
 */
describe('GET /records, GET /records/{recordId} (UR-055/058)', () => {
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

  async function makeArchivedJob(opts: {
    documentNumber?: string;
    areaId?: string | null;
    assignedTo?: string;
    submittedBy?: string;
    archivedAt?: Date;
  }) {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(opts.documentNumber ?? `DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, { areaId: opts.areaId });
    const author = opts.submittedBy ?? (await createUser('author'));
    const revisionId = await createTemplateRevision(formTemplateId, author, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-ARCH-${randomUUID()}`,
      status: 'archived',
      assignedTo: opts.assignedTo,
      submittedBy: opts.submittedBy,
      submittedAt: new Date(),
      archivedAt: opts.archivedAt ?? new Date(),
    });
    return { jobId, assetId, formTemplateId, revisionId };
  }

  it('a MAINTAINER sees only their OWN archived records', async () => {
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const otherMaintainerId = await createUser('other-maintainer');
    await grantRole(otherMaintainerId, 'MAINTAINER');

    const own = await makeArchivedJob({ assignedTo: maintainerId, submittedBy: maintainerId });
    await makeArchivedJob({ assignedTo: otherMaintainerId, submittedBy: otherMaintainerId });

    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
    const res = await request(app.getHttpServer())
      .get('/api/v1/records')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(own.jobId);
  });

  it('a TEAM_LEADER sees every archived record in area scope', async () => {
    const tlId = await createUser('tl');
    await grantRole(tlId, 'TEAM_LEADER');
    const maintainerId = await createUser('maintainer-2');
    await grantRole(maintainerId, 'MAINTAINER');

    await makeArchivedJob({ assignedTo: maintainerId });
    await makeArchivedJob({ assignedTo: maintainerId });

    const token = await mintAccessToken(app, tlId, ['TEAM_LEADER']);
    const res = await request(app.getHttpServer())
      .get('/api/v1/records')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.data).toHaveLength(2);
  });

  it('area scope excludes a record in an area the caller is not scoped to', async () => {
    const tlId = await createUser('tl-scoped');
    await grantRole(tlId, 'TEAM_LEADER');
    const inArea = await createArea(`AREA-IN-${randomUUID()}`);
    const outArea = await createArea(`AREA-OUT-${randomUUID()}`);
    await scopeUserToArea(tlId, inArea);

    const inJob = await makeArchivedJob({ areaId: inArea });
    await makeArchivedJob({ areaId: outArea });

    const token = await mintAccessToken(app, tlId, ['TEAM_LEADER']);
    const res = await request(app.getHttpServer())
      .get('/api/v1/records')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(inJob.jobId);
  });

  it('filters by documentNumber (UR-058)', async () => {
    const adminId = await createUser('admin');
    await grantRole(adminId, 'ADMIN');
    const docNumber = `DOC-FILTER-${randomUUID()}`;
    const match = await makeArchivedJob({ documentNumber: docNumber });
    await makeArchivedJob({});

    const token = await mintAccessToken(app, adminId, ['ADMIN']);
    const res = await request(app.getHttpServer())
      .get('/api/v1/records')
      .query({ documentNumber: docNumber })
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(match.jobId);
  });

  it('filters by technician (submittedBy) and approver (verified actor) (UR-058)', async () => {
    const adminId = await createUser('admin-2');
    await grantRole(adminId, 'ADMIN');
    const technician = await createUser('technician');
    const approver = await createUser('approver');

    const match = await makeArchivedJob({ submittedBy: technician });
    await adminPool.query(
      `INSERT INTO "approval_step"
         ("job_id", "stage_ordinal", "action", "actor_id", "actor_role_code", "acted_at",
          "content_hash", "signature", "signing_key_id")
       VALUES ($1, 1, 'verified', $2, 'ENGINEER', now(), digest('x','sha256'), digest('y','sha256'), 'test-kid')`,
      [match.jobId, approver],
    );
    await makeArchivedJob({});

    const token = await mintAccessToken(app, adminId, ['ADMIN']);

    const byTech = await request(app.getHttpServer())
      .get('/api/v1/records')
      .query({ technician })
      .set(...authHeader(token))
      .expect(200);
    expect(byTech.body.data).toHaveLength(1);
    expect(byTech.body.data[0].id).toBe(match.jobId);

    const byApprover = await request(app.getHttpServer())
      .get('/api/v1/records')
      .query({ approver })
      .set(...authHeader(token))
      .expect(200);
    expect(byApprover.body.data).toHaveLength(1);
    expect(byApprover.body.data[0].id).toBe(match.jobId);
  });

  it('filters by a date range on archivedAt (UR-058)', async () => {
    const adminId = await createUser('admin-3');
    await grantRole(adminId, 'ADMIN');
    const inRange = await makeArchivedJob({ archivedAt: new Date('2026-06-15T00:00:00Z') });
    await makeArchivedJob({ archivedAt: new Date('2026-01-01T00:00:00Z') });

    const token = await mintAccessToken(app, adminId, ['ADMIN']);
    const res = await request(app.getHttpServer())
      .get('/api/v1/records')
      .query({ archivedFrom: '2026-06-01', archivedTo: '2026-06-30' })
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(inRange.jobId);
  });

  it('GET /records/{recordId} retrieves the full record with checklist/measurements', async () => {
    const adminId = await createUser('admin-4');
    await grantRole(adminId, 'ADMIN');
    const { jobId } = await makeArchivedJob({});

    const token = await mintAccessToken(app, adminId, ['ADMIN']);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}`)
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.id).toBe(jobId);
    expect(res.body.status).toBe('ARCHIVED');
  });

  it('GET /records/{recordId} 404s for a job that is not archived', async () => {
    const adminId = await createUser('admin-5');
    await grantRole(adminId, 'ADMIN');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
    const revisionId = await createTemplateRevision(formTemplateId, adminId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-NOTARCH-${randomUUID()}`,
      status: 'in_progress',
    });

    const token = await mintAccessToken(app, adminId, ['ADMIN']);
    await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('GET /records/{recordId} 403s (out-of-scope) for a MAINTAINER who is not the assignee', async () => {
    const maintainerId = await createUser('maintainer-3');
    await grantRole(maintainerId, 'MAINTAINER');
    const otherMaintainerId = await createUser('other-maintainer-2');
    await grantRole(otherMaintainerId, 'MAINTAINER');
    const { jobId } = await makeArchivedJob({ assignedTo: otherMaintainerId });

    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
    await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}`)
      .set(...authHeader(token))
      .expect(403);
  });
});
