import { getDB } from '../offline/db';
import { HttpSyncTransport } from '../api/http-transport';
import type { SyncTransport } from '../api/transport';
import { getCurrentUser } from '../auth';

/**
 * SYS-6: the id every offline read/write is partitioned by. Sourced from
 * `current-user-store`, which only ever holds what the SERVER returned in
 * an authenticated response (`AuthResult.user` on login/refresh) — the same
 * session state the bearer itself comes from, so rows are always keyed by
 * the identity they would be transmitted under. Null when signed out, and
 * every offline function treats null as "touch nothing".
 */
export function getSyncUserId(): string | null {
  return getCurrentUser()?.id ?? null;
}

/**
 * The single place a screen gets its `db`/`transport` pair. Production
 * always uses the real `HttpSyncTransport` — the seam (`SyncTransport`)
 * is what makes this swappable, not a runtime environment branch, so
 * screens never need to know or care which implementation is behind it.
 * Tests construct their own `db`/transport pair directly rather than going
 * through this singleton.
 */
let transportSingleton: SyncTransport | null = null;

export function getTransport(): SyncTransport {
  if (!transportSingleton) transportSingleton = new HttpSyncTransport();
  return transportSingleton;
}

export function getServices() {
  return { db: getDB(), transport: getTransport() };
}
