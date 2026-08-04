import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createLoginableUser } from './helpers/auth-fixtures';
import {
  createArea,
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createScheduleRule,
  createTemplateRevision,
  createUser,
  getAssetDocumentId,
  getSeededApprovalRouteId,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { createTemplateItem } from './helpers/fixtures';
import { SchedulerService } from '../../src/scheduling/scheduler.service';

interface AssignableUserRow {
  id: string;
  fullName: string;
  roles: string[];
}

/**
 * Slice 32-PLANNERJOB — WHO DOES THE WORK.
 *
 * Assignment now happens at two levels, and this suite exists mainly to prove
 * ONE property that nothing else can: THE PICKER CANNOT LIE. The list at
 * `GET /schedule/{scheduleRuleId}/assignable-users` is a SQL expression of the
 * same rule `POST /jobs/{jobId}/assign` enforces as a check, and two
 * expressions of one rule are exactly the kind of duplication that rots. So
 * the central test below feeds the list's own output back through the assign
 * endpoint and requires every row to be accepted — and requires each
 * deliberately-excluded user to be refused when assigned directly.
 *
 * Without that cross-check, a drift between the two would surface as a 422 in
 * a planner's face, naming a condition they cannot see and did not choose.
 */
describe('Assignment — the picker, the standing assignee, and the check they share', () => {
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

  /** A real, properly-encrypted user — the list DECRYPTS `full_name`. */
  async function makeTechnician(opts: {
    fullName: string;
    roleCodes: string[];
    areaId?: string;
    deactivated?: boolean;
  }): Promise<string> {
    const { userId } = await createLoginableUser({
      email: `tech-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: opts.fullName,
      roleCodes: opts.roleCodes,
    });
    if (opts.areaId) await scopeUserToArea(userId, opts.areaId);
    if (opts.deactivated) {
      await adminPool.query(`UPDATE "app_user" SET "status" = 'deactivated' WHERE id = $1`, [
        userId,
      ]);
    }
    return userId;
  }

  /**
   * An ACTOR for these endpoints, and it must be a REAL, properly-encrypted
   * row — the same rule `users.spec.ts` documents for `GET /users`.
   *
   * The reason is sharper here: TEAM_LEADER and ENGINEER are BOTH assign
   * roles AND result-recording roles, so an actor holding either appears in
   * the very candidate list they are fetching, and this endpoint DECRYPTS
   * every candidate's `full_name`. Built with `fixtures.ts#createUser`'s
   * placeholder bytes, the actor would blow up its own request.
   *
   * That is a fixture defect rather than a service one, and it is left as a
   * hard failure deliberately: an undecryptable `full_name_ct` means the DEK
   * has changed or the row was hand-written, which is a crypto incident, and
   * `users.mapper.ts#toUser` already lets that propagate rather than papering
   * over it. Inventing a per-row rescue here would make this the one endpoint
   * that hides it.
   */
  async function actorToken(role: string): Promise<string> {
    const { userId } = await createLoginableUser({
      email: `actor-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: `${role} Actor`,
      roleCodes: [role],
    });
    return mintAccessToken(app, userId, [role]);
  }

  function plannerToken(): Promise<string> {
    return actorToken('PLANNER');
  }

  /** A machine, its one document with a CURRENT revision, and one rule. */
  async function makeMachine(opts: { areaId?: string | null } = {}) {
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      areaId: opts.areaId ?? null,
      scheduleAnchorDate: '2026-01-01',
    });
    const assetDocumentId = await getAssetDocumentId(assetId);
    const authorId = await createUser('template-author');
    const templateRevisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const ruleId = await createScheduleRule(assetId, {
      frequency: 'M3',
      intervalMonths: 3,
      anchorDate: '2026-01-01',
      nextDueOn: '2026-03-19',
    });
    return { assetId, assetDocumentId, templateRevisionId, approvalRouteId, ruleId };
  }

  function listAssignable(token: string, ruleId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/schedule/${ruleId}/assignable-users?limit=100`)
      .set(...authHeader(token));
  }

  function setDefault(token: string, ruleId: string, defaultAssigneeId: string | null) {
    return request(app.getHttpServer())
      .put(`/api/v1/schedule/${ruleId}/default-assignee`)
      .set(...authHeader(token))
      .send({ defaultAssigneeId });
  }

  // ------------------------------------------------------------- the picker

  describe('GET /schedule/{scheduleRuleId}/assignable-users', () => {
    it('rejects an unauthenticated request', async () => {
      const { ruleId } = await makeMachine();
      await request(app.getHttpServer())
        .get(`/api/v1/schedule/${ruleId}/assignable-users`)
        .expect(401);
    });

    /**
     * Unlike `GET /schedule` itself, which carries NO role gate because a
     * schedule is not confidential, this one does: a list of the plant's
     * technicians is not something an AUDITOR or DOC_CONTROLLER has any
     * reason to receive, and neither may assign anything.
     */
    it('is closed to roles that cannot assign, and open to the four that can', async () => {
      const { ruleId } = await makeMachine();

      for (const role of ['MAINTAINER', 'AUDITOR', 'DOC_CONTROLLER'] as const) {
        await listAssignable(await actorToken(role), ruleId).expect(403);
      }
      for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'] as const) {
        await listAssignable(await actorToken(role), ruleId).expect(200);
      }
    });

    it('404s an unknown rule', async () => {
      await listAssignable(await plannerToken(), randomUUID()).expect(404);
    });

    /**
     * A NAMED rule outside the caller's scope is 403, not 404 — answering
     * "no such rule" for one that exists would be a lie, and the collection
     * read's "simply absent" behaviour is wrong for a single named entity
     * (`AssetScheduleService` settled this). It also stops the endpoint being
     * used to enumerate technicians against a machine the caller cannot see.
     */
    it('403s a rule whose machine is outside the caller’s area scope', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const theirs = await makeMachine({ areaId: areaB });

      const { userId } = await createLoginableUser({
        email: `scoped-${randomUUID()}@bevorasg.com`,
        password: 'CorrectHorseBattery1!',
        fullName: 'Scoped Planner',
        roleCodes: ['PLANNER'],
      });
      await scopeUserToArea(userId, areaA);
      const token = await mintAccessToken(app, userId, ['PLANNER']);

      await listAssignable(token, theirs.ruleId).expect(403);
    });

    it('offers a user holding a result-recording role, with the roles that put them there', async () => {
      const { ruleId } = await makeMachine();
      const techId = await makeTechnician({
        fullName: 'Sam Maintainer',
        roleCodes: ['MAINTAINER'],
      });

      const res = await listAssignable(await plannerToken(), ruleId).expect(200);
      const rows: AssignableUserRow[] = res.body.data;
      const sam = rows.find((row) => row.id === techId);

      expect(sam).toBeDefined();
      // The name is DECRYPTED — an id names nobody, which is the whole point.
      expect(sam?.fullName).toBe('Sam Maintainer');
      expect(sam?.roles).toEqual(['MAINTAINER']);
    });

    it('never carries email or employee id — this is not the user directory', async () => {
      const { ruleId } = await makeMachine();
      await makeTechnician({ fullName: 'Sam Maintainer', roleCodes: ['MAINTAINER'] });

      const res = await listAssignable(await plannerToken(), ruleId).expect(200);
      // `GET /users` stays the ADMIN-only place personal data lives. Widening
      // it was the alternative to this endpoint and would have handed three
      // more roles the whole directory.
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['fullName', 'id', 'roles']);
    });

    describe('excludes exactly who the assign endpoint would refuse', () => {
      it('a deactivated user', async () => {
        const { ruleId } = await makeMachine();
        const goneId = await makeTechnician({
          fullName: 'Gone Person',
          roleCodes: ['MAINTAINER'],
          deactivated: true,
        });

        const res = await listAssignable(await plannerToken(), ruleId).expect(200);
        expect(res.body.data.map((row: AssignableUserRow) => row.id)).not.toContain(goneId);
      });

      it('a user holding no result-recording role', async () => {
        const { ruleId } = await makeMachine();
        const auditorId = await makeTechnician({
          fullName: 'Ada Auditor',
          roleCodes: ['AUDITOR'],
        });

        const res = await listAssignable(await plannerToken(), ruleId).expect(200);
        expect(res.body.data.map((row: AssignableUserRow) => row.id)).not.toContain(auditorId);
      });

      it('a user whose area scope does not reach the machine', async () => {
        const areaA = await createArea(`AREA-${randomUUID()}`);
        const areaB = await createArea(`AREA-${randomUUID()}`);
        const { ruleId } = await makeMachine({ areaId: areaA });

        const inAreaId = await makeTechnician({
          fullName: 'In Area',
          roleCodes: ['MAINTAINER'],
          areaId: areaA,
        });
        const elsewhereId = await makeTechnician({
          fullName: 'Elsewhere',
          roleCodes: ['MAINTAINER'],
          areaId: areaB,
        });
        // No scope rows at all = unrestricted (PR-API-10's read-side rule).
        const unrestrictedId = await makeTechnician({
          fullName: 'Unrestricted',
          roleCodes: ['ENGINEER'],
        });

        const res = await listAssignable(await plannerToken(), ruleId).expect(200);
        const ids = res.body.data.map((row: AssignableUserRow) => row.id);
        expect(ids).toEqual(expect.arrayContaining([inAreaId, unrestrictedId]));
        expect(ids).not.toContain(elsewhereId);
      });

      /**
       * A machine with NO area is reachable only by an unrestricted user —
       * `assertAssignable`'s `!areaId` branch. Pinned because the SQL form and
       * the check form express this differently and could easily diverge.
       */
      it('everyone with an area scope, when the machine itself has no area', async () => {
        const areaA = await createArea(`AREA-${randomUUID()}`);
        const { ruleId } = await makeMachine({ areaId: null });

        const scopedId = await makeTechnician({
          fullName: 'Scoped',
          roleCodes: ['MAINTAINER'],
          areaId: areaA,
        });
        const unrestrictedId = await makeTechnician({
          fullName: 'Unrestricted',
          roleCodes: ['MAINTAINER'],
        });

        const res = await listAssignable(await plannerToken(), ruleId).expect(200);
        const ids = res.body.data.map((row: AssignableUserRow) => row.id);
        expect(ids).toContain(unrestrictedId);
        expect(ids).not.toContain(scopedId);
      });
    });

    /**
     * ############################################################
     * THE TEST THIS SUITE EXISTS FOR.
     *
     * `assignable-user.service.ts` states one rule twice — once as a Prisma
     * `where` (the list) and once as a sequence of checks (`assertAssignable`,
     * which `POST /jobs/{jobId}/assign` runs). Nothing but this holds them
     * together. If they drift, a planner picks a name the picker offered and
     * gets a 422 describing a condition they cannot see.
     * ############################################################
     */
    it('every user it offers is ACCEPTED by POST /jobs/{jobId}/assign, and the excluded ones are refused', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const machine = await makeMachine({ areaId: areaA });

      // Three who should be offered, spanning all three record roles and both
      // scope shapes...
      const offered = [
        await makeTechnician({ fullName: 'A', roleCodes: ['MAINTAINER'], areaId: areaA }),
        await makeTechnician({ fullName: 'B', roleCodes: ['TEAM_LEADER'] }),
        await makeTechnician({ fullName: 'C', roleCodes: ['ENGINEER'], areaId: areaA }),
      ];
      // ...and three who should not, one per condition.
      const excluded = [
        await makeTechnician({
          fullName: 'D',
          roleCodes: ['MAINTAINER'],
          areaId: areaA,
          deactivated: true,
        }),
        await makeTechnician({ fullName: 'E', roleCodes: ['AUDITOR'], areaId: areaA }),
        await makeTechnician({
          fullName: 'F',
          roleCodes: ['MAINTAINER'],
          areaId: await createArea(`AREA-${randomUUID()}`),
        }),
      ];

      const token = await plannerToken();
      const res = await listAssignable(token, machine.ruleId).expect(200);
      const listed: string[] = res.body.data.map((row: AssignableUserRow) => row.id);

      expect(listed).toEqual(expect.arrayContaining(offered));
      for (const id of excluded) expect(listed).not.toContain(id);

      // A fresh job per candidate, each on its OWN due date: assigning is a
      // state change, so reusing one job would let the second assertion pass
      // for the wrong reason — and `job`'s partial unique index on
      // `(asset_document_id, frequency_scope, due_on)` forbids two live jobs
      // sharing a period, which is the index this whole slice relies on.
      let dueDay = 0;
      async function assignTo(assigneeId: string) {
        dueDay += 1;
        const jobId = await createJob({
          assetId: machine.assetId,
          assetDocumentId: machine.assetDocumentId,
          templateRevisionId: machine.templateRevisionId,
          approvalRouteId: machine.approvalRouteId,
          jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
          status: 'scheduled',
          frequency: 'M3',
          frequencyScope: ['M3'],
          dueOn: `2026-03-${String(dueDay).padStart(2, '0')}`,
        });
        return request(app.getHttpServer())
          .post(`/api/v1/jobs/${jobId}/assign`)
          .set(...authHeader(token))
          .send({ assigneeId });
      }

      // EVERY offered candidate is genuinely assignable.
      for (const id of listed) {
        expect((await assignTo(id)).status).toBe(200);
      }
      // And every exclusion was a real refusal, not an arbitrary omission.
      for (const id of excluded) {
        expect((await assignTo(id)).status).toBe(422);
      }
    });
  });

  // -------------------------------------------------- the standing assignee

  describe('PUT /schedule/{scheduleRuleId}/default-assignee', () => {
    it('sets who normally does this machine’s PM, and reports them back', async () => {
      const { ruleId } = await makeMachine();
      const techId = await makeTechnician({
        fullName: 'Sam Maintainer',
        roleCodes: ['MAINTAINER'],
      });

      const res = await setDefault(await plannerToken(), ruleId, techId).expect(200);
      expect(res.body).toMatchObject({
        scheduleRuleId: ruleId,
        defaultAssignee: { id: techId, fullName: 'Sam Maintainer', eligibility: 'assignable' },
      });

      const stored = await adminPool.query(
        `SELECT "default_assignee_id" FROM "schedule_rule" WHERE id = $1`,
        [ruleId],
      );
      expect(stored.rows[0].default_assignee_id).toBe(techId);
    });

    it('clears it with null — back to generating unassigned jobs', async () => {
      const { ruleId } = await makeMachine();
      const techId = await makeTechnician({ fullName: 'Sam', roleCodes: ['MAINTAINER'] });
      const token = await plannerToken();

      await setDefault(token, ruleId, techId).expect(200);
      const res = await setDefault(token, ruleId, null).expect(200);
      expect(res.body.defaultAssignee).toBeNull();

      const stored = await adminPool.query(
        `SELECT "default_assignee_id" FROM "schedule_rule" WHERE id = $1`,
        [ruleId],
      );
      expect(stored.rows[0].default_assignee_id).toBeNull();
    });

    it('refuses an assignee the assign endpoint would refuse, naming the reason', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const { ruleId } = await makeMachine({ areaId: areaA });
      const token = await plannerToken();

      const auditorId = await makeTechnician({ fullName: 'Ada', roleCodes: ['AUDITOR'] });
      const elsewhereId = await makeTechnician({
        fullName: 'Far',
        roleCodes: ['MAINTAINER'],
        areaId: areaB,
      });
      const goneId = await makeTechnician({
        fullName: 'Gone',
        roleCodes: ['MAINTAINER'],
        deactivated: true,
      });

      // Each names WHICH condition failed — the whole reason these are 422s
      // about the assignee rather than 403s about the caller.
      const noRole = await setDefault(token, ruleId, auditorId).expect(422);
      expect(noRole.body.detail).toMatch(/no role that can record results/);

      const outOfArea = await setDefault(token, ruleId, elsewhereId).expect(422);
      expect(outOfArea.body.detail).toMatch(/area scope/);

      const inactive = await setDefault(token, ruleId, goneId).expect(422);
      expect(inactive.body.detail).toMatch(/active user/);
    });

    it('leaves the column untouched when it refuses', async () => {
      const { ruleId } = await makeMachine();
      const token = await plannerToken();
      const goodId = await makeTechnician({ fullName: 'Sam', roleCodes: ['MAINTAINER'] });
      const badId = await makeTechnician({ fullName: 'Ada', roleCodes: ['AUDITOR'] });

      await setDefault(token, ruleId, goodId).expect(200);
      await setDefault(token, ruleId, badId).expect(422);

      const stored = await adminPool.query(
        `SELECT "default_assignee_id" FROM "schedule_rule" WHERE id = $1`,
        [ruleId],
      );
      expect(stored.rows[0].default_assignee_id).toBe(goodId);
    });

    it('403s a rule outside the caller’s area scope, and 404s an unknown one', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const theirs = await makeMachine({ areaId: areaB });
      const techId = await makeTechnician({ fullName: 'Sam', roleCodes: ['MAINTAINER'] });

      const { userId } = await createLoginableUser({
        email: `scoped-${randomUUID()}@bevorasg.com`,
        password: 'CorrectHorseBattery1!',
        fullName: 'Scoped Planner',
        roleCodes: ['PLANNER'],
      });
      await scopeUserToArea(userId, areaA);
      const token = await mintAccessToken(app, userId, ['PLANNER']);

      await setDefault(token, theirs.ruleId, techId).expect(403);
      await setDefault(token, randomUUID(), techId).expect(404);
    });

    it('is closed to roles that may not assign', async () => {
      const { ruleId } = await makeMachine();
      const techId = await makeTechnician({ fullName: 'Sam', roleCodes: ['MAINTAINER'] });

      for (const role of ['MAINTAINER', 'AUDITOR', 'DOC_CONTROLLER'] as const) {
        await setDefault(await actorToken(role), ruleId, techId).expect(403);
      }
    });

    /**
     * PR-SEC-02: `audit_event` is append-only with 7-year retention, so a
     * decrypted name written there would be a permanent plaintext copy that
     * defeats the field encryption. Ids only, both sides.
     */
    it('audits the change with ids and no personal data', async () => {
      const { ruleId } = await makeMachine();
      const techId = await makeTechnician({
        fullName: 'Sam Maintainer',
        roleCodes: ['MAINTAINER'],
      });

      await setDefault(await plannerToken(), ruleId, techId).expect(200);

      const events = await adminPool.query(
        `SELECT "action", "before", "after" FROM "audit_event"
         WHERE "entity_type" = 'schedule_rule' AND "entity_id" = $1`,
        [ruleId],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].action).toBe('update');
      expect(events.rows[0].before).toMatchObject({ defaultAssigneeId: null });
      expect(events.rows[0].after).toMatchObject({ defaultAssigneeId: techId });
      expect(JSON.stringify(events.rows[0])).not.toContain('Sam Maintainer');
    });

    /**
     * THE INDEPENDENCE OF THE TWO LEVELS, proven rather than asserted. A
     * planner who sets the standing assignee must not discover that work
     * already raised — possibly already started — has moved under them.
     */
    it('does NOT touch a job that already exists', async () => {
      const machine = await makeMachine();
      const token = await plannerToken();
      const original = await makeTechnician({ fullName: 'Original', roleCodes: ['MAINTAINER'] });
      const newDefault = await makeTechnician({ fullName: 'New', roleCodes: ['MAINTAINER'] });

      const jobId = await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: '2026-03-19',
      });
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/assign`)
        .set(...authHeader(token))
        .send({ assigneeId: original })
        .expect(200);

      await setDefault(token, machine.ruleId, newDefault).expect(200);

      const job = await adminPool.query(`SELECT "assigned_to" FROM "job" WHERE id = $1`, [jobId]);
      expect(job.rows[0].assigned_to).toBe(original);
    });

    /**
     * REVIEW FINDING (minor 7) — the test above proves only the ASSIGNED case.
     * The reviewer added an `updateMany` filtered to `status = 'scheduled'`
     * and all 32 tests still passed: a regression that pushed a new standing
     * assignee onto already-raised but still-UNASSIGNED jobs would have
     * shipped undetected, and that is the likelier mistake — "it has nobody on
     * it, so it is safe to fill in" is exactly the reasoning someone would
     * apply. It is not safe: the job exists, and the plan does not reach back.
     */
    it('does NOT touch an already-raised job that is still UNASSIGNED', async () => {
      const machine = await makeMachine();
      const token = await plannerToken();
      const newDefault = await makeTechnician({ fullName: 'New', roleCodes: ['MAINTAINER'] });

      const jobId = await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        // Born the way every scheduler-generated job was before this slice:
        // SCHEDULED and with nobody on it.
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: '2026-03-19',
      });

      await setDefault(token, machine.ruleId, newDefault).expect(200);

      const job = await adminPool.query(
        `SELECT "assigned_to", "assigned_at", "status" FROM "job" WHERE id = $1`,
        [jobId],
      );
      expect(job.rows[0].assigned_to).toBeNull();
      expect(job.rows[0].assigned_at).toBeNull();
      // And the status is untouched — a write here must not take the
      // SCHEDULED -> ASSIGNED edge on a job it does not own.
      expect(job.rows[0].status).toBe('scheduled');
    });

    /** ...and the mirror: covering one visit must not rewrite the plan. */
    it('is NOT written back by POST /jobs/{jobId}/assign', async () => {
      const machine = await makeMachine();
      const token = await plannerToken();
      const standing = await makeTechnician({ fullName: 'Standing', roleCodes: ['MAINTAINER'] });
      const coverer = await makeTechnician({ fullName: 'Coverer', roleCodes: ['MAINTAINER'] });

      await setDefault(token, machine.ruleId, standing).expect(200);
      const jobId = await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: '2026-03-19',
      });
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/assign`)
        .set(...authHeader(token))
        .send({ assigneeId: coverer })
        .expect(200);

      const rule = await adminPool.query(
        `SELECT "default_assignee_id" FROM "schedule_rule" WHERE id = $1`,
        [machine.ruleId],
      );
      expect(rule.rows[0].default_assignee_id).toBe(standing);
    });
  });

  // ------------------------------------------ what the planner grid reports

  describe('GET /schedule reports both levels', () => {
    const YEAR = '?from=2026-01-01&to=2026-12-31&limit=100';

    async function plannerRow(token: string, ruleId: string) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/schedule${YEAR}`)
        .set(...authHeader(token))
        .expect(200);
      return res.body.data.find((row: { id: string }) => row.id === ruleId);
    }

    it('names the standing assignee, and says they are still eligible', async () => {
      const { ruleId } = await makeMachine();
      const token = await plannerToken();
      const techId = await makeTechnician({
        fullName: 'Sam Maintainer',
        roleCodes: ['MAINTAINER'],
      });
      await setDefault(token, ruleId, techId).expect(200);

      expect(await plannerRow(token, ruleId)).toMatchObject({
        defaultAssignee: { id: techId, fullName: 'Sam Maintainer', eligibility: 'assignable' },
      });
    });

    it('reports null where no standing assignee is set — every rule today', async () => {
      const { ruleId } = await makeMachine();
      expect((await plannerRow(await plannerToken(), ruleId)).defaultAssignee).toBeNull();
    });

    /**
     * THE WARNING THE PLANNER NEEDS BEFORE THE SWEEP PROVES IT. Eligibility
     * lapses silently after the default is set — someone leaves, a role is
     * revoked, an area scope is narrowed — and the next sweep then raises the
     * job UNASSIGNED, which is invisible to every MAINTAINER.
     */
    it('still names them but flags them ineligible once they lapse', async () => {
      const { ruleId } = await makeMachine();
      const token = await plannerToken();
      const techId = await makeTechnician({
        fullName: 'Sam Maintainer',
        roleCodes: ['MAINTAINER'],
      });
      await setDefault(token, ruleId, techId).expect(200);

      await adminPool.query(`UPDATE "app_user" SET "status" = 'deactivated' WHERE id = $1`, [
        techId,
      ]);

      // Still NAMED — a planner has to know who it was to know what changed.
      expect(await plannerRow(token, ruleId)).toMatchObject({
        defaultAssignee: { id: techId, fullName: 'Sam Maintainer', eligibility: 'not-assignable' },
      });
    });

    /**
     * REVIEW FINDING, at the wire: the grid's field is three-valued, and
     * `unknown` means "the check did not complete" rather than accusing the
     * person of having lost their role.
     *
     * NOT EXERCISED HERE, deliberately. Both routes to `unknown` — a failed
     * lookup, and a `default_assignee_id` whose row cannot be read — are
     * unreachable against a healthy, correctly-constrained database: the FK is
     * RESTRICT and nothing in this system deletes an `app_user` (INV-16). The
     * only way to provoke either from an integration test is to drop the
     * constraint or the connection mid-suite, and a first attempt at that did
     * real damage: the assertion between the DROP and the re-add failed, the
     * re-add never ran, and the schema stayed mutated for every test after it
     * in a suite that shares one database.
     *
     * The seam is covered exactly and cheaply instead by
     * `src/jobs/assignable-user.service.spec.ts`, which throws a connection
     * error, a statement timeout and a bare `null` straight at
     * `checkAssignable`/`resolveEligibility` and pins that none of them
     * becomes `not-assignable`. That is a better test of this property than
     * anything a real database can be talked into.
     */

    /**
     * REVIEW FINDING (important 1). `GET /schedule` carries no `@Roles()` and
     * must not gain one — every authenticated user could already read these
     * rows one machine at a time, and removing that would break slice 18's
     * "ADD, never remove". But the NAMES are new personal data: `GET /users`
     * is ADMIN-only, the picker twenty lines away refuses these exact roles,
     * and `jobs/mappers.ts` omits `assignedToName` from every job read for
     * this reason. So the row stays and the name is withheld.
     */
    describe('technician names are withheld from roles that cannot assign', () => {
      async function rowAs(role: string, ruleId: string) {
        const { userId } = await createLoginableUser({
          email: `reader-${randomUUID()}@bevorasg.com`,
          password: 'CorrectHorseBattery1!',
          fullName: `${role} Reader`,
          roleCodes: [role],
        });
        return plannerRow(await mintAccessToken(app, userId, [role]), ruleId);
      }

      async function machineWithBothLevels() {
        const machine = await makeMachine();
        const token = await plannerToken();
        const techId = await makeTechnician({
          fullName: 'Sam Maintainer',
          roleCodes: ['MAINTAINER'],
        });
        await setDefault(token, machine.ruleId, techId).expect(200);
        const jobId = await createJob({
          assetId: machine.assetId,
          assetDocumentId: machine.assetDocumentId,
          templateRevisionId: machine.templateRevisionId,
          approvalRouteId: machine.approvalRouteId,
          jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
          status: 'scheduled',
          frequency: 'M3',
          frequencyScope: ['M3'],
          dueOn: '2026-03-19',
        });
        await request(app.getHttpServer())
          .post(`/api/v1/jobs/${jobId}/assign`)
          .set(...authHeader(token))
          .send({ assigneeId: techId })
          .expect(200);
        return { ...machine, techId };
      }

      it('still returns the ROW to every authenticated role — nothing is taken away', async () => {
        const machine = await machineWithBothLevels();
        for (const role of ['MAINTAINER', 'AUDITOR', 'DOC_CONTROLLER'] as const) {
          const row = await rowAs(role, machine.ruleId);
          expect(row).toBeDefined();
          expect(row.nextDueJob).not.toBeNull();
          expect(row.defaultAssignee).not.toBeNull();
        }
      });

      it('withholds both names from a role that cannot act on assignment', async () => {
        const machine = await machineWithBothLevels();
        for (const role of ['MAINTAINER', 'AUDITOR', 'DOC_CONTROLLER'] as const) {
          const row = await rowAs(role, machine.ruleId);
          expect(row.defaultAssignee.fullName).toBeNull();
          expect(row.nextDueJob.assignedToName).toBeNull();
          // The IDS stay, so a caller can still tell "nobody is assigned" from
          // "a name you are not shown" — and nothing the plan already told
          // them is removed.
          expect(row.defaultAssignee.id).toBe(machine.techId);
          expect(row.nextDueJob.assignedTo).toBe(machine.techId);
          expect(row.defaultAssignee.eligibility).toBe('assignable');
          // The decrypted name must not leak anywhere else on the row either.
          expect(JSON.stringify(row)).not.toContain('Sam Maintainer');
        }
      });

      it('shows both names to every role that CAN act on assignment', async () => {
        const machine = await machineWithBothLevels();
        for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'] as const) {
          const row = await rowAs(role, machine.ruleId);
          expect(row.defaultAssignee.fullName).toBe('Sam Maintainer');
          expect(row.nextDueJob.assignedToName).toBe('Sam Maintainer');
        }
      });
    });

    it('reports a job’s own assignee, by name', async () => {
      const machine = await makeMachine();
      const token = await plannerToken();
      const techId = await makeTechnician({ fullName: 'Bo Engineer', roleCodes: ['ENGINEER'] });

      const jobId = await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: '2026-03-19',
      });
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/assign`)
        .set(...authHeader(token))
        .send({ assigneeId: techId })
        .expect(200);

      expect((await plannerRow(token, machine.ruleId)).nextDueJob).toMatchObject({
        id: jobId,
        assignedTo: techId,
        assignedToName: 'Bo Engineer',
      });
    });

    it('reports an unassigned job as such, with no name invented for it', async () => {
      const machine = await makeMachine();
      await createJob({
        assetId: machine.assetId,
        assetDocumentId: machine.assetDocumentId,
        templateRevisionId: machine.templateRevisionId,
        approvalRouteId: machine.approvalRouteId,
        jobNumber: `PM-2026-${randomUUID().slice(0, 8)}`,
        status: 'scheduled',
        frequency: 'M3',
        frequencyScope: ['M3'],
        dueOn: '2026-03-19',
      });

      expect((await plannerRow(await plannerToken(), machine.ruleId)).nextDueJob).toMatchObject({
        assignedTo: null,
        assignedToName: null,
      });
    });
  });

  // ------------------------------------- what the sweep does with the default

  /**
   * The standing assignee is only worth anything if GENERATION honours it —
   * and the case that decides whether this feature is safe is the one where
   * it cannot: a technician who left, a role revoked, an area scope narrowed.
   *
   * The decision is GENERATE UNASSIGNED, NEVER REFUSE. Refusing would stall
   * the schedule for ever (`next_due_on` only advances on completion, so a job
   * never raised is a rule never cleared) and would stop the plant producing
   * the very records the ISO audit asks for. But an unassigned job is
   * INVISIBLE to every MAINTAINER (`job-access.ts`), so doing it quietly would
   * make "the work stopped being assigned" look exactly like "there was no
   * work". These prove it is never quiet.
   */
  describe('the scheduler sweep honours the standing assignee', () => {
    /** A machine the sweep will really generate for: current revision, active item, due now. */
    async function makeSweepableMachine(areaId?: string) {
      const approvalRouteId = await getSeededApprovalRouteId();
      const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
      const assetTypeId = await createAssetType(
        formTemplateId,
        approvalRouteId,
        `AT-${randomUUID()}`,
      );
      const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
        areaId: areaId ?? null,
        // Today, so it is inside any lead-time window.
        scheduleAnchorDate: new Date().toISOString().slice(0, 10),
      });
      const authorId = await createUser('author');
      const revisionId = await createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      await createTemplateItem(revisionId, 'M1');
      const ruleId = await createScheduleRule(assetId, {
        frequency: 'M1',
        intervalMonths: 1,
        anchorDate: new Date().toISOString().slice(0, 10),
      });
      return { assetId, ruleId };
    }

    async function jobFor(assetId: string) {
      const res = await adminPool.query(
        `SELECT id, "assigned_to", "assigned_at", "status" FROM "job" WHERE asset_id = $1`,
        [assetId],
      );
      return res.rows[0];
    }

    it('generates the job ALREADY ASSIGNED to the standing assignee', async () => {
      const { assetId, ruleId } = await makeSweepableMachine();
      const techId = await makeTechnician({
        fullName: 'Sam Maintainer',
        roleCodes: ['MAINTAINER'],
      });
      await setDefault(await plannerToken(), ruleId, techId).expect(200);

      const result = await app.get(SchedulerService).run();
      expect(result.ran).toBe(true);
      if (result.ran) {
        expect(result.generated).toBe(1);
        expect(result.assignedFromDefault).toBe(1);
        expect(result.defaultAssigneeUnavailable).toBe(0);
      }

      const job = await jobFor(assetId);
      expect(job.assigned_to).toBe(techId);
      // The PRD §5.1 SCHEDULED->ASSIGNED edge, taken at birth. Without it the
      // job would be assigned but still SCHEDULED, which no other path
      // produces and result capture (`job-status-guard.ts`) would refuse.
      expect(job.status).toBe('assigned');
      expect(job.assigned_at).not.toBeNull();
    });

    it('leaves a rule with no standing assignee exactly as before this slice', async () => {
      const { assetId } = await makeSweepableMachine();

      const result = await app.get(SchedulerService).run();
      expect(result.ran).toBe(true);
      if (result.ran) expect(result.assignedFromDefault).toBe(0);

      const job = await jobFor(assetId);
      expect(job.assigned_to).toBeNull();
      expect(job.status).toBe('scheduled');
    });

    describe('when the standing assignee has lapsed', () => {
      async function sweepWithLapsedDefault() {
        const { assetId, ruleId } = await makeSweepableMachine();
        const techId = await makeTechnician({
          fullName: 'Gone Person',
          roleCodes: ['MAINTAINER'],
        });
        await setDefault(await plannerToken(), ruleId, techId).expect(200);
        // The lapse: set legitimately, then the person leaves.
        await adminPool.query(`UPDATE "app_user" SET "status" = 'deactivated' WHERE id = $1`, [
          techId,
        ]);
        const result = await app.get(SchedulerService).run();
        return { assetId, ruleId, techId, result };
      }

      it('STILL generates the job, unassigned, rather than stalling the schedule', async () => {
        const { assetId, result } = await sweepWithLapsedDefault();
        expect(result.ran).toBe(true);
        if (result.ran) expect(result.generated).toBe(1);

        const job = await jobFor(assetId);
        expect(job).toBeDefined();
        expect(job.assigned_to).toBeNull();
        expect(job.status).toBe('scheduled');
      });

      it('counts it, so the sweep’s own log line names it', async () => {
        const { result } = await sweepWithLapsedDefault();
        if (result.ran) {
          expect(result.defaultAssigneeUnavailable).toBe(1);
          expect(result.assignedFromDefault).toBe(0);
        }
      });

      /**
       * THE TRACE THAT OUTLIVES LOG ROTATION, and the reason this outcome is
       * acceptable at all. In the append-only, hash-chained audit record, by
       * id — never the name, which is encrypted (PR-SEC-02).
       */
      it('records WHY in the job’s own creation audit event', async () => {
        const { assetId, techId } = await sweepWithLapsedDefault();
        const job = await jobFor(assetId);

        const events = await adminPool.query(
          `SELECT "after" FROM "audit_event"
           WHERE "entity_type" = 'job' AND "entity_id" = $1 AND "action" = 'create'`,
          [job.id],
        );
        expect(events.rows).toHaveLength(1);
        expect(events.rows[0].after).toMatchObject({
          defaultAssigneeUnavailable: true,
          defaultAssigneeId: techId,
          assignedTo: null,
        });
        expect(JSON.stringify(events.rows[0].after)).not.toContain('Gone Person');
      });

      it('leaves the rule’s default in place — clearing it would hide the problem', async () => {
        const { ruleId, techId } = await sweepWithLapsedDefault();
        const rule = await adminPool.query(
          `SELECT "default_assignee_id" FROM "schedule_rule" WHERE id = $1`,
          [ruleId],
        );
        // The planner must still SEE who it was, and `GET /schedule` reports
        // it with `eligible: false`. Silently nulling it would erase the
        // evidence of what went wrong.
        expect(rule.rows[0].default_assignee_id).toBe(techId);
      });
    });

    /**
     * The area half of the rule, end to end: a default set while the
     * technician was in scope, then the machine moves area. The check runs
     * again at generation and this is the branch that catches it.
     */
    it('treats an assignee whose area no longer reaches the machine as lapsed', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const { assetId, ruleId } = await makeSweepableMachine(areaA);
      const techId = await makeTechnician({
        fullName: 'Area Bound',
        roleCodes: ['MAINTAINER'],
        areaId: areaA,
      });
      await setDefault(await plannerToken(), ruleId, techId).expect(200);

      await adminPool.query(`UPDATE "asset" SET "area_id" = $1 WHERE id = $2`, [areaB, assetId]);

      const result = await app.get(SchedulerService).run();
      if (result.ran) expect(result.defaultAssigneeUnavailable).toBe(1);
      expect((await jobFor(assetId)).assigned_to).toBeNull();
    });
  });
});
