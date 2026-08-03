import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '../router';
import { listAssetTypes, listAssets, type Asset, type AssetType } from '../api/admin-client';
import { MachineSchedule } from '../components/MachineSchedule';

/**
 * Slice 29-SCHEDULE-UI review, IMPORTANT-2. `MachineSchedule` originally only
 * rendered inside `AdminMachineDetail`, reachable exclusively through the
 * Menu's "Administration" entry — gated on ADMIN
 * (`Menu.tsx#isAdmin`/`NavShell.tsx`). But `PUT /assets/{assetId}/schedule`
 * is `PLANNER`/`TEAM_LEADER`/`ENGINEER`/`ADMIN`
 * (`asset-schedule.controller.ts`), added because "planning the PM schedule
 * is what the role exists for". Three of those four roles had no way to
 * reach the one screen that performs the adjustment without typing a URL.
 *
 * This is a NEW route, deliberately OUTSIDE `/admin/*`: it exposes exactly
 * the schedule editor and nothing else that lives under the admin area (user
 * administration, area administration, machine creation/renaming, document
 * tagging — all still ADMIN/ENGINEER-only exactly as before, and still
 * reachable only through Administration). The machine picker below is the
 * SAME open pattern `RaiseJob` already uses for the same reason: `GET
 * /assets` and `GET /asset-types` carry no `@Roles()` at all — area-scoped,
 * open to every authenticated user — so filtering the list is not a
 * permission decision, only a convenience. A PLANNER reaching this screen
 * gains only what `PUT /assets/{assetId}/schedule` already lets them do;
 * `MachineSchedule`'s own role gate keeps anyone without that permission
 * exactly as read-only here as it does inside `AdminMachineDetail`.
 */
export function MachineSchedules() {
  const { navigate } = useRouter();
  const [assetTypes, setAssetTypes] = useState<AssetType[] | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void listAssetTypes().then((result) => setAssetTypes(result.ok ? result.value.data : []));
  }, []);

  const loadAssets = useCallback(async (assetTypeId: string) => {
    const result = await listAssets(assetTypeId ? { assetTypeId } : {});
    if (result.ok) {
      setAssets(result.value.data);
      setLoadError(null);
    } else {
      setAssets([]);
      setLoadError(
        result.status === 0
          ? 'Could not reach the server. Reading the machine list needs a connection.'
          : (result.problem?.detail ??
              result.problem?.title ??
              `The server refused the machine list (${result.status}).`),
      );
    }
  }, []);

  useEffect(() => {
    setAssets(null);
    setAssetId('');
    void loadAssets(typeFilter);
  }, [typeFilter, loadAssets]);

  const chosen = (assets ?? []).find((asset) => asset.id === assetId) ?? null;

  return (
    <main className="app-shell" aria-labelledby="machine-schedules-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/menu')}>
          <span aria-hidden="true">‹</span> Menu
        </button>
        <h1 id="machine-schedules-heading">Machine schedules</h1>
        <p className="screen-meta">
          Pick a machine to view its preventive-maintenance schedule, or adjust a next-due date.
        </p>
      </header>

      {loadError && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {loadError}
        </p>
      )}

      <div className="field">
        <label htmlFor="schedules-type">Machine type</label>
        <select
          id="schedules-type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          disabled={assetTypes === null}
        >
          <option value="">All types</option>
          {(assetTypes ?? []).map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="schedules-asset">Machine</label>
        <select
          id="schedules-asset"
          value={assetId}
          onChange={(e) => setAssetId(e.target.value)}
          disabled={assets === null}
        >
          <option value="">{assets === null ? 'Loading…' : 'Choose a machine'}</option>
          {(assets ?? []).map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.code}
              {asset.description ? ` — ${asset.description}` : ''}
            </option>
          ))}
        </select>
      </div>

      {chosen && <MachineSchedule assetId={chosen.id} />}
    </main>
  );
}
