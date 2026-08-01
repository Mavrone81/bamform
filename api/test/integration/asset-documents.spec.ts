import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetDocument,
  createAssetType,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * Slice 27-ASSETDOC §4.6 — the read/write API the admin tagging screen and the
 * maintainer's form picker (slice 28-ASSETDOC-UI) consume.
 *
 * `titleHasFillableRun` and `resolvedTitle` are DERIVED per response, never
 * stored, so a template revision that changes the title stays correct.
 */
describe('Asset documents — GET/POST /assets/{assetId}/documents, PATCH /asset-documents/{id}', () => {
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

  /** A form_template with a REAL title, so the fillable-run flag means something. */
  async function createTitledTemplate(title: string): Promise<string> {
    const result = await adminPool.query(
      `INSERT INTO "form_template" ("document_number", "title") VALUES ($1, $2) RETURNING id`,
      [`DOC-${randomUUID()}`, title],
    );
    return result.rows[0].id as string;
  }

  async function makeMachine(): Promise<string> {
    const approvalRouteId = await getSeededApprovalRouteId();
    const assetTypeId = await createAssetType(
      await createTitledTemplate('Unused family template'),
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    return createAsset(assetTypeId, `AS-${randomUUID()}`, { skipDefaultDocument: true });
  }

  async function tokens() {
    const adminId = await createUser('admin');
    await grantRole(adminId, 'ADMIN');
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const engineerId = await createUser('engineer');
    await grantRole(engineerId, 'ENGINEER');
    return {
      admin: await mintAccessToken(app, adminId, ['ADMIN']),
      maintainer: await mintAccessToken(app, maintainerId, ['MAINTAINER']),
      engineer: await mintAccessToken(app, engineerId, ['ENGINEER']),
    };
  }

  it('rejects an unauthenticated request', async () => {
    const assetId = await makeMachine();
    await request(app.getHttpServer()).get(`/api/v1/assets/${assetId}/documents`).expect(401);
  });

  it("lists a machine's documents with the resolved title", async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate(
      'KNS Wire Bond Preventive Maintenance Record KW___',
    );
    await createAssetDocument(assetId, templateId, { machineNumber: '13' });
    const t = await tokens();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.maintainer))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      assetId,
      formTemplateId: templateId,
      machineNumber: '13',
      title: 'KNS Wire Bond Preventive Maintenance Record KW___',
      resolvedTitle: 'KNS Wire Bond Preventive Maintenance Record KW13',
      titleHasFillableRun: true,
      active: true,
    });
  });

  it('leaves the blank intact when no machineNumber was given — as the paper form is', async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate(
      'BESI Die Attach Preventive Maintenance Record ED____',
    );
    await createAssetDocument(assetId, templateId);
    const t = await tokens();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.maintainer))
      .expect(200);

    expect(res.body.data[0]).toMatchObject({
      machineNumber: null,
      resolvedTitle: 'BESI Die Attach Preventive Maintenance Record ED____',
      titleHasFillableRun: true,
    });
  });

  it('reports titleHasFillableRun false for a fixed title, so no field is offered', async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate('Preventive Maintenance Record EP01');
    await createAssetDocument(assetId, templateId);
    const t = await tokens();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.maintainer))
      .expect(200);

    expect(res.body.data[0].titleHasFillableRun).toBe(false);
    expect(res.body.data[0].resolvedTitle).toBe('Preventive Maintenance Record EP01');
  });

  it('ADMIN tags a document, and the same machine may carry several', async () => {
    const assetId = await makeMachine();
    const phCheck = await createTitledTemplate('pH Meter Check Record MB_____');
    const pm = await createTitledTemplate('MB Encapsulation Preventive Maintenance Record MB_____');
    const t = await tokens();

    await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: phCheck, machineNumber: '02' })
      .expect(201);
    // TE7's case: a second, independent document on the same machine.
    await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: pm })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .expect(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('accepts a machineNumber for a fixed title without error — never a validation failure', async () => {
    // Owner, 2026-07-29: "Is ok some forms are already pre updated just allow
    // user to choose". It is accepted and simply has nothing to substitute into.
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate('Preventive Maintenance Record EP01');
    const t = await tokens();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: templateId, machineNumber: '99' })
      .expect(201);

    expect(res.body).toMatchObject({
      machineNumber: '99',
      titleHasFillableRun: false,
      resolvedTitle: 'Preventive Maintenance Record EP01',
    });
  });

  it('rejects tagging the same document twice to one machine', async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate('Preventive Maintenance Record PM01');
    const t = await tokens();

    await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: templateId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: templateId })
      .expect(409);
  });

  it('404s for an unknown machine, and for an unknown template', async () => {
    const assetId = await makeMachine();
    const t = await tokens();

    await request(app.getHttpServer())
      .post(`/api/v1/assets/${randomUUID()}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: await createTitledTemplate('X') })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: randomUUID() })
      .expect(404);
  });

  it('an ENGINEER may tag — the same gate as POST /assets, which creates the machine (m-1)', async () => {
    // An engineer who can create a machine can finish it. Otherwise they can
    // create one that is permanently inert until an admin tags a document.
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate('Preventive Maintenance Record PM01');
    const t = await tokens();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.engineer))
      .send({ formTemplateId: templateId })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/asset-documents/${res.body.id}`)
      .set(...authHeader(t.engineer))
      .send({ machineNumber: '4' })
      .expect(200);
  });

  it('a MAINTAINER may not write', async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate('Preventive Maintenance Record PM01');
    const t = await tokens();

    await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.maintainer))
      .send({ formTemplateId: templateId })
      .expect(403);

    const docId = await createAssetDocument(assetId, templateId);
    await request(app.getHttpServer())
      .patch(`/api/v1/asset-documents/${docId}`)
      .set(...authHeader(t.maintainer))
      .send({ machineNumber: '7' })
      .expect(403);
  });

  it('PATCH changes the machine number, and the resolved title follows', async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate(
      'KNS Wire Bond Preventive Maintenance Record KW___',
    );
    const docId = await createAssetDocument(assetId, templateId, { machineNumber: '13' });
    const t = await tokens();

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/asset-documents/${docId}`)
      .set(...authHeader(t.admin))
      .send({ machineNumber: '21' })
      .expect(200);

    expect(res.body).toMatchObject({
      machineNumber: '21',
      resolvedTitle: 'KNS Wire Bond Preventive Maintenance Record KW21',
    });
  });

  it('deactivates rather than deletes — INV-16, and history stays resolvable', async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate('Preventive Maintenance Record PM01');
    const docId = await createAssetDocument(assetId, templateId);
    const t = await tokens();

    await request(app.getHttpServer())
      .patch(`/api/v1/asset-documents/${docId}`)
      .set(...authHeader(t.admin))
      .send({ active: false })
      .expect(200);

    const row = await adminPool.query(`SELECT active FROM "asset_document" WHERE id = $1`, [docId]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].active).toBe(false);

    // A deactivated document is still listed (history must stay visible); the
    // scheduler is what stops raising work for it.
    const listed = await request(app.getHttpServer())
      .get(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].active).toBe(false);
  });

  /**
   * Review m-4. Mirrors `scheduling.spec.ts`'s "outside area scope is 403, not
   * 404" test for the sibling `/assets/{id}/schedule` endpoint, so deleting
   * `getAssetInScopeOrThrow` from `AssetDocumentsService` is caught on all three
   * routes rather than on none.
   */
  describe('area scoping — 403 out-of-scope, never a silent 404 (m-4)', () => {
    async function machineInAnotherArea() {
      const areaMine = await createArea(`A-${randomUUID()}`);
      const areaTheirs = await createArea(`B-${randomUUID()}`);
      const approvalRouteId = await getSeededApprovalRouteId();
      const assetTypeId = await createAssetType(
        await createTitledTemplate('Unused family template'),
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
        areaId: areaTheirs,
        skipDefaultDocument: true,
      });
      const templateId = await createTitledTemplate('Preventive Maintenance Record PM01');
      const docId = await createAssetDocument(assetId, templateId);

      // An ADMIN scoped to a DIFFERENT area — the role gate passes, so only the
      // area check can refuse. Scoping an admin is what makes this test about
      // scoping rather than about roles.
      const userId = await createUser('scoped-admin');
      await grantRole(userId, 'ADMIN');
      await scopeUserToArea(userId, areaMine);
      const token = await mintAccessToken(app, userId, ['ADMIN']);
      return { assetId, templateId, docId, token };
    }

    it('GET is 403 for a machine outside the caller’s area', async () => {
      const { assetId, token } = await machineInAnotherArea();
      await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/documents`)
        .set(...authHeader(token))
        .expect(403);
    });

    it('POST is 403 for a machine outside the caller’s area, and tags nothing', async () => {
      const { assetId, templateId, token } = await machineInAnotherArea();
      await request(app.getHttpServer())
        .post(`/api/v1/assets/${assetId}/documents`)
        .set(...authHeader(token))
        .send({ formTemplateId: templateId })
        .expect(403);

      const rows = await adminPool.query(
        `SELECT count(*)::int AS n FROM "asset_document" WHERE asset_id = $1`,
        [assetId],
      );
      expect(rows.rows[0].n).toBe(1); // only the one seeded above
    });

    it('PATCH is 403 for a document on a machine outside the caller’s area, and changes nothing', async () => {
      const { docId, token } = await machineInAnotherArea();
      await request(app.getHttpServer())
        .patch(`/api/v1/asset-documents/${docId}`)
        .set(...authHeader(token))
        .send({ active: false })
        .expect(403);

      const row = await adminPool.query(`SELECT active FROM "asset_document" WHERE id = $1`, [
        docId,
      ]);
      expect(row.rows[0].active).toBe(true);
    });
  });

  it('writes an audit_event in the same transaction as the tag (PR-098)', async () => {
    const assetId = await makeMachine();
    const templateId = await createTitledTemplate('Preventive Maintenance Record PM01');
    const t = await tokens();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/assets/${assetId}/documents`)
      .set(...authHeader(t.admin))
      .send({ formTemplateId: templateId })
      .expect(201);

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'asset_document' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rows[0]?.action).toBe('create');
  });
});
