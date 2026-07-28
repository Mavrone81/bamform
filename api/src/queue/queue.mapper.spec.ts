import { toQueueEntry } from './queue.mapper';
import type { JobSummaryRow } from '../jobs/job-include';

function baseRow(overrides: Partial<JobSummaryRow & { submittedAt: Date | null }> = {}) {
  return {
    id: 'job-1',
    jobNumber: 'PM-2026-000431',
    assetId: 'asset-1',
    frequency: 'M1',
    frequencyScope: ['M1'],
    dueOn: new Date('2026-07-01T00:00:00Z'),
    status: 'submitted',
    assignedTo: null,
    submittedAt: new Date('2026-07-20T00:00:00Z'),
    asset: { code: 'AW03', areaId: 'area-1' },
    templateRevision: { revisionCode: 'A', formTemplate: { documentNumber: 'DOC-1' } },
    ...overrides,
  } as unknown as JobSummaryRow & { submittedAt: Date | null };
}

const STAGE_1 = { ordinal: 1, label: 'Verified By (Workshop Team Leader)', count: 2 };
const STAGE_2 = { ordinal: 2, label: 'Verified By (Supervisor / Engineer)', count: 2 };

describe('toQueueEntry (PR-073/076 queue response mapping)', () => {
  it('computes ageHours from now - submittedAt', () => {
    const now = new Date('2026-07-22T00:00:00Z'); // 48h after submittedAt
    const entry = toQueueEntry(baseRow(), null, now, 72, STAGE_1);
    expect(entry.ageHours).toBe(48);
  });

  it('escalated is true once ageHours reaches the display threshold', () => {
    const now = new Date('2026-07-23T00:00:00Z'); // 72h after submittedAt
    const entry = toQueueEntry(baseRow(), null, now, 72, STAGE_1);
    expect(entry.escalated).toBe(true);
  });

  it('escalated is false below the display threshold', () => {
    const now = new Date('2026-07-21T00:00:00Z'); // 24h after submittedAt
    const entry = toQueueEntry(baseRow(), null, now, 72, STAGE_1);
    expect(entry.escalated).toBe(false);
  });

  it('carries onBehalfOf through unchanged (null for own-eligibility entries)', () => {
    const entry = toQueueEntry(baseRow(), null, new Date(), 72, STAGE_1);
    expect(entry.onBehalfOf).toBeNull();
  });

  it('sets onBehalfOf to the delegator id for a delegated entry', () => {
    const entry = toQueueEntry(baseRow(), 'delegator-1', new Date(), 72, STAGE_1);
    expect(entry.onBehalfOf).toBe('delegator-1');
  });

  it('throws a clear error if a SUBMITTED job somehow has no submittedAt (data invariant guard)', () => {
    expect(() =>
      toQueueEntry(baseRow({ submittedAt: null }), null, new Date(), 72, STAGE_1),
    ).toThrow(/data invariant/);
  });

  // Slice 26-TWOSTAGE. The route is two stages (TEAM_LEADER then ENGINEER),
  // so a queue entry that says nothing about WHICH stage it awaits leaves a
  // verifier unable to tell where in the process a record actually is.
  it('slice 26: carries the stage the record awaits — ordinal, human label and the route stage count', () => {
    const entry = toQueueEntry(baseRow(), null, new Date(), 72, STAGE_1);
    expect(entry.stageOrdinal).toBe(1);
    expect(entry.stageCount).toBe(2);
    expect(entry.stageLabel).toBe('Verified By (Workshop Team Leader)');
  });

  it('slice 26: a record at the FINAL stage reports that stage, not stage 1', () => {
    const entry = toQueueEntry(baseRow(), null, new Date(), 72, STAGE_2);
    expect(entry.stageOrdinal).toBe(2);
    expect(entry.stageCount).toBe(2);
    expect(entry.stageLabel).toBe('Verified By (Supervisor / Engineer)');
  });
});
