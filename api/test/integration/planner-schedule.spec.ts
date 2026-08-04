import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetDocument,
  createAssetType,
  createFormTemplate,
  createJob,
  createScheduleRule,
  createTemplateRevision,
  createUser,
  getAssetDocumentId,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

interface PlannerRow {
  id: string;
  assetId: string;
  assetCode: string;
  areaId: string | null;
  assetDocumentId: string;
  documentNumber: string;
  documentTitle: string;
  frequency: string;
  intervalMonths: number;
  nextDueOn: string;
  lastCompletedOn: string | null;
  plannedDates: string[];
  cascadeFrequencies: string[];
  nextDueJob: { id: string; jobNumber: string; status: string } | null;
  jobGenerationOpensOn: string;
}

const YEAR = '?from=2026-01-01&to=2026-12-31&limit=100';

/**
 * Slice 31-PLANNER — `GET /schedule`, the cross-machine planner grid.
 *
 * The area-scoping block below is the one that matters. This is the ONLY
 * endpoint in the system that returns rows for every machine in the plant in
 * a single response, so a missing `applyAreaScope` here does not leak one
 * extra row — it hands a planner scoped to one area the whole site's
 * maintenance plan. `scope-coverage.spec.ts` statically pins that the
 * repository still CALLS `applyAreaScope`; only this file proves the call
 * actually filters.
 */
describe('Planner schedule — GET /schedule (cross-machine, area-scoped)', () => {
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

  async function plannerToken(userId?: string): Promise<string> {
    const id = userId ?? (await createUser('planner'));
    await grantRole(id, 'PLANNER');
    return mintAccessToken(app, id, ['PLANNER']);
  }

  async function makeAssetType(): Promise<string> {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    return createAssetType(formTemplateId, approvalRouteId, `AT-${randomUUID()}`);
  }

  /** A machine with one document and one rule at `frequency`, in `areaId`. */
  async function makeScheduledMachine(opts: {
    assetTypeId: string;
    areaId?: string | null;
    code?: string;
    frequency?: 'M1' | 'M3' | 'M6' | 'Y';
    intervalMonths?: number;
    nextDueOn?: string;
  }) {
    const code = opts.code ?? `AS-${randomUUID()}`;
    const assetId = await createAsset(opts.assetTypeId, code, {
      areaId: opts.areaId ?? null,
      scheduleAnchorDate: '2026-01-01',
    });
    const ruleId = await createScheduleRule(assetId, {
      frequency: opts.frequency ?? 'M3',
      intervalMonths: opts.intervalMonths ?? 3,
      anchorDate: '2026-01-01',
      nextDueOn: opts.nextDueOn ?? '2026-02-10',
    });
    return { assetId, code, ruleId };
  }

  function get(token: string, query = YEAR) {
    return request(app.getHttpServer())
      .get(`/api/v1/schedule${query}`)
      .set(...authHeader(token));
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/schedule').expect(401);
  });

  // ------------------------------------------------------------------ scoping

  describe('area scoping (PR-API-10, ADR-005) — the whole plant in one response', () => {
    it('a scoped planner sees ONLY their own area, not the rest of the plant', async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const mine = await makeScheduledMachine({ assetTypeId, areaId: areaA });
      const theirs = await makeScheduledMachine({ assetTypeId, areaId: areaB });

      const userId = await createUser('scoped-planner');
      await scopeUserToArea(userId, areaA);
      const token = await plannerToken(userId);

      const res = await get(token).expect(200);
      const rows: PlannerRow[] = res.body.data;

      expect(rows.map((r) => r.assetId)).toEqual([mine.assetId]);
      // Stated separately and deliberately: the assertion that matters is not
      // "mine is present" but "theirs is ABSENT". A filter that returned
      // everything would satisfy the first and fail only this.
      expect(rows.some((r) => r.assetId === theirs.assetId)).toBe(false);
      expect(rows.some((r) => r.id === theirs.ruleId)).toBe(false);
    });

    it('an unrestricted user (no user_area_scope rows) sees every area', async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const a = await makeScheduledMachine({ assetTypeId, areaId: areaA });
      const b = await makeScheduledMachine({ assetTypeId, areaId: areaB });

      const res = await get(await plannerToken()).expect(200);
      const ids: string[] = res.body.data.map((r: PlannerRow) => r.assetId);
      expect(ids).toEqual(expect.arrayContaining([a.assetId, b.assetId]));
    });

    /**
     * A machine with NO area is invisible to a scoped user, exactly as it is
     * on `GET /assets`: `applyAreaScope` writes `areaId IN (...)`, and SQL
     * `NULL IN (...)` is never true. Pinned so the planner grid can never
     * become the one place an unassigned machine leaks.
     */
    it('a machine with no area is invisible to a scoped user', async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      await makeScheduledMachine({ assetTypeId, areaId: null });
      const mine = await makeScheduledMachine({ assetTypeId, areaId: areaA });

      const userId = await createUser('scoped-planner');
      await scopeUserToArea(userId, areaA);

      const res = await get(await plannerToken(userId)).expect(200);
      expect(res.body.data.map((r: PlannerRow) => r.assetId)).toEqual([mine.assetId]);
    });

    it('an explicit ?areaId= outside the caller’s scope narrows to nothing — it never widens', async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      await makeScheduledMachine({ assetTypeId, areaId: areaA });
      await makeScheduledMachine({ assetTypeId, areaId: areaB });

      const userId = await createUser('scoped-planner');
      await scopeUserToArea(userId, areaA);
      const token = await plannerToken(userId);

      const res = await get(token, `${YEAR}&areaId=${areaB}`).expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('a scoped user asking for their OWN area still sees it', async () => {
      const assetTypeId = await makeAssetType();
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const mine = await makeScheduledMachine({ assetTypeId, areaId: areaA });

      const userId = await createUser('scoped-planner');
      await scopeUserToArea(userId, areaA);
      const token = await plannerToken(userId);

      const res = await get(token, `${YEAR}&areaId=${areaA}`).expect(200);
      expect(res.body.data.map((r: PlannerRow) => r.assetId)).toEqual([mine.assetId]);
    });
  });

  // ------------------------------------------------------------------- roles

  /**
   * The read carries NO `@Roles()`, matching `GET /assets/{assetId}/schedule`.
   * `route-roles.spec.ts` pins the metadata; this pins the behaviour a role
   * change would alter — a MAINTAINER and an AUDITOR can read the grid, and
   * neither gains any write from it.
   */
  it('is readable by every authenticated role, not only the planning ones', async () => {
    const assetTypeId = await makeAssetType();
    const machine = await makeScheduledMachine({ assetTypeId });

    for (const role of ['MAINTAINER', 'AUDITOR', 'DOC_CONTROLLER'] as const) {
      const userId = await createUser(role.toLowerCase());
      await grantRole(userId, role);
      const token = await mintAccessToken(app, userId, [role]);
      const res = await get(token).expect(200);
      expect(res.body.data.map((r: PlannerRow) => r.assetId)).toContain(machine.assetId);
    }
  });

  // ------------------------------------------------------------- the payload

  it('returns the standard page envelope, not the bare array the per-asset read returns', async () => {
    const assetTypeId = await makeAssetType();
    await makeScheduledMachine({ assetTypeId });

    const res = await get(await plannerToken()).expect(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body).toMatchObject({
      page: { hasMore: false, nextCursor: null, limit: 100 },
    });
  });

  it('carries the machine and the document on every row, so the grid needs no second call', async () => {
    const assetTypeId = await makeAssetType();
    const areaId = await createArea(`AREA-${randomUUID()}`);
    const { assetId, code } = await makeScheduledMachine({
      assetTypeId,
      areaId,
      frequency: 'M3',
      intervalMonths: 3,
      nextDueOn: '2026-02-10',
    });
    const assetDocumentId = await getAssetDocumentId(assetId);

    const res = await get(await plannerToken()).expect(200);
    const row: PlannerRow = res.body.data[0];

    expect(row).toMatchObject({
      assetId,
      assetCode: code,
      areaId,
      assetDocumentId,
      frequency: 'M3',
      intervalMonths: 3,
      nextDueOn: '2026-02-10',
      lastCompletedOn: null,
    });
    expect(row.documentNumber).toMatch(/^DOC-/);
    expect(row.documentTitle.length).toBeGreaterThan(0);
  });

  it('projects a rule across the whole window, not just its single next due date', async () => {
    const assetTypeId = await makeAssetType();
    await makeScheduledMachine({
      assetTypeId,
      frequency: 'M3',
      intervalMonths: 3,
      nextDueOn: '2026-02-10',
    });

    const res = await get(await plannerToken()).expect(200);
    expect(res.body.data[0].plannedDates).toEqual([
      '2026-02-10',
      '2026-05-10',
      '2026-08-10',
      '2026-11-10',
    ]);
  });

  it('advances a rule anchored before the window into it', async () => {
    const assetTypeId = await makeAssetType();
    await makeScheduledMachine({
      assetTypeId,
      frequency: 'M6',
      intervalMonths: 6,
      nextDueOn: '2025-09-15',
    });

    const res = await get(await plannerToken()).expect(200);
    expect(res.body.data[0]).toMatchObject({
      nextDueOn: '2025-09-15',
      plannedDates: ['2026-03-15', '2026-09-15'],
    });
  });

  /**
   * PR-053's cascade, as the grid needs it: a yearly visit is not one cell's
   * worth of work, it is the annual PLUS the 6M, 3M and 1M items. Without
   * this a load bar would tell a planner four monthlies outweigh three
   * annuals.
   */
  it('reports what one visit carries — the frequency cascade, per rule', async () => {
    const assetTypeId = await makeAssetType();
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      scheduleAnchorDate: '2026-01-01',
    });
    for (const [frequency, intervalMonths] of [
      ['M1', 1],
      ['M3', 3],
      ['M6', 6],
      ['Y', 12],
    ] as const) {
      await createScheduleRule(assetId, {
        frequency,
        intervalMonths,
        anchorDate: '2026-01-01',
        nextDueOn: '2026-01-05',
      });
    }

    const res = await get(await plannerToken()).expect(200);
    const byFrequency = new Map<string, string[]>(
      res.body.data.map((r: PlannerRow) => [r.frequency, r.cascadeFrequencies]),
    );

    expect(byFrequency.get('M1')).toEqual(['M1']);
    expect(byFrequency.get('M3')).toEqual(['M1', 'M3']);
    expect(byFrequency.get('M6')).toEqual(['M1', 'M3', 'M6']);
    expect(byFrequency.get('Y')).toEqual(['M1', 'M3', 'M6', 'Y']);
  });

  it('reports only the frequencies the document really has (U-CAS-05), not every divisor', async () => {
    const assetTypeId = await makeAssetType();
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      scheduleAnchorDate: '2026-01-01',
    });
    // A quarterly rule on a document with NO monthly rule: there is nothing to
    // do monthly on this machine, so the quarterly visit carries {M3} alone.
    await createScheduleRule(assetId, {
      frequency: 'M3',
      intervalMonths: 3,
      anchorDate: '2026-01-01',
      nextDueOn: '2026-01-05',
    });

    const res = await get(await plannerToken()).expect(200);
    expect(res.body.data[0].cascadeFrequencies).toEqual(['M3']);
  });

  // ------------------------------------------------------------- exclusions

  it('excludes a rule belonging to a RETIRED document — it will never raise work', async () => {
    const assetTypeId = await makeAssetType();
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      scheduleAnchorDate: '2026-01-01',
      skipDefaultDocument: true,
    });
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const retiredDocumentId = await createAssetDocument(assetId, templateId, { active: false });
    await createScheduleRule(assetId, {
      frequency: 'M1',
      intervalMonths: 1,
      anchorDate: '2026-01-01',
      assetDocumentId: retiredDocumentId,
    });

    const res = await get(await plannerToken()).expect(200);
    expect(res.body.data).toEqual([]);
  });

  /**
   * Review M-1. The grid must draw what the scheduler will actually raise:
   * `job-generation.service.ts` filters `{ active: true, assetDocument: {
   * active: true } }`, and so does this. Deliberately STRICTER than
   * `asset-schedule.service.ts`, which lets an inactive rule through so the
   * per-machine screen can label it "Retired" — on a forward plan a row that
   * will never generate work is a phantom, and this is the one screen whose
   * whole job is judging how much load a week carries.
   *
   * Nothing in the API sets `schedule_rule.active` false today, so this is
   * only reachable by writing the column directly — which is the point: it
   * has to be right before the first writer arrives.
   */
  it('excludes an inactive RULE, exactly as job generation does', async () => {
    const assetTypeId = await makeAssetType();
    const { assetId, ruleId } = await makeScheduledMachine({ assetTypeId });
    const live = await makeScheduledMachine({ assetTypeId });

    await adminPool.query(`UPDATE "schedule_rule" SET "active" = false WHERE id = $1`, [ruleId]);

    const res = await get(await plannerToken()).expect(200);
    const rows: PlannerRow[] = res.body.data;
    expect(rows.map((r) => r.assetId)).toEqual([live.assetId]);
    expect(rows.some((r) => r.id === ruleId)).toBe(false);
    // The machine itself is not hidden — only that one dead rule.
    expect(assetId).not.toBe(live.assetId);
  });

  it('excludes a rule due entirely after the window', async () => {
    const assetTypeId = await makeAssetType();
    await makeScheduledMachine({ assetTypeId, nextDueOn: '2027-04-01' });

    const res = await get(await plannerToken()).expect(200);
    expect(res.body.data).toEqual([]);
  });

  // ------------------------------------------------- the job for a visit (32)

  /**
   * Slice 32-PLANNERJOB. The planner shows when work is DUE; `/jobs/{id}` is
   * where it is DONE. These pin the join between them.
   *
   * The assertions that matter are the negative ones. A link that merely
   * renders is worthless — what a planner needs is that the link goes to the
   * job for THIS visit and to no other. `job` is keyed
   * `(asset_document_id, frequency_scope, due_on) WHERE status <> 'voided' AND
   * is_adhoc = false`, and every one of those qualifiers is a way to get the
   * wrong answer: a machine's second document, a rule at another frequency, a
   * previous period's completed job, a voided job whose replacement is still
   * to come, and — the one this whole slice exists to prevent — an ad-hoc
   * job, which carries an EMPTY `frequency_scope` and cannot advance
   * `schedule_rule.next_due_on` at all.
   */
  describe('nextDueJob — the job the scheduler raised for the stored due date', () => {
    /**
     * A machine whose document can actually carry jobs: a real `current`
     * template revision to hang them off, and a rule at a known due date.
     */
    async function makeJobbableMachine(
      opts: {
        frequency?: 'M1' | 'M3' | 'M6' | 'Y';
        intervalMonths?: number;
        nextDueOn?: string;
        leadTimeDays?: number;
      } = {},
    ) {
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
        { leadTimeDays: opts.leadTimeDays },
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
        scheduleAnchorDate: '2026-01-01',
      });
      const assetDocumentId = await getAssetDocumentId(assetId);
      const authorId = await createUser('template-author');
      const templateRevisionId = await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      const frequency = opts.frequency ?? 'M3';
      const nextDueOn = opts.nextDueOn ?? '2026-03-19';
      const ruleId = await createScheduleRule(assetId, {
        frequency,
        intervalMonths: opts.intervalMonths ?? 3,
        anchorDate: '2026-01-01',
        nextDueOn,
      });
      return {
        assetId,
        assetDocumentId,
        templateRevisionId,
        approvalRouteId,
        formTemplateId,
        ruleId,
        frequency,
        nextDueOn,
      };
    }

    async function rowFor(token: string, ruleId: string): Promise<PlannerRow> {
      const res = await get(token).expect(200);
      const row = (res.body.data as PlannerRow[]).find((r) => r.id === ruleId);
      if (!row) throw new Error(`rule ${ruleId} missing from the planner response`);
      return row;
    }

    it('names the job raised for the stored next-due date, with its number and status', async () => {
      const machine = await makeJobbableMachine();
      const jobId = await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'assigned',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: machine.nextDueOn,
      });

      const row = await rowFor(await plannerToken(), machine.ruleId);
      expect(row.nextDueJob).toMatchObject({ id: jobId, status: 'ASSIGNED' });
      expect(row.nextDueJob?.jobNumber).toMatch(/^PM-2026-/);
    });

    it('reports null when the scheduler has not raised one yet', async () => {
      const machine = await makeJobbableMachine();
      const row = await rowFor(await plannerToken(), machine.ruleId);
      expect(row.nextDueJob).toBeNull();
    });

    /**
     * THE TRAP THIS SLICE EXISTS TO AVOID. An ad-hoc job is off-plan work
     * (UR-028): empty `frequency_scope`, excluded from the partial unique
     * index, structurally incapable of advancing `schedule_rule.next_due_on`.
     * One raised on the same machine on the same day is a DIFFERENT piece of
     * work, and presenting it as this visit's job would tell a planner the
     * plan was covered while the schedule sat exactly where it was.
     */
    it('never links an AD-HOC job, even on the same document, frequency and date', async () => {
      const machine = await makeJobbableMachine();
      await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'in_progress',
        frequency: 'M3',
        dueOn: machine.nextDueOn,
        isAdhoc: true,
        adhocReason: 'bearing seized on the night shift, unplanned service',
      });

      const row = await rowFor(await plannerToken(), machine.ruleId);
      expect(row.nextDueJob).toBeNull();
    });

    /**
     * SYS-19: a voided job releases its schedule period so the scheduler can
     * raise a replacement. Linking it would send a planner to dead work AND
     * hide the fact that the live job is still to come.
     */
    it('never links a VOIDED job — its period is free again', async () => {
      const machine = await makeJobbableMachine();
      await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'voided',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: machine.nextDueOn,
        voidReason: 'raised against the wrong machine, voided by the team leader',
      });

      const row = await rowFor(await plannerToken(), machine.ruleId);
      expect(row.nextDueJob).toBeNull();
    });

    /**
     * The case that makes date proximity useless. Since slice 27 a machine can
     * carry several documents, so one date can carry several unrelated jobs —
     * the owner's own example is a wire bonder with both its PM record and a
     * separate pH-meter check. Each rule must reach ITS job.
     */
    it('resolves per DOCUMENT when one machine carries two, both due the same day', async () => {
      const approvalRouteId = await getSeededApprovalRouteId();
      const templateA = await createFormTemplate(`DOC-A-${randomUUID()}`);
      const templateB = await createFormTemplate(`DOC-B-${randomUUID()}`);
      const assetTypeId = await createAssetType(templateA, approvalRouteId, `AT-${randomUUID()}`);
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
        scheduleAnchorDate: '2026-01-01',
      });
      const documentA = await getAssetDocumentId(assetId);
      const documentB = await createAssetDocument(assetId, templateB);
      const authorId = await createUser('template-author');
      const revisionA = await createTemplateRevision(templateA, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      const revisionB = await createTemplateRevision(templateB, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });

      const ruleA = await createScheduleRule(assetId, {
        frequency: 'M3',
        intervalMonths: 3,
        anchorDate: '2026-01-01',
        nextDueOn: '2026-03-19',
        assetDocumentId: documentA,
      });
      const ruleB = await createScheduleRule(assetId, {
        frequency: 'M3',
        intervalMonths: 3,
        anchorDate: '2026-01-01',
        nextDueOn: '2026-03-19',
        assetDocumentId: documentB,
      });

      const jobA = await createJob({
        assetId,
        assetDocumentId: documentA,
        templateRevisionId: revisionA,
        approvalRouteId,
        jobNumber: `PM-2026-A${randomUUID().slice(0, 6)}`,
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: '2026-03-19',
      });
      const jobB = await createJob({
        assetId,
        assetDocumentId: documentB,
        templateRevisionId: revisionB,
        approvalRouteId,
        jobNumber: `PM-2026-B${randomUUID().slice(0, 6)}`,
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: '2026-03-19',
      });
      expect(jobA).not.toBe(jobB);

      const token = await plannerToken();
      expect((await rowFor(token, ruleA)).nextDueJob?.id).toBe(jobA);
      expect((await rowFor(token, ruleB)).nextDueJob?.id).toBe(jobB);
    });

    /**
     * `schedule_rule` is `@@unique([asset_document_id, frequency])`, which is
     * why `(assetDocumentId, frequency, dueOn)` names one rule's job. Two rules
     * at different frequencies on one document, both due the same day, is the
     * case that proves `frequency` is really part of the match rather than
     * decoration.
     */
    it('does not borrow the job of a DIFFERENT frequency on the same document and date', async () => {
      const machine = await makeJobbableMachine({ frequency: 'M3', intervalMonths: 3 });
      const monthlyRuleId = await createScheduleRule(machine.assetId, {
        frequency: 'M1',
        intervalMonths: 1,
        anchorDate: '2026-01-01',
        nextDueOn: machine.nextDueOn,
        assetDocumentId: machine.assetDocumentId,
      });
      // Only the MONTHLY rule has a job.
      const monthlyJob = await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'scheduled',
        frequency: 'M1',
        frequencyScope: ['M1'],
        dueOn: machine.nextDueOn,
      });

      const token = await plannerToken();
      expect((await rowFor(token, monthlyRuleId)).nextDueJob?.id).toBe(monthlyJob);
      expect((await rowFor(token, machine.ruleId)).nextDueJob).toBeNull();
    });

    /**
     * The previous period's job is real, finished work — it must not be
     * offered as the job for the visit still to come. This is the assertion
     * that "the nearest job on this machine" would fail.
     */
    it('ignores a job at any other due date, however close', async () => {
      const machine = await makeJobbableMachine({ nextDueOn: '2026-03-19' });
      await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'verified',
        frequency: 'M3',
        frequencyScope: ['M3'],
        // One day out — the last period, already done.
        dueOn: '2026-03-18',
      });

      const row = await rowFor(await plannerToken(), machine.ruleId);
      expect(row.nextDueJob).toBeNull();
    });

    /**
     * A projected visit gets no job of its own, ever: `JobGenerationService`
     * reads `schedule_rule.next_due_on` and writes `job.due_on` from it, so
     * only the STORED date can carry one. Proven by writing a job at a
     * projected date and showing the row still reports none — the row would
     * otherwise have to grow a per-date job map, and the grid would start
     * claiming work exists for dates nothing has been written against.
     */
    it('belongs to the stored date only — a job at a projected date is not this visit’s', async () => {
      const machine = await makeJobbableMachine({ nextDueOn: '2026-03-19' });
      await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        // The next PROJECTED visit — a date the scheduler will only reach
        // after this rule has been completed and advanced.
        dueOn: '2026-06-19',
      });

      const row = await rowFor(await plannerToken(), machine.ruleId);
      expect(row.plannedDates).toContain('2026-06-19');
      expect(row.nextDueJob).toBeNull();
    });
  });

  describe('jobGenerationOpensOn — when a job will appear', () => {
    it('is the due date less THIS machine type’s lead time, not a fixed 30 days', async () => {
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
        { leadTimeDays: 45 },
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
        scheduleAnchorDate: '2026-01-01',
      });
      const ruleId = await createScheduleRule(assetId, {
        frequency: 'M3',
        intervalMonths: 3,
        anchorDate: '2026-01-01',
        nextDueOn: '2026-03-19',
      });

      const res = await get(await plannerToken()).expect(200);
      const row = (res.body.data as PlannerRow[]).find((r) => r.id === ruleId);
      // 19 March less 45 days. A client printing "30 days" would be wrong for
      // this machine, which is exactly why the server computes it.
      expect(row?.jobGenerationOpensOn).toBe('2026-02-02');
    });

    it('is computed for every row, including one already past its window', async () => {
      const assetTypeId = await makeAssetType();
      await makeScheduledMachine({ assetTypeId, nextDueOn: '2026-01-10' });

      const res = await get(await plannerToken()).expect(200);
      // Default lead time of 30 days: 10 January less 30 days crosses the year
      // end, which is precisely the arithmetic a client should not be doing.
      expect(res.body.data[0].jobGenerationOpensOn).toBe('2025-12-11');
    });
  });

  // ------------------------------------------------------------ the window

  it('refuses a malformed window rather than silently planning the wrong year', async () => {
    const token = await plannerToken();
    await get(token, '?from=2026&to=2026-12-31').expect(422);
    await get(token, '?from=2026-02-31&to=2026-12-31').expect(422);
    await get(token, '?from=2026-12-31&to=2026-01-01').expect(422);
    await get(token, '?from=2026-01-01&to=2999-12-31').expect(422);
  });

  it('defaults to the current calendar year when the window is omitted', async () => {
    const assetTypeId = await makeAssetType();
    const thisYear = new Date().getUTCFullYear();
    await makeScheduledMachine({
      assetTypeId,
      frequency: 'M1',
      intervalMonths: 1,
      nextDueOn: `${thisYear}-01-10`,
    });

    const res = await get(await plannerToken(), '?limit=100').expect(200);
    const row: PlannerRow = res.body.data[0];
    expect(row.plannedDates).toHaveLength(12);
    expect(row.plannedDates[0]).toBe(`${thisYear}-01-10`);
    expect(row.plannedDates[11]).toBe(`${thisYear}-12-10`);
  });

  // ------------------------------------------------------------ pagination

  it('paginates by cursor over rule id, and the cursor honours the same scope', async () => {
    const assetTypeId = await makeAssetType();
    const areaA = await createArea(`AREA-${randomUUID()}`);
    const areaB = await createArea(`AREA-${randomUUID()}`);
    for (let i = 0; i < 3; i += 1) {
      await makeScheduledMachine({ assetTypeId, areaId: areaA });
    }
    const theirs = await makeScheduledMachine({ assetTypeId, areaId: areaB });

    const userId = await createUser('scoped-planner');
    await scopeUserToArea(userId, areaA);
    const token = await plannerToken(userId);

    const first = await get(token, '?from=2026-01-01&to=2026-12-31&limit=2').expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);

    const second = await get(
      token,
      `?from=2026-01-01&to=2026-12-31&limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
    ).expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.page.hasMore).toBe(false);

    const seen = [...first.body.data, ...second.body.data].map((r: PlannerRow) => r.assetId);
    expect(new Set(seen).size).toBe(3);
    expect(seen).not.toContain(theirs.assetId);
  });
});
