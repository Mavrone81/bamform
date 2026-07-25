import { test, expect } from '../support/fixtures';

/**
 * O-11: device storage quota exceeded — graceful degradation, technician
 * warned, no silent data loss.
 *
 * The unit suite (outbox.test.ts) proves `append()`'s contract directly
 * against a real IndexedDB (fake-indexeddb) that is made to throw
 * `QuotaExceededError`. This proves the SAME fault, injected at the real
 * browser's `IDBObjectStore.add`, is surfaced to the technician as an
 * explicit "not saved" warning rather than a false "held on device"
 * success — the actual thing O-11 is worried about.
 */
test('O-11: a quota-exceeded write is never shown as saved, and the technician is warned', async ({
  signedInPage: page,
}) => {
  // Force the very next IDBObjectStore.add() (Dexie's underlying primitive
  // for outbox.append()) to throw QuotaExceededError, exactly as a real
  // device out of storage would. Installed via an init script so it is in
  // place before the app's own module graph runs.
  await page.evaluate(() => {
    const proto = IDBObjectStore.prototype;
    const original = proto.add;
    let triggered = false;
    proto.add = function patchedAdd(...args: unknown[]) {
      if (!triggered && this.name === 'outbox') {
        triggered = true;
        throw new DOMException('quota exceeded (simulated for O-11)', 'QuotaExceededError');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return original.apply(this, args as any);
    };
  });

  await page.getByText('PM-2026-000431').click();
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();

  // Must NOT show the success/"held on device" path for this entry.
  await expect(page.getByText(/Device storage is full/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/entry was NOT saved/i)).toBeVisible();

  // No silent loss: the item's status control must NOT show pressed —
  // there is nothing to be misleadingly optimistic about.
  const doneButton = page.getByRole('button', { name: 'Done', exact: true }).first();
  await expect(doneButton).not.toHaveAttribute('aria-pressed', 'true');
});
