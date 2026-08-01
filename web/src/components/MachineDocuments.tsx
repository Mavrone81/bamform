import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  listAssetDocuments,
  listTemplates,
  tagAssetDocument,
  updateAssetDocument,
  type AssetDocument,
  type FormTemplate,
  type Problem,
} from '../api/admin-client';

/**
 * Slice 28-ASSETDOC-UI — the owner's process step 2, on screen at last:
 *
 * > "Admin will log in to setup the machine tagged with which preventive
 * > Maintenance document — all the forms in the doc folder."
 *
 * Slice 27 shipped the API for this and nothing rendered it, so tagging was
 * something only a person with a terminal could do. It lives on the machine's
 * own page rather than a new top-level screen because a machine's documents
 * are a property of the machine.
 *
 * THE THING THIS SCREEN EXISTS TO PREVENT — slice 27's review flagged it and
 * nothing said it out loud: a machine carrying no ACTIVE document is INERT. No
 * schedule rule is bootstrapped for it, the scheduler raises nothing, and
 * `POST /jobs/adhoc` answers 422. An admin who creates a machine and walks
 * away has built something that will never do anything, and the old failure
 * mode was total silence. Hence the red alert at the top, keyed off ACTIVE
 * documents (retiring the last one puts the machine back into exactly the same
 * inert state as never tagging one).
 *
 * `resolvedTitle` and `titleHasFillableRun` are rendered EXACTLY as the server
 * sends them and are never re-derived here. Slice 26 had to unpick three
 * drifting copies of a stage label; the title of a controlled document is not
 * a mistake worth repeating that with.
 *
 * TWO-STEP BY NECESSITY, not by preference: `titleHasFillableRun` is derived
 * server-side onto `AssetDocument`, and there is no such flag on
 * `FormTemplate`. Until there is, the only honest way to key the form-number
 * field off the SERVER's answer is to tag the document first and read the flag
 * off the row the server returns — see the slice report for the one-line API
 * change that would collapse this back into a single step.
 */
export function MachineDocuments({ assetId }: { assetId: string }) {
  const [documents, setDocuments] = useState<AssetDocument[] | null>(null);
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [chosenTemplateId, setChosenTemplateId] = useState('');
  const [tagMsg, setTagMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  /** Per-row draft form numbers, keyed by document id. */
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>({});
  const [rowMsg, setRowMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  /** Which row's retire confirmation is open (review m-2) — at most one. */
  const [confirmingRetireId, setConfirmingRetireId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDocuments = useCallback(async () => {
    const result = await listAssetDocuments(assetId);
    if (result.ok) {
      setDocuments(result.value.data);
      setNumberDrafts(
        Object.fromEntries(result.value.data.map((doc) => [doc.id, doc.machineNumber ?? ''])),
      );
      setLoadError(null);
      return;
    }
    setLoadError(refusalText(result.status, result.problem, 'Reading this machine’s documents'));
    setDocuments((prev) => prev ?? []);
  }, [assetId]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Review M-5: a failed catalogue load used to be swallowed whole, leaving
  // the admin an empty dropdown, no reason, and a red alarm telling them to
  // tag a document — silent inertness inside the slice written to abolish it.
  //
  // Review m-8: the catalogue is paged (`PAGE_LIMIT` 100). Twelve templates
  // fit today; a truncated list would silently hide documents that exist, so
  // it follows the cursor rather than assuming one page.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all: FormTemplate[] = [];
      let cursor: string | undefined;
      // Bounded: 20 pages of 100 is far beyond any plausible catalogue, and a
      // server that never stops saying `hasMore` must not spin the browser.
      for (let page = 0; page < 20; page += 1) {
        const result = await listTemplates(cursor ? { cursor } : undefined);
        if (cancelled) return;
        if (!result.ok) {
          setLoadError(
            refusalText(result.status, result.problem, 'Reading the document catalogue'),
          );
          return;
        }
        all.push(...result.value.data);
        if (!result.value.page.hasMore || !result.value.page.nextCursor) break;
        cursor = result.value.page.nextCursor;
      }
      setTemplates(all);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function refusalText(status: number, problem?: Problem, what = 'This change'): string {
    if (status === 0) return `Could not reach the server. ${what} needs a connection.`;
    return problem?.detail ?? problem?.title ?? `The server refused this request (${status}).`;
  }

  async function tag(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setTagMsg(null);
    try {
      const result = await tagAssetDocument(assetId, { formTemplateId: chosenTemplateId });
      if (result.ok) {
        setChosenTemplateId('');
        setTagMsg({
          tone: 'good',
          text: result.value.titleHasFillableRun
            ? `${result.value.documentNumber} tagged. Its title carries a blank — fill the form number below.`
            : `${result.value.documentNumber} tagged. Its title carries no blank, so there is no form number to fill.`,
        });
        await loadDocuments();
      } else {
        setTagMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveNumber(doc: AssetDocument) {
    setBusy(true);
    setRowMsg(null);
    try {
      // Review M-1: `assetDocumentUpdateSchema` (shared/src/asset.ts) is
      // `.trim().min(1).max(50).nullable().optional()` — an empty string is a
      // 422 whose entire detail is "Request body failed validation.", naming
      // no field and offering no remedy. NULL is what clears the blank. This
      // screen's own hint promises that leaving the field empty is allowed,
      // and sending `''` made that promise false: the typo an admin came here
      // to fix would have been unfixable.
      const draft = numberDrafts[doc.id]?.trim() ?? '';
      const result = await updateAssetDocument(doc.id, {
        machineNumber: draft === '' ? null : draft,
      });
      if (result.ok) {
        setRowMsg({ tone: 'good', text: `Form number saved for ${doc.documentNumber}.` });
        await loadDocuments();
      } else {
        setRowMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function setDocumentActive(doc: AssetDocument, active: boolean) {
    setBusy(true);
    setRowMsg(null);
    setConfirmingRetireId(null);
    try {
      const result = await updateAssetDocument(doc.id, { active });
      if (result.ok) {
        setRowMsg({
          tone: 'good',
          text: active
            ? `${doc.documentNumber} is back in service — jobs will be raised on it again.`
            : `${doc.documentNumber} retired. No new job will be raised on it; records already made keep it.`,
        });
        await loadDocuments();
      } else {
        setRowMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  function banner(msg: { tone: 'good' | 'bad'; text: string } | null) {
    if (!msg) return null;
    return (
      <p className="banner" data-tone={msg.tone} role={msg.tone === 'bad' ? 'alert' : 'status'}>
        <span aria-hidden="true">{msg.tone === 'bad' ? '⚠' : '✓'}</span> {msg.text}
      </p>
    );
  }

  const taggedTemplateIds = new Set((documents ?? []).map((doc) => doc.formTemplateId));
  const offerable = templates.filter(
    (template) => template.active && !taggedTemplateIds.has(template.id),
  );
  const hasActiveDocument = (documents ?? []).some((doc) => doc.active);

  return (
    <section aria-labelledby="machine-documents-heading" className="card">
      <h2 id="machine-documents-heading">Preventive-maintenance documents</h2>
      <p className="text-soft">
        The forms this machine is maintained against. Each one carries its own schedule; a
        maintainer picks between them when raising off-plan work.
      </p>

      {loadError && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {loadError}
        </p>
      )}

      {documents === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      )}

      {/* The inert-machine alarm. Keyed off ACTIVE documents, so retiring the
          last one brings it straight back — that machine is every bit as inert
          as one that was never tagged. */}
      {documents !== null && !loadError && !hasActiveDocument && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span>{' '}
          <strong>This machine carries no active preventive-maintenance document.</strong> Nothing
          is scheduled against it, no job will ever be raised for it, and an ad-hoc job will be
          refused. It stays inert until a document is tagged below.
        </p>
      )}

      {banner(rowMsg)}

      <ul className="data-list">
        {(documents ?? []).map((doc) => (
          <li key={doc.id}>
            <div className="card" data-rule={doc.active ? 'good' : 'neutral'}>
              <div className="card-row">
                <span className="card-title">{doc.resolvedTitle}</span>
                <span className="job-code text-soft">{doc.documentNumber}</span>
              </div>
              <div className="card-row">
                {!doc.active && (
                  <span className="status-chip" data-tone="neutral">
                    <span aria-hidden="true">⊘</span>
                    <span>Retired</span>
                  </span>
                )}
                {doc.active && doc.titleHasFillableRun && !doc.machineNumber && (
                  <span className="status-chip" data-tone="attention">
                    <span aria-hidden="true">✎</span>
                    <span>Form number not set</span>
                  </span>
                )}
              </div>

              {/* ABSENT, never merely disabled, when the server says the title
                  has no blank: an admin is never shown a box that does nothing
                  and can never believe they have labelled a form when they
                  have not. */}
              {doc.titleHasFillableRun && doc.active && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveNumber(doc);
                  }}
                  noValidate
                >
                  <div className="field">
                    <label htmlFor={`doc-number-${doc.id}`}>
                      Form number for {doc.documentNumber}
                    </label>
                    <input
                      id={`doc-number-${doc.id}`}
                      type="text"
                      autoComplete="off"
                      value={numberDrafts[doc.id] ?? ''}
                      onChange={(e) =>
                        setNumberDrafts((prev) => ({ ...prev, [doc.id]: e.target.value }))
                      }
                      aria-describedby={`doc-number-hint-${doc.id}`}
                    />
                    <p className="field-hint" id={`doc-number-hint-${doc.id}`}>
                      Fills the blank in the title — e.g. 13 for KW___. Leaving it empty is allowed;
                      the form then reads exactly as the blank paper form does.
                    </p>
                  </div>
                  <button type="submit" disabled={busy}>
                    Save form number
                  </button>
                </form>
              )}

              {/* Review m-7: a number can legitimately be stored against a
                  title with nowhere to substitute it (the owner's "some forms
                  are already pre updated just allow user to choose"), and a
                  retired document keeps the number it was retired with.
                  Rendering it ONLY inside the editable field hid it entirely
                  in both cases. */}
              {!(doc.titleHasFillableRun && doc.active) && doc.machineNumber && (
                <div className="kv-row">
                  <span className="kv-label">Form number</span>
                  <span className="kv-value">{doc.machineNumber}</span>
                </div>
              )}

              {/* Review m-2/m-3: retiring is the house two-step confirm
                  (`AdminUserDetail`'s deactivation, `global.css`'s rule that
                  `btn-destructive` only ever sits behind a confirmation) —
                  this is a gloved tap on a plant-floor tablet. Every control
                  names its document, so a list of rows is never a column of
                  identically-labelled buttons to a screen reader. */}
              {doc.active ? (
                confirmingRetireId === doc.id ? (
                  <div
                    className="dialog"
                    role="group"
                    aria-label={`Confirm retiring ${doc.documentNumber}`}
                  >
                    <p>
                      No new job will be raised on {doc.documentNumber}. Records already made
                      against it are untouched and keep it, and you can return it to service here at
                      any time. Nothing is deleted.
                    </p>
                    <div className="dialog-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmingRetireId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn-destructive"
                        disabled={busy}
                        onClick={() => void setDocumentActive(doc, false)}
                      >
                        Yes, retire it
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="dialog-actions">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Retire ${doc.documentNumber}`}
                      onClick={() => {
                        setRowMsg(null);
                        setConfirmingRetireId(doc.id);
                      }}
                    >
                      Retire
                    </button>
                  </div>
                )
              ) : (
                <div className="dialog-actions">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Return ${doc.documentNumber} to service`}
                    onClick={() => void setDocumentActive(doc, true)}
                  >
                    Return to service
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={(e) => void tag(e)} noValidate>
        <div className="field">
          <label htmlFor="tag-document">Document</label>
          <select
            id="tag-document"
            value={chosenTemplateId}
            onChange={(e) => setChosenTemplateId(e.target.value)}
            aria-describedby="tag-document-hint"
          >
            <option value="">Choose a document</option>
            {offerable.map((template) => (
              <option key={template.id} value={template.id}>
                {template.documentNumber} — {template.title}
                {template.currentRevisionId ? '' : ' (no approved revision yet)'}
              </option>
            ))}
          </select>
          <p className="field-hint" id="tag-document-hint">
            Documents this machine already carries are not listed again — change an existing one on
            its own row above. A document with no approved revision has no checklist to freeze onto
            a job, so tagging it alone still leaves the machine unable to raise work.
          </p>
        </div>
        {banner(tagMsg)}
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || chosenTemplateId.length === 0}
        >
          Tag this document
        </button>
      </form>

      <p className="field-hint">
        Retiring a document stops new jobs being raised on it. Records already made against it are
        untouched and keep it. Nothing is ever deleted.
      </p>
    </section>
  );
}
