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

  dropResponseOnceFor(mutationId: string): void {
    this.dropResponseOnce.add(mutationId);
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

  private async handleLogin(route: Route) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: 'e2e-access-token',
        expiresIn: 900,
        user: { id: 'user-1', fullName: 'Test Technician', roles: ['MAINTAINER'] },
      }),
    });
  }

  private async handleRefresh(route: Route) {
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
      await route.fulfill({ status: 400, contentType: 'application/problem+json', body: JSON.stringify({
        type: 'about:blank', title: 'batch too large', status: 400,
      }) });
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

      let result: OutboxResultLike;
      if (this.conflictOnce.has(m.id) || isStale) {
        this.conflictOnce.delete(m.id);
        result = {
          id: m.id,
          status: 409,
          applied: false,
          problem: {
            type: 'https://form.bevorasg.com/errors/draft-conflict',
            title: 'Draft version conflict',
            status: 409,
            detail: isStale ? `Job is at draftVersion ${currentVersion}, mutation based on ${m.ifMatch}` : undefined,
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(this.submitStore.get(dedupeKey)) });
      return;
    }
    this.submitCount.set(jobId, (this.submitCount.get(jobId) ?? 0) + 1);
    const job = this.jobs.get(jobId);
    const body = job ? { ...this.toApiJob(job), status: 'SUBMITTED' } : { id: jobId, status: 'SUBMITTED' };
    this.submitStore.set(dedupeKey, body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/auth/login', (route) => this.handleLogin(route));
    await page.route('**/api/v1/auth/refresh', (route) => this.handleRefresh(route));
    await page.route('**/api/v1/auth/logout', (route) => route.fulfill({ status: 204, body: '' }));
    await page.route('**/api/v1/sync/bootstrap*', (route) => this.handleBootstrap(route));
    await page.route('**/api/v1/sync/outbox', (route) => this.handleOutbox(route));
    await page.route(/\/api\/v1\/jobs\/([^/]+)\/submit/, (route) => {
      const match = route.request().url().match(/\/jobs\/([^/]+)\/submit/);
      return this.handleSubmit(route, match ? match[1] : 'unknown');
    });
  }
}
