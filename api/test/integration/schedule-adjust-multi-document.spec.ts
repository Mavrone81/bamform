import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
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

/**
 * Slice 27-ASSETDOC review addition — the multi-document 422 ambiguity guard
 * on `PUT /assets/{assetId}/schedule`, which the slice report flagged as
 * covered by reasoning only.
 */
describe('PUT /assets/{id}/schedule with several documents (slice 27)', () => {
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

  async function seed(documentCount: number) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const assetTypeId = await createAssetType(
      await createFormTemplate(`DOC-UNUSED-${randomUUID()}`),
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      skipDefaultDocument: true,
    });
    const docs: string[] = [];
    for (let i = 0; i < documentCount; i += 1) {
      const templateId = await createFormTemplate(`DOC-${i}-${randomUUID()}`);
      const revisionId = await createTemplateRevision(templateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      await createTemplateItem(revisionId, 'M1');
      docs.push(await createAssetDocument(assetId, templateId));
    }
    const plannerId = await createUser('planner');
    await grantRole(plannerId, 'PLANNER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      plannerId,
    ]);
    const token = await mintAccessToken(app, plannerId, ['PLANNER']);
    // Materialise the rules via the lazy bootstrap on GET.
    await request(app.getHttpServer())
      .get(`/api/v1/assets/${assetId}/schedule`)
      .set(...authHeader(token))
      .expect(200);
    return { assetId, docs, token };
  }

  const BODY = { frequency: 'M1', nextDueOn: '2027-01-31', adjustedReason: 'reviewer probe body' };

  it('one document: no assetDocumentId still works (back-compat)', async () => {
    const { assetId, token } = await seed(1);
    const res = await request(app.getHttpServer())
      .put(`/api/v1/assets/${assetId}/schedule`)
      .set(...authHeader(token))
      .send(BODY);
    expect(res.status).toBe(200);
  });

  it('two documents at the same frequency: 422, and NOTHING is adjusted', async () => {
    const { assetId, docs, token } = await seed(2);
    const res = await request(app.getHttpServer())
      .put(`/api/v1/assets/${assetId}/schedule`)
      .set(...authHeader(token))
      .send(BODY);
    expect(res.status).toBe(422);
    const rows = await adminPool.query(
      `SELECT next_due_on, adjusted_reason FROM "schedule_rule"
        WHERE asset_document_id = ANY($1::uuid[])`,
      [docs],
    );
    expect(rows.rows.every((r) => r.adjusted_reason === null)).toBe(true);
  });

  it('naming the document adjusts exactly that one', async () => {
    const { assetId, docs, token } = await seed(2);
    const res = await request(app.getHttpServer())
      .put(`/api/v1/assets/${assetId}/schedule`)
      .set(...authHeader(token))
      .send({ ...BODY, assetDocumentId: docs[1] });
    expect(res.status).toBe(200);
    expect(res.body.assetDocumentId).toBe(docs[1]);
    const other = await adminPool.query(
      `SELECT adjusted_reason FROM "schedule_rule" WHERE asset_document_id = $1`,
      [docs[0]],
    );
    expect(other.rows[0].adjusted_reason).toBeNull();
  });

  it('a document belonging to ANOTHER machine is a 404, not a cross-machine adjust', async () => {
    const a = await seed(1);
    const b = await seed(1);
    const res = await request(app.getHttpServer())
      .put(`/api/v1/assets/${a.assetId}/schedule`)
      .set(...authHeader(a.token))
      .send({ ...BODY, assetDocumentId: b.docs[0] });
    expect(res.status).toBe(404);
    const other = await adminPool.query(
      `SELECT adjusted_reason FROM "schedule_rule" WHERE asset_document_id = $1`,
      [b.docs[0]],
    );
    expect(other.rows[0].adjusted_reason).toBeNull();
  });

  /**
   * Review m-6. A RETIRED document's rules were still listed and still
   * adjustable, and still counted toward the 422 ambiguity above — so
   * deactivating one of two documents did not restore the unambiguous case.
   * `job-generation.service.ts` already filters on `assetDocument.active`, so
   * nothing was actually generated for them; the inconsistency was between
   * what a planner is shown and what the scheduler does.
   */
  describe('a deactivated document is not part of the machine’s live schedule (m-6)', () => {
    it('GET omits a retired document’s rules', async () => {
      const { assetId, docs, token } = await seed(2);
      await adminPool.query(`UPDATE "asset_document" SET active = false WHERE id = $1`, [docs[1]]);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .expect(200);

      expect(res.body.map((r: { assetDocumentId: string }) => r.assetDocumentId)).toEqual([
        docs[0],
      ]);
    });

    it('retiring one of two documents makes PUT unambiguous again, not a 422', async () => {
      const { assetId, docs, token } = await seed(2);
      await adminPool.query(`UPDATE "asset_document" SET active = false WHERE id = $1`, [docs[1]]);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .send(BODY);

      expect(res.status).toBe(200);
      expect(res.body.assetDocumentId).toBe(docs[0]);
    });

    it('a retired document cannot be adjusted even when named explicitly', async () => {
      const { assetId, docs, token } = await seed(2);
      await adminPool.query(`UPDATE "asset_document" SET active = false WHERE id = $1`, [docs[1]]);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/assets/${assetId}/schedule`)
        .set(...authHeader(token))
        .send({ ...BODY, assetDocumentId: docs[1] });

      expect(res.status).toBe(404);
      const row = await adminPool.query(
        `SELECT adjusted_reason FROM "schedule_rule" WHERE asset_document_id = $1`,
        [docs[1]],
      );
      expect(row.rows[0].adjusted_reason).toBeNull();
    });
  });
});
