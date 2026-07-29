/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AssetDocument, FormTemplate } from '../api/admin-client';

/**
 * Slice 28-ASSETDOC-UI — the admin's document-tagging surface.
 *
 * The property this file exists to protect is the one slice 27's review
 * flagged and nothing on screen said: a machine carrying no ACTIVE document is
 * INERT — no schedule rule is bootstrapped, the scheduler raises nothing, and
 * `POST /jobs/adhoc` answers 422. An admin who tags nothing (or retires the
 * last document) has built something that will never do anything. That state
 * must be unmistakable, and it is tested first here.
 *
 * The second property: `titleHasFillableRun` and `resolvedTitle` come from the
 * SERVER and are never re-derived here (slice 26 had to unpick three drifting
 * copies of a stage label). The field is ABSENT — not disabled — when the
 * server says the title has no blank to fill.
 */

const listAssetDocuments = vi.fn();
const listTemplates = vi.fn();
const tagAssetDocument = vi.fn();
const updateAssetDocument = vi.fn();

vi.mock('../api/admin-client', () => ({
  listAssetDocuments: (...args: unknown[]) => listAssetDocuments(...args),
  listTemplates: (...args: unknown[]) => listTemplates(...args),
  tagAssetDocument: (...args: unknown[]) => tagAssetDocument(...args),
  updateAssetDocument: (...args: unknown[]) => updateAssetDocument(...args),
}));

// Imported AFTER the mock so the component binds to it.
import { MachineDocuments } from './MachineDocuments';

/** The KNS wire-bond record — a title with a real blank (`KW___`). */
const FILLABLE: AssetDocument = {
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

/** EP01 — the number is printed on the form already; there is nothing to fill. */
const FIXED: AssetDocument = {
  id: 'ad-2',
  assetId: 'asset-1',
  formTemplateId: 'tpl-2',
  documentNumber: 'CE 95 020 00 01',
  title: 'Epoxy Dispenser EP01 Preventive Maintenance Record',
  resolvedTitle: 'Epoxy Dispenser EP01 Preventive Maintenance Record',
  titleHasFillableRun: false,
  machineNumber: null,
  active: true,
};

const TEMPLATES: FormTemplate[] = [
  {
    id: 'tpl-1',
    documentNumber: 'CE 95 020 00 03',
    title: 'KNS Wire Bond Preventive Maintenance Record KW___',
    active: true,
    currentRevisionId: 'rev-1',
  },
  {
    id: 'tpl-2',
    documentNumber: 'CE 95 020 00 01',
    title: 'Epoxy Dispenser EP01 Preventive Maintenance Record',
    active: true,
    currentRevisionId: 'rev-2',
  },
  {
    id: 'tpl-3',
    documentNumber: 'CE 95 050 00 01',
    title: 'Aging Oven Preventive Maintenance Record ______',
    active: true,
    currentRevisionId: null,
  },
];

function seed(documents: AssetDocument[], templates: FormTemplate[] = TEMPLATES) {
  listAssetDocuments.mockResolvedValue({ ok: true, status: 200, value: { data: documents } });
  listTemplates.mockResolvedValue({
    ok: true,
    status: 200,
    value: { data: templates, page: { hasMore: false, limit: 100 } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

const INERT = /carries no active preventive-maintenance document/i;

describe('U-DOC-UI-01: the inert machine is unmistakable', () => {
  it('a machine with NO documents raises an alert that names what will never happen', async () => {
    seed([]);
    render(<MachineDocuments assetId="asset-1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(INERT);
    // Not a vague "nothing here" — the three concrete consequences.
    expect(alert).toHaveTextContent(/nothing is scheduled/i);
    expect(alert).toHaveTextContent(/no job/i);
    expect(alert).toHaveTextContent(/ad-hoc/i);
  });

  it('a machine whose ONLY document has been RETIRED is just as inert, and says so', async () => {
    // The state slice 27's `active: false` retirement creates. The row is
    // still listed (history stays visible) — but the machine does nothing.
    seed([{ ...FILLABLE, active: false }]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(INERT);
    expect(screen.getByText(FILLABLE.resolvedTitle)).toBeInTheDocument();
  });

  it('a machine carrying an active document raises no such alert', async () => {
    seed([FILLABLE]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(FILLABLE.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByText(INERT)).not.toBeInTheDocument();
  });
});

describe('U-DOC-UI-02: the form-number field is keyed off the SERVER flag', () => {
  it('is PRESENT for a title the server says has a fillable run', async () => {
    seed([FILLABLE]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByLabelText(/form number for CE 95 020 00 03/i)).toBeInTheDocument();
  });

  it('is ABSENT — not disabled — for a title the server says has no blank', async () => {
    seed([FIXED]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(FIXED.resolvedTitle)).toBeInTheDocument();
    expect(screen.queryByLabelText(/form number for CE 95 020 00 01/i)).not.toBeInTheDocument();
    // Nor is it rendered anywhere else on that row in a disabled state.
    expect(screen.queryByRole('textbox', { name: /form number/i })).not.toBeInTheDocument();
  });

  it('renders the SERVER’s resolvedTitle verbatim — the client never substitutes anything itself', async () => {
    // A deliberately inconsistent payload: a machineNumber is set but the
    // server's resolvedTitle still shows the blank. A client that re-derived
    // the title would print KW99 and disagree with the record.
    seed([{ ...FILLABLE, machineNumber: '99', resolvedTitle: 'Stale Title KW___' }]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText('Stale Title KW___')).toBeInTheDocument();
    expect(screen.queryByText(/KW99/)).not.toBeInTheDocument();
  });

  it('a fillable document with no number yet is flagged, not left looking finished', async () => {
    seed([{ ...FILLABLE, machineNumber: null, resolvedTitle: FILLABLE.title }]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(/form number not set/i)).toBeInTheDocument();
  });

  it('saving a form number PATCHes machineNumber and re-reads the list', async () => {
    seed([{ ...FILLABLE, machineNumber: null, resolvedTitle: FILLABLE.title }]);
    updateAssetDocument.mockResolvedValue({ ok: true, status: 200, value: FILLABLE });
    render(<MachineDocuments assetId="asset-1" />);
    const field = await screen.findByLabelText(/form number for CE 95 020 00 03/i);
    fireEvent.change(field, { target: { value: '13' } });
    fireEvent.click(screen.getByRole('button', { name: /save form number/i }));
    await waitFor(() =>
      expect(updateAssetDocument).toHaveBeenCalledWith('ad-1', { machineNumber: '13' }),
    );
    expect(listAssetDocuments).toHaveBeenCalledTimes(2);
  });
});

describe('U-DOC-UI-03: retiring is `active: false`, never a delete', () => {
  it('retire PATCHes { active: false }', async () => {
    seed([FILLABLE]);
    updateAssetDocument.mockResolvedValue({
      ok: true,
      status: 200,
      value: { ...FILLABLE, active: false },
    });
    render(<MachineDocuments assetId="asset-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^retire CE 95 020 00 03$/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, retire it/i }));
    await waitFor(() =>
      expect(updateAssetDocument).toHaveBeenCalledWith('ad-1', { active: false }),
    );
  });

  it('a retired document is shown as retired and can be returned to service', async () => {
    seed([{ ...FILLABLE, active: false }]);
    updateAssetDocument.mockResolvedValue({ ok: true, status: 200, value: FILLABLE });
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(/^retired$/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^return CE 95 020 00 03 to service$/i }));
    await waitFor(() => expect(updateAssetDocument).toHaveBeenCalledWith('ad-1', { active: true }));
  });
});

describe('U-DOC-UI-04: tagging a document', () => {
  it('POSTs the chosen template to the machine', async () => {
    seed([]);
    tagAssetDocument.mockResolvedValue({ ok: true, status: 201, value: FILLABLE });
    render(<MachineDocuments assetId="asset-1" />);
    const select = await screen.findByLabelText(/^document$/i);
    fireEvent.change(select, { target: { value: 'tpl-1' } });
    fireEvent.click(screen.getByRole('button', { name: /tag this document/i }));
    await waitFor(() =>
      expect(tagAssetDocument).toHaveBeenCalledWith('asset-1', { formTemplateId: 'tpl-1' }),
    );
  });

  it('does not offer a template the machine ALREADY carries — the 409 is a dead end, not a choice', async () => {
    seed([FILLABLE]);
    render(<MachineDocuments assetId="asset-1" />);
    const select = await screen.findByLabelText(/^document$/i);
    expect(select).not.toHaveTextContent('CE 95 020 00 03');
    expect(select).toHaveTextContent('CE 95 020 00 01');
  });

  it('marks a template with no approved revision — tagging it leaves the machine unable to raise work', async () => {
    seed([]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByLabelText(/^document$/i)).toHaveTextContent(/no approved revision/i);
  });

  it('surfaces the server’s refusal verbatim rather than pretending it worked', async () => {
    seed([]);
    tagAssetDocument.mockResolvedValue({
      ok: false,
      status: 403,
      problem: { type: '/errors/out-of-scope', title: 'Out of scope', status: 403 },
    });
    render(<MachineDocuments assetId="asset-1" />);
    fireEvent.change(await screen.findByLabelText(/^document$/i), { target: { value: 'tpl-1' } });
    fireEvent.click(screen.getByRole('button', { name: /tag this document/i }));
    expect(await screen.findByText(/out of scope/i)).toBeInTheDocument();
  });
});

/**
 * ---------------------------------------------------------------------------
 * Slice 28 review fix pass. Every test below was written against a proven
 * defect and watched failing before the fix.
 */

describe('U-DOC-UI-05: clearing a form number (review M-1)', () => {
  it('sends null, NEVER the empty string the server rejects', async () => {
    // `assetDocumentUpdateSchema` (shared/src/asset.ts:138) is
    // `.trim().min(1).max(50).nullable().optional()` — `''` is a 422 whose
    // whole detail is "Request body failed validation.", with no field named
    // and no remedy offered. `null` is the value that clears the blank.
    seed([FILLABLE]);
    updateAssetDocument.mockResolvedValue({
      ok: true,
      status: 200,
      value: { ...FILLABLE, machineNumber: null },
    });
    render(<MachineDocuments assetId="asset-1" />);
    const field = await screen.findByLabelText(/form number for CE 95 020 00 03/i);
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /save form number/i }));
    await waitFor(() =>
      expect(updateAssetDocument).toHaveBeenCalledWith('ad-1', { machineNumber: null }),
    );
  });

  it('the hint promising an empty field is allowed is therefore true', async () => {
    seed([FILLABLE]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(/leaving it empty is allowed/i)).toBeInTheDocument();
  });
});

describe('U-DOC-UI-06: a failure is never reported as an absence (review M-5, m-1)', () => {
  it('surfaces a failed template-catalogue load instead of handing over an empty dropdown', async () => {
    seed([FILLABLE]);
    listTemplates.mockResolvedValue({
      ok: false,
      status: 500,
      problem: { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    });
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(/internal server error/i)).toBeInTheDocument();
  });

  it('does NOT claim the machine is inert when the document list merely failed to load', async () => {
    listAssetDocuments.mockResolvedValue({
      ok: false,
      status: 500,
      problem: { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    });
    listTemplates.mockResolvedValue({
      ok: true,
      status: 200,
      value: { data: TEMPLATES, page: { hasMore: false, limit: 100 } },
    });
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(/internal server error/i)).toBeInTheDocument();
    expect(screen.queryByText(INERT)).not.toBeInTheDocument();
  });

  it('does NOT claim the machine is inert before the list has arrived', async () => {
    // The pending state: an unresolved promise, exactly what a slow tablet
    // sees for the first second. A "this machine will never do anything"
    // alarm shown here would be a guess.
    listAssetDocuments.mockReturnValue(new Promise(() => {}));
    listTemplates.mockResolvedValue({
      ok: true,
      status: 200,
      value: { data: TEMPLATES, page: { hasMore: false, limit: 100 } },
    });
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(INERT)).not.toBeInTheDocument();
  });
});

describe('U-DOC-UI-07: the row’s controls (review m-1, m-2, m-3, m-7)', () => {
  it('offers no form-number field on a RETIRED document — there is nothing to fill in on a form no job will use', async () => {
    seed([{ ...FILLABLE, active: false }]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(/^retired$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/form number for/i)).not.toBeInTheDocument();
  });

  it('retiring takes two deliberate steps — gloves, tablets, and a one-way-looking word', async () => {
    seed([FILLABLE]);
    updateAssetDocument.mockResolvedValue({
      ok: true,
      status: 200,
      value: { ...FILLABLE, active: false },
    });
    render(<MachineDocuments assetId="asset-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^retire CE 95 020 00 03$/i }));
    expect(updateAssetDocument).not.toHaveBeenCalled();
    // The confirm names the document and says what retiring does.
    expect(
      screen.getByRole('group', { name: /confirm retiring CE 95 020 00 03/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No new job will be raised on CE 95 020 00 03/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /yes, retire it/i }));
    await waitFor(() =>
      expect(updateAssetDocument).toHaveBeenCalledWith('ad-1', { active: false }),
    );
  });

  it('the retire control names its document, so two rows are never two identical buttons', async () => {
    seed([FILLABLE, FIXED]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(
      await screen.findByRole('button', { name: /^retire CE 95 020 00 03$/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^retire CE 95 020 00 01$/i })).toBeInTheDocument();
  });

  it('shows a stored form number on a document whose title has no blank — the API permits it, so it must be visible', async () => {
    // The owner's "some forms are already pre updated just allow user to
    // choose": a number can legitimately be stored against a title with
    // nowhere to substitute it. Rendering it only inside the editable field
    // hid it completely.
    seed([{ ...FIXED, machineNumber: '4' }]);
    render(<MachineDocuments assetId="asset-1" />);
    expect(await screen.findByText(FIXED.resolvedTitle)).toBeInTheDocument();
    expect(screen.getByText('Form number')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    // Still no editable box: the title has no blank to fill.
    expect(screen.queryByLabelText(/form number for/i)).not.toBeInTheDocument();
  });
});
