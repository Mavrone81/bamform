import type { Page, Route } from '@playwright/test';

/**
 * A fake backend for the offline suite, installed via Playwright route
 * interception (`page.route`) rather than depending on the real api/
 * workspace. As of this branch `/sync/bootstrap`, `/sync/outbox` and
 * `/jobs/**` are not implemented server-side (slice 6/9/10 work — see
 * src/api/transport.ts's module doc), and the CI compose topology
 * (docker-compose.ci.yml) does not yet stitch bamform-web and bamform-api
 * onto one origin for a same-origin relative fetch to reach the api
 * container. Route interception sidesteps both gaps deterministically: it
 * intercepts every `/api/v1/**` request at the browser network boundary
 * before either question matters, so these tests exercise the REAL client
 * code (outbox.ts, sync-engine.ts, the screens) against a server that
 * behaves exactly as api/openapi.yaml contracts it to, with full control
 * over the fault injection the O-suite requires (dropped responses, 409s,
 * batch caps).
 *
 * This mirrors src/api/mock-transport.ts's semantics (same idempotency
 * store, same "commit before dropping the response" O-15 model) — that one
 * backs the Vitest unit suite; this one backs the browser-driven E2E suite.
 * Two independent tests of the same contract, at two different layers.
 */

export interface SeedJob {
  id: string;
  jobNumber: string;
  assetCode: string;
  frequency: 'M1' | 'M3' | 'M6' | 'Y';
  dueOn: string;
  overdue?: boolean;
  status?: string;
  draftVersion?: number;
  revisionId?: string;
  revisionCode?: string;
  items: Array<{ id: string; itemNo: number; instruction: string; mandatory?: boolean }>;
  /** Slice 11b additions — only meaningful once a job is (or becomes)
   * `SUBMITTED`; every field defaults to something sensible for jobs that
   * never touch the verifier queue. */
  submittedBy?: string;
  submittedAt?: string;
  currentStageOrdinal?: 1 | 2;
}

interface OutboxResultLike {
  id: string;
  status: number;
  applied: boolean;
  problem?: unknown;
}

/**
 * Slice 11b: a small fixed cast of users so the verifier-queue/delegation
 * journeys (E-02/03/04) can exercise multiple distinct actors — the
 * SUBMITTER, a TEAM_LEADER, an ENGINEER and a delegate — within one
 * FakeServer instance, each in their own BrowserContext (mirrors how
 * O-13/O-14 already use separate contexts sharing one server). Every
 * existing offline/a11y spec signs in as `tech@bevorasg.com` and is
 * completely unaffected: unknown emails fall back to the same
 * user-1/MAINTAINER identity they always got.
 */
export interface E2EUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
}

export const E2E_USERS: {
  technician: E2EUser;
  teamLeader: E2EUser;
  engineer: E2EUser;
  delegateLeader: E2EUser;
} = {
  technician: {
    id: 'user-1',
    email: 'tech@bevorasg.com',
    fullName: 'Test Technician',
    roles: ['MAINTAINER'],
  },
  teamLeader: {
    id: 'user-2',
    email: 'leader@bevorasg.com',
    fullName: 'Test Team Leader',
    roles: ['TEAM_LEADER'],
  },
  engineer: {
    id: 'user-3',
    email: 'engineer@bevorasg.com',
    fullName: 'Test Engineer',
    roles: ['ENGINEER'],
  },
  delegateLeader: {
    id: 'user-4',
    email: 'delegate@bevorasg.com',
    fullName: 'Test Delegate Leader',
    roles: ['TEAM_LEADER'],
  },
};

/** The password every canned user accepts on login (fake server does not
 * check it there — matches the existing specs' single hard-coded literal)
 * AND the only password `/auth/step-up` accepts (there, it IS checked, so
 * the step-up-retry flow is genuinely exercised rather than always
 * trivially succeeding). */
export const E2E_PASSWORD = 'correct-horse-battery-staple';

const USERS_BY_EMAIL = new Map<string, E2EUser>(Object.values(E2E_USERS).map((u) => [u.email, u]));
const USERS_BY_ID = new Map<string, E2EUser>(Object.values(E2E_USERS).map((u) => [u.id, u]));

export interface FakeDelegation {
  id: string;
  delegatorId: string;
  delegateId: string;
  validFrom: string;
  validTo: string;
  reason: string | null;
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
}

interface ApprovalStepLike {
  id: string;
  stageOrdinal: number;
  stageLabel: string;
  action: 'SUBMITTED' | 'VERIFIED' | 'RETURNED' | 'RECALLED' | 'VOIDED';
  actorId: string;
  actorName: string;
  actorRoleCode?: string;
  onBehalfOfName?: string | null;
  reason?: string | null;
  actedAt: string;
}

export class FakeServer {
  private jobs = new Map<string, SeedJob>();
  private deletedJobIds = new Set<string>();
  private idempotencyStore = new Map<string, OutboxResultLike>();
  appliedCount = new Map<string, number>();
  private conflictOnce = new Set<string>();
  private dropResponseOnce = new Set<string>();
  networkDown = false;
  serverTime = new Date().toISOString();
  outboxRequestCount = 0;
  submitCount = new Map<string, number>();
  private submitStore = new Map<string, unknown>();
  /** Every mutation batch ever received, in arrival order — lets a test
   * assert exactly what was sent without needing to peek into IndexedDB. */
  receivedBatches: Array<{ id: string; path: string }[]> = [];
  /** Real optimistic-concurrency tracking (mirrors the `draftVersion` /
   * `If-Match` contract, api/openapi.yaml `IfMatch` parameter): a mutation
   * whose `ifMatch` does not match the job's current version is rejected
   * 409, exactly as PR-064 describes — this is what makes O-13 (two
   * devices editing the same job) a genuine test of the mechanism rather
   * than a canned one-shot conflict. */
  private draftVersions = new Map<string, number>();

  /** Slice 11b: mutable per-job approval state. Kept SEPARATE from the
   * immutable `SeedJob` a test seeds with, defaulting to that job's own
   * `status`/`currentStageOrdinal` fields until `/submit`, `/verify` or
   * `/return` actually changes them — so every pre-existing offline/a11y
   * spec (none of which touch the verifier queue) is completely unaffected. */
  private jobStatus = new Map<string, string>();
  private jobStageOrdinal = new Map<string, 1 | 2>();
  private jobSubmittedBy = new Map<string, string>();
  private jobSubmittedAt = new Map<string, string>();
  private approvalSteps = new Map<string, ApprovalStepLike[]>();
  private approvalStepSeq = 0;
  private delegations = new Map<string, FakeDelegation>();
  private delegationSeq = 0;
  /** Users who have completed `/auth/step-up` and not yet had it consumed
   * by a `/verify` call — real re-authentication IS required per user, per
   * signing action (there is no "logging in satisfies it" shortcut here),
   * which is what makes the pad's step-up-retry path a genuine test rather
   * than one that trivially never fires. */
  private stepUpValidUserIds = new Set<string>();

  seedJob(job: SeedJob): void {
    this.jobs.set(job.id, job);
    this.draftVersions.set(job.id, job.draftVersion ?? 1);
    this.jobStatus.set(job.id, job.status ?? 'IN_PROGRESS');
    this.jobStageOrdinal.set(job.id, job.currentStageOrdinal ?? 1);
    if (job.submittedBy) this.jobSubmittedBy.set(job.id, job.submittedBy);
    if (job.submittedAt) this.jobSubmittedAt.set(job.id, job.submittedAt);
    if (!this.approvalSteps.has(job.id)) this.approvalSteps.set(job.id, []);
  }

  /** Grants a delegation directly (bypassing `POST /delegations`) so a test
   * can set up E-04's starting condition without needing UI interaction
   * first. `createDelegation` (via the real endpoint) is exercised
   * separately by whichever journey actually creates one through the UI. */
  seedDelegation(input: {
    delegatorId: string;
    delegateId: string;
    validFrom: string;
    validTo: string;
    reason?: string | null;
  }): FakeDelegation {
    const id = `deleg-${++this.delegationSeq}`;
    const delegation: FakeDelegation = {
      id,
      delegatorId: input.delegatorId,
      delegateId: input.delegateId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      reason: input.reason ?? null,
      createdBy: input.delegatorId,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.delegations.set(id, delegation);
    return delegation;
  }

  removeJob(jobId: string): void {
    this.jobs.delete(jobId);
    this.deletedJobIds.add(jobId);
  }

  draftVersionOf(jobId: string): number {
    return this.draftVersions.get(jobId) ?? 1;
  }

  forceConflictOnce(mutationId: string): void {
    this.conflictOnce.add(mutationId);
  }

  /** Coarser sibling of `forceConflictOnce`, for the same reason
   * `dropNextOutboxResponseOnce` exists: a client-generated UUIDv7 can't be
   * known ahead of the tap that creates it. Conflicts every mutation in the
   * very next `/sync/outbox` batch, regardless of id. */
  private forceNextConflict = false;
  forceNextConflictOnce(): void {
    this.forceNextConflict = true;
  }

  dropResponseOnceFor(mutationId: string): void {
    this.dropResponseOnce.add(mutationId);
  }

  /** Coarser than `dropResponseOnceFor`: drops the response for the very
   * next `/sync/outbox` request regardless of which mutation ids it
   * carries, after committing them normally — used where a test cannot
   * predict a client-generated UUIDv7 ahead of time (which is always, since
   * it is generated in the browser at the moment of the tap). This models
   * O-02/O-15 precisely: the server applied the batch, the client never saw
   * the response. */
  private dropNextResponse = false;
  dropNextOutboxResponseOnce(): void {
    this.dropNextResponse = true;
  }

  private jobIdFromPath(path: string): string | null {
    const match = path.match(/\/jobs\/([^/]+)\//);
    return match ? match[1] : null;
  }

  private toApiJob(job: SeedJob) {
    return {
      id: job.id,
      jobNumber: job.jobNumber,
      assetId: job.id,
      assetCode: job.assetCode,
      documentNumber: 'CE 95 020 00 01',
      revisionCode: job.revisionCode ?? 'A',
      frequency: job.frequency,
      frequencyScope: [job.frequency],
      dueOn: job.dueOn,
      overdue: job.overdue ?? false,
      status: this.jobStatus.get(job.id) ?? job.status ?? 'IN_PROGRESS',
      assignedTo: 'user-1',
      assignedToName: 'Test Technician',
      draftVersion: this.draftVersionOf(job.id),
      templateRevision: {
        id: job.revisionId ?? `rev-${job.id}`,
        formTemplateId: 'tpl-1',
        documentNumber: 'CE 95 020 00 01',
        revisionCode: job.revisionCode ?? 'A',
        sequenceOrdinal: 1,
        status: 'CURRENT',
        items: job.items.map((i, idx) => ({
          id: i.id,
          itemNo: i.itemNo,
          frequency: job.frequency,
          instruction: i.instruction,
          mandatory: i.mandatory ?? true,
          stableKey: `item-${idx}`,
          displayOrder: idx,
        })),
        measurements: [],
      },
      itemResults: [],
      measurementResults: [],
      partsUsed: [],
      attachments: [],
      approvalSteps: this.approvalSteps.get(job.id) ?? [],
    };
  }

  private currentStageRole(ordinal: number): 'TEAM_LEADER' | 'ENGINEER' {
    return ordinal >= 2 ? 'ENGINEER' : 'TEAM_LEADER';
  }

  private async currentUser(route: Route): Promise<E2EUser> {
    const auth = (await route.request().headerValue('authorization')) ?? '';
    const match = auth.match(/Bearer e2e-token-(user-\d+)/);
    const userId = match?.[1];
    return (userId && USERS_BY_ID.get(userId)) || E2E_USERS.technician;
  }

  private problem(status: number, title: string, type = 'about:blank') {
    return { type, title, status };
  }

  /** Real login is required before refresh will succeed for THAT SAME
   * browser context — modelled with an actual `Set-Cookie` on login and a
   * `Cookie` check on refresh, exactly like the real HttpOnly refresh
   * cookie, rather than a single shared boolean. A single global flag was
   * tried first and broke as soon as a second "device" (BrowserContext)
   * appeared in the same test (O-13): logging in on device A made device
   * B's fresh page silently auto-authenticate via refresh too, since
   * cookies are NOT actually shared between real browser contexts — the
   * flag was pretending they were. Without this fix, every fresh page load
   * for a context that never logged in would ALSO be redirected straight
   * past the sign-in screen. */
  private async handleLogin(route: Route) {
    const body = route.request().postDataJSON() as { email?: string };
    const user = (body.email && USERS_BY_EMAIL.get(body.email)) || E2E_USERS.technician;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Set-Cookie': `bf_refresh=e2e-refresh-${user.id}; Path=/; HttpOnly` },
      body: JSON.stringify({
        accessToken: `e2e-token-${user.id}`,
        expiresIn: 900,
        user: { id: user.id, fullName: user.fullName, roles: user.roles },
      }),
    });
  }

  private async handleRefresh(route: Route) {
    const cookieHeader = (await route.request().headerValue('cookie')) ?? '';
    const match = cookieHeader.match(/bf_refresh=e2e-refresh-(user-\d+)/);
    if (!match) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'no session', status: 401 }),
      });
      return;
    }
    const user = USERS_BY_ID.get(match[1]) ?? E2E_USERS.technician;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: `e2e-token-${user.id}-refreshed`,
        expiresIn: 900,
        user: { id: user.id, fullName: user.fullName, roles: user.roles },
      }),
    });
  }

  private async handleBootstrap(route: Route) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        serverTime: this.serverTime,
        user: { id: 'user-1', fullName: 'Test Technician', roles: ['MAINTAINER'] },
        jobs: Array.from(this.jobs.values()).map((j) => this.toApiJob(j)),
        deletedJobIds: Array.from(this.deletedJobIds),
        syncToken: `tok-${this.jobs.size}`,
      }),
    });
  }

  private async handleOutbox(route: Route) {
    this.outboxRequestCount++;
    const body = route.request().postDataJSON() as {
      mutations: Array<{ id: string; path: string; ifMatch?: number | null }>;
    };
    this.receivedBatches.push(body.mutations.map((m) => ({ id: m.id, path: m.path })));

    if (this.networkDown) {
      await route.abort('internetdisconnected');
      return;
    }

    if (body.mutations.length > 200) {
      await route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'batch too large',
          status: 400,
        }),
      });
      return;
    }

    const results: OutboxResultLike[] = [];
    let mustDrop = false;

    for (const m of body.mutations) {
      const existing = this.idempotencyStore.get(m.id);
      if (existing) {
        results.push(existing);
        continue;
      }
      const jobId = this.jobIdFromPath(m.path);
      const currentVersion = jobId ? this.draftVersionOf(jobId) : 1;
      const isStale = m.ifMatch != null && m.ifMatch !== currentVersion;
      const forcedConflict = this.conflictOnce.has(m.id) || this.forceNextConflict;
      const jobWasRemoved = jobId != null && this.deletedJobIds.has(jobId);

      let result: OutboxResultLike;
      if (jobWasRemoved) {
        // O-14: a mutation against a job that no longer exists/was
        // reassigned server-side is rejected, not silently applied — if it
        // were silently applied, the device's `hasPendingOutbox` flag would
        // clear on its own and the NEXT bootstrap would have nothing left
        // to protect, defeating the "device is informed, cannot submit"
        // guarantee this scenario is specifically about.
        result = {
          id: m.id,
          status: 404,
          applied: false,
          problem: { type: 'about:blank', title: 'job not found (reassigned)', status: 404 },
        };
      } else if (forcedConflict || isStale) {
        this.conflictOnce.delete(m.id);
        result = {
          id: m.id,
          status: 409,
          applied: false,
          problem: {
            type: 'https://form.bevorasg.com/errors/draft-conflict',
            title: 'Draft version conflict',
            status: 409,
            detail: isStale
              ? `Job is at draftVersion ${currentVersion}, mutation based on ${m.ifMatch}`
              : undefined,
          },
        };
      } else {
        this.appliedCount.set(m.id, (this.appliedCount.get(m.id) ?? 0) + 1);
        if (jobId) this.draftVersions.set(jobId, currentVersion + 1);
        result = { id: m.id, status: 200, applied: true };
      }
      this.idempotencyStore.set(m.id, result);
      results.push(result);
      if (this.dropResponseOnce.has(m.id)) {
        this.dropResponseOnce.delete(m.id);
        mustDrop = true;
      }
    }
    this.forceNextConflict = false;

    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      mustDrop = true;
    }

    if (mustDrop) {
      await route.abort('internetdisconnected'); // commit already happened above — O-15 fault
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results, syncToken: `tok-${this.idempotencyStore.size}` }),
    });
  }

  private async handleSubmit(route: Route, jobId: string) {
    const key = await route.request().headerValue('idempotency-key');
    const dedupeKey = key ?? jobId;
    if (this.submitStore.has(dedupeKey)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(this.submitStore.get(dedupeKey)),
      });
      return;
    }
    this.submitCount.set(jobId, (this.submitCount.get(jobId) ?? 0) + 1);
    const job = this.jobs.get(jobId);
    if (job) {
      const requester = await this.currentUser(route);
      this.jobStatus.set(jobId, 'SUBMITTED');
      this.jobStageOrdinal.set(jobId, 1);
      this.jobSubmittedBy.set(jobId, requester.id);
      this.jobSubmittedAt.set(jobId, new Date().toISOString());
      const steps = this.approvalSteps.get(jobId) ?? [];
      steps.push({
        id: `step-${++this.approvalStepSeq}`,
        stageOrdinal: 0,
        stageLabel: 'Submitted',
        action: 'SUBMITTED',
        actorId: requester.id,
        actorName: requester.fullName,
        actedAt: this.jobSubmittedAt.get(jobId)!,
      });
      this.approvalSteps.set(jobId, steps);
    }
    const body = job ? this.toApiJob(job) : { id: jobId, status: 'SUBMITTED' };
    this.submitStore.set(dedupeKey, body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }

  // ---- Slice 11a/11b: verifier queue / record review / delegations ----

  private async handleGetJob(route: Route, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Job not found')),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleQueue(route: Route) {
    const requester = await this.currentUser(route);
    const now = Date.now();
    const activeDelegationsToMe = Array.from(this.delegations.values()).filter(
      (d) =>
        d.delegateId === requester.id &&
        !d.revokedAt &&
        Date.parse(d.validFrom) <= now &&
        now <= Date.parse(d.validTo),
    );

    const data: unknown[] = [];
    for (const job of this.jobs.values()) {
      if ((this.jobStatus.get(job.id) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') continue;
      const submitter = this.jobSubmittedBy.get(job.id);
      if (submitter === requester.id) continue; // INV-05: never your own submission
      const stage = this.jobStageOrdinal.get(job.id) ?? 1;
      const stageRole = this.currentStageRole(stage);

      let onBehalfOf: string | null = null;
      const eligible = requester.roles.includes(stageRole);
      if (!eligible) {
        const viaDelegation = activeDelegationsToMe.find((d) => {
          const delegator = USERS_BY_ID.get(d.delegatorId);
          return delegator?.roles.includes(stageRole);
        });
        if (!viaDelegation) continue;
        onBehalfOf = viaDelegation.delegatorId;
      }

      const submittedAt = this.jobSubmittedAt.get(job.id) ?? new Date().toISOString();
      data.push({
        ...this.toApiJob(job),
        submittedAt,
        submittedByName: submitter
          ? (USERS_BY_ID.get(submitter)?.fullName ?? submitter)
          : undefined,
        ageHours: (now - Date.parse(submittedAt)) / 3_600_000,
        escalated: false,
        onBehalfOf,
      });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, limit: 50, nextCursor: null } }),
    });
  }

  private async handleVerify(route: Route, jobId: string) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      drawnSignature?: string;
      onBehalfOf?: string | null;
      comment?: string | null;
    };

    if (!body.drawnSignature) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            422,
            'drawnSignature is required (base64 PNG data-URL).',
            'https://form.bevorasg.com/errors/attachment-rejected',
          ),
        ),
      });
      return;
    }

    // PR-API-07: step-up is required per signing action, per user — a
    // fresh login does NOT itself satisfy it in this fake (see the
    // `stepUpValidUserIds` field doc).
    if (!this.stepUpValidUserIds.has(requester.id)) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            403,
            'Re-authentication required before signing',
            'https://form.bevorasg.com/errors/step-up-required',
          ),
        ),
      });
      return;
    }

    const job = this.jobs.get(jobId);
    if (!job || (this.jobStatus.get(jobId) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Job is not SUBMITTED',
            'https://form.bevorasg.com/errors/invalid-transition',
          ),
        ),
      });
      return;
    }

    const submitter = this.jobSubmittedBy.get(jobId);
    if (!body.onBehalfOf && submitter === requester.id) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Self-approval is not permitted',
            'https://form.bevorasg.com/errors/self-approval',
          ),
        ),
      });
      return;
    }

    const stage = this.jobStageOrdinal.get(jobId) ?? 1;
    const stageRole = this.currentStageRole(stage);
    let actingRoles = requester.roles as readonly string[];
    let onBehalfOfName: string | null = null;
    if (body.onBehalfOf) {
      const now = Date.now();
      const delegation = Array.from(this.delegations.values()).find(
        (d) =>
          d.delegatorId === body.onBehalfOf &&
          d.delegateId === requester.id &&
          !d.revokedAt &&
          Date.parse(d.validFrom) <= now &&
          now <= Date.parse(d.validTo),
      );
      if (!delegation) {
        await route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          body: JSON.stringify(
            this.problem(403, 'No active delegation permits acting on behalf of that user'),
          ),
        });
        return;
      }
      const delegator = USERS_BY_ID.get(body.onBehalfOf);
      actingRoles = delegator?.roles ?? [];
      onBehalfOfName = delegator?.fullName ?? body.onBehalfOf;
    }

    if (!actingRoles.includes(stageRole)) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }

    // Consumed by this signing action — the NEXT verify by this same user
    // (e.g. stage 2, or a different job) requires stepping up again.
    this.stepUpValidUserIds.delete(requester.id);

    const steps = this.approvalSteps.get(jobId) ?? [];
    steps.push({
      id: `step-${++this.approvalStepSeq}`,
      stageOrdinal: stage,
      stageLabel: stage >= 2 ? 'Verified By (Engineer)' : 'Verified By (Workshop Team Leader)',
      action: 'VERIFIED',
      actorId: requester.id,
      actorName: requester.fullName,
      actorRoleCode: stageRole,
      onBehalfOfName,
      actedAt: new Date().toISOString(),
    });
    this.approvalSteps.set(jobId, steps);

    if (stage >= 2) {
      this.jobStatus.set(jobId, 'ARCHIVED');
    } else {
      this.jobStageOrdinal.set(jobId, 2);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleReturn(route: Route, jobId: string) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as { reason?: string };
    if (!body.reason || body.reason.trim().length < 10) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(422, 'reason must be at least 10 characters (INV-13, PR-074).'),
        ),
      });
      return;
    }
    const job = this.jobs.get(jobId);
    if (!job || (this.jobStatus.get(jobId) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(409, 'Job is not SUBMITTED')),
      });
      return;
    }

    this.jobStatus.set(jobId, 'IN_PROGRESS');
    this.jobStageOrdinal.set(jobId, 1);
    const steps = this.approvalSteps.get(jobId) ?? [];
    steps.push({
      id: `step-${++this.approvalStepSeq}`,
      stageOrdinal: this.jobStageOrdinal.get(jobId) ?? 1,
      stageLabel: 'Returned',
      action: 'RETURNED',
      actorId: requester.id,
      actorName: requester.fullName,
      reason: body.reason,
      actedAt: new Date().toISOString(),
    });
    this.approvalSteps.set(jobId, steps);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleStepUp(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as { password?: string };
    if (body.password !== E2E_PASSWORD) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(401, 'Incorrect password')),
      });
      return;
    }
    this.stepUpValidUserIds.add(requester.id);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stepUpValidUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  }

  private async handleListDelegations(route: Route) {
    const requester = await this.currentUser(route);
    const data = Array.from(this.delegations.values())
      .filter((d) => d.delegatorId === requester.id || d.delegateId === requester.id)
      .map((d) => this.toApiDelegation(d));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, limit: 50, nextCursor: null } }),
    });
  }

  private toApiDelegation(d: FakeDelegation) {
    return {
      ...d,
      delegatorName: USERS_BY_ID.get(d.delegatorId)?.fullName,
      delegateName: USERS_BY_ID.get(d.delegateId)?.fullName,
    };
  }

  private async handleCreateDelegation(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      delegatorId: string;
      delegateId: string;
      validFrom: string;
      validTo: string;
      reason?: string | null;
    };

    // Mirrors the real permission matrix (§4.1): a TEAM_LEADER/ENGINEER may
    // only delegate their OWN authority away; only ADMIN may set up a
    // delegation between two other users (no ADMIN exists among the canned
    // E2E_USERS, so that branch never applies here).
    const canDelegate = requester.roles.some((r) => r === 'TEAM_LEADER' || r === 'ENGINEER');
    if (!canDelegate || body.delegatorId !== requester.id) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }

    const delegation = this.seedDelegation(body);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiDelegation(delegation)),
    });
  }

  private async handleRevokeDelegation(route: Route, delegationId: string) {
    const requester = await this.currentUser(route);
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Delegation not found')),
      });
      return;
    }
    const canRevoke =
      delegation.delegatorId === requester.id || delegation.createdBy === requester.id;
    if (!canRevoke) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }
    if (!delegation.revokedAt) {
      delegation.revokedAt = new Date().toISOString();
      this.delegations.set(delegationId, delegation);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiDelegation(delegation)),
    });
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/auth/login', (route) => this.handleLogin(route));
    await page.route('**/api/v1/auth/refresh', (route) => this.handleRefresh(route));
    await page.route('**/api/v1/auth/step-up', (route) => this.handleStepUp(route));
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204, body: '' }));
    await page.route('**/api/v1/sync/bootstrap*', (route) => this.handleBootstrap(route));
    await page.route('**/api/v1/sync/outbox', (route) => this.handleOutbox(route));
    await page.route(/\/api\/v1\/jobs\/([^/]+)\/submit/, (route) => {
      const match = route
        .request()
        .url()
        .match(/\/jobs\/([^/]+)\/submit/);
      return this.handleSubmit(route, match ? match[1] : 'unknown');
    });
    await page.route('**/api/v1/queue*', (route) => this.handleQueue(route));
    await page.route(/\/api\/v1\/jobs\/([^/]+)\/verify/, (route) => {
      const match = route
        .request()
        .url()
        .match(/\/jobs\/([^/]+)\/verify/);
      return this.handleVerify(route, match ? match[1] : 'unknown');
    });
    await page.route(/\/api\/v1\/jobs\/([^/]+)\/return/, (route) => {
      const match = route
        .request()
        .url()
        .match(/\/jobs\/([^/]+)\/return/);
      return this.handleReturn(route, match ? match[1] : 'unknown');
    });
    // Anchored (no trailing segment) so it never intercepts /submit,
    // /verify, /return, /items/*, /measurements/*, /parts, /attachments —
    // all of which are registered as their own, more specific routes above
    // and below. Playwright resolves overlapping routes last-registered-
    // first, but this still keeps each handler's own responsibility
    // unambiguous to read.
    await page.route(/\/api\/v1\/jobs\/([^/]+)$/, (route) => {
      const match = route
        .request()
        .url()
        .match(/\/jobs\/([^/]+)$/);
      return this.handleGetJob(route, match ? match[1] : 'unknown');
    });
    await page.route('**/api/v1/delegations', (route) => {
      if (route.request().method() === 'POST') return this.handleCreateDelegation(route);
      return this.handleListDelegations(route);
    });
    await page.route(/\/api\/v1\/delegations\/([^/]+)$/, (route) => {
      const match = route
        .request()
        .url()
        .match(/\/delegations\/([^/]+)$/);
      return this.handleRevokeDelegation(route, match ? match[1] : 'unknown');
    });
  }
}
