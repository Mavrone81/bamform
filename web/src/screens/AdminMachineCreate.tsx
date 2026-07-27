import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from '../router';
import {
  createAsset,
  listAreas,
  listAssetTypes,
  type Area,
  type AssetType,
} from '../api/admin-client';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Slice 13-UI-B — add a machine (`POST /assets`, ENGINEER/ADMIN
 * server-side). The code field is OPTIONAL by design (owner decision #3 /
 * B-09): left blank, the SERVER generates the next provisional code and
 * flags it — the detail screen then shows it RED until an admin replaces it
 * with the real machine code. Typing a code here means "this IS the real
 * code" and it is treated as confirmed.
 */
export function AdminMachineCreate() {
  const { navigate } = useRouter();
  const [assetTypes, setAssetTypes] = useState<AssetType[] | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [assetTypeId, setAssetTypeId] = useState('');
  const [code, setCode] = useState('');
  const [areaId, setAreaId] = useState('');
  const [anchorDate, setAnchorDate] = useState(today());
  const [description, setDescription] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void listAssetTypes().then((result) => setAssetTypes(result.ok ? result.value.data : []));
    void listAreas().then((result) => {
      if (result.ok) setAreas(result.value.data);
    });
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await createAsset({
        assetTypeId,
        scheduleAnchorDate: anchorDate,
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(areaId ? { areaId } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(serialNumber.trim() ? { serialNumber: serialNumber.trim() } : {}),
      });
      if (result.ok) {
        navigate(`/admin/machines/${encodeURIComponent(result.value.id)}`);
        return;
      }
      if (result.status === 0) {
        setError('Could not reach the server. Adding a machine needs a connection.');
      } else {
        setError(
          result.problem?.detail ??
            result.problem?.title ??
            `The server refused this request (${result.status}).`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell app-shell--focus" aria-labelledby="machine-create-heading">
      <header className="screen-header">
        <button
          type="button"
          className="back-link btn-quiet"
          onClick={() => navigate('/admin/machines')}
        >
          <span aria-hidden="true">‹</span> Machines
        </button>
        <span className="microlabel">Administration</span>
        <h1 id="machine-create-heading" style={{ marginBottom: 0 }}>
          Add a machine
        </h1>
      </header>

      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="machine-type">Asset type</label>
          <select
            id="machine-type"
            value={assetTypeId}
            onChange={(e) => setAssetTypeId(e.target.value)}
          >
            <option value="">Choose an asset type…</option>
            {assetTypes?.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="machine-code">Machine code (optional)</label>
          <input
            id="machine-code"
            type="text"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-describedby="machine-code-hint"
          />
          <p className="field-hint" id="machine-code-hint">
            Leave blank and the system assigns a provisional code, shown in red until you replace it
            with the machine&rsquo;s real code. Type a code only if it IS the real one.
          </p>
        </div>

        <div className="field">
          <label htmlFor="machine-area">Area (optional)</label>
          <select id="machine-area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">No area</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name} ({area.code})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="machine-anchor">Schedule anchor date</label>
          <input
            id="machine-anchor"
            type="date"
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.target.value)}
            aria-describedby="machine-anchor-hint"
          />
          <p className="field-hint" id="machine-anchor-hint">
            Maintenance due dates count from this date.
          </p>
        </div>

        <div className="field">
          <label htmlFor="machine-description">Description (optional)</label>
          <input
            id="machine-description"
            type="text"
            autoComplete="off"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="machine-manufacturer">Manufacturer (optional)</label>
          <input
            id="machine-manufacturer"
            type="text"
            autoComplete="off"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="machine-model">Model (optional)</label>
          <input
            id="machine-model"
            type="text"
            autoComplete="off"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="machine-serial">Serial number (optional)</label>
          <input
            id="machine-serial"
            type="text"
            autoComplete="off"
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
          />
        </div>

        {error && (
          <p className="banner" data-tone="bad" role="alert">
            <span aria-hidden="true">⚠</span> {error}
          </p>
        )}

        <button
          type="submit"
          className="btn-primary btn-block"
          disabled={submitting || !assetTypeId || !anchorDate}
        >
          {submitting ? 'Adding…' : 'Add machine'}
        </button>
      </form>
    </main>
  );
}
