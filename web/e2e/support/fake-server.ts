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
}

interface OutboxResultLike {
  id: string;
  status: number;
  applied: boolean;
  problem?: unknown;
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

  seedJob(job: SeedJob): void {
    this.jobs.set(job.id, job);
    this.draftVersions.set(job.id, job.draftVersion ?? 1);
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
      status: job.status ?? 'IN_PROGRESS',
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
      approvalSteps: [],
    };
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Set-Cookie': 'bf_refresh=e2e-refresh-token; Path=/; HttpOnly' },
      body: JSON.stringify({
        accessToken: 'e2e-access-token',
        expiresIn: 900,
        user: { id: 'user-1', fullName: 'Test Technician', roles: ['MAINTAINER'] },
      }),
    });
  }

  private async handleRefresh(route: Route) {
    const cookieHeader = (await route.request().headerValue('cookie')) ?? '';
    if (!cookieHeader.includes('bf_refresh=e2e-refresh-token')) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'no session', status: 401 }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: 'e2e-access-token-refreshed',
        expiresIn: 900,
        user: { id: 'user-1', fullName: 'Test Technician', roles: ['MAINTAINER'] },
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
    const body = job
      ? { ...this.toApiJob(job), status: 'SUBMITTED' }
      : { id: jobId, status: 'SUBMITTED' };
    this.submitStore.set(dedupeKey, body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/auth/login', (route) => this.handleLogin(route));
    await page.route('**/api/v1/auth/refresh', (route) => this.handleRefresh(route));
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
  }
}
