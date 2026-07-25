import { test } from '@playwright/test';

/**
 * Scenarios genuinely not covered by a passing test in this branch, marked
 * pending rather than faked (per the brief: "do NOT fake a pass"). Every
 * other O-01..O-16 scenario has a real, passing spec elsewhere in this
 * directory, driven through the real built app, real Chromium, real
 * IndexedDB — see o01-04, o02-05-15, o03, o08, o09, o10, o11, o13-14,
 * o16-batch-cap.
 */

test.fixme('O-06: submit while attachments still uploading — record submits, attachments flagged pending', async () => {
  // Requires an attachment-capture UI (photo upload widget on the
  // record-capture screen, wired to POST /jobs/{id}/attachments) and an
  // "attachments pending" indicator on the record. This foundation pass
  // deliberately scoped to the core outbox/sync machinery + checklist/
  // measurement capture (the highest-risk surface, RK-01) and did not
  // build attachment capture — PR-067's queuing/pending semantics exist
  // at the contract and type level (Attachment.uploadState
  // pending|received in the generated OpenAPI types) but nothing in
  // src/screens/RecordCapture.tsx calls the upload endpoint yet.
  // Follow-up: add the capture widget, then this is a straightforward
  // extension of the O-01/O-08 patterns already proven in this suite.
});

test.fixme('O-07: a record is not verifiable while attachments are pending — verify blocked until received', async () => {
  // Same prerequisite as O-06: no attachment capture UI exists yet to
  // put a record into the "attachments pending" state in the first
  // place. Verification itself (PR-041..046) is also a later slice
  // (api/src has no jobs/approval module on `main` at the time of this
  // branch), so there is no verify endpoint to call regardless.
});

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
