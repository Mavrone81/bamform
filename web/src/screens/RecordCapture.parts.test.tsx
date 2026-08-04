/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { RouterProvider } from '../router';
import { createTestDB, type BamFormDB, type OutboxEntry } from '../offline/db';
import { MockSyncTransport } from '../api/mock-transport';
import type { components } from '../api/generated/openapi-types';

/**
 * Slice 30-PARTS, Task 6 (+ review fix pass). Mirrors the JobList screen-test
 * pattern (real Dexie test db + MockSyncTransport, only `../state/services`
 * mocked) rather than mocking `appendJobMutation` itself — the outbox row IS
 * the contract (non-negotiable #1: it must never be cleared optimistically),
 * so asserting on what actually landed in `db.outbox` is stronger than
 * asserting on a spied call.
 */

type Job = components['schemas']['Job'];
type PartUsed = components['schemas']['PartUsed'];

let db: BamFormDB;
let transport: MockSyncTransport;
let counter = 0;

vi.mock('../state/services', () => ({
  getServices: () => ({ db, transport }),
  getSyncUserId: () => 'user-1',
}));

// Imported AFTER the mock is declared so the screen binds to the mocked seam.
import { RecordCapture } from './RecordCapture';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    jobNumber: 'PM-2026-000001',
    assetCode: 'AW01',
    frequency: 'M3',
    dueOn: '2026-08-01',
    status: 'IN_PROGRESS',
    draftVersion: 1,
    templateRevision: {
      id: 'rev-1',
      formTemplateId: 'tpl-1',
      revisionCode: 'A',
      sequenceOrdinal: 1,
      status: 'CURRENT',
      items: [],
      measurements: [],
    },
    ...overrides,
  } as Job;
}

async function seedJob(job: Job) {
  await db.jobs.put({
    userId: 'user-1',
    id: job.id,
    job,
    cachedAt: new Date().toISOString(),
    hasPendingOutbox: false,
    submitState: 'none',
    serverRemoved: false,
    predictedDraftVersion: job.draftVersion ?? 1,
  });
}

let outboxSequence = 0;

/** Directly seeds a pending (never-drained) outbox row — used to simulate
 * "reload while a part mutation is still queued" without going through the
 * UI, and to make quota-exceeded simulation available to every test via
 * `failNextOutboxWrite`. */
async function seedOutboxRow(overrides: Partial<OutboxEntry>) {
  await db.outbox.add({
    id: `row-${outboxSequence}`,
    userId: 'user-1',
    sequence: ++outboxSequence,
    jobId: 'job-1',
    method: 'PUT',
    path: '/jobs/job-1/parts/part-x',
    body: { description: 'placeholder', quantity: 1, active: true },
    ifMatch: null,
    clientRecordedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    lastError: null,
    lastResult: null,
    ...overrides,
  });
}

function renderScreen(jobId = 'job-1') {
  return render(
    <RouterProvider>
      <RecordCapture jobId={jobId} />
    </RouterProvider>,
  );
}

/** Same technique `sync-engine.test.ts` uses to simulate O-11 (device
 * storage full): `append()`'s transaction wraps `db.outbox.add`, and Dexie
 * re-throws whatever that throws. Restores itself after ONE call so a test
 * can assert the write genuinely never lands. */
function failNextOutboxWrite() {
  const original = db.outbox.add.bind(db.outbox);
  db.outbox.add = (() => {
    db.outbox.add = original;
    throw new DOMException('quota exceeded', 'QuotaExceededError');
  }) as typeof db.outbox.add;
}

/** The OTHER way a write fails: not "full", but "this database is not
 * usable" — a closed or faulted IndexedDB. `outbox.append()` returns a
 * result for the quota case and RE-THROWS this one, which is the whole
 * point of the distinction. */
function failNextOutboxWriteHard() {
  const original = db.outbox.add.bind(db.outbox);
  db.outbox.add = (() => {
    db.outbox.add = original;
    throw new Error('DatabaseClosedError: Database has been closed');
  }) as typeof db.outbox.add;
}

beforeEach(() => {
  db = createTestDB(`test-parts-${counter++}-${Math.random()}`);
  transport = new MockSyncTransport();
  // Offline: keeps the outbox row on the shelf so the test can inspect it
  // rather than racing a drain that would ack and clear it.
  vi.stubGlobal('navigator', { onLine: false });
});

afterEach(async () => {
  cleanup();
  await db.delete();
  vi.unstubAllGlobals();
});

describe('RecordCapture — Parts Used capture (slice 30-PARTS, Task 6)', () => {
  it('renders existing parts from cached.job.partsUsed on load', async () => {
    const part: PartUsed = {
      id: 'part-1',
      partNo: 'BRG-6203',
      description: 'Bearing 6203',
      quantity: 2,
      remarks: null,
    };
    await seedJob(makeJob({ partsUsed: [part] }));

    renderScreen();

    expect(await screen.findByText('Bearing 6203')).toBeInTheDocument();
    expect(screen.getByText(/qty 2/)).toBeInTheDocument();
  });

  it('adding a part enqueues an UNVERSIONED PUT to /jobs/{jobId}/parts/{uuid} with active:true', async () => {
    await seedJob(makeJob({ partsUsed: [] }));
    renderScreen();
    await screen.findByText('PM-2026-000001');

    fireEvent.click(screen.getByRole('button', { name: /add a part/i }));
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Drive belt' },
    });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add part' }));

    await waitFor(async () => {
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(1);
    });
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.method).toBe('PUT');
    expect(row.path).toMatch(
      /^\/jobs\/job-1\/parts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(row.body).toMatchObject({
      description: 'Drive belt',
      quantity: 3,
      active: true,
    });
    // Review Critical: the parts-upsert route never bumps the job's real
    // draftVersion server-side, so this must never carry a predicted
    // ifMatch — see sync-engine.test.ts for the focused unit-level proof
    // that a later item/measurement mutation stays unaffected.
    expect(row.ifMatch).toBeNull();

    // The row is only shown as saved once appendJobMutation actually
    // durably wrote it — this proves it did, on the UI side too.
    expect(await screen.findByText('Drive belt')).toBeInTheDocument();
  });

  it('an empty partNo is sent as null, not "" — the server schema is min(1) and "" would 422 on drain', async () => {
    await seedJob(makeJob({ partsUsed: [] }));
    renderScreen();
    await screen.findByText('PM-2026-000001');

    fireEvent.click(screen.getByRole('button', { name: /add a part/i }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Drive belt' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    // Part number and remarks left blank.
    fireEvent.click(screen.getByRole('button', { name: 'Add part' }));

    await waitFor(async () => {
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(1);
    });
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.body).toMatchObject({ partNo: null, remarks: null });
  });

  it('an entered partNo and remarks round-trip into the enqueued body', async () => {
    await seedJob(makeJob({ partsUsed: [] }));
    renderScreen();
    await screen.findByText('PM-2026-000001');

    fireEvent.click(screen.getByRole('button', { name: /add a part/i }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Drive belt' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/part number/i), { target: { value: 'BLT-01' } });
    fireEvent.change(screen.getByLabelText(/remarks/i), {
      target: { value: 'sourced from spares cabinet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add part' }));

    await waitFor(async () => {
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(1);
    });
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.body).toMatchObject({
      partNo: 'BLT-01',
      remarks: 'sourced from spares cabinet',
    });
  });

  describe('validation — nothing invalid is ever enqueued', () => {
    async function openAddForm() {
      await seedJob(makeJob({ partsUsed: [] }));
      renderScreen();
      await screen.findByText('PM-2026-000001');
      fireEvent.click(screen.getByRole('button', { name: /add a part/i }));
    }

    it('a whitespace-only description leaves Add part disabled and enqueues nothing', async () => {
      await openAddForm();
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: '   ' } });
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });

      expect(screen.getByRole('button', { name: 'Add part' })).toBeDisabled();
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
    });

    it.each(['0', '-1', 'not-a-number', ''])(
      'a quantity of %j leaves Add part disabled and enqueues nothing',
      async (quantity) => {
        await openAddForm();
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Drive belt' } });
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: quantity } });

        expect(screen.getByRole('button', { name: 'Add part' })).toBeDisabled();
        expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
      },
    );
  });

  it('editing an existing part re-enqueues an UNVERSIONED PUT to the SAME partId with the new values', async () => {
    const part: PartUsed = {
      id: 'part-1',
      partNo: null,
      description: 'Bearing 6203',
      quantity: 2,
      remarks: null,
    };
    await seedJob(makeJob({ partsUsed: [part] }));
    renderScreen();
    await screen.findByText('Bearing 6203');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Bearing 6203' }));
    const qtyInput = screen.getByLabelText('Quantity');
    fireEvent.change(qtyInput, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(async () => {
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(1);
    });
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.method).toBe('PUT');
    expect(row.path).toBe('/jobs/job-1/parts/part-1');
    expect(row.body).toMatchObject({ description: 'Bearing 6203', quantity: 5, active: true });
    expect(row.ifMatch).toBeNull();

    expect(await screen.findByText(/qty 5/)).toBeInTheDocument();
  });

  it('editing the FIRST of several parts keeps it in place rather than moving it to the end of the list', async () => {
    const partA: PartUsed = {
      id: 'part-a',
      partNo: null,
      description: 'Bearing 6203',
      quantity: 2,
      remarks: null,
    };
    const partB: PartUsed = {
      id: 'part-b',
      partNo: null,
      description: 'Drive belt',
      quantity: 1,
      remarks: null,
    };
    await seedJob(makeJob({ partsUsed: [partA, partB] }));
    renderScreen();
    await screen.findByText('Bearing 6203');

    const rows = screen.getAllByTestId('part-row');
    const editButtonInFirstRow = within(rows[0]).getByRole('button', { name: /^Edit /i });
    fireEvent.click(editButtonInFirstRow);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText(/qty 9/);
    const rowsAfter = screen.getAllByTestId('part-row');
    expect(rowsAfter).toHaveLength(2);
    expect(rowsAfter[0]).toHaveTextContent('Bearing 6203');
    expect(rowsAfter[1]).toHaveTextContent('Drive belt');
  });

  it('removing a part enqueues an UNVERSIONED PUT to that partId with active:false and the row disappears', async () => {
    const part: PartUsed = {
      id: 'part-1',
      partNo: null,
      description: 'Bearing 6203',
      quantity: 2,
      remarks: null,
    };
    await seedJob(makeJob({ partsUsed: [part] }));
    renderScreen();
    await screen.findByText('Bearing 6203');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bearing 6203' }));

    await waitFor(async () => {
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(1);
    });
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.method).toBe('PUT');
    expect(row.path).toBe('/jobs/job-1/parts/part-1');
    expect(row.body).toMatchObject({ active: false });
    expect(row.ifMatch).toBeNull();

    await waitFor(() => {
      expect(screen.queryByText('Bearing 6203')).not.toBeInTheDocument();
    });
  });

  describe('quota-exceeded (non-negotiable #1: the outbox never clears/shows-saved optimistically)', () => {
    it('add: shows the quota banner and does NOT show the part as saved', async () => {
      await seedJob(makeJob({ partsUsed: [] }));
      renderScreen();
      await screen.findByText('PM-2026-000001');

      fireEvent.click(screen.getByRole('button', { name: /add a part/i }));
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Drive belt' } });
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
      failNextOutboxWrite();
      fireEvent.click(screen.getByRole('button', { name: 'Add part' }));

      expect(await screen.findByText(/device storage is full/i)).toBeInTheDocument();
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
      // Not in the list as a saved row — only in the still-open form field.
      expect(screen.queryAllByTestId('part-row')).toHaveLength(0);
    });

    it('edit: shows the quota banner and the row keeps its OLD value, not the failed edit', async () => {
      const part: PartUsed = {
        id: 'part-1',
        partNo: null,
        description: 'Bearing 6203',
        quantity: 2,
        remarks: null,
      };
      await seedJob(makeJob({ partsUsed: [part] }));
      renderScreen();
      await screen.findByText('Bearing 6203');

      fireEvent.click(screen.getByRole('button', { name: 'Edit Bearing 6203' }));
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '5' } });
      failNextOutboxWrite();
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(await screen.findByText(/device storage is full/i)).toBeInTheDocument();
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
      // The failed value never rendered anywhere.
      expect(screen.queryByText(/qty 5/)).not.toBeInTheDocument();
    });

    it('remove: shows the quota banner and the row stays in the list', async () => {
      const part: PartUsed = {
        id: 'part-1',
        partNo: null,
        description: 'Bearing 6203',
        quantity: 2,
        remarks: null,
      };
      await seedJob(makeJob({ partsUsed: [part] }));
      renderScreen();
      await screen.findByText('Bearing 6203');

      failNextOutboxWrite();
      fireEvent.click(screen.getByRole('button', { name: 'Remove Bearing 6203' }));

      expect(await screen.findByText(/device storage is full/i)).toBeInTheDocument();
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
      expect(screen.getByText('Bearing 6203')).toBeInTheDocument();
    });
  });

  /**
   * The gap review M-1 named and left. `outbox.append()` RETURNS a result for
   * a quota refusal but RE-THROWS everything else (a closed or faulted
   * IndexedDB — e.g. another tab upgrading the schema fires `versionchange`
   * and Dexie closes this connection). `savePart`/`removePart` run from
   * `void`ed click handlers, so that throw was an unhandled rejection and
   * NOTHING ELSE: no banner, no error, the part simply never appeared. A part
   * that does not show up after "Add part" reads as a mis-tap, not a fault.
   *
   * These tests exist so the surface cannot quietly disappear again — a
   * blanket `.catch` that swallowed the throw would pass the old suite and
   * fail this one.
   */
  describe('a non-quota IndexedDB fault is STATED, never silently dropped', () => {
    it('add: states the device fault, does not blame full storage, and does not show the part as saved', async () => {
      await seedJob(makeJob({ partsUsed: [] }));
      renderScreen();
      await screen.findByText('PM-2026-000001');

      fireEvent.click(screen.getByRole('button', { name: /add a part/i }));
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Drive belt' } });
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
      failNextOutboxWriteHard();
      fireEvent.click(screen.getByRole('button', { name: 'Add part' }));

      expect(
        await screen.findByText(/last entry could NOT be held on this device/i),
      ).toBeInTheDocument();
      // Not the storage-full message — that would send them to free up space
      // that was never the problem.
      expect(screen.queryByText(/device storage is full/i)).not.toBeInTheDocument();
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
      expect(screen.queryAllByTestId('part-row')).toHaveLength(0);
    });

    it('remove: states the device fault and the row STAYS in the list', async () => {
      const part: PartUsed = {
        id: 'part-1',
        partNo: null,
        description: 'Bearing 6203',
        quantity: 2,
        remarks: null,
      };
      await seedJob(makeJob({ partsUsed: [part] }));
      renderScreen();
      await screen.findByText('Bearing 6203');

      failNextOutboxWriteHard();
      fireEvent.click(screen.getByRole('button', { name: 'Remove Bearing 6203' }));

      expect(
        await screen.findByText(/last entry could NOT be held on this device/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/device storage is full/i)).not.toBeInTheDocument();
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
      // A row that vanished without a queued `active:false` would read as
      // removed here and stay on the record for ever.
      expect(screen.getByText('Bearing 6203')).toBeInTheDocument();
    });

    it('a failed READ of this device is stated, not shown as a record with no parts', async () => {
      const part: PartUsed = {
        id: 'part-1',
        partNo: null,
        description: 'Bearing 6203',
        quantity: 2,
        remarks: null,
      };
      await seedJob(makeJob({ partsUsed: [part] }));
      // `refreshState` is the ONLY writer of `parts`. Both it and
      // `loadCached` are fire-and-forget, so a faulted read used to reject
      // into nothing and leave the Parts used section stating that no parts
      // were used — when the truth was that nobody could find out.
      db.outbox.where = (() => {
        throw new Error('DatabaseClosedError: Database has been closed');
      }) as typeof db.outbox.where;

      renderScreen();

      expect(await screen.findByText(/held entries could not be read/i)).toBeInTheDocument();
    });

    it('a cached copy that cannot be read says so instead of spinning for ever', async () => {
      await seedJob(makeJob({ partsUsed: [] }));
      db.jobs.get = (() =>
        Promise.reject(
          new Error('DatabaseClosedError: Database has been closed'),
        )) as unknown as typeof db.jobs.get;

      renderScreen();

      expect(await screen.findByText(/storage could not be read/i)).toBeInTheDocument();
      expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    });
  });

  describe('edit window — controls only while ASSIGNED/IN_PROGRESS', () => {
    it('a SUBMITTED job shows parts read-only: no Add/Edit/Remove controls', async () => {
      const part: PartUsed = {
        id: 'part-1',
        partNo: null,
        description: 'Bearing 6203',
        quantity: 2,
        remarks: null,
      };
      await seedJob(makeJob({ status: 'SUBMITTED', partsUsed: [part] }));
      renderScreen();

      expect(await screen.findByText('Bearing 6203')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add a part/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Edit /i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Remove /i })).not.toBeInTheDocument();
    });
  });

  describe('reload survival — a queued-but-unsynced part must not vanish or be re-addable under a new id', () => {
    it('a part present only in the outbox (not yet in cached.job.partsUsed) still renders, keyed by its original id', async () => {
      await seedJob(makeJob({ partsUsed: [] })); // server has not acked anything yet
      await seedOutboxRow({
        path: '/jobs/job-1/parts/part-offline-1',
        body: {
          partNo: null,
          description: 'Bearing 6203',
          quantity: 2,
          remarks: null,
          active: true,
        },
      });

      renderScreen();

      expect(await screen.findByText('Bearing 6203')).toBeInTheDocument();
      expect(screen.getByText(/qty 2/)).toBeInTheDocument();
      // Still editable by its ORIGINAL id — proves it round-tripped as the
      // same part, not a placeholder that would fork into a duplicate.
      fireEvent.click(screen.getByRole('button', { name: 'Edit Bearing 6203' }));
      fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(async () => {
        expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(2);
      });
      const rows = await db.outbox.where('jobId').equals('job-1').toArray();
      expect(rows.every((r) => r.path === '/jobs/job-1/parts/part-offline-1')).toBe(true);
    });

    it('a pending REMOVE for a server-acked part hides it even though cached.job.partsUsed still lists it', async () => {
      const part: PartUsed = {
        id: 'part-1',
        partNo: null,
        description: 'Bearing 6203',
        quantity: 2,
        remarks: null,
      };
      // O-10: a job with pending outbox rows is protected from being
      // overwritten by a later bootstrap snapshot, so this — server
      // snapshot still listing the part, outbox already holding its
      // removal — is exactly the state a real device would be in.
      await seedJob(makeJob({ partsUsed: [part] }));
      await seedOutboxRow({
        path: '/jobs/job-1/parts/part-1',
        body: {
          partNo: null,
          description: 'Bearing 6203',
          quantity: 2,
          remarks: null,
          active: false,
        },
      });

      renderScreen();
      await screen.findByText('PM-2026-000001');

      expect(screen.queryByText('Bearing 6203')).not.toBeInTheDocument();
    });
  });
});
