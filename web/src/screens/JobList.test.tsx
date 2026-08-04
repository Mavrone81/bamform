/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { RouterProvider } from '../router';
import { createTestDB, LEGACY_USER_ID, type BamFormDB } from '../offline/db';
import { MockSyncTransport } from '../api/mock-transport';

/**
 * H-2 (review): the first post-upgrade session. App's sign-in resume drain
 * fires BEFORE bootstrap's legacy claim, so unless something drains AFTER
 * the claim, a technician's pre-upgrade unsent work sits untransmitted for
 * the whole session on an always-online device (the reviewer measured 0
 * outbox requests). This screen-level test renders the real JobList against
 * a mocked services seam and fails without the drain-after-bootstrap
 * trigger in JobList's `.finally`.
 */

let db: BamFormDB;
let transport: MockSyncTransport;
let counter = 0;

vi.mock('../state/services', () => ({
  getServices: () => ({ db, transport }),
  getSyncUserId: () => 'user-1',
}));

// Imported AFTER the mock is declared so JobList binds to the mocked seam.
import { JobList } from './JobList';

beforeEach(() => {
  db = createTestDB(`test-joblist-${counter++}-${Math.random()}`);
  transport = new MockSyncTransport();
  // jsdom has no matchMedia; InstallHint queries display-mode on mount.
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});

afterEach(async () => {
  cleanup();
  await db.delete();
});

describe('JobList — first-session drain of claimed legacy work (H-2)', () => {
  it('drains pre-upgrade legacy rows in the SAME session that claims them — no online transition needed', async () => {
    // A device fresh from the v1→v2 upgrade: one unsent pre-upgrade row,
    // still quarantined under the migration sentinel, its job carrying no
    // assignee hint (fallback-claim path).
    await db.jobs.put({
      userId: LEGACY_USER_ID,
      id: 'job-legacy',
      job: { id: 'job-legacy', jobNumber: 'PM-OLD-1', dueOn: '2026-08-01' } as never,
      cachedAt: new Date().toISOString(),
      hasPendingOutbox: true,
      submitState: 'none',
      serverRemoved: false,
      predictedDraftVersion: 2,
    });
    await db.outbox.add({
      id: 'legacy-row-1',
      userId: LEGACY_USER_ID,
      sequence: 1,
      jobId: 'job-legacy',
      method: 'PUT',
      path: '/jobs/job-legacy/items/item-1',
      body: { status: 'DONE' },
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      lastResult: null,
    });

    render(
      <RouterProvider>
        <JobList />
      </RouterProvider>,
    );

    // Mount → bootstrap (claims the row for user-1, the bootstrap
    // principal) → the post-bootstrap drain transmits it. Exactly once.
    await waitFor(() => expect(transport.timesApplied('legacy-row-1')).toBe(1), {
      timeout: 3000,
    });
    expect(await db.outbox.get('legacy-row-1')).toBeUndefined(); // acked + cleared
  });
});

/**
 * Every Dexie read on this screen is fire-and-forget (`void refresh()` from
 * the effect and from `onSynced`; three `void x.then(...)` reads on mount), so
 * a rejection used to go nowhere at all. Two consequences, one visible in CI
 * and one only on a real device:
 *
 * - vitest 4 FAILS the run on an unhandled rejection while still reporting
 *   every test as passed, which is how `main` shipped red with green counts.
 * - a technician saw "Loading…" for ever, with no warning about unsent work,
 *   and nothing retrying behind it.
 */
describe('a faulted IndexedDB is stated, not spun on for ever', () => {
  it('says the device could not be read instead of showing an endless spinner', async () => {
    // A closed/faulted database — what `versionchange` from a second tab, or
    // an evicted origin, actually looks like to this screen.
    const closed = () => {
      throw new Error('DatabaseClosedError: Database has been closed');
    };
    db.jobs.where = closed as typeof db.jobs.where;
    db.outbox.where = closed as typeof db.outbox.where;
    db.meta.get = closed as typeof db.meta.get;

    const view = render(
      <RouterProvider>
        <JobList />
      </RouterProvider>,
    );

    await waitFor(() => expect(view.getByText(/storage could not be read/i)).toBeInTheDocument());
    expect(view.queryByText(/Loading/)).not.toBeInTheDocument();
  });
});
