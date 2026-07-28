/**
 * Scenarios genuinely not covered by a passing test in this branch, marked
 * pending rather than faked (per the brief: "do NOT fake a pass"). Every
 * other O-01..O-16 scenario has a real, passing spec elsewhere in this
 * directory, driven through the real built app, real Chromium, real
 * IndexedDB — see o01-04, o02-05-15, o03, o08, o09, o10, o11, o12, o13-14,
 * o16-batch-cap.
 *
 * This file no longer declares any pending test. It is kept for the
 * O-06/O-07 note below, which is a live design statement rather than a debt.
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

// O-12 — CLOSED by slice 22-SELFUPDATE. It used to sit here as a
// `test.fixme`, deferred as "flaky in this harness", and that deferral is
// the direct cause of the owner being stranded on a stale build against a
// newer API. It is now a real, passing, discriminating spec:
// `o12-self-update.spec.ts` serves build A, deploys build B underneath a
// live client and requires the client to reach B unaided, with an unsent
// outbox intact. The earlier attempt was not flaky for the reason recorded
// here — `navigator.serviceWorker.ready` was the wrong thing to wait on, and
// "Execution context was destroyed" was the update SUCCEEDING (the reload)
// being read as a fault. See that spec and the slice-22 report.
