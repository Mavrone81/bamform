/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AssetDocument } from '../api/admin-client';

/**
 * Slice 28-ASSETDOC-UI — the owner's process step 4, the maintainer's half:
 *
 * > "he will go to his assigned machine and select the form to start (note
 * > these forms were previously already setup and tagged to the machine)"
 *
 * WHY THE PICKER LIVES HERE AND NOWHERE ELSE. A SCHEDULED job already knows
 * its document: the scheduler stamps `Job.assetDocumentId` at generation and
 * freezes that document's revision onto it, so there is nothing left to
 * choose by the time a maintainer opens it — offering a picker there would be
 * offering a choice the record cannot honour. The ONE place a choice genuinely
 * exists is off-plan work: `POST /jobs/adhoc` takes an optional
 * `assetDocumentId` and answers 422 when the machine carries several and the
 * caller named none. That 422 is what this picker exists to make impossible.
 *
 * And the case the owner will actually hit: a machine carrying NO active
 * document cannot have work raised against it at all. Before this, that was a
 * bare 422 after filling the whole form.
 */

const listAssets = vi.fn();
const listAssetTypes = vi.fn();
const listAssetDocuments = vi.fn();
const createAdhocJob = vi.fn();
const navigate = vi.fn();

vi.mock('../api/admin-client', () => ({
  listAssets: (...args: unknown[]) => listAssets(...args),
  listAssetTypes: (...args: unknown[]) => listAssetTypes(...args),
  listAssetDocuments: (...args: unknown[]) => listAssetDocuments(...args),
}));
vi.mock('../router', () => ({ useRouter: () => ({ navigate, path: '/jobs/raise' }) }));
vi.mock('../state/services', () => ({
  getServices: () => ({ transport: { createAdhocJob }, db: {} }),
}));
vi.mock('../offline/sync-engine', () => ({ bootstrap: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../offline/sync-events', () => ({ notifySynced: vi.fn() }));

// Imported AFTER the mocks so the screen binds to them.
import { RaiseJob } from './RaiseJob';

const WIRE_BOND: AssetDocument = {
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

const PH_METER: AssetDocument = {
  id: 'ad-2',
  assetId: 'asset-1',
  formTemplateId: 'tpl-2',
  documentNumber: 'CE 95 040 00 02',
  title: 'pH Meter Preventive Maintenance Record',
  resolvedTitle: 'pH Meter Preventive Maintenance Record',
  titleHasFillableRun: false,
  machineNumber: null,
  active: true,
};

function seed(documents: AssetDocument[]) {
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
  listAssetDocuments.mockResolvedValue({ ok: true, status: 200, value: { data: documents } });
}

async function chooseTheMachine() {
  const machine = await screen.findByLabelText('Machine');
  await waitFor(() => expect(machine).toHaveTextContent('AW01'));
  fireEvent.change(machine, { target: { value: 'asset-1' } });
  await waitFor(() => expect(listAssetDocuments).toHaveBeenCalledWith('asset-1'));
}

function fillReason() {
  fireEvent.change(screen.getByLabelText(/why is this being raised off-plan/i), {
    target: { value: 'bearing seized on the night shift, unplanned service' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('U-RAISE-DOC-01: a machine with no document cannot have work raised on it', () => {
  it('says so BEFORE the form is filled in, and blocks the raise', async () => {
    seed([]);
    render(<RaiseJob />);
    await chooseTheMachine();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/carries no active preventive-maintenance document/i);
    expect(alert).toHaveTextContent(/admin/i);
    fillReason();
    expect(screen.getByRole('button', { name: /raise this job/i })).toBeDisabled();
  });

  it('a machine whose only document is RETIRED is treated the same — retired documents raise nothing', async () => {
    seed([{ ...WIRE_BOND, active: false }]);
    render(<RaiseJob />);
    await chooseTheMachine();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /carries no active preventive-maintenance document/i,
    );
    fillReason();
    expect(screen.getByRole('button', { name: /raise this job/i })).toBeDisabled();
  });
});

describe('U-RAISE-DOC-02: exactly one document is never a choice', () => {
  it('names the document instead of offering a select', async () => {
    seed([WIRE_BOND]);
    render(<RaiseJob />);
    await chooseTheMachine();
    expect(await screen.findByText(WIRE_BOND.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByLabelText(/which document/i)).not.toBeInTheDocument();
  });

  it('still sends the document explicitly, so the server records the one shown on screen', async () => {
    seed([WIRE_BOND]);
    createAdhocJob.mockResolvedValue({ ok: true, status: 201, body: { id: 'job-9' } });
    render(<RaiseJob />);
    await chooseTheMachine();
    await screen.findByText(WIRE_BOND.resolvedTitle);
    fillReason();
    fireEvent.click(screen.getByRole('button', { name: /raise this job/i }));
    await waitFor(() =>
      expect(createAdhocJob).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: 'asset-1', assetDocumentId: 'ad-1' }),
      ),
    );
  });
});

describe('U-RAISE-DOC-03: several documents must be chosen between', () => {
  it('offers the picker, and refuses to raise until one is chosen', async () => {
    seed([WIRE_BOND, PH_METER]);
    render(<RaiseJob />);
    await chooseTheMachine();
    const picker = await screen.findByLabelText(/which document/i);
    expect(picker).toHaveTextContent(WIRE_BOND.resolvedTitle);
    expect(picker).toHaveTextContent(PH_METER.resolvedTitle);
    fillReason();
    // The 422 this exists to prevent: reason given, machine chosen, but no
    // document named.
    expect(screen.getByRole('button', { name: /raise this job/i })).toBeDisabled();
  });

  it('sends the chosen document — never one picked silently', async () => {
    seed([WIRE_BOND, PH_METER]);
    createAdhocJob.mockResolvedValue({ ok: true, status: 201, body: { id: 'job-9' } });
    render(<RaiseJob />);
    await chooseTheMachine();
    fireEvent.change(await screen.findByLabelText(/which document/i), {
      target: { value: 'ad-2' },
    });
    fillReason();
    fireEvent.click(screen.getByRole('button', { name: /raise this job/i }));
    await waitFor(() =>
      expect(createAdhocJob).toHaveBeenCalledWith(
        expect.objectContaining({ assetDocumentId: 'ad-2' }),
      ),
    );
  });

  it('a RETIRED document is not offered as a choice', async () => {
    seed([WIRE_BOND, { ...PH_METER, active: false }]);
    render(<RaiseJob />);
    await chooseTheMachine();
    // One active document left, so no picker at all — and the retired one is
    // nowhere on screen as something startable.
    expect(await screen.findByText(WIRE_BOND.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByText(PH_METER.resolvedTitle)).not.toBeInTheDocument();
  });

  it('changing the machine re-reads its documents and drops the previous choice', async () => {
    seed([WIRE_BOND, PH_METER]);
    render(<RaiseJob />);
    await chooseTheMachine();
    fireEvent.change(await screen.findByLabelText(/which document/i), {
      target: { value: 'ad-2' },
    });
    listAssetDocuments.mockResolvedValue({ ok: true, status: 200, value: { data: [] } });
    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'asset-1' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /carries no active preventive-maintenance document/i,
    );
    fillReason();
    expect(screen.getByRole('button', { name: /raise this job/i })).toBeDisabled();
  });
});

/**
 * Slice 28 review fix pass, M-3. Written against a proven defect and watched
 * failing before the fix.
 */
describe('U-RAISE-DOC-04: a failed document list is not a diagnosis (review M-3)', () => {
  it('does NOT tell the planner the machine has no document when the list merely failed to load', async () => {
    seed([]);
    listAssetDocuments.mockResolvedValue({
      ok: false,
      status: 500,
      problem: { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    });
    render(<RaiseJob />);
    await chooseTheMachine();
    // The honest error is shown…
    expect(await screen.findByText(/internal server error/i)).toBeInTheDocument();
    // …but NOT the confident, actionable, and in this case false claim that
    // an admin needs to go and tag a document.
    expect(
      screen.queryByText(/carries no active preventive-maintenance document/i),
    ).not.toBeInTheDocument();
    // Still nothing can be raised — a cause we do not know is not a licence
    // to proceed.
    fillReason();
    expect(screen.getByRole('button', { name: /raise this job/i })).toBeDisabled();
  });

  it('reports an unreachable server as unreachable, not as an untagged machine', async () => {
    seed([]);
    listAssetDocuments.mockResolvedValue({ ok: false, status: 0 });
    render(<RaiseJob />);
    await chooseTheMachine();
    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/carries no active preventive-maintenance document/i),
    ).not.toBeInTheDocument();
  });
});
