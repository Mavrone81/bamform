import { IdempotencyService } from './idempotency.service';

/**
 * PR-API-16/PR-062/DBD §6.23 — the offline outbox's idempotency mechanism.
 * `PrismaService` is mocked here (unit-level); the real-Postgres round trip
 * (I-INV-16/17 territory — same key replayed / same key different body) is
 * proven against a live `job.items.{id}` PUT in
 * `test/integration/jobs-idempotency.spec.ts`.
 */
describe('IdempotencyService (PR-API-16)', () => {
  it('fingerprint is deterministic for the same logical body', () => {
    const service = new IdempotencyService({} as never);
    const a = service.fingerprint({ status: 'DONE', remark: 'ok' });
    const b = service.fingerprint({ status: 'DONE', remark: 'ok' });
    expect(a.equals(b)).toBe(true);
  });

  it('fingerprint differs for a different body', () => {
    const service = new IdempotencyService({} as never);
    const a = service.fingerprint({ status: 'DONE' });
    const b = service.fingerprint({ status: 'NOT_DONE' });
    expect(a.equals(b)).toBe(false);
  });

  it('checkReplay returns null when the key has never been seen', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const service = new IdempotencyService({ idempotencyKey: { findUnique } } as never);

    const result = await service.checkReplay('key-1', Buffer.from('fp'), 'user-1');
    expect(result).toBeNull();
    expect(findUnique).toHaveBeenCalledWith({ where: { key: 'key-1' } });
  });

  it('checkReplay returns the cached response when the fingerprint AND the user match (safe replay)', async () => {
    const fp = Buffer.from('same-fingerprint');
    const findUnique = jest.fn().mockResolvedValue({
      userId: 'user-1',
      requestFingerprint: fp,
      responseStatus: 200,
      responseBody: { id: 'row-1' },
    });
    const service = new IdempotencyService({ idempotencyKey: { findUnique } } as never);

    const result = await service.checkReplay('key-1', fp, 'user-1');
    expect(result).toEqual({ status: 200, body: { id: 'row-1' } });
  });

  it('checkReplay throws 422 idempotency-mismatch when the fingerprint differs (DBD §6.23)', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      userId: 'user-1',
      requestFingerprint: Buffer.from('original'),
      responseStatus: 200,
      responseBody: {},
    });
    const service = new IdempotencyService({ idempotencyKey: { findUnique } } as never);

    await expect(
      service.checkReplay('key-1', Buffer.from('different'), 'user-1'),
    ).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
    try {
      await service.checkReplay('key-1', Buffer.from('different'), 'user-1');
      fail('expected checkReplay to throw');
    } catch (error) {
      const body = (error as { getResponse(): unknown }).getResponse();
      expect(body).toMatchObject({ type: '/errors/idempotency-mismatch', status: 422 });
    }
  });

  it("checkReplay throws 422 idempotency-mismatch when the SAME key/body was recorded by a DIFFERENT user (DBD §6.23 'key scope is per user')", async () => {
    const fp = Buffer.from('same-fingerprint');
    const findUnique = jest.fn().mockResolvedValue({
      userId: 'user-1',
      requestFingerprint: fp,
      responseStatus: 200,
      responseBody: { id: 'row-1' },
    });
    const service = new IdempotencyService({ idempotencyKey: { findUnique } } as never);

    await expect(service.checkReplay('key-1', fp, 'user-2')).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
  });

  it('recordWithin writes the response against the key, scoped to the user and endpoint, in the passed transaction', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = { idempotencyKey: { create } } as never;
    const service = new IdempotencyService({} as never);

    await service.recordWithin(
      tx,
      {
        key: 'key-1',
        userId: 'user-1',
        endpoint: 'PUT /jobs/{id}/items/{id}',
        fingerprint: Buffer.from('fp'),
      },
      { status: 200, body: { id: 'row-1' } },
    );

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      key: 'key-1',
      userId: 'user-1',
      endpoint: 'PUT /jobs/{id}/items/{id}',
      responseStatus: 200,
      responseBody: { id: 'row-1' },
    });
    expect(Buffer.isBuffer(arg.data.requestFingerprint)).toBe(true);
    const expiresInDays = (arg.data.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(expiresInDays).toBeGreaterThan(29.9);
    expect(expiresInDays).toBeLessThan(30.1);
  });
});
