import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createArea,
  createAsset,
  createUser,
  listAreas,
  listAssetTypes,
  listAssets,
  listRoles,
  listUsers,
  getUser,
  setUserAreaScopes,
  updateArea,
  updateAsset,
  updateUser,
} from './admin-client';
import { setAccessToken, _resetForTests as resetTokens } from '../auth/token-store';
import {
  isPasswordChangeRequired,
  _resetForTests as resetGate,
} from '../auth/password-change-gate';

/**
 * Slice 13-UI-B — the admin surface's API client. All calls ride
 * `authorizedFetch` (http-transport.ts), so they carry the bearer, get the
 * silent 401-refresh retry, and latch the forced-password-change gate — the
 * same seam every other authenticated request in the app already uses.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this;
    },
  } as unknown as Response;
}

function lastCall() {
  const calls = vi.mocked(fetch).mock.calls;
  const [url, init] = calls[calls.length - 1];
  const headers = new Headers((init as RequestInit | undefined)?.headers);
  return {
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    headers,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
  };
}

beforeEach(() => {
  resetTokens();
  resetGate();
  setAccessToken('admin-token', 900);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PAGE = { data: [], page: { nextCursor: null, hasMore: false, limit: 100 } };

describe('U-ADMIN-01: admin-client — request shapes', () => {
  it('listUsers GETs /users with the bearer and a limit', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(PAGE));
    const result = await listUsers();
    expect(result.ok).toBe(true);
    const call = lastCall();
    expect(call.url).toContain('/api/v1/users?limit=100');
    expect(call.headers.get('authorization')).toBe('Bearer admin-token');
  });

  it('listUsers passes a cursor through for the next page', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(PAGE));
    await listUsers({ cursor: 'abc' });
    expect(lastCall().url).toContain('cursor=abc');
  });

  it('getUser GETs /users/{id}, URI-encoding the id', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'u1' }));
    await getUser('a/b');
    expect(lastCall().url).toContain('/api/v1/users/a%2Fb');
  });

  it('createUser POSTs the payload and never logs or echoes the password anywhere else', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'u-new' }, 201));
    const result = await createUser({
      fullName: 'New Person',
      email: 'new@bevorasg.com',
      password: 'a-long-password',
      roleCodes: ['MAINTAINER'],
    });
    expect(result.ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.body).toMatchObject({ email: 'new@bevorasg.com' });
  });

  it('updateUser PATCHes /users/{id}', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'u1' }));
    await updateUser('u1', { active: false });
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('/api/v1/users/u1');
    expect(call.body).toEqual({ active: false });
  });

  it('setUserAreaScopes PUTs { areaIds } to /users/{id}/area-scopes', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'u1', areaIds: ['a1'] }));
    const result = await setUserAreaScopes('u1', ['a1']);
    expect(result.ok).toBe(true);
    const call = lastCall();
    expect(call.method).toBe('PUT');
    expect(call.url).toContain('/api/v1/users/u1/area-scopes');
    expect(call.body).toEqual({ areaIds: ['a1'] });
  });

  it('an empty areaIds array is sent as-is — [] means "clear to unrestricted", not "skip"', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'u1', areaIds: [] }));
    await setUserAreaScopes('u1', []);
    expect(lastCall().body).toEqual({ areaIds: [] });
  });

  it('listRoles / listAreas / listAssetTypes GET their collections', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(PAGE));
    await listRoles();
    expect(lastCall().url).toContain('/api/v1/roles');
    await listAreas();
    expect(lastCall().url).toContain('/api/v1/areas');
    await listAssetTypes();
    expect(lastCall().url).toContain('/api/v1/asset-types');
  });

  it('listAssets filters by assetTypeId when given', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(PAGE));
    await listAssets({ assetTypeId: 'at-1' });
    expect(lastCall().url).toContain('assetTypeId=at-1');
  });

  it('createAsset POSTs /assets WITHOUT a code key when none was typed (the server generates the provisional code)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ id: 'as-1', code: 'PROV-AB12CD34', codeProvisional: true }, 201),
    );
    await createAsset({ assetTypeId: 'at-1', scheduleAnchorDate: '2026-08-01' });
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.body).not.toHaveProperty('code');
  });

  it('updateAsset PATCHes /assets/{id}', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'as-1', codeProvisional: false }));
    await updateAsset('as-1', { code: 'AW01' });
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.body).toEqual({ code: 'AW01' });
  });

  it('createArea POSTs and updateArea PATCHes /areas', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: 'ar-1' }, 201));
    await createArea({ code: 'CLEAN-1', name: 'Cleanroom 1' });
    expect(lastCall().method).toBe('POST');
    await updateArea('ar-1', { active: false });
    expect(lastCall().url).toContain('/api/v1/areas/ar-1');
    expect(lastCall().method).toBe('PATCH');
  });
});

describe('U-ADMIN-02: admin-client — outcome mapping', () => {
  it('a non-2xx carries the Problem to the caller (the 409 last-admin refusal must reach the screen)', async () => {
    const problem = {
      type: '/errors/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'You are the last active ADMIN…',
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(problem, 409));
    const result = await updateUser('u1', { active: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.problem?.detail).toContain('last active ADMIN');
    }
  });

  it('a dead network maps to status 0, distinguishable from every server refusal', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await listUsers();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(0);
  });

  it('a 403 password-change-required response still latches the global gate (rides authorizedFetch)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          type: '/errors/password-change-required',
          title: 'Password change required',
          status: 403,
        },
        403,
      ),
    );
    expect(isPasswordChangeRequired()).toBe(false);
    await listUsers();
    expect(isPasswordChangeRequired()).toBe(true);
  });

  it('a body-less 2xx (should one ever appear) resolves ok with an undefined value rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new SyntaxError('no body');
      },
      clone() {
        return this;
      },
    } as unknown as Response);
    const result = await updateUser('u1', {});
    expect(result.ok).toBe(true);
  });
});
