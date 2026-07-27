import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB, type BamFormDB } from './db';
import { ensurePersistentStorage, getStoragePersistence } from './persistence';

let db: BamFormDB;
let counter = 0;

function stubStorage(impl: Partial<StorageManager> | undefined) {
  Object.defineProperty(navigator, 'storage', {
    value: impl,
    configurable: true,
  });
}

beforeEach(() => {
  db = createTestDB(`test-persist-${counter++}-${Math.random()}`);
});

afterEach(async () => {
  await db.delete();
  vi.restoreAllMocks();
});

describe('ensurePersistentStorage — SYS-15: iOS/Chromium eviction protection', () => {
  it('requests persistence once, records the outcome, and reports granted', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(false) });

    const outcome = await ensurePersistentStorage(db);
    expect(outcome).toMatchObject({ supported: true, persisted: true });
    expect(persist).toHaveBeenCalledTimes(1);

    const stored = await getStoragePersistence(db);
    expect(stored?.persisted).toBe(true);
  });

  it('records a refusal honestly — the UI must be able to warn, not pretend', async () => {
    const persist = vi.fn().mockResolvedValue(false);
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(false) });

    const outcome = await ensurePersistentStorage(db);
    expect(outcome).toMatchObject({ supported: true, persisted: false });
    expect((await getStoragePersistence(db))?.persisted).toBe(false);
  });

  it('does not re-prompt once refused (Firefox shows a user prompt), but notices a later grant via persisted()', async () => {
    const persist = vi.fn().mockResolvedValue(false);
    const persisted = vi.fn().mockResolvedValue(false);
    stubStorage({ persist, persisted });
    await ensurePersistentStorage(db);
    expect(persist).toHaveBeenCalledTimes(1);

    // Second sign-in: no second prompt…
    await ensurePersistentStorage(db);
    expect(persist).toHaveBeenCalledTimes(1);

    // …but if the browser granted it in the meantime (e.g. the PWA was
    // installed), the recorded outcome flips to persisted.
    persisted.mockResolvedValue(true);
    const outcome = await ensurePersistentStorage(db);
    expect(outcome.persisted).toBe(true);
    expect((await getStoragePersistence(db))?.persisted).toBe(true);
  });

  it('handles a browser with no Storage API at all (supported: false, never throws)', async () => {
    stubStorage(undefined);
    const outcome = await ensurePersistentStorage(db);
    expect(outcome).toMatchObject({ supported: false, persisted: false });
  });

  it('is a no-op after persistence has been granted once', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    stubStorage({ persist, persisted });
    await ensurePersistentStorage(db);
    persist.mockClear();
    persisted.mockClear();

    const outcome = await ensurePersistentStorage(db);
    expect(outcome.persisted).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
  });
});
