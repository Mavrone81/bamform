import { describe, expect, it } from 'vitest';
import { createTestDB, getDB } from './db';

describe('BamFormDB', () => {
  it('createTestDB gives each test its own isolated database', async () => {
    const a = createTestDB('db-test-a');
    const b = createTestDB('db-test-b');
    await a.jobs.put({ id: '1', job: {} as never, cachedAt: '', hasPendingOutbox: false, submitState: 'none', serverRemoved: false, predictedDraftVersion: 1 });
    expect(await b.jobs.count()).toBe(0);
    await a.delete();
    await b.delete();
  });

  it('getDB returns the same singleton instance on repeated calls', () => {
    const first = getDB();
    const second = getDB();
    expect(second).toBe(first);
  });

  it('exposes the outbox, jobs and meta tables', () => {
    const db = createTestDB('db-test-tables');
    expect(db.outbox).toBeDefined();
    expect(db.jobs).toBeDefined();
    expect(db.meta).toBeDefined();
  });
});
