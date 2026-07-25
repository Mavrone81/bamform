import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login, refresh, logout, ensureFreshToken } from './auth-client';
import { getAccessToken, isTokenStale, _resetForTests } from './token-store';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 401): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  _resetForTests();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login', () => {
  it('stores the returned access token in memory (token-store) and returns the AuthResult', async () => {
    const authResult = {
      accessToken: 'tok-1',
      expiresIn: 900,
      user: { id: 'u1', fullName: 'A', roles: [] },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(authResult));

    const result = await login('tech@bevorasg.com', 'password12345');
    expect(result).toEqual(authResult);
    expect(getAccessToken()).toBe('tok-1');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/auth/login');
    expect(init?.credentials).toBe('include'); // needed to receive the HttpOnly refresh cookie
  });

  it('throws on a non-OK response and does not set a token', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 401));
    await expect(login('tech@bevorasg.com', 'wrong')).rejects.toThrow('login failed: 401');
    expect(getAccessToken()).toBeNull();
  });
});

describe('refresh', () => {
  it('relies on the HttpOnly cookie (no body sent) and stores the new access token', async () => {
    const authResult = {
      accessToken: 'tok-2',
      expiresIn: 900,
      user: { id: 'u1', fullName: 'A', roles: [] },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(authResult));

    const result = await refresh();
    expect(result).toEqual(authResult);
    expect(getAccessToken()).toBe('tok-2');
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.credentials).toBe('include');
  });

  it('clears any held token and returns null when the refresh cookie is rejected', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 401));
    const result = await refresh();
    expect(result).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});

describe('logout', () => {
  it('calls the logout endpoint and clears the in-memory token', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, true, 204));
    await logout();
    expect(getAccessToken()).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('/auth/logout'),
      expect.anything(),
    );
  });

  it('still clears the local token even if the network call fails outright', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    await expect(logout()).resolves.toBeUndefined();
    expect(getAccessToken()).toBeNull();
  });
});

describe('ensureFreshToken', () => {
  it('returns the current token without a network call when it is not stale', async () => {
    const authResult = {
      accessToken: 'tok-3',
      expiresIn: 900,
      user: { id: 'u1', fullName: 'A', roles: [] },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(authResult));
    await login('tech@bevorasg.com', 'password12345');
    vi.mocked(fetch).mockClear();

    const token = await ensureFreshToken();
    expect(token).toBe('tok-3');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes when there is no token yet', async () => {
    const authResult = {
      accessToken: 'tok-4',
      expiresIn: 900,
      user: { id: 'u1', fullName: 'A', roles: [] },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(authResult));
    const token = await ensureFreshToken();
    expect(token).toBe('tok-4');
    expect(isTokenStale()).toBe(false);
  });
});
