/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AssetDocument, ScheduleRule } from '../api/admin-client';

/**
 * Slice 29-SCHEDULE-UI — the missing half of the backfill workflow.
 * `MachineDocuments` lets an admin attach a document; this proves the screen
 * that lets anyone actually set when its work is due, and — the property
 * that matters most — that the past-due warning names the CONSEQUENCE
 * (a job raised on the next hourly sweep), not a bare red dot. A machine
 * that has just been given a document has a schedule anchored in the past,
 * and setting real dates is the same sitting's work as tagging the document,
 * not next week's.
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

describe('U-SCHED-UI-04: a past due date says what will happen, not just that it is red', () => {
  it('names the consequence — a job raised on the next scheduler sweep', async () => {
    setRole(['MAINTAINER']);
    seed([PAST_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(/already passed/i);
    expect(warning).toHaveTextContent(/scheduler sweep/i);
    expect(warning).toHaveTextContent(/overdue/i);
  });

  it('raises no such warning for a rule due in the future', async () => {
    setRole(['MAINTAINER']);
    seed([FUTURE_RULE]);
    render(<MachineSchedule assetId="asset-1" />);
    expect(await screen.findByText(DOC.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

describe('U-SCHED-UI-06: a retired rule or document is visibly distinguished', () => {
  it('marks a rule whose own `active` flag is false', async () => {
    setRole(['MAINTAINER']);
    seed([{ ...FUTURE_RULE, active: false }]);
    render(<MachineSchedule assetId="asset-1" />);
    expect(await screen.findByText(/retired/i)).toBeInTheDocument();
  });

  it('marks a rule belonging to a retired document', async () => {
    setRole(['MAINTAINER']);
    seed([FUTURE_RULE], [{ ...DOC, active: false }]);
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
