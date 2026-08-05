import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
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
import { NOTIFICATION_QUEUE } from '../../src/notifications/notification.tokens';

/**
 * Slice 33-APPLYDEFAULT — "ALSO GIVE THEM THE JOBS THAT ARE ALREADY THERE".
 *
 * THE DEFECT THIS CLOSES, in the owner's own production data on day one: four
 * schedule rules carried a standing assignee, zero jobs were assigned, 195
 * were still unassigned. Nothing was broken — `PUT .../default-assignee`
 * affects jobs the scheduler raises from then on and deliberately does not
 * touch work already raised — but a planner who did the sensible thing was
 * told only what would NOT happen and left with no next step.
 *
 * So this suite pins the properties that make the new offer trustworthy rather
 * than merely present:
 *
 *  1. THE COUNT IS THE TRUTH. The number the PUT reports is the number the
 *     POST changes — same predicate, both directions.
 *  2. ALREADY-ASSIGNED WORK IS NEVER TOUCHED. That is the rule the
 *     non-cascading default exists to protect, and this feature must not
 *     become a back door to breaking it.
 *  3. IT TAKES THE REAL PATH. SCHEDULED -> ASSIGNED through the state
 *     machine, one `audit_event` per job, one `JOB_ASSIGNED` notification per
 *     job — never a bulk UPDATE of the column.
 *  4. A REFUSAL IS LEGIBLE AND LOCAL. It names the job and carries the
 *     server's own words, and nothing else is left half-applied.
 *
 * (The MIXED batch — some assigned, one refused — is proved in
 * `src/jobs/rule-default-assignment.service.spec.ts`. Every job on one rule
 * sits on one machine, so no honest fixture here can make the real assign
 * service accept one and refuse the next; manufacturing one would mean writing
 * rows whose `asset_id` and `asset_document_id` disagree and then asserting on
 * data that cannot exist.)
 */
describe('Applying a standing assignee to the jobs a plan has already raised', () => {
  let app: INestApplication;
  let notificationQueue: Queue;

  beforeAll(async () => {
    app = await createTestApp();
    notificationQueue = app.get<Queue>(NOTIFICATION_QUEUE);
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

  /** A real, properly-encrypted user — the endpoints decrypt `full_name`. */
  async function makeTechnician(opts: {
    fullName: string;
    roleCodes: string[];
    areaId?: string;
  }): Promise<string> {
    const { userId } = await createLoginableUser({
      email: `tech-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: opts.fullName,
      roleCodes: opts.roleCodes,
    });
    if (opts.areaId) await scopeUserToArea(userId, opts.areaId);
    return userId;
  }

  async function actorToken(role: string): Promise<{ userId: string; token: string }> {
    const { userId } = await createLoginableUser({
      email: `actor-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: `${role} Actor`,
      roleCodes: [role],
    });
    return { userId, token: await mintAccessToken(app, userId, [role]) };
  }

  /** A machine, its one document with a CURRENT revision, and one 3M rule. */
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

  type Machine = Awaited<ReturnType<typeof makeMachine>>;

  /** A scheduler-generated job for this machine's 3M plan. */
  function raiseJob(
    machine: Machine,
    opts: {
      dueOn: string;
      status?: string;
      assignedTo?: string | null;
      isAdhoc?: boolean;
      voidReason?: string;
      frequency?: 'M1' | 'M3' | 'M6' | 'Y';
    } = { dueOn: '2026-03-19' },
  ): Promise<string> {
    return createJob({
      assetId: machine.assetId,
      assetDocumentId: machine.assetDocumentId,
      templateRevisionId: machine.templateRevisionId,
      approvalRouteId: machine.approvalRouteId,
      jobNumber: `PM-${randomUUID().slice(0, 12)}`,
      status: opts.status ?? 'scheduled',
      assignedTo: opts.assignedTo ?? null,
      dueOn: opts.dueOn,
      frequency: opts.frequency ?? 'M3',
      frequencyScope: opts.isAdhoc ? [] : ['M3'],
      isAdhoc: opts.isAdhoc ?? false,
      // `job_void_reason_length_chk` — a voided job must say why.
      voidReason:
        opts.status === 'voided' ? (opts.voidReason ?? 'voided by an integration fixture') : null,
    });
  }

  function setDefault(token: string, ruleId: string, defaultAssigneeId: string | null) {
    return request(app.getHttpServer())
      .put(`/api/v1/schedule/${ruleId}/default-assignee`)
      .set(...authHeader(token))
      .send({ defaultAssigneeId });
  }

  function applyToExisting(token: string, ruleId: string, assigneeId: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/schedule/${ruleId}/default-assignee/apply-to-existing`)
      .set(...authHeader(token))
      .send({ assigneeId });
  }

  async function jobRow(jobId: string): Promise<{ status: string; assigned_to: string | null }> {
    const row = await adminPool.query(
      `SELECT status::text AS status, assigned_to FROM "job" WHERE id = $1`,
      [jobId],
    );
    return row.rows[0];
  }

  // ------------------------------------------------------- 1. the count

  describe('the count the planner is offered', () => {
    /**
     * THE HEADLINE. Exactly the reported situation: a plan with jobs already
     * raised and nobody on them. Setting the standing assignee still moves
     * none of them — and now says how many are sitting there.
     */
    it('reports the jobs already raised and unassigned, and still assigns none of them', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      const first = await raiseJob(machine, { dueOn: '2026-03-19' });
      const second = await raiseJob(machine, { dueOn: '2026-06-19' });

      const res = await setDefault(planner.token, machine.ruleId, tech).expect(200);

      expect(res.body.unassignedJobsAlreadyRaised).toBe(2);
      // The PUT is still a one-column write. Nothing cascaded.
      expect(await jobRow(first)).toEqual({ status: 'scheduled', assigned_to: null });
      expect(await jobRow(second)).toEqual({ status: 'scheduled', assigned_to: null });
    });

    /**
     * "The number offered must be the number that will actually change." Every
     * exclusion is present at once, so a filter that quietly dropped one would
     * show up as a wrong number rather than as a passing test.
     */
    it('counts ONLY jobs that would really change — not the assigned, the submitted, the voided or the ad-hoc', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      const other = await makeTechnician({ fullName: 'Sam Other', roleCodes: ['MAINTAINER'] });

      const genuinelyUnassigned = await raiseJob(machine, { dueOn: '2026-03-19' });
      // Somebody already holds this one — the rule the whole split protects.
      await raiseJob(machine, { dueOn: '2026-06-19', status: 'assigned', assignedTo: other });
      // Past the technician's hands: `POST /jobs/{id}/assign` is a 409 here.
      await raiseJob(machine, { dueOn: '2026-09-19', status: 'submitted' });
      await raiseJob(machine, { dueOn: '2026-12-19', status: 'voided' });
      // Off-plan work on the same machine, same frequency column.
      await raiseJob(machine, { dueOn: '2026-04-01', isAdhoc: true });

      const res = await setDefault(planner.token, machine.ruleId, tech).expect(200);
      expect(res.body.unassignedJobsAlreadyRaised).toBe(1);

      // And the batch walks exactly the one the count named.
      const applied = await applyToExisting(planner.token, machine.ruleId, tech).expect(200);
      expect(applied.body.assigned).toHaveLength(1);
      expect(applied.body.assigned[0].jobId).toBe(genuinelyUnassigned);
    });

    /**
     * SCOPE IS ONE SCHEDULE RULE — not every job on the machine. A machine
     * carrying a monthly plan as well as a quarterly one must not have the
     * monthly plan's work swept up by a decision about the quarterly one.
     */
    it('counts this rule only — not the machine’s other frequencies', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      await createScheduleRule(machine.assetId, {
        frequency: 'M1',
        intervalMonths: 1,
        anchorDate: '2026-01-01',
        nextDueOn: '2026-02-19',
      });
      await raiseJob(machine, { dueOn: '2026-03-19' });
      const monthlyJob = await raiseJob(machine, { dueOn: '2026-02-19', frequency: 'M1' });

      const res = await setDefault(planner.token, machine.ruleId, tech).expect(200);
      expect(res.body.unassignedJobsAlreadyRaised).toBe(1);

      await applyToExisting(planner.token, machine.ruleId, tech).expect(200);
      expect(await jobRow(monthlyJob)).toEqual({ status: 'scheduled', assigned_to: null });
    });

    it('reports zero where there is nothing to offer, rather than omitting the field', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });

      const res = await setDefault(planner.token, machine.ruleId, tech).expect(200);
      expect(res.body.unassignedJobsAlreadyRaised).toBe(0);
    });
  });

  // -------------------------------------------- 2. the batch does the work

  describe('applying it', () => {
    /**
     * THE REAL PATH, PROVED AT THE DATABASE. A bulk `UPDATE job SET
     * assigned_to` would satisfy the wire response and leave a signed-record
     * system with assigned work nobody can account for — no lifecycle
     * transition, no audit event, no notification. So all three are asserted.
     */
    it('assigns each job through the real transition, with an audit event and a notification each', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      const first = await raiseJob(machine, { dueOn: '2026-03-19' });
      const second = await raiseJob(machine, { dueOn: '2026-06-19' });

      await setDefault(planner.token, machine.ruleId, tech).expect(200);
      const res = await applyToExisting(planner.token, machine.ruleId, tech).expect(200);

      expect(res.body.assigneeId).toBe(tech);
      expect(res.body.refused).toEqual([]);
      expect(res.body.notAttempted).toBe(0);
      expect(res.body.assigned.map((entry: { jobId: string }) => entry.jobId).sort()).toEqual(
        [first, second].sort(),
      );

      // PRD §5.1's SCHEDULED -> ASSIGNED edge really happened.
      expect(await jobRow(first)).toEqual({ status: 'assigned', assigned_to: tech });
      expect(await jobRow(second)).toEqual({ status: 'assigned', assigned_to: tech });

      const audit = await adminPool.query(
        `SELECT entity_id, actor_id, before, after FROM "audit_event"
         WHERE entity_type = 'job' AND action = 'state_change' AND entity_id = ANY($1::uuid[])
         ORDER BY entity_id`,
        [[first, second]],
      );
      expect(audit.rowCount).toBe(2);
      for (const row of audit.rows) {
        expect(row.actor_id).toBe(planner.userId);
        expect(row.before).toMatchObject({ status: 'SCHEDULED', assignedTo: null });
        expect(row.after).toMatchObject({ status: 'ASSIGNED', assignedTo: tech });
      }

      const queued = await notificationQueue.getJobs(['waiting', 'delayed', 'prioritized']);
      const notifications = queued.filter((job) => job.name === 'notification');
      expect(notifications).toHaveLength(2);
      for (const notification of notifications) {
        expect(notification.data).toMatchObject({
          recipientId: tech,
          templateCode: 'JOB_ASSIGNED',
          entityType: 'job',
        });
      }
    });

    /**
     * THE PROPERTY THE ORIGINAL BEHAVIOUR EXISTS TO PROTECT, restated against
     * the new endpoint. This is the one thing that must survive the feature.
     */
    it('never touches a job that already has an assignee', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      const busy = await makeTechnician({ fullName: 'Sam Busy', roleCodes: ['MAINTAINER'] });

      const held = await raiseJob(machine, {
        dueOn: '2026-03-19',
        status: 'in_progress',
        assignedTo: busy,
      });
      const free = await raiseJob(machine, { dueOn: '2026-06-19' });

      await setDefault(planner.token, machine.ruleId, tech).expect(200);
      const res = await applyToExisting(planner.token, machine.ruleId, tech).expect(200);

      expect(res.body.assigned).toHaveLength(1);
      expect(res.body.assigned[0].jobId).toBe(free);
      // Sam is still doing the work Sam was doing, in the state it was in.
      expect(await jobRow(held)).toEqual({ status: 'in_progress', assigned_to: busy });

      // And no audit event claims otherwise.
      const audit = await adminPool.query(
        `SELECT count(*)::int AS n FROM "audit_event" WHERE entity_type = 'job' AND entity_id = $1`,
        [held],
      );
      expect(audit.rows[0].n).toBe(0);
    });

    it('leaves a job past submission exactly as it is', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      const submitted = await raiseJob(machine, { dueOn: '2026-03-19', status: 'submitted' });

      await setDefault(planner.token, machine.ruleId, tech).expect(200);
      const res = await applyToExisting(planner.token, machine.ruleId, tech).expect(200);

      expect(res.body.assigned).toEqual([]);
      expect(res.body.refused).toEqual([]);
      expect(await jobRow(submitted)).toEqual({ status: 'submitted', assigned_to: null });
    });

    /**
     * REPEATING IT IS HARMLESS. The second run finds nothing left to do,
     * because everything it assigned is no longer unassigned — so a planner
     * who presses twice does not double-notify or re-audit.
     */
    it('is a no-op the second time, because the jobs are no longer unassigned', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      await raiseJob(machine, { dueOn: '2026-03-19' });

      await setDefault(planner.token, machine.ruleId, tech).expect(200);
      await applyToExisting(planner.token, machine.ruleId, tech).expect(200);
      const again = await applyToExisting(planner.token, machine.ruleId, tech).expect(200);

      expect(again.body.assigned).toEqual([]);
      expect(again.body.refused).toEqual([]);
    });
  });

  // ----------------------------------------------------- 3. refusals

  describe('refusals', () => {
    /**
     * A REFUSAL IS PER JOB AND CARRIES THE SERVER'S OWN WORDS, even when every
     * job in the batch is refused: the request still succeeds, nothing is
     * silently dropped, and each job is named. Reached honestly — the standing
     * assignee is set while eligible and loses their role afterwards, which is
     * exactly how eligibility lapses in the plant.
     */
    it('reports each job it could not assign, by number and reason, and changes nothing', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const machine = await makeMachine({ areaId: areaA });
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({
        fullName: 'Priya Sundaram',
        roleCodes: ['MAINTAINER'],
        areaId: areaA,
      });
      const jobId = await raiseJob(machine, { dueOn: '2026-03-19' });

      await setDefault(planner.token, machine.ruleId, tech).expect(200);

      // The lapse: her area scope is moved away from this machine after the
      // plan named her. `assertAssignableUser` now refuses her for this job.
      await adminPool.query(`DELETE FROM "user_area_scope" WHERE user_id = $1`, [tech]);
      await scopeUserToArea(tech, areaB);

      const res = await applyToExisting(planner.token, machine.ruleId, tech).expect(200);

      expect(res.body.assigned).toEqual([]);
      expect(res.body.refused).toHaveLength(1);
      expect(res.body.refused[0].jobId).toBe(jobId);
      expect(typeof res.body.refused[0].jobNumber).toBe('string');
      expect(res.body.refused[0].reason).toEqual(expect.any(String));
      expect(res.body.refused[0].reason.length).toBeGreaterThan(0);
      // Refused means refused: the job is untouched.
      expect(await jobRow(jobId)).toEqual({ status: 'scheduled', assigned_to: null });
    });

    /**
     * The planner answered a question about a NAMED person. If somebody else
     * changed the plan in between, applying whatever the column now holds
     * would assign real work to a person they never saw named.
     */
    it('409s and assigns nothing when the standing assignee changed after the offer', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const offered = await makeTechnician({
        fullName: 'Priya Sundaram',
        roleCodes: ['MAINTAINER'],
      });
      const someoneElse = await makeTechnician({
        fullName: 'Sam Other',
        roleCodes: ['MAINTAINER'],
      });
      const jobId = await raiseJob(machine, { dueOn: '2026-03-19' });

      await setDefault(planner.token, machine.ruleId, someoneElse).expect(200);

      await applyToExisting(planner.token, machine.ruleId, offered).expect(409);
      expect(await jobRow(jobId)).toEqual({ status: 'scheduled', assigned_to: null });
    });

    it('422s when the plan has no standing assignee to apply', async () => {
      const machine = await makeMachine();
      const planner = await actorToken('PLANNER');
      const tech = await makeTechnician({ fullName: 'Priya Sundaram', roleCodes: ['MAINTAINER'] });
      await raiseJob(machine, { dueOn: '2026-03-19' });

      await applyToExisting(planner.token, machine.ruleId, tech).expect(422);
    });
  });

  // ---------------------------------------------------- 4. who may do it

  describe('who may reach it', () => {
    it('rejects an unauthenticated request', async () => {
      const machine = await makeMachine();
      await request(app.getHttpServer())
        .post(`/api/v1/schedule/${machine.ruleId}/default-assignee/apply-to-existing`)
        .send({ assigneeId: randomUUID() })
        .expect(401);
    });

    /**
     * EXACTLY the gate on `POST /jobs/{jobId}/assign`, because that is what
     * this is a loop over. A role that could reach this and not that would be
     * a way to assign work through a door the single-job gate refuses.
     */
    it('is open to the four roles that may assign, and closed to the rest', async () => {
      for (const role of ['MAINTAINER', 'AUDITOR', 'DOC_CONTROLLER'] as const) {
        const machine = await makeMachine();
        const actor = await actorToken(role);
        await applyToExisting(actor.token, machine.ruleId, randomUUID()).expect(403);
      }
      for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'] as const) {
        const machine = await makeMachine();
        const actor = await actorToken(role);
        const tech = await makeTechnician({
          fullName: `Tech ${role}`,
          roleCodes: ['MAINTAINER'],
        });
        await setDefault(actor.token, machine.ruleId, tech).expect(200);
        await applyToExisting(actor.token, machine.ruleId, tech).expect(200);
      }
    });

    it('404s an unknown rule', async () => {
      const planner = await actorToken('PLANNER');
      await applyToExisting(planner.token, randomUUID(), randomUUID()).expect(404);
    });

    /**
     * A NAMED rule outside the caller's scope is 403, not 404 — the same
     * distinction its `PUT` sibling makes. Answering "no such rule" for one
     * that exists would be a lie, and this one WRITES.
     */
    it('403s a rule whose machine is outside the caller’s area scope', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const theirs = await makeMachine({ areaId: areaB });
      const jobId = await raiseJob(theirs, { dueOn: '2026-03-19' });

      const { userId } = await createLoginableUser({
        email: `scoped-${randomUUID()}@bevorasg.com`,
        password: 'CorrectHorseBattery1!',
        fullName: 'Scoped Planner',
        roleCodes: ['PLANNER'],
      });
      await scopeUserToArea(userId, areaA);
      const token = await mintAccessToken(app, userId, ['PLANNER']);

      await applyToExisting(token, theirs.ruleId, randomUUID()).expect(403);
      expect(await jobRow(jobId)).toEqual({ status: 'scheduled', assigned_to: null });
    });
  });
});
