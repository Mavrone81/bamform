import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from '../router';
import {
  getAsset,
  listAreas,
  updateAsset,
  type Area,
  type Asset,
  type AssetUpdate,
} from '../api/admin-client';

const STATUSES = ['ACTIVE', 'UNDER_REPAIR', 'DECOMMISSIONED'] as const;

/**
 * Slice 13-UI-B — one machine's admin page. The centrepiece is the
 * provisional-code flow (owner decision #3 / B-09): a system-generated code
 * renders RED — tone + icon + the word PROVISIONAL (A-05) — with a field to
 * type the machine's REAL code over it. The server clears the flag only on
 * an actual code CHANGE (sending the same code back is not a confirmation),
 * so the UI asks for the real code rather than offering a hollow
 * "keep as is" button the API would ignore.
 */
export function AdminMachineDetail({ assetId }: { assetId: string }) {
  const { navigate } = useRouter();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newCode, setNewCode] = useState('');
  const [codeMsg, setCodeMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const [description, setDescription] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [locationDetail, setLocationDetail] = useState('');
  const [areaId, setAreaId] = useState('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('ACTIVE');
  const [active, setActive] = useState(true);
  const [detailsMsg, setDetailsMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function applyAsset(next: Asset) {
    setAsset(next);
    setDescription(next.description ?? '');
    setManufacturer(next.manufacturer ?? '');
    setModel(next.model ?? '');
    setLocationDetail(next.locationDetail ?? '');
    setAreaId(next.areaId ?? '');
    setStatus(next.status);
    // `active` is not in the openapi `required` list (pre-existing), so the
    // generated type is optional — the api always sends it; default true.
    setActive(next.active ?? true);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [assetRes, areasRes] = await Promise.all([getAsset(assetId), listAreas()]);
      if (cancelled) return;
      if (assetRes.ok) {
        applyAsset(assetRes.value);
      } else if (assetRes.status === 0) {
        setLoadError('Could not reach the server. Machine administration needs a connection.');
      } else {
        setLoadError(
          assetRes.problem?.detail ??
            assetRes.problem?.title ??
            `The server refused this request (${assetRes.status}).`,
        );
      }
      if (areasRes.ok) setAreas(areasRes.value.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  function refusalText(statusCode: number, problem?: { detail?: string; title?: string }): string {
    if (statusCode === 0) return 'Could not reach the server. This change needs a connection.';
    return problem?.detail ?? problem?.title ?? `The server refused this change (${statusCode}).`;
  }

  async function confirmCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setCodeMsg(null);
    try {
      // Review B-2: the server clears `codeProvisional` only on an actual
      // CHANGE (`assets.service.ts` — a same-code PATCH is a no-op on the
      // flag), so retyping the code on screen must not be reported as a
      // confirmation the server never performed.
      if (asset && newCode.trim() === asset.code) {
        setCodeMsg(
          asset.codeProvisional
            ? {
                tone: 'bad',
                text: `${asset.code} IS the provisional code — type the machine's real code to confirm it.`,
              }
            : { tone: 'bad', text: `That is already this machine's code — nothing to change.` },
        );
        return;
      }
      const result = await updateAsset(assetId, { code: newCode.trim() });
      if (result.ok) {
        applyAsset(result.value);
        setNewCode('');
        // Belt-and-braces on the same B-2 rule: only claim a confirmation
        // the server actually made (the flag must really be clear now).
        setCodeMsg(
          result.value.codeProvisional
            ? {
                tone: 'bad',
                text: `The code is still provisional — type the machine's real code to confirm it.`,
              }
            : { tone: 'good', text: `Code confirmed as ${result.value.code}.` },
        );
      } else {
        setCodeMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setDetailsMsg(null);
    try {
      const body: AssetUpdate = {
        description: description.trim(),
        manufacturer: manufacturer.trim(),
        model: model.trim(),
        locationDetail: locationDetail.trim(),
        // Review B-1: "No area" sends an EXPLICIT null — the API clears the
        // FK (nullable since this fix). Omitting the field would silently
        // keep the old area and make the option a lie.
        areaId: areaId || null,
        status,
        active,
      };
      const result = await updateAsset(assetId, body);
      if (result.ok) {
        applyAsset(result.value);
        setDetailsMsg({ tone: 'good', text: 'Saved.' });
      } else {
        setDetailsMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  function sectionBanner(msg: { tone: 'good' | 'bad'; text: string } | null) {
    if (!msg) return null;
    return (
      <p className="banner" data-tone={msg.tone} role={msg.tone === 'bad' ? 'alert' : 'status'}>
        <span aria-hidden="true">{msg.tone === 'bad' ? '⚠' : '✓'}</span> {msg.text}
      </p>
    );
  }

  if (loadError) {
    return (
      <main className="app-shell" aria-labelledby="machine-detail-heading">
        <header className="screen-header">
          <button
            type="button"
            className="back-link btn-quiet"
            onClick={() => navigate('/admin/machines')}
          >
            <span aria-hidden="true">‹</span> Machines
          </button>
          <span className="microlabel">Administration</span>
          <h1 id="machine-detail-heading" style={{ marginBottom: 0 }}>
            Machine
          </h1>
        </header>
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {loadError}
        </p>
      </main>
    );
  }

  if (!asset) {
    return (
      <main className="app-shell" aria-label="Machine">
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      </main>
    );
  }

  return (
    <main className="app-shell app-shell--focus" aria-labelledby="machine-detail-heading">
      <header className="screen-header">
        <button
          type="button"
          className="back-link btn-quiet"
          onClick={() => navigate('/admin/machines')}
        >
          <span aria-hidden="true">‹</span> Machines
        </button>
        <span className="microlabel">{asset.assetTypeName ?? 'Machine'}</span>
        <div className="card-row">
          <h1 id="machine-detail-heading" className="job-code" style={{ marginBottom: 0 }}>
            {asset.code}
          </h1>
          {asset.codeProvisional && (
            <span className="status-chip" data-tone="bad">
              <span aria-hidden="true">⚠</span>
              <span>PROVISIONAL</span>
            </span>
          )}
        </div>
      </header>

      {/* ---- Provisional code confirmation ---- */}
      {asset.codeProvisional && (
        <section aria-labelledby="machine-code-heading" className="card">
          <h2 id="machine-code-heading">Confirm the machine code</h2>
          <p className="banner" data-tone="bad" role="alert">
            <span aria-hidden="true">⚠</span> <strong>{asset.code}</strong> was generated by the
            system, not chosen by a person. Replace it with the code stamped on the real machine —
            it stays red until you do.
          </p>
          <form onSubmit={(e) => void confirmCode(e)} noValidate>
            <div className="field">
              <label htmlFor="machine-real-code">Real machine code</label>
              <input
                id="machine-real-code"
                type="text"
                autoComplete="off"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                aria-describedby="machine-real-code-hint"
              />
              <p className="field-hint" id="machine-real-code-hint">
                e.g. AW01, BD03, IMOS 01 — the identifier used on the plant floor.
              </p>
            </div>
            {sectionBanner(codeMsg)}
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || newCode.trim().length === 0}
            >
              Confirm code
            </button>
          </form>
        </section>
      )}

      {/* ---- Rename for an already-confirmed code ---- */}
      {!asset.codeProvisional && (
        <section aria-labelledby="machine-rename-heading" className="card">
          <h2 id="machine-rename-heading">Machine code</h2>
          <form onSubmit={(e) => void confirmCode(e)} noValidate>
            <div className="field">
              <label htmlFor="machine-real-code">Change code</label>
              <input
                id="machine-real-code"
                type="text"
                autoComplete="off"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                aria-describedby="machine-rename-hint"
              />
              <p className="field-hint" id="machine-rename-hint">
                Current code: <span className="job-code">{asset.code}</span>. Renaming keeps the
                machine&rsquo;s history — records already signed keep the code they were signed
                under.
              </p>
            </div>
            {sectionBanner(codeMsg)}
            <button type="submit" disabled={busy || newCode.trim().length === 0}>
              Rename
            </button>
          </form>
        </section>
      )}

      {/* ---- Details ---- */}
      <section aria-labelledby="machine-details-heading" className="card">
        <h2 id="machine-details-heading">Details</h2>
        <div className="kv-row">
          <span className="kv-label">Anchor date</span>
          <span className="kv-value">{asset.scheduleAnchorDate}</span>
        </div>
        {asset.serialNumber && (
          <div className="kv-row">
            <span className="kv-label">Serial number</span>
            <span className="kv-value">{asset.serialNumber}</span>
          </div>
        )}
        <form onSubmit={(e) => void saveDetails(e)} noValidate>
          <div className="field">
            <label htmlFor="machine-edit-description">Description</label>
            <input
              id="machine-edit-description"
              type="text"
              autoComplete="off"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="machine-edit-manufacturer">Manufacturer</label>
            <input
              id="machine-edit-manufacturer"
              type="text"
              autoComplete="off"
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="machine-edit-model">Model</label>
            <input
              id="machine-edit-model"
              type="text"
              autoComplete="off"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="machine-edit-location">Location detail</label>
            <input
              id="machine-edit-location"
              type="text"
              autoComplete="off"
              value={locationDetail}
              onChange={(e) => setLocationDetail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="machine-edit-area">Area</label>
            <select
              id="machine-edit-area"
              value={areaId}
              onChange={(e) => setAreaId(e.target.value)}
            >
              <option value="">No area</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name} ({area.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="machine-edit-status">Status</label>
            <select
              id="machine-edit-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="checkbox-field">
            <input
              id="machine-edit-active"
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              aria-describedby="machine-active-hint"
            />
            <label htmlFor="machine-edit-active">Active</label>
          </div>
          <p className="field-hint" id="machine-active-hint">
            Unticking deactivates the machine — it stops scheduling new jobs but keeps its full
            history. Nothing is ever deleted.
          </p>
          {sectionBanner(detailsMsg)}
          <button type="submit" disabled={busy}>
            Save details
          </button>
        </form>
      </section>
    </main>
  );
}
