import { getDB } from '../offline/db';
import { HttpSyncTransport } from '../api/http-transport';
import type { SyncTransport } from '../api/transport';

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
