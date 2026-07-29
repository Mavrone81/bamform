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

  useEffect(() => {
    void listTemplates().then((result) => {
      if (result.ok) setTemplates(result.value.data);
    });
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
      const result = await updateAssetDocument(doc.id, {
        machineNumber: numberDrafts[doc.id]?.trim() ?? '',
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

              <div className="dialog-actions">
                {doc.active ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setDocumentActive(doc, false)}
                  >
                    Retire
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setDocumentActive(doc, true)}
                  >
                    Return to service
                  </button>
                )}
              </div>
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
