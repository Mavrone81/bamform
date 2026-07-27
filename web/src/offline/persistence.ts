import type { BamFormDB } from './db';
import { META_KEYS } from './db';

/**
 * SYS-15: without `navigator.storage.persist()` the origin's IndexedDB is
 * "best-effort" — Chromium may evict it under storage pressure, and iOS
 * Safari wipes a NON-installed origin's storage after 7 days without use.
 * Either one silently destroys unsent records: the app just looks empty.
 * (The handled O-11 path covers quota-full APPENDS; this covers eviction of
 * data already held.)
 *
 * Called at sign-in (App.tsx). The outcome is recorded in `meta` so the
 * job-list sync area can surface a refusal honestly — installing the PWA is
 * the user-side fix on both platforms, and the technician deserves to know
 * their held work is not yet protected.
 */
export interface StoragePersistenceOutcome {
  requestedAt: string;
  persisted: boolean;
  /** false when the browser exposes no StorageManager at all. */
  supported: boolean;
}

export async function getStoragePersistence(
  db: BamFormDB,
): Promise<StoragePersistenceOutcome | null> {
  const row = await db.meta.get(META_KEYS.storagePersistence);
  return (row?.value as StoragePersistenceOutcome | undefined) ?? null;
}

export async function ensurePersistentStorage(db: BamFormDB): Promise<StoragePersistenceOutcome> {
  const prior = await getStoragePersistence(db);
  // Granted persistence is permanent for the origin — nothing to re-check.
  if (prior?.persisted) return prior;

  const requestedAt = new Date().toISOString();
  const storage: Partial<StorageManager> | undefined = navigator.storage;
  if (!storage || typeof storage.persist !== 'function') {
    const outcome: StoragePersistenceOutcome = { requestedAt, persisted: false, supported: false };
    await db.meta.put({ key: META_KEYS.storagePersistence, value: outcome });
    return outcome;
  }

  let persisted = false;
  try {
    persisted = (await storage.persisted?.()) ?? false;
    if (!persisted && !prior) {
      // Ask exactly ONCE per device. Chromium decides silently on
      // heuristics; Firefox shows a real user prompt — re-prompting every
      // sign-in would train users to dismiss it. A later grant (e.g. after
      // the PWA is installed) is still noticed via `persisted()` above.
      persisted = await storage.persist();
    }
  } catch {
    // A throwing StorageManager is treated as a refusal, never a crash —
    // this path must not be able to break sign-in.
  }

  const outcome: StoragePersistenceOutcome = { requestedAt, persisted, supported: true };
  await db.meta.put({ key: META_KEYS.storagePersistence, value: outcome });
  return outcome;
}
