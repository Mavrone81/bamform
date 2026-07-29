/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { RouterProvider } from '../router';
import { createTestDB, type BamFormDB } from '../offline/db';
import { MockSyncTransport } from '../api/mock-transport';
import type { components } from '../api/generated/openapi-types';

/**
 * Slice 30-PARTS, Task 6. Mirrors the JobList screen-test pattern (real
 * Dexie test db + MockSyncTransport, only `../state/services` mocked) rather
 * than mocking `appendJobMutation` itself — the outbox row IS the contract
 * (non-negotiable #1: it must never be cleared optimistically), so asserting
 * on what actually landed in `db.outbox` is stronger than asserting on a
 * spied call.
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

function renderScreen(jobId = 'job-1') {
  return render(
    <RouterProvider>
      <RecordCapture jobId={jobId} />
    </RouterProvider>,
  );
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

  it('adding a part enqueues a PUT to /jobs/{jobId}/parts/{uuid} with active:true', async () => {
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

    // The row is only shown as saved once appendJobMutation actually
    // durably wrote it — this proves it did, on the UI side too.
    expect(await screen.findByText('Drive belt')).toBeInTheDocument();
  });

  it('editing an existing part re-enqueues a PUT to the SAME partId with the new values', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
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
    const editButtonInFirstRow = within(rows[0]).getByRole('button', { name: 'Edit' });
    fireEvent.click(editButtonInFirstRow);
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText(/qty 9/);
    const rowsAfter = screen.getAllByTestId('part-row');
    expect(rowsAfter).toHaveLength(2);
    expect(rowsAfter[0]).toHaveTextContent('Bearing 6203');
    expect(rowsAfter[1]).toHaveTextContent('Drive belt');
  });

  it('removing a part enqueues a PUT to that partId with active:false and the row disappears', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(async () => {
      expect(await db.outbox.where('jobId').equals('job-1').count()).toBe(1);
    });
    const [row] = await db.outbox.where('jobId').equals('job-1').toArray();
    expect(row.method).toBe('PUT');
    expect(row.path).toBe('/jobs/job-1/parts/part-1');
    expect(row.body).toMatchObject({ active: false });

    await waitFor(() => {
      expect(screen.queryByText('Bearing 6203')).not.toBeInTheDocument();
    });
  });
});
