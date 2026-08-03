/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AssetDocument, ScheduleRule } from '../api/admin-client';

/**
 * Slice 29-SCHEDULE-UI — the missing half of the backfill workflow.
 * `MachineDocuments` lets an admin attach a document; this proves the screen
 * that lets anyone actually set when its work is due, and — the property
 * that matters most — that the past-due warning is true about BOTH the past
 * and the future (review IMPORTANT-3): a sweep may already have raised a job
 * against the old date, adjusting the date here does not remove it, and this
 * app has no control anywhere that voids one, so the banner says so instead
 * of inventing a path.
 */

const getAssetSchedule = vi.fn();
const listAssetDocuments = vi.fn();
const adjustAssetSchedule = vi.fn();

vi.mock('../api/admin-client', () => ({
  getAssetSchedule: (...args: unknown[]) => getAssetSchedule(...args),
  listAssetDocuments: (...args: unknown[]) => listAssetDocuments(...args),
  adjustAssetSchedule: (...args: unknown[]) => adjustAssetSchedule(...args),
}));

const getCurrentUser = vi.fn();
const onCurrentUserChange = vi.fn();

vi.mock('../auth', () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  onCurrentUserChange: (...args: unknown[]) => onCurrentUserChange(...args),
}));

// Imported AFTER the mocks so the component binds to them.
import { MachineSchedule } from './MachineSchedule';

const DOC: AssetDocument = {
  id: 'ad-1',
  assetId: 'asset-1',
  formTemplateId: 'tpl-1',
  documentNumber: 'CE 95 020 00 03',
  title: 'KNS Wire Bond Preventive Maintenance Record KW___',
  resolvedTitle: 'KNS Wire Bond Preventive Maintenance Record KW13',
  titleHasFillableRun: true,
  machineNumber: '13',
  active: true,
};

const FUTURE_RULE: ScheduleRule = {
  id: 'rule-1',
  assetDocumentId: 'ad-1',
  assetId: 'asset-1',
  frequency: 'M1',
  intervalMonths: 1,
  anchorDate: '2026-01-01',
  lastCompletedOn: null,
  nextDueOn: '2099-01-01',
  adjustedReason: null,
  active: true,
};

/** A machine just given a document with `nextDueOn = scheduleAnchorDate` in
 * the past — the exact state this screen exists to catch before the next
 * sweep. */
const PAST_RULE: ScheduleRule = {
  id: 'rule-2',
  assetDocumentId: 'ad-1',
  assetId: 'asset-1',
  frequency: 'M3',
  intervalMonths: 3,
  anchorDate: '2020-01-01',
  lastCompletedOn: null,
  nextDueOn: '2020-01-01',
  adjustedReason: null,
  active: true,
};

/** A second overdue row on the same machine — the two-alert case MINOR-2
 * flagged: `findByRole('alert')` throws on more than one match. */
const ANOTHER_PAST_RULE: ScheduleRule = {
  ...PAST_RULE,
  id: 'rule-3',
  frequency: 'M6',
  intervalMonths: 6,
  nextDueOn: '2019-01-01',
};

function seed(rules: ScheduleRule[], documents: AssetDocument[] = [DOC]) {
  getAssetSchedule.mockResolvedValue({ ok: true, status: 200, value: rules });
  listAssetDocuments.mockResolvedValue({ ok: true, status: 200, value: { data: documents } });
}

function setRole(roles: string[]) {
  getCurrentUser.mockReturnValue({ id: 'u-1', fullName: 'Test User', roles });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockReturnValue(null);
  onCurrentUserChange.mockReturnValue(() => {});
});

afterEach(() => {
  cleanup();
});

describe('U-SCHED-UI-01: read-only for a caller without a PUT role', () => {
  it('renders the schedule but offers no adjust control for a role the server refuses', async () => {
    setRole(['MAINTAINER']);
    seed([FUTURE_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    expect(await screen.findByText(DOC.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adjust next due date/i })).not.toBeInTheDocument();
    expect(screen.getByText(/you can view this schedule/i)).toBeInTheDocument();
  });

  it('offers the control to a role the server permits (PUT is PLANNER/TEAM_LEADER/ENGINEER/ADMIN)', async () => {
    setRole(['ENGINEER']);
    seed([FUTURE_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    expect(
      await screen.findByRole('button', { name: /adjust next due date/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/you can view this schedule/i)).not.toBeInTheDocument();
  });

  it('a signed-out / not-yet-loaded user is treated as read-only, not crashed', async () => {
    getCurrentUser.mockReturnValue(null);
    seed([FUTURE_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    expect(await screen.findByText(DOC.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adjust next due date/i })).not.toBeInTheDocument();
  });
});

describe('U-SCHED-UI-02: the reason must be at least 10 characters, trimmed', () => {
  it('keeps Save disabled below 10 trimmed characters and enables it at 10', async () => {
    setRole(['ENGINEER']);
    seed([FUTURE_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /adjust next due date/i }));

    const reasonField = screen.getByLabelText(/reason for this change/i);
    const saveButton = screen.getByRole('button', { name: /^save$/i });
    expect(saveButton).toBeDisabled();

    fireEvent.change(reasonField, { target: { value: 'short' } });
    expect(saveButton).toBeDisabled();

    // Padding whitespace must not count — the server trims before checking.
    fireEvent.change(reasonField, { target: { value: '   short  ' } });
    expect(saveButton).toBeDisabled();

    fireEvent.change(reasonField, { target: { value: 'a real reason' } });
    expect(saveButton).toBeEnabled();
  });
});

describe('U-SCHED-UI-02b: an empty date cannot be submitted (review IMPORTANT-1)', () => {
  it('keeps Save disabled once the date input is cleared, even with a valid reason', async () => {
    setRole(['ENGINEER']);
    seed([FUTURE_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /adjust next due date/i }));

    const dateField = screen.getByLabelText(/next due date/i);
    const reasonField = screen.getByLabelText(/reason for this change/i);
    const saveButton = screen.getByRole('button', { name: /^save$/i });

    fireEvent.change(reasonField, { target: { value: 'a perfectly valid reason' } });
    expect(saveButton).toBeEnabled();

    // `<input type="date">` is clearable — a planner retyping the date on a
    // tablet picker passes through '' mid-edit. Sending that would 422 with
    // "Request body failed validation." and name no field
    // (`z.string().min(1)`, `shared/src/schedule.ts`).
    fireEvent.change(dateField, { target: { value: '' } });
    expect(saveButton).toBeDisabled();

    fireEvent.change(dateField, { target: { value: '2028-01-01' } });
    expect(saveButton).toBeEnabled();
  });
});

// The MIN_REASON-vs-shared-schema pin now lives in
// `MachineSchedule.schema-contract.test.ts`, asserted BEHAVIOURALLY against
// `scheduleAdjustRequestSchema` itself (review MINOR round 2) rather than
// regexed out of the schema's source text here. It is a separate file, not a
// separate `describe` in this one, because it needs to import the real
// schema from `shared/src` — see that file's own header for why.

describe('U-SCHED-UI-03: assetDocumentId is always sent on the PUT', () => {
  it('PUTs assetDocumentId, frequency, nextDueOn and the trimmed reason, then re-reads the list', async () => {
    setRole(['PLANNER']);
    seed([FUTURE_RULE]);
    adjustAssetSchedule.mockResolvedValue({
      ok: true,
      status: 200,
      value: { ...FUTURE_RULE, nextDueOn: '2027-06-01', adjustedReason: 'plant shutdown' },
    });
    render(<MachineSchedule assetId="asset-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /adjust next due date/i }));
    fireEvent.change(screen.getByLabelText(/next due date/i), {
      target: { value: '2027-06-01' },
    });
    fireEvent.change(screen.getByLabelText(/reason for this change/i), {
      target: { value: '  plant shutdown, pushed out  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(adjustAssetSchedule).toHaveBeenCalledWith('asset-1', {
        assetDocumentId: 'ad-1',
        frequency: 'M1',
        nextDueOn: '2027-06-01',
        adjustedReason: 'plant shutdown, pushed out',
      }),
    );
    await waitFor(() => expect(getAssetSchedule).toHaveBeenCalledTimes(2));
  });
});

describe('U-SCHED-UI-04: a past due date says what will happen — the RIGHT direction (review IMPORTANT-3, round 2)', () => {
  it('says one job already exists, leaving it alone does not repeat it, ADJUSTING is what raises a second, and this app cannot void the first', async () => {
    setRole(['MAINTAINER']);
    seed([PAST_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    const [warning] = await screen.findAllByRole('alert');
    expect(warning).toHaveTextContent(/already passed/i);
    expect(warning).toHaveTextContent(/already raised one job/i);
    // The property round 1 got backwards: leaving it as-is must NOT be
    // described as the thing that raises more work.
    expect(warning).toHaveTextContent(/will not raise a second/i);
    expect(warning).toHaveTextContent(/saving a new date here does not remove that job/i);
    expect(warning).toHaveTextContent(/next sweep raises a second/i);
    expect(warning).toHaveTextContent(/no control yet to void/i);
  });

  it('raises no such warning for a rule due in the future', async () => {
    setRole(['MAINTAINER']);
    seed([FUTURE_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    expect(await screen.findByText(DOC.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a machine with TWO overdue rows gets two warnings, not a thrown query (review MINOR)', async () => {
    setRole(['MAINTAINER']);
    seed([PAST_RULE, ANOTHER_PAST_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    const warnings = await screen.findAllByRole('alert');
    expect(warnings).toHaveLength(2);
  });
});

describe('U-SCHED-UI-05: a server refusal is shown verbatim, never a generic message', () => {
  it('surfaces the Problem detail from a failed adjustment', async () => {
    setRole(['ENGINEER']);
    seed([FUTURE_RULE]);
    adjustAssetSchedule.mockResolvedValue({
      ok: false,
      status: 422,
      problem: {
        type: '/errors/validation',
        title: 'Validation failed',
        status: 422,
        detail:
          'This machine carries 2 documents scheduled at M1. Name the one to adjust with `assetDocumentId`.',
      },
    });
    render(<MachineSchedule assetId="asset-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /adjust next due date/i }));
    fireEvent.change(screen.getByLabelText(/next due date/i), {
      target: { value: '2027-06-01' },
    });
    fireEvent.change(screen.getByLabelText(/reason for this change/i), {
      target: { value: 'a real reason for this' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/name the one to adjust with/i)).toBeInTheDocument();
  });
});

describe('U-SCHED-UI-06: a retired rule is visibly distinguished', () => {
  // Review MINOR: only `rule.active` is tested here, not a retired
  // DOCUMENT's rule. `GET`/`PUT /assets/{assetId}/schedule`
  // (`asset-schedule.service.ts`) both filter to `assetDocument: { active:
  // true }`, so a row belonging to a retired document can never reach this
  // component from a real response — a test built on that combination would
  // pin behaviour the server makes unreachable. `rule.active` itself is on
  // the wire contract and currently unreachable too (no writer in the API
  // ever sets it `false`), but it is kept live in the component because
  // `job-generation.service.ts` honours it if something someday does.
  it('marks a rule whose own `active` flag is false', async () => {
    setRole(['MAINTAINER']);
    seed([{ ...FUTURE_RULE, active: false }]);
    render(<MachineSchedule assetId="asset-1" />);
    expect(await screen.findByText(/retired/i)).toBeInTheDocument();
  });
});

describe('U-SCHED-UI-07: a failure to load is surfaced, never swallowed', () => {
  it('shows the schedule read error instead of an empty list', async () => {
    setRole(['MAINTAINER']);
    getAssetSchedule.mockResolvedValue({
      ok: false,
      status: 500,
      problem: { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    });
    listAssetDocuments.mockResolvedValue({ ok: true, status: 200, value: { data: [DOC] } });
    render(<MachineSchedule assetId="asset-1" />);
    expect(await screen.findByText(/internal server error/i)).toBeInTheDocument();
  });
});
