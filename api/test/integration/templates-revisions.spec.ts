import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

describe('Template revisions — lifecycle (PRD §5.2, PR-022..028, PR-047..049)', () => {
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

  async function tokenFor(label: string, role: string): Promise<{ userId: string; token: string }> {
    const userId = await createUser(label);
    await grantRole(userId, role);
    const token = await mintAccessToken(app, userId, [role]);
    return { userId, token };
  }

  async function stepUp(userId: string): Promise<void> {
    await adminPool.query(`UPDATE "app_user" SET last_authenticated_at = now() WHERE id = $1`, [
      userId,
    ]);
  }

  const server = () => app.getHttpServer();

  it('rejects an unauthenticated request', async () => {
    await request(server()).get('/api/v1/templates').expect(401);
  });

  it('GET /templates and /templates/{id} work; unknown id is 404', async () => {
    const { token } = await tokenFor('engineer', 'ENGINEER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);

    const listRes = await request(server())
      .get('/api/v1/templates?limit=100')
      .set(...authHeader(token))
      .expect(200);
    expect(listRes.body.data.some((t: { id: string }) => t.id === templateId)).toBe(true);

    await request(server())
      .get(`/api/v1/templates/${templateId}`)
      .set(...authHeader(token))
      .expect(200);

    await request(server())
      .get(`/api/v1/templates/${randomUUID()}`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('ENGINEER creates the first DRAFT revision (sequence 0, empty checklist) and it is audited', async () => {
    const { token } = await tokenFor('engineer', 'ENGINEER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);

    const res = await request(server())
      .post(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .send({ revisionCode: '0', changeDescription: 'Initial load' })
      .expect(201);

    expect(res.body).toMatchObject({
      formTemplateId: templateId,
      revisionCode: '0',
      sequenceOrdinal: 0,
      status: 'DRAFT',
      items: [],
      measurements: [],
    });

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'template_revision' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rows[0]?.action).toBe('create');
  });

  it('a MAINTAINER is forbidden from creating a revision', async () => {
    const { token } = await tokenFor('maintainer', 'MAINTAINER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);

    await request(server())
      .post(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .send({ revisionCode: '0', changeDescription: 'Initial load' })
      .expect(403);
  });

  it('lists revisions newest-first', async () => {
    const { token } = await tokenFor('engineer', 'ENGINEER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);

    await request(server())
      .post(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .send({ revisionCode: '0', changeDescription: 'first' })
      .expect(201);
    await request(server())
      .post(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .send({ revisionCode: 'A', changeDescription: 'second' })
      .expect(201);

    const res = await request(server())
      .get(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .expect(200);
    expect(res.body.map((r: { sequenceOrdinal: number }) => r.sequenceOrdinal)).toEqual([1, 0]);
  });

  it('PATCH edits a DRAFT revision, forbidden for other roles', async () => {
    const { token } = await tokenFor('engineer', 'ENGINEER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const createRes = await request(server())
      .post(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .send({ revisionCode: '0', changeDescription: 'first' })
      .expect(201);

    const patchRes = await request(server())
      .patch(`/api/v1/revisions/${createRes.body.id}`)
      .set(...authHeader(token))
      .send({ changeDescription: 'Updated description text' })
      .expect(200);
    expect(patchRes.body.changeDescription).toBe('Updated description text');

    const { token: maintainerToken } = await tokenFor('maintainer', 'MAINTAINER');
    await request(server())
      .patch(`/api/v1/revisions/${createRes.body.id}`)
      .set(...authHeader(maintainerToken))
      .send({ changeDescription: 'Should not be allowed' })
      .expect(403);
  });

  it('PUT items upserts by stableKey (re-PUT with the same key updates in place, not duplicates)', async () => {
    const { token } = await tokenFor('engineer', 'ENGINEER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const createRes = await request(server())
      .post(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .send({ revisionCode: '0', changeDescription: 'first' })
      .expect(201);
    const revisionId = createRes.body.id as string;

    const firstPut = await request(server())
      .put(`/api/v1/revisions/${revisionId}/items`)
      .set(...authHeader(token))
      .send([
        { itemNo: 1, frequency: 'M1', instruction: 'Check belt tension', mandatory: true },
        { itemNo: 2, frequency: 'M3', instruction: 'Lubricate bearings', mandatory: true },
      ])
      .expect(200);
    expect(firstPut.body).toHaveLength(2);
    const stableKeys = firstPut.body.map((i: { stableKey: string }) => i.stableKey);

    await request(server())
      .put(`/api/v1/revisions/${revisionId}/items`)
      .set(...authHeader(token))
      .send([
        {
          itemNo: 1,
          frequency: 'M1',
          instruction: 'Check belt tension (revised wording)',
          mandatory: true,
          stableKey: stableKeys[0],
        },
        {
          itemNo: 2,
          frequency: 'M3',
          instruction: 'Lubricate bearings',
          mandatory: true,
          stableKey: stableKeys[1],
        },
      ])
      .expect(200);

    const rows = await adminPool.query(
      `SELECT instruction FROM "template_item" WHERE template_revision_id = $1 ORDER BY item_no`,
      [revisionId],
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows[0].instruction).toBe('Check belt tension (revised wording)');
  });

  it('PUT measurements rejects lowerLimit > upperLimit with 422 spec-limits-inverted (INV-04)', async () => {
    const { token } = await tokenFor('engineer', 'ENGINEER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const createRes = await request(server())
      .post(`/api/v1/templates/${templateId}/revisions`)
      .set(...authHeader(token))
      .send({ revisionCode: '0', changeDescription: 'first' })
      .expect(201);
    const revisionId = createRes.body.id as string;

    const res = await request(server())
      .put(`/api/v1/revisions/${revisionId}/measurements`)
      .set(...authHeader(token))
      .send([
        {
          description: 'Heater block temperature',
          specType: 'RANGE',
          lowerLimit: 105,
          upperLimit: 95,
          specDisplay: '95 - 105 g (inverted on purpose)',
          stableKey: randomUUID(),
        },
      ])
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/spec-limits-inverted' });

    await request(server())
      .put(`/api/v1/revisions/${revisionId}/measurements`)
      .set(...authHeader(token))
      .send([
        {
          description: 'Heater block temperature',
          specType: 'RANGE',
          lowerLimit: 95,
          upperLimit: 105,
          specDisplay: '95 - 105 g',
          stableKey: randomUUID(),
        },
      ])
      .expect(200);
  });

  describe('submit → approve/reject', () => {
    async function createDraft(token: string, templateId: string, revisionCode = '0') {
      const res = await request(server())
        .post(`/api/v1/templates/${templateId}/revisions`)
        .set(...authHeader(token))
        .send({ revisionCode, changeDescription: `revision ${revisionCode}` })
        .expect(201);
      return res.body.id as string;
    }

    it('submit moves DRAFT to PENDING_APPROVAL; forbidden for other roles; rejects a second submit', async () => {
      const { token } = await tokenFor('engineer', 'ENGINEER');
      const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const revisionId = await createDraft(token, templateId);

      const { token: maintainerToken } = await tokenFor('maintainer', 'MAINTAINER');
      await request(server())
        .post(`/api/v1/revisions/${revisionId}/submit`)
        .set(...authHeader(maintainerToken))
        .expect(403);

      const res = await request(server())
        .post(`/api/v1/revisions/${revisionId}/submit`)
        .set(...authHeader(token))
        .expect(200);
      expect(res.body.status).toBe('PENDING_APPROVAL');

      await request(server())
        .post(`/api/v1/revisions/${revisionId}/submit`)
        .set(...authHeader(token))
        .expect(409);
    });

    it('PR-047/INV-03: the author cannot approve their own revision (409 self-approval)', async () => {
      const { userId: authorId, token: authorToken } = await tokenFor('author', 'DOC_CONTROLLER');
      const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const revisionId = await createDraft(authorToken, templateId);
      await request(server())
        .post(`/api/v1/revisions/${revisionId}/submit`)
        .set(...authHeader(authorToken))
        .expect(200);

      await stepUp(authorId);
      const res = await request(server())
        .post(`/api/v1/revisions/${revisionId}/approve`)
        .set(...authHeader(authorToken))
        .expect(409);
      expect(res.body).toMatchObject({ type: '/errors/self-approval' });
    });

    it('PR-API-07: approve requires step-up (403 step-up-required without it)', async () => {
      const { token: authorToken } = await tokenFor('author', 'DOC_CONTROLLER');
      const { userId: approverId, token: approverToken } = await tokenFor(
        'approver',
        'DOC_CONTROLLER',
      );
      const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const revisionId = await createDraft(authorToken, templateId);
      await request(server())
        .post(`/api/v1/revisions/${revisionId}/submit`)
        .set(...authHeader(authorToken))
        .expect(200);

      // Explicitly no last_authenticated_at for approverId.
      const res = await request(server())
        .post(`/api/v1/revisions/${revisionId}/approve`)
        .set(...authHeader(approverToken))
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/step-up-required' });
      void approverId;
    });

    it('approve issues CURRENT, is audited, and a second approve attempt is an invalid transition', async () => {
      const { token: authorToken } = await tokenFor('author', 'DOC_CONTROLLER');
      const { userId: approverId, token: approverToken } = await tokenFor(
        'approver',
        'DOC_CONTROLLER',
      );
      const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const revisionId = await createDraft(authorToken, templateId);
      await request(server())
        .post(`/api/v1/revisions/${revisionId}/submit`)
        .set(...authHeader(authorToken))
        .expect(200);
      await stepUp(approverId);

      const res = await request(server())
        .post(`/api/v1/revisions/${revisionId}/approve`)
        .set(...authHeader(approverToken))
        .expect(200);
      expect(res.body).toMatchObject({ status: 'CURRENT' });
      expect(res.body.effectiveFrom).toBeTruthy();

      const audit = await adminPool.query(
        `SELECT action FROM "audit_event" WHERE entity_type = 'template_revision' AND entity_id = $1 AND action = 'approve'`,
        [revisionId],
      );
      expect(audit.rowCount).toBe(1);

      await stepUp(approverId);
      const secondAttempt = await request(server())
        .post(`/api/v1/revisions/${revisionId}/approve`)
        .set(...authHeader(approverToken))
        .expect(409);
      expect(secondAttempt.body).toMatchObject({ type: '/errors/invalid-transition' });
    });

    it('I-INV-18: issuing a new CURRENT supersedes the previous one; an in-flight job keeps its frozen revision (PR-048/PR-049)', async () => {
      const { token: authorToken } = await tokenFor('author', 'DOC_CONTROLLER');
      const { userId: approverId, token: approverToken } = await tokenFor(
        'approver',
        'DOC_CONTROLLER',
      );
      const templateId = await createFormTemplate(`DOC-${randomUUID()}`);

      // Revision 1 -> CURRENT.
      const revision1Id = await createDraft(authorToken, templateId, '0');
      await request(server())
        .post(`/api/v1/revisions/${revision1Id}/submit`)
        .set(...authHeader(authorToken))
        .expect(200);
      await stepUp(approverId);
      await request(server())
        .post(`/api/v1/revisions/${revision1Id}/approve`)
        .set(...authHeader(approverToken))
        .expect(200);

      // A job raised against revision 1, still in-flight (ASSIGNED).
      const approvalRouteId = await getSeededApprovalRouteId();
      const assetTypeId = await createAssetType(templateId, approvalRouteId, `AT-${randomUUID()}`);
      const assetId = await createAsset(assetTypeId, `AW-${randomUUID()}`);
      const jobId = await createJob({
        assetId,
        templateRevisionId: revision1Id,
        approvalRouteId,
        jobNumber: `PM-${randomUUID()}`,
        status: 'assigned',
      });

      // Revision 2 -> CURRENT (supersedes revision 1).
      const revision2Id = await createDraft(authorToken, templateId, 'A');
      await request(server())
        .post(`/api/v1/revisions/${revision2Id}/submit`)
        .set(...authHeader(authorToken))
        .expect(200);
      await stepUp(approverId);
      const approveRes = await request(server())
        .post(`/api/v1/revisions/${revision2Id}/approve`)
        .set(...authHeader(approverToken))
        .expect(200);
      expect(approveRes.body.status).toBe('CURRENT');

      const revision1After = await request(server())
        .get(`/api/v1/revisions/${revision1Id}`)
        .set(...authHeader(authorToken))
        .expect(200);
      expect(revision1After.body.status).toBe('SUPERSEDED');
      expect(revision1After.body.supersededAt).toBeTruthy();

      const jobRow = await adminPool.query(`SELECT template_revision_id FROM "job" WHERE id = $1`, [
        jobId,
      ]);
      expect(jobRow.rows[0].template_revision_id).toBe(revision1Id);
    });

    it('reject requires a reason of at least 10 chars, sets REJECTED, forbidden for other roles', async () => {
      const { token: authorToken } = await tokenFor('author', 'DOC_CONTROLLER');
      const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const revisionId = await createDraft(authorToken, templateId);
      await request(server())
        .post(`/api/v1/revisions/${revisionId}/submit`)
        .set(...authHeader(authorToken))
        .expect(200);

      await request(server())
        .post(`/api/v1/revisions/${revisionId}/reject`)
        .set(...authHeader(authorToken))
        .send({ reason: 'too short' })
        .expect(422);

      const { token: maintainerToken } = await tokenFor('maintainer', 'MAINTAINER');
      await request(server())
        .post(`/api/v1/revisions/${revisionId}/reject`)
        .set(...authHeader(maintainerToken))
        .send({ reason: 'Missing safety statement entirely' })
        .expect(403);

      const res = await request(server())
        .post(`/api/v1/revisions/${revisionId}/reject`)
        .set(...authHeader(authorToken))
        .send({ reason: 'Missing safety statement entirely' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        rejectedReason: 'Missing safety statement entirely',
      });
    });
  });

  it('a concurrent race to create the first revision for a template never 500s (translated to a clean error)', async () => {
    const { token } = await tokenFor('engineer', 'ENGINEER');
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(server())
          .post(`/api/v1/templates/${templateId}/revisions`)
          .set(...authHeader(token))
          .send({ revisionCode: '0', changeDescription: 'racing draft' }),
      ),
    );

    for (const res of results) {
      expect([201, 409, 422]).toContain(res.status);
    }
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(results.every((r) => r.status < 500)).toBe(true);
  });
});
