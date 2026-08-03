/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RouterProvider } from '../router';
import { createTestDB, type BamFormDB, type OutboxEntry } from '../offline/db';
import { MockSyncTransport } from '../api/mock-transport';
import type { components } from '../api/generated/openapi-types';

/**
 * Slice 31-TITLEBLANK — the technician fills the blank in the form's TITLE.
 *
 * Same shape as `RecordCapture.parts.test.tsx` (real Dexie test db +
 * `MockSyncTransport`, only `../state/services` mocked) and for the same
 * reason: the outbox row IS the contract, so asserting on what actually
 * landed in `db.outbox` is stronger than asserting on a spied call.
 *
 * The two things most worth pinning here are the ones a technician would pay
 * for if they broke: (a) the value survives a reload while it is still queued
 * offline, and (b) submit is refused while the blank is empty.
 */

type Job = components['schemas']['Job'];

/** The real `ED____` shape, from `April 2026/ED01.pdf`. */
const FILLABLE_TITLE = 'BESi Die Attach Preventive Maintenance Record ED____';
/** The `EP01` shape — the number is printed already, so there is no blank. */
const PRINTED_TITLE = 'Epoxy Dispenser EP01 Preventive Maintenance Record';

let db: BamFormDB;
let transport: MockSyncTransport;
let counter = 0;

vi.mock('../state/services', () => ({
  getServices: () => ({ db, transport }),
  getSyncUserId: () => 'user-1',
}));

// Imported AFTER the mock is declared so the screen binds to the mocked seam.
import { RecordCapture, pendingTitleMachineNumber } from './RecordCapture';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    jobNumber: 'PM-2026-000001',
    assetCode: 'ED01',
    frequency: 'M3',
    dueOn: '2026-08-01',
    status: 'IN_PROGRESS',
    draftVersion: 1,
    titleHasFillableRun: true,
    titleMachineNumber: null,
    templateRevision: {
      id: 'rev-1',
      formTemplateId: 'tpl-1',
      revisionCode: 'A',
      sequenceOrdinal: 1,
      status: 'CURRENT',
      title: FILLABLE_TITLE,
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

async function seedOutboxRow(overrides: Partial<OutboxEntry>) {
  await db.outbox.add({
    id: `row-${outboxSequence}`,
    userId: 'user-1',
    sequence: ++outboxSequence,
    jobId: 'job-1',
    method: 'PUT',
    path: '/jobs/job-1/title-machine-number',
    body: { titleMachineNumber: '01' },
    ifMatch: 1,
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

/** Same technique as the parts suite: `append()`'s transaction wraps
 * `db.outbox.add`, and Dexie re-throws whatever that throws. */
function failNextOutboxWrite() {
  const original = db.outbox.add.bind(db.outbox);
  db.outbox.add = (() => {
    db.outbox.add = original;
    throw new DOMException('quota exceeded', 'QuotaExceededError');
  }) as typeof db.outbox.add;
}

const field = () => screen.getByLabelText('Form number in the title');
/** The entry is debounced by 400ms, so the row lands later than a bare tick. */
const untilOutbox = (count: number) =>
  waitFor(
    async () => {
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(count);
    },
    { timeout: 3000 },
  );

beforeEach(() => {
  db = createTestDB(`test-title-${counter++}-${Math.random()}`);
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

describe('RecordCapture — the blank in the form title (slice 31-TITLEBLANK)', () => {
  describe('the box is shown only when the title actually has a blank', () => {
    it('renders the field for a title with a fillable run', async () => {
      await seedJob(makeJob());
      renderScreen();
      expect(await screen.findByLabelText('Form number in the title')).toBeInTheDocument();
    });

    it.each([
      ['a title with the number already printed (EP01/PM01)', PRINTED_TITLE],
      ['a title with no machine designation at all', 'Aging Oven Preventive Maintenance Record'],
    ])('renders NO field for %s', async (_label, title) => {
      // The flag comes from the SERVER and is rendered verbatim — the screen
      // never re-derives it from the title string.
      await seedJob(
        makeJob({
          titleHasFillableRun: false,
          templateRevision: { ...makeJob().templateRevision!, title },
        }),
      );
      renderScreen();
      await screen.findByText('PM-2026-000001');
      expect(screen.queryByLabelText('Form number in the title')).not.toBeInTheDocument();
    });

    it('renders NO field when the server sent no flag at all (a job cached before this field existed)', async () => {
      const job = makeJob();
      delete (job as { titleHasFillableRun?: boolean }).titleHasFillableRun;
      await seedJob(job);
      renderScreen();
      await screen.findByText('PM-2026-000001');
      expect(screen.queryByLabelText('Form number in the title')).not.toBeInTheDocument();
    });
  });

  it('starts EMPTY — never pre-filled from the machine code', async () => {
    // `assetCode` is `ED01` and the blank is `ED____`; guessing that `01`
    // belongs in it is exactly the inference this slice refuses to make.
    await seedJob(makeJob());
    renderScreen();
    expect(await screen.findByLabelText('Form number in the title')).toHaveValue('');
  });

  it('shows the RAW title, blank and all, so the technician can see which blank they are filling', async () => {
    await seedJob(makeJob());
    renderScreen();
    expect(await screen.findByText(FILLABLE_TITLE)).toBeInTheDocument();
  });

  it('hydrates from a value the server already acknowledged', async () => {
    await seedJob(makeJob({ titleMachineNumber: '01' }));
    renderScreen();
    expect(await screen.findByLabelText('Form number in the title')).toHaveValue('01');
  });

  it('typing enqueues an UNVERSIONED PUT to /jobs/{jobId}/title-machine-number', async () => {
    await seedJob(makeJob());
    renderScreen();
    await screen.findByLabelText('Form number in the title');

    fireEvent.change(field(), { target: { value: '01' } });

    await untilOutbox(1);
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.method).toBe('PUT');
    expect(row.path).toBe('/jobs/job-1/title-machine-number');
    expect(row.body).toEqual({ titleMachineNumber: '01' });
    // Like a part upsert and unlike an item result: the server neither checks
    // nor bumps `draftVersion` for this route, so predicting a version here
    // would leave the prediction ahead of reality AND make two appends in one
    // tick (this box flushes on blur, blur is caused by tapping a checklist
    // button) conflict with each other.
    expect(row.ifMatch).toBeNull();
  });

  it('debounces — a burst of keystrokes queues ONE row carrying the final value', async () => {
    await seedJob(makeJob());
    renderScreen();
    await screen.findByLabelText('Form number in the title');

    fireEvent.change(field(), { target: { value: '0' } });
    fireEvent.change(field(), { target: { value: '01' } });
    fireEvent.change(field(), { target: { value: '012' } });

    await untilOutbox(1);
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.body).toEqual({ titleMachineNumber: '012' });
  });

  it('trims what is sent, and sends a CLEARED box as null — the server schema is min(1) and "" would 422 on drain', async () => {
    await seedJob(makeJob({ titleMachineNumber: '01' }));
    renderScreen();
    await screen.findByLabelText('Form number in the title');

    fireEvent.change(field(), { target: { value: '  02  ' } });
    await untilOutbox(1);
    expect((await db.outbox.where('jobId').equals('job-1').toArray())[0].body).toEqual({
      titleMachineNumber: '02',
    });

    fireEvent.change(field(), { target: { value: '   ' } });
    await untilOutbox(2);
    const rows = await db.outbox.where('jobId').equals('job-1').sortBy('sequence');
    expect(rows[1].body).toEqual({ titleMachineNumber: null });
  });

  describe('required at SUBMIT, optional while drafting', () => {
    it('blocks submit and SAYS WHY while the blank is empty', async () => {
      await seedJob(makeJob());
      renderScreen();
      const button = await screen.findByRole('button', {
        name: /enter the form number above to submit/i,
      });
      expect(button).toBeDisabled();
      expect(screen.getByText(/fill this in before submitting/i)).toBeInTheDocument();
    });

    it('offers submit once the blank is filled', async () => {
      await seedJob(makeJob({ titleMachineNumber: '01' }));
      renderScreen();
      const button = await screen.findByRole('button', { name: 'Sign and submit' });
      expect(button).toBeEnabled();
      expect(screen.queryByText(/fill this in before submitting/i)).not.toBeInTheDocument();
    });

    it('never blocks submit for a title that has no blank', async () => {
      await seedJob(
        makeJob({
          titleHasFillableRun: false,
          titleMachineNumber: null,
          templateRevision: { ...makeJob().templateRevision!, title: PRINTED_TITLE },
        }),
      );
      renderScreen();
      expect(await screen.findByRole('button', { name: 'Sign and submit' })).toBeEnabled();
    });
  });

  describe('offline survival — a queued-but-unsynced entry must not vanish', () => {
    it('a value present ONLY in the outbox still shows, and stops blocking submit', async () => {
      // O-10: a job with pending outbox rows is protected from being
      // overwritten by a later bootstrap, so this — server snapshot still
      // null, outbox already holding the entry — is exactly the state a real
      // device is in after a reload mid-shift.
      await seedJob(makeJob({ titleMachineNumber: null }));
      await seedOutboxRow({ body: { titleMachineNumber: '01' } });

      renderScreen();

      expect(await screen.findByLabelText('Form number in the title')).toHaveValue('01');
      // Not blocked on the blank any more — the remaining block is the
      // ordinary "still sending" one, which resolves on its own.
      expect(screen.queryByText(/fill this in before submitting/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /enter the form number above to submit/i }),
      ).not.toBeInTheDocument();
    });

    it('the LAST queued entry wins over both an earlier one and the server snapshot', async () => {
      await seedJob(makeJob({ titleMachineNumber: '99' }));
      await seedOutboxRow({ body: { titleMachineNumber: '01' } });
      await seedOutboxRow({ body: { titleMachineNumber: '02' } });

      renderScreen();

      expect(await screen.findByLabelText('Form number in the title')).toHaveValue('02');
    });

    it('a queued CLEAR beats an acknowledged value — and re-blocks submit, as the server would', async () => {
      await seedJob(makeJob({ titleMachineNumber: '01' }));
      await seedOutboxRow({ body: { titleMachineNumber: null } });

      renderScreen();

      expect(await screen.findByLabelText('Form number in the title')).toHaveValue('');
      expect(await screen.findByText(/fill this in before submitting/i)).toBeInTheDocument();
    });
  });

  it('quota-exceeded: shows the banner and enqueues NOTHING (non-negotiable #1)', async () => {
    await seedJob(makeJob());
    renderScreen();
    await screen.findByLabelText('Form number in the title');

    failNextOutboxWrite();
    fireEvent.change(field(), { target: { value: '01' } });

    expect(await screen.findByText(/device storage is full/i, undefined, { timeout: 3000 }));
    expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(0);
  });

  it('a SUBMITTED record shows the captured value read-only — no box to retype it in', async () => {
    await seedJob(makeJob({ status: 'SUBMITTED', titleMachineNumber: '01' }));
    renderScreen();

    await screen.findByText('PM-2026-000001');
    expect(screen.queryByLabelText('Form number in the title')).not.toBeInTheDocument();
    expect(screen.getByText('01')).toBeInTheDocument();
  });
});

/**
 * The merge rule on its own. It is the piece that decides whether a
 * technician's offline entry is visible after a reload, and `undefined`
 * (nothing queued) vs `null` (queued a CLEAR) is the distinction the whole
 * thing turns on — a Map-style "absent means null" would silently discard the
 * server's acknowledged value.
 */
describe('pendingTitleMachineNumber', () => {
  const row = (overrides: Partial<OutboxEntry>): OutboxEntry =>
    ({
      id: 'r',
      userId: 'user-1',
      sequence: 1,
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/title-machine-number',
      body: { titleMachineNumber: '01' },
      ifMatch: null,
      clientRecordedAt: '',
      createdAt: '',
      status: 'pending',
      attempts: 0,
      lastError: null,
      lastResult: null,
      ...overrides,
    }) as OutboxEntry;

  it('returns undefined when nothing is queued for the title', () => {
    expect(pendingTitleMachineNumber('job-1', [])).toBeUndefined();
    expect(
      pendingTitleMachineNumber('job-1', [row({ path: '/jobs/job-1/items/item-1' })]),
    ).toBeUndefined();
  });

  it('never picks up ANOTHER job’s queued entry', () => {
    expect(
      pendingTitleMachineNumber('job-2', [row({ path: '/jobs/job-1/title-machine-number' })]),
    ).toBeUndefined();
  });

  it('takes the highest-sequence row, whatever order they arrive in', () => {
    expect(
      pendingTitleMachineNumber('job-1', [
        row({ id: 'b', sequence: 9, body: { titleMachineNumber: '02' } }),
        row({ id: 'a', sequence: 4, body: { titleMachineNumber: '01' } }),
      ]),
    ).toBe('02');
  });

  it('distinguishes a queued CLEAR (null) from nothing queued (undefined)', () => {
    expect(
      pendingTitleMachineNumber('job-1', [row({ body: { titleMachineNumber: null } })]),
    ).toBeNull();
  });
});
