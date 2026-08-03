/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Slice 29-SCHEDULE-UI review, IMPORTANT-2: `MachineSchedule` (the
 * adjustment screen) previously lived ONLY inside `AdminMachineDetail`,
 * reachable exclusively through the Menu's ADMIN-gated "Administration"
 * entry — so PLANNER, TEAM_LEADER and ENGINEER, three of the four roles the
 * server permits on `PUT /assets/{assetId}/schedule`, had no way to reach
 * it without typing a URL. `MachineSchedules` is the new, non-admin route
 * that fixes that (see its own module doc for the reasoning); this proves
 * the machine picker in front of it behaves, using the exact same
 * open-to-everyone `GET /assets`/`GET /asset-types` `RaiseJob` already
 * relies on for the same reason.
 */

const listAssetTypes = vi.fn();
const listAssets = vi.fn();
const getAssetSchedule = vi.fn();
const listAssetDocuments = vi.fn();
const adjustAssetSchedule = vi.fn();
const navigate = vi.fn();

vi.mock('../api/admin-client', () => ({
  listAssetTypes: (...args: unknown[]) => listAssetTypes(...args),
  listAssets: (...args: unknown[]) => listAssets(...args),
  getAssetSchedule: (...args: unknown[]) => getAssetSchedule(...args),
  listAssetDocuments: (...args: unknown[]) => listAssetDocuments(...args),
  adjustAssetSchedule: (...args: unknown[]) => adjustAssetSchedule(...args),
}));
vi.mock('../router', () => ({ useRouter: () => ({ navigate, path: '/schedule' }) }));

const getCurrentUser = vi.fn();
const onCurrentUserChange = vi.fn();
vi.mock('../auth', () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  onCurrentUserChange: (...args: unknown[]) => onCurrentUserChange(...args),
}));

// Imported AFTER the mocks so the screen binds to them.
import { MachineSchedules } from './MachineSchedules';

function seed() {
  listAssetTypes.mockResolvedValue({
    ok: true,
    status: 200,
    value: { data: [{ id: 'at-1', code: 'WB', name: 'Wire Bonder', active: true }] },
  });
  listAssets.mockResolvedValue({
    ok: true,
    status: 200,
    value: { data: [{ id: 'asset-1', code: 'AW01', description: 'Wire bonder, bay 3' }] },
  });
  getAssetSchedule.mockResolvedValue({ ok: true, status: 200, value: [] });
  listAssetDocuments.mockResolvedValue({ ok: true, status: 200, value: { data: [] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockReturnValue({ id: 'u-1', fullName: 'Test User', roles: ['ENGINEER'] });
  onCurrentUserChange.mockReturnValue(() => {});
});

afterEach(() => {
  cleanup();
});

describe('U-SCHEDULES-01: choosing a machine reveals its schedule editor', () => {
  it('renders nothing schedule-shaped until a machine is chosen', async () => {
    seed();
    render(<MachineSchedules />);
    await screen.findByLabelText('Machine');
    expect(
      screen.queryByRole('heading', { name: /preventive-maintenance schedule/i }),
    ).not.toBeInTheDocument();
  });

  it('choosing a machine renders MachineSchedule for that machine', async () => {
    seed();
    render(<MachineSchedules />);
    const machine = await screen.findByLabelText('Machine');
    await waitFor(() => expect(machine).toHaveTextContent('AW01'));
    fireEvent.change(machine, { target: { value: 'asset-1' } });
    await waitFor(() => expect(getAssetSchedule).toHaveBeenCalledWith('asset-1'));
    expect(
      await screen.findByRole('heading', { name: /preventive-maintenance schedule/i }),
    ).toBeInTheDocument();
  });
});

describe('U-SCHEDULES-02: filtering by machine type re-queries the list', () => {
  it('passes the chosen type as assetTypeId', async () => {
    seed();
    render(<MachineSchedules />);
    const typeSelect = await screen.findByLabelText('Machine type');
    await waitFor(() => expect(typeSelect).toHaveTextContent('Wire Bonder'));
    fireEvent.change(typeSelect, { target: { value: 'at-1' } });
    await waitFor(() => expect(listAssets).toHaveBeenLastCalledWith({ assetTypeId: 'at-1' }));
  });
});

describe('U-SCHEDULES-03: a failed machine list is surfaced, never swallowed', () => {
  it('shows the refusal instead of an empty picker with no explanation', async () => {
    listAssetTypes.mockResolvedValue({ ok: true, status: 200, value: { data: [] } });
    listAssets.mockResolvedValue({
      ok: false,
      status: 500,
      problem: { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    });
    render(<MachineSchedules />);
    expect(await screen.findByText(/internal server error/i)).toBeInTheDocument();
  });
});

describe('U-SCHEDULES-04: the back link returns to the Menu', () => {
  it('navigates to /menu', async () => {
    seed();
    render(<MachineSchedules />);
    fireEvent.click(await screen.findByRole('button', { name: /menu/i }));
    expect(navigate).toHaveBeenCalledWith('/menu');
  });
});
