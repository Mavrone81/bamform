// Polyfills IndexedDB inside the jsdom/node test environment so Dexie
// (offline/db.ts) runs against a real IndexedDB implementation in tests
// rather than a hand-rolled mock — the outbox tests exercise actual
// transaction/durability semantics, not a stand-in for them.
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

// Node 22+'s own experimental global `localStorage`/`sessionStorage` shadow
// jsdom's real implementation unless the process was started with
// `--localstorage-file`, leaving `window.localStorage` unusable in this test
// environment. token-store.test.ts asserts non-negotiable #10 (never
// persisted) against the real Storage API, so it needs a working one —
// this installs a minimal in-memory Storage polyfill only when the
// environment's own storage is missing or non-functional.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

function ensureWorkingStorage(name: 'localStorage' | 'sessionStorage'): void {
  try {
    const storage = window[name];
    storage.setItem('__probe__', '1');
    storage.removeItem('__probe__');
  } catch {
    Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true });
  }
}

ensureWorkingStorage('localStorage');
ensureWorkingStorage('sessionStorage');
