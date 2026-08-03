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

describe('Assets — GET/POST /assets, GET/PATCH /assets/{id}, area scoping', () => {
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

  async function engineerToken(): Promise<string> {
    const userId = await createUser('engineer');
    await grantRole(userId, 'ENGINEER');
    return mintAccessToken(app, userId, ['ENGINEER']);
  }

  async function makeAssetType(): Promise<string> {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    return createAssetType(formTemplateId, approvalRouteId, `AT-${randomUUID()}`);
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/assets').expect(401);
  });

  it('ENGINEER creates an asset (PR-020)', async () => {
    const token = await engineerToken();
    const assetTypeId = await makeAssetType();
    const code = `AW-${randomUUID()}`;

    const res = await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(201);

    expect(res.body).toMatchObject({ code, assetTypeId, status: 'ACTIVE', active: true });
  });

  it('writes an audit_event in the same transaction as creation (PR-098)', async () => {
    const token = await engineerToken();
    const assetTypeId = await makeAssetType();

    const res = await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code: `AW-${randomUUID()}`, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(201);

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'asset' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rows[0]?.action).toBe('create');
  });

  it('a MAINTAINER is forbidden from creating an asset (permission matrix §4.1)', async () => {
    const userId = await createUser('maintainer');
    await grantRole(userId, 'MAINTAINER');
    const token = await mintAccessToken(app, userId, ['MAINTAINER']);
    const assetTypeId = await makeAssetType();

    await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code: `AW-${randomUUID()}`, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(403);
  });

  it('rejects a duplicate asset code with 409 (INV-06, defect B-09)', async () => {
    const token = await engineerToken();
    const assetTypeId = await makeAssetType();
    const code = `AW-${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(409);
  });

  it('GET /assets/{id} 404s for an unknown id', async () => {
    const token = await engineerToken();
    await request(app.getHttpServer())
      .get(`/api/v1/assets/${randomUUID()}`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('GET /assets/{id}/history is a real, paginated, area-scoped endpoint (empty until slice 5/6/7 generate jobs)', async () => {
    const token = await engineerToken();
    const assetTypeId = await makeAssetType();
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code: `AW-${randomUUID()}`, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/assets/${createRes.body.id}/history`)
      .set(...authHeader(token))
      .expect(200);
    expect(res.body).toMatchObject({ data: [], page: { hasMore: false, nextCursor: null } });

    await request(app.getHttpServer())
      .get(`/api/v1/assets/${randomUUID()}/history`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('PATCH deactivates an asset — status/active only, never deletion (PR-039)', async () => {
    const token = await engineerToken();
    const assetTypeId = await makeAssetType();
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code: `AW-${randomUUID()}`, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(201);

    const patchRes = await request(app.getHttpServer())
      .patch(`/api/v1/assets/${createRes.body.id}`)
      .set(...authHeader(token))
      .send({ status: 'DECOMMISSIONED', active: false })
      .expect(200);

    expect(patchRes.body).toMatchObject({ status: 'DECOMMISSIONED', active: false });

    const stillThere = await adminPool.query('SELECT id FROM "asset" WHERE id = $1', [
      createRes.body.id,
    ]);
    expect(stillThere.rowCount).toBe(1);
  });

  it('a MAINTAINER is forbidden from PATCHing an asset', async () => {
    const engineer = await engineerToken();
    const assetTypeId = await makeAssetType();
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/assets')
      .set(...authHeader(engineer))
      .send({ code: `AW-${randomUUID()}`, assetTypeId, scheduleAnchorDate: '2026-01-01' })
      .expect(201);

    const userId = await createUser('maintainer');
    await grantRole(userId, 'MAINTAINER');
    const token = await mintAccessToken(app, userId, ['MAINTAINER']);

    await request(app.getHttpServer())
      .patch(`/api/v1/assets/${createRes.body.id}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(403);
  });

  describe('area scoping (PR-API-10, ADR-005 — repository-layer, mandatory)', () => {
    it('an unrestricted user (no user_area_scope rows) sees assets in every area', async () => {
      const token = await engineerToken();
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const server = app.getHttpServer();

      const idA = await createAssetCode(server, token, assetTypeId, areaA);
      const idB = await createAssetCode(server, token, assetTypeId, areaB);

      const res = await request(server)
        .get('/api/v1/assets?limit=100')
        .set(...authHeader(token))
        .expect(200);
      const ids: string[] = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toEqual(expect.arrayContaining([idA, idB]));
    });

    it("a user scoped to one area only sees that area's assets in the collection", async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);

      const engineer = await engineerToken();
      const server = app.getHttpServer();
      const assetInA = await createAssetCode(server, engineer, assetTypeId, areaA);
      await createAssetCode(server, engineer, assetTypeId, areaB);

      const scopedUserId = await createUser('scoped');
      await grantRole(scopedUserId, 'ENGINEER');
      await scopeUserToArea(scopedUserId, areaA);
      const scopedToken = await mintAccessToken(app, scopedUserId, ['ENGINEER']);

      const res = await request(server)
        .get('/api/v1/assets?limit=100')
        .set(...authHeader(scopedToken))
        .expect(200);

      const ids: string[] = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(assetInA);
      expect(res.body.data.every((a: { areaId: string | null }) => a.areaId === areaA)).toBe(true);
    });

    it('B-1: PATCH areaId: null CLEARS the area — assign → clear → reassign, and clearing removes it from scoped visibility', async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);

      const engineer = await engineerToken();
      const server = app.getHttpServer();
      const assetId = await createAssetCode(server, engineer, assetTypeId, areaA);

      // A user scoped to area A sees it while it is IN area A…
      const scopedUserId = await createUser('scoped-clear');
      await grantRole(scopedUserId, 'ENGINEER');
      await scopeUserToArea(scopedUserId, areaA);
      const scopedToken = await mintAccessToken(app, scopedUserId, ['ENGINEER']);
      const seen = await request(server)
        .get('/api/v1/assets?limit=100')
        .set(...authHeader(scopedToken))
        .expect(200);
      expect(seen.body.data.map((a: { id: string }) => a.id)).toContain(assetId);

      // …clear the assignment with an EXPLICIT null (the B-1 fix: nullable,
      // distinct from omission which must keep the current value)…
      const cleared = await request(server)
        .patch(`/api/v1/assets/${assetId}`)
        .set(...authHeader(engineer))
        .send({ areaId: null })
        .expect(200);
      expect(cleared.body.areaId).toBeNull();

      // …and the scoped user no longer sees it: area membership is
      // load-bearing for visibility, which is why the clear must exist.
      const gone = await request(server)
        .get('/api/v1/assets?limit=100')
        .set(...authHeader(scopedToken))
        .expect(200);
      expect(gone.body.data.map((a: { id: string }) => a.id)).not.toContain(assetId);

      // Omission still means "no change" (null and undefined stay distinct).
      const untouched = await request(server)
        .patch(`/api/v1/assets/${assetId}`)
        .set(...authHeader(engineer))
        .send({ description: 'still unassigned' })
        .expect(200);
      expect(untouched.body.areaId).toBeNull();

      // Reassign to area B — the full round trip.
      const reassigned = await request(server)
        .patch(`/api/v1/assets/${assetId}`)
        .set(...authHeader(engineer))
        .send({ areaId: areaB })
        .expect(200);
      expect(reassigned.body.areaId).toBe(areaB);

      // The clear is audited like any other change (before/after carry areaId).
      const audit = await adminPool.query(
        `SELECT before, after FROM "audit_event"
          WHERE entity_type = 'asset' AND entity_id = $1 AND action = 'update'
          ORDER BY occurred_at ASC`,
        [assetId],
      );
      const clearing = audit.rows.find(
        (row: { before: { areaId: string | null }; after: { areaId: string | null } }) =>
          row.before.areaId === areaA && row.after.areaId === null,
      );
      expect(clearing).toBeDefined();
    });

    it("GET /assets/{id} for an asset outside the caller's scope is 403 out-of-scope, not 404", async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);

      const engineer = await engineerToken();
      const server = app.getHttpServer();
      const assetInB = await createAssetCode(server, engineer, assetTypeId, areaB);

      const scopedUserId = await createUser('scoped2');
      await grantRole(scopedUserId, 'ENGINEER');
      await scopeUserToArea(scopedUserId, areaA);
      const scopedToken = await mintAccessToken(app, scopedUserId, ['ENGINEER']);

      const res = await request(server)
        .get(`/api/v1/assets/${assetInB}`)
        .set(...authHeader(scopedToken))
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/out-of-scope' });
    });
  });

  describe('machine-code provisional/"RED" generation (slice 13a, B-09)', () => {
    it('POST /assets without a code auto-generates one and flags it provisional/"RED"', async () => {
      const token = await engineerToken();
      const assetTypeId = await makeAssetType();

      const res = await request(app.getHttpServer())
        .post('/api/v1/assets')
        .set(...authHeader(token))
        .send({ assetTypeId, scheduleAnchorDate: '2026-01-01' })
        .expect(201);

      expect(typeof res.body.code).toBe('string');
      expect(res.body.code.length).toBeGreaterThan(0);
      expect(res.body.codeProvisional).toBe(true);
    });

    it('POST /assets WITH an explicit code is treated as already confirmed (codeProvisional: false)', async () => {
      const token = await engineerToken();
      const assetTypeId = await makeAssetType();
      const code = `AW-${randomUUID()}`;

      const res = await request(app.getHttpServer())
        .post('/api/v1/assets')
        .set(...authHeader(token))
        .send({ code, assetTypeId, scheduleAnchorDate: '2026-01-01' })
        .expect(201);

      expect(res.body).toMatchObject({ code, codeProvisional: false });
    });

    it('PATCH changing `code` confirms it — clears codeProvisional', async () => {
      const token = await engineerToken();
      const assetTypeId = await makeAssetType();

      const created = await request(app.getHttpServer())
        .post('/api/v1/assets')
        .set(...authHeader(token))
        .send({ assetTypeId, scheduleAnchorDate: '2026-01-01' })
        .expect(201);
      expect(created.body.codeProvisional).toBe(true);

      const confirmedCode = `IMOS-${randomUUID()}`;
      const patched = await request(app.getHttpServer())
        .patch(`/api/v1/assets/${created.body.id}`)
        .set(...authHeader(token))
        .send({ code: confirmedCode })
        .expect(200);

      expect(patched.body).toMatchObject({ code: confirmedCode, codeProvisional: false });
    });

    it('PATCH sending the SAME code back does not spuriously clear codeProvisional', async () => {
      const token = await engineerToken();
      const assetTypeId = await makeAssetType();

      const created = await request(app.getHttpServer())
        .post('/api/v1/assets')
        .set(...authHeader(token))
        .send({ assetTypeId, scheduleAnchorDate: '2026-01-01' })
        .expect(201);
      expect(created.body.codeProvisional).toBe(true);

      const patched = await request(app.getHttpServer())
        .patch(`/api/v1/assets/${created.body.id}`)
        .set(...authHeader(token))
        .send({ code: created.body.code, description: 'no-op code resend' })
        .expect(200);

      expect(patched.body).toMatchObject({ code: created.body.code, codeProvisional: true });
    });

    it('a PATCH that never touches `code` leaves codeProvisional untouched', async () => {
      const token = await engineerToken();
      const assetTypeId = await makeAssetType();

      const created = await request(app.getHttpServer())
        .post('/api/v1/assets')
        .set(...authHeader(token))
        .send({ assetTypeId, scheduleAnchorDate: '2026-01-01' })
        .expect(201);

      const patched = await request(app.getHttpServer())
        .patch(`/api/v1/assets/${created.body.id}`)
        .set(...authHeader(token))
        .send({ description: 'unrelated field' })
        .expect(200);

      expect(patched.body.codeProvisional).toBe(true);
    });
  });

  /** Creates an asset directly in the given area via POST, returns its id. */
  async function createAssetCode(
    server: unknown,
    token: string,
    assetTypeId: string,
    areaId: string,
  ): Promise<string> {
    const res = await request(server as never)
      .post('/api/v1/assets')
      .set(...authHeader(token))
      .send({ code: `AW-${randomUUID()}`, assetTypeId, scheduleAnchorDate: '2026-01-01', areaId })
      .expect(201);
    return res.body.id as string;
  }

  /**
   * INV-09 — an archived record's PRINTED machine identity is immutable.
   *
   * `asset.code` is read live on every render and printed as the machine code
   * in the PDF header and footer (and as `assetCode` in an export manifest) —
   * nothing is frozen at archive. Renaming a machine therefore rewrote every
   * archived record for it at once, and `/integrity` still said `intact: true`
   * because the canonical record binds `job.assetId`, not the asset's
   * descriptive columns.
   *
   * The ALLOW cases carry the weight here: `code` is the ONLY column of the row
   * that reaches a rendered artefact, so describing, re-siting or retiring a
   * machine must never be blocked.
   */
  describe('an archived record’s printed machine identity is immutable (INV-09)', () => {
    async function machineWithArchivedRecord(): Promise<{ assetId: string; token: string }> {
      const token = await engineerToken();
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId = await createAsset(assetTypeId, `AW-${randomUUID()}`);
      const authorId = await createUser('revision-author');
      const revisionId = await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      await createJob({
        assetId,
        templateRevisionId: revisionId,
        approvalRouteId,
        jobNumber: `ARCH-${randomUUID().slice(0, 8)}`,
        status: 'archived',
        archivedAt: new Date(),
      });
      return { assetId, token };
    }

    async function storedAsset(assetId: string) {
      const row = await adminPool.query(`SELECT code, description FROM "asset" WHERE id = $1`, [
        assetId,
      ]);
      return row.rows[0] as { code: string; description: string | null };
    }

    it('refuses a code change, with the specific problem type', async () => {
      const { assetId, token } = await machineWithArchivedRecord();
      const before = await storedAsset(assetId);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/assets/${assetId}`)
        .set(...authHeader(token))
        .send({ code: 'AW99' })
        .expect(409);

      expect(res.body).toMatchObject({
        type: '/errors/archived-record-dependency',
        title: 'An archived record depends on this value',
        status: 409,
      });
      expect(res.body.detail).toContain('the machine code');
      expect(res.body.detail).toContain(before.code);
      expect(res.body.detail).toContain('AW99');
      expect(res.body.errors[0]).toMatchObject({
        pointer: '/code',
        code: 'ARCHIVED_RECORD_DEPENDENCY',
      });

      // And it actually refused.
      expect((await storedAsset(assetId)).code).toBe(before.code);
    });

    it('ALLOWS a description change — description is not rendered on the record', async () => {
      // Measured, not assumed: `pdf-html-template.ts` emits exactly one
      // asset-derived value, `esc(input.machineCode)`. `assetDescription` is
      // assembled into `PdfRecordInput` and then never printed, and it is not
      // in the export manifest either. Refusing here would 409 an engineer
      // fixing a typo with a message claiming archived records would print
      // differently — which would be false.
      const { assetId, token } = await machineWithArchivedRecord();

      await request(app.getHttpServer())
        .patch(`/api/v1/assets/${assetId}`)
        .set(...authHeader(token))
        .send({ description: 'Rewritten description' })
        .expect(200);

      expect((await storedAsset(assetId)).description).toBe('Rewritten description');
    });

    it('ALLOWS the same edit on a machine with no archived record', async () => {
      // Someone fixing a typo on a new machine must never be blocked.
      const assetTypeId = await makeAssetType();
      const token = await engineerToken();
      const created = await request(app.getHttpServer())
        .post('/api/v1/assets')
        .set(...authHeader(token))
        .send({ code: `AW-${randomUUID()}`, assetTypeId, scheduleAnchorDate: '2026-01-01' })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/assets/${created.body.id}`)
        .set(...authHeader(token))
        .send({ code: 'AW42', description: 'Corrected' })
        .expect(200);
      expect(await storedAsset(created.body.id)).toMatchObject({
        code: 'AW42',
        description: 'Corrected',
      });
    });

    it('ALLOWS editing fields that do not print, even with an archived record', async () => {
      // `description`, `manufacturer`, `model`, `locationDetail`, `status` and
      // `active` never reach the PDF, so describing, re-siting or retiring a
      // machine stays ordinary work.
      const { assetId, token } = await machineWithArchivedRecord();

      await request(app.getHttpServer())
        .patch(`/api/v1/assets/${assetId}`)
        .set(...authHeader(token))
        .send({
          description: 'Redescribed',
          manufacturer: 'ASM',
          model: 'Eagle60',
          locationDetail: 'Bay 4',
          status: 'UNDER_REPAIR',
          active: false,
        })
        .expect(200);
    });

    it('ALLOWS a no-op re-send of the same printed value', async () => {
      const { assetId, token } = await machineWithArchivedRecord();
      const before = await storedAsset(assetId);

      await request(app.getHttpServer())
        .patch(`/api/v1/assets/${assetId}`)
        .set(...authHeader(token))
        .send({ code: before.code })
        .expect(200);
    });

    it('ALLOWS the change when the archived record belongs to ANOTHER machine', async () => {
      const { token } = await machineWithArchivedRecord();
      const assetTypeId = await makeAssetType();
      const otherId = await createAsset(assetTypeId, `AW-${randomUUID()}`);

      await request(app.getHttpServer())
        .patch(`/api/v1/assets/${otherId}`)
        .set(...authHeader(token))
        .send({ code: 'AW77' })
        .expect(200);
      expect((await storedAsset(otherId)).code).toBe('AW77');
    });
  });
});
