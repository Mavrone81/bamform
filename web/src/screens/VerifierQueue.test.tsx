/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { RouterProvider } from '../router';
import type { QueueEntry, QueuePage } from '../api/transport';

/**
 * Slice 26-TWOSTAGE. The delivered approval route is TWO stages — a workshop
 * team leader checks the record, then an engineer independently validates it
 * and only that second signature archives. Before this slice the queue screen
 * contained no reference to stage or ordinal at all, so a verifier opening it
 * could not tell where in that process a record actually sat, nor which
 * signature they were about to be asked for.
 *
 * The server only ever puts a record in the queue of someone eligible for its
 * CURRENT stage, so this is orientation rather than a filter — but "whose
 * signature is this, and is it the last one?" is exactly what a verifier needs
 * before signing something that archives an ISO-13485 record.
 */

let queuePage: QueuePage;

vi.mock('../state/services', () => ({
  getServices: () => ({
    transport: {
      getQueue: () => Promise.resolve(queuePage),
    },
  }),
}));

// Imported AFTER the mock is declared so the screen binds to the mocked seam.
import { VerifierQueue } from './VerifierQueue';

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'job-1',
    jobNumber: 'PM-2026-000431',
    assetId: 'asset-1',
    assetCode: 'AW03',
    frequency: 'M1',
    dueOn: '2026-08-01',
    status: 'SUBMITTED',
    submittedAt: '2026-07-28T00:00:00.000Z',
    ageHours: 4,
    escalated: false,
    onBehalfOf: null,
    stageOrdinal: 1,
    stageCount: 2,
    stageLabel: 'Verified By (Workshop Team Leader)',
    ...overrides,
  } as QueueEntry;
}

function page(entries: QueueEntry[]): QueuePage {
  return { data: entries, page: { hasMore: false, limit: 50, nextCursor: null } };
}

beforeEach(() => {
  queuePage = page([entry()]);
});

afterEach(() => {
  cleanup();
});

describe('VerifierQueue — which stage is this record at? (slice 26-TWOSTAGE)', () => {
  it('shows the stage position and the configured stage label for each entry', async () => {
    render(
      <RouterProvider>
        <VerifierQueue />
      </RouterProvider>,
    );

    expect(await screen.findByText('Stage 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Verified By (Workshop Team Leader)')).toBeInTheDocument();
  });

  it('marks the FINAL stage as the one that archives, so the engineer knows their signature is the last', async () => {
    queuePage = page([
      entry({
        id: 'job-2',
        stageOrdinal: 2,
        stageCount: 2,
        stageLabel: 'Verified By (Supervisor / Engineer)',
      }),
    ]);

    render(
      <RouterProvider>
        <VerifierQueue />
      </RouterProvider>,
    );

    expect(await screen.findByText('Stage 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('Verified By (Supervisor / Engineer)')).toBeInTheDocument();
    // A11y A-05: never colour alone — the final-stage meaning is in words.
    expect(screen.getByText(/final sign-off — archives the record/i)).toBeInTheDocument();
  });

  it('does not claim a non-final stage archives anything', async () => {
    render(
      <RouterProvider>
        <VerifierQueue />
      </RouterProvider>,
    );

    expect(await screen.findByText('Stage 1 of 2')).toBeInTheDocument();
    expect(screen.queryByText(/archives the record/i)).not.toBeInTheDocument();
  });

  /**
   * Review fix m1. `null >= null` is TRUE in JavaScript — both operands
   * coerce to 0 — so a server that ever omitted these fields would have made
   * the card render an empty chip AND "Final sign-off — archives the record",
   * telling a verifier their signature archives an ISO-13485 record when the
   * client has no idea what stage it is. Not reachable from today's server
   * (the fields are required and `eligibleEntriesFor` drops entries whose
   * stage is unconfigured), but a false claim about a controlled record is
   * worth one line of guard.
   */
  it('m1: says NOTHING about the stage when the server omitted it — never a bare chip, never a false "final" claim', async () => {
    queuePage = page([
      entry({
        stageOrdinal: null as unknown as number,
        stageCount: null as unknown as number,
        stageLabel: undefined as unknown as string,
      }),
    ]);

    render(
      <RouterProvider>
        <VerifierQueue />
      </RouterProvider>,
    );

    // The card still renders — the record is real and must not vanish.
    expect(await screen.findByText('PM-2026-000431')).toBeInTheDocument();
    expect(screen.queryByText(/final sign-off/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Stage /)).not.toBeInTheDocument();
    expect(screen.queryByText(/of 2/)).not.toBeInTheDocument();
  });

  it('renders both stages distinguishably when a verifier is eligible for both', async () => {
    queuePage = page([
      entry({ id: 'job-1', jobNumber: 'PM-A' }),
      entry({
        id: 'job-2',
        jobNumber: 'PM-B',
        stageOrdinal: 2,
        stageCount: 2,
        stageLabel: 'Verified By (Supervisor / Engineer)',
      }),
    ]);

    render(
      <RouterProvider>
        <VerifierQueue />
      </RouterProvider>,
    );

    expect(await screen.findByText('Stage 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Stage 2 of 2')).toBeInTheDocument();
  });
});
