import { test } from '@playwright/test';

/**
 * Scenarios genuinely not covered by a passing test in this branch, marked
 * pending rather than faked (per the brief: "do NOT fake a pass"). Every
 * other O-01..O-16 scenario has a real, passing spec elsewhere in this
 * directory, driven through the real built app, real Chromium, real
 * IndexedDB — see o01-04, o02-05-15, o03, o08, o09, o10, o11, o13-14,
 * o16-batch-cap.
 */

// O-06 / O-07 — RESOLVED by design in slice 16 (D-2b), not by tests:
// attachment capture shipped ONLINE-ONLY. Photos are never queued in the
// offline outbox; an upload either completes or visibly fails before
// Submit (a staged or in-flight photo BLOCKS Submit), so the "attachments
// still uploading at submit" / "attachments pending at verify" states
// these two scenarios describe cannot be reached. Their protective intent
// — a record never silently rides ahead of its evidence — is covered by
// the passing O-21 specs (o21-attachments.spec.ts). If offline-queued
// attachments are ever built (PR-069 quota work), O-06/O-07 become real
// targets again and belong back here as fixmes until proven. See
// docs/TEST_PLAN.md §8 status note and the slice-16 report's defence.

test.fixme('O-12: service worker updated mid-session — cache versioned, no mismatched code against a newer API', async () => {
  // Implemented in production code: src/sw.ts names its cache
  // `bamform-shell-${VITE_APP_VERSION}`, deletes every other cache on
  // activate, and calls skipWaiting/clients.claim; register-sw.ts
  // reloads once on `controllerchange`. A real end-to-end test needs
  // the SECOND service worker to actually reach "activated" and take
  // control inside the test browser before the reload fires, and that
  // lifecycle did not complete reliably within a reasonable timeout in
  // this harness (`navigator.serviceWorker.ready` never resolved for
  // the second registration in the attempts made here). Worth another
  // pass with either a longer, more deliberate wait on the
  // installing/waiting worker's `statechange` events, or the Chromium
  // DevTools Protocol's ServiceWorker domain instead of the page-level
  // API, rather than shipping a flaky or falsely-passing test for a
  // mechanism this important.
});
