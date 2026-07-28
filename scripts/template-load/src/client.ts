/**
 * Slice 13-TL — minimal authenticated HTTP client for the BamForm API.
 *
 * Drives the REAL API surface (PR-TLP-07: the load is an authenticated
 * operation attributable to a named person, producing audit events — no
 * direct DB writes anywhere in this tooling). Node 22 global fetch; no
 * dependencies.
 */

export interface Credentials {
  email: string;
  password: string;
}

export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body)}`);
  }
}

export class ApiClient {
  private accessToken: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly credentials: Credentials,
  ) {}

  async login(): Promise<void> {
    const result = (await this.request('POST', '/api/v1/auth/login', {
      email: this.credentials.email,
      password: this.credentials.password,
    })) as { accessToken?: string };
    if (!result.accessToken) {
      throw new Error(
        `login for ${this.credentials.email} returned no accessToken — is MFA enabled for this ` +
          'account? The load requires MFA flags off (slice brief §0).',
      );
    }
    this.accessToken = result.accessToken;
  }

  /** Fresh authentication window for approvals (StepUpGuard, 900 s default). */
  async stepUp(): Promise<void> {
    await this.request('POST', '/api/v1/auth/step-up', { password: this.credentials.password });
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request('GET', path)) as T;
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    return (await this.request('POST', path, body)) as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.request('PATCH', path, body)) as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    return (await this.request('PUT', path, body)) as T;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      // Access tokens live ACCESS_TOKEN_TTL_SECONDS (900 s default); a long
      // staging load can outlive one. Re-login once and retry — logins are
      // rate-limited (RATE_LIMIT_LOGIN_PER_MIN), so this must stay rare,
      // which it is: at most once per TTL window.
      if (response.status === 401 && this.accessToken && !isRetry) {
        await this.login();
        return this.request(method, path, body, true);
      }
      throw new ApiError(method, path, response.status, parsed);
    }
    return parsed;
  }
}
