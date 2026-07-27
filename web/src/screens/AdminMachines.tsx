import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '../router';
import { listAssets, listAssetTypes, type Asset, type AssetType } from '../api/admin-client';

/**
 * Slice 13-UI-B — the machine list (owner decision #3: the SAMPLE machine
 * workflow IS the product — admins add machines here; the 13a backend
 * auto-suggests provisional codes; the real plant list migrates in later
 * through this same flow). One dropdown per the owner's description: pick
 * an asset type, see its machines. A provisional (system-generated) code
 * renders RED — colour + icon + the word PROVISIONAL (A-05: never colour
 * alone) — until an admin replaces it with the real machine code.
 */
export function AdminMachines() {
  const { navigate } = useRouter();
  const [assetTypes, setAssetTypes] = useState<AssetType[] | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    void listAssetTypes().then((result) => {
      setAssetTypes(result.ok ? result.value.data : []);
    });
  }, []);

  const load = useCallback(async (assetTypeId: string, cursor?: string) => {
    const result = await listAssets({
      ...(assetTypeId ? { assetTypeId } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (result.ok) {
      setAssets((prev) => (cursor && prev ? [...prev, ...result.value.data] : result.value.data));
      setNextCursor(result.value.page.hasMore ? (result.value.page.nextCursor ?? null) : null);
      setError(null);
      return;
    }
    if (result.status === 0) {
      setError('Could not reach the server. The machine list needs a connection.');
    } else {
      setError(
        result.problem?.detail ??
          result.problem?.title ??
          `The server refused this request (${result.status}).`,
      );
    }
    setAssets((prev) => prev ?? []);
  }, []);

  useEffect(() => {
    setAssets(null);
    void load(typeFilter);
  }, [typeFilter, load]);

  const typeName = (id: string) => assetTypes?.find((t) => t.id === id)?.name ?? '';

  return (
    <main className="app-shell" aria-labelledby="admin-machines-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/admin')}>
          <span aria-hidden="true">‹</span> Administration
        </button>
        <span className="microlabel">Administration</span>
        <div className="card-row">
          <h1 id="admin-machines-heading" style={{ marginBottom: 0 }}>
            Machines
          </h1>
          <button
            type="button"
            className="btn-primary"
            onClick={() => navigate('/admin/machines/new')}
          >
            Add machine
          </button>
        </div>
      </header>

      <div className="field">
        <label htmlFor="machine-type-filter">Asset type</label>
        <select
          id="machine-type-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All asset types</option>
          {assetTypes?.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      {assets === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      )}

      {assets !== null && assets.length === 0 && !error && (
        <div className="empty-state">
          <span className="empty-state-glyph" aria-hidden="true">
            ⬡
          </span>
          <p className="empty-state-title">No machines here yet.</p>
          <p>
            Add one with the button above — leave the code blank and the system suggests a
            provisional one you confirm later.
          </p>
        </div>
      )}

      <ul className="data-list">
        {assets?.map((asset) => (
          <li key={asset.id}>
            <button
              type="button"
              className="card card-button"
              data-rule={asset.codeProvisional ? 'bad' : asset.active ? 'good' : 'neutral'}
              onClick={() => navigate(`/admin/machines/${encodeURIComponent(asset.id)}`)}
            >
              <div className="card-row">
                <span className="card-title job-code">{asset.code}</span>
                {asset.codeProvisional && (
                  <span className="status-chip" data-tone="bad">
                    <span aria-hidden="true">⚠</span>
                    <span>PROVISIONAL</span>
                  </span>
                )}
              </div>
              <div className="card-row">
                <span className="text-soft">
                  {asset.assetTypeName ?? typeName(asset.assetTypeId)}
                </span>
                {asset.status === 'ACTIVE' ? (
                  <span className="status-chip" data-tone="good">
                    <span aria-hidden="true">✓</span>
                    <span>ACTIVE</span>
                  </span>
                ) : asset.status === 'UNDER_REPAIR' ? (
                  <span className="status-chip" data-tone="attention">
                    <span aria-hidden="true">⚠</span>
                    <span>UNDER_REPAIR</span>
                  </span>
                ) : (
                  <span className="status-chip" data-tone="neutral">
                    <span aria-hidden="true">⊘</span>
                    <span>DECOMMISSIONED</span>
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {nextCursor && (
        <button
          type="button"
          className="btn-block"
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void load(typeFilter, nextCursor).finally(() => setLoadingMore(false));
          }}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
