# Slice 23-PDFA — the controlled copy becomes a fixed artefact

**Date:** 2026-07-29
**Status:** awaiting owner review
**Owner decisions folded in:** freeze-at-archive + PDF/A-2u; PDF/A is good practice, not externally mandated; a PDF is downloadable at any stage that has a signature.

---

## 1. The problem

`GET /records/{recordId}/pdf` renders the record with headless Chromium **on
every request** and stores nothing (`pdf-coordinator.service.ts` →
`pdf-queue.service.ts` → `chromium-browser.service.ts`,
`page.pdf({ format: 'A4', printBackground: true })`). Three consequences:

1. **A template edit silently rewrites history.** Change
   `pdf-html-template.ts` and every historical record's "signed copy" changes
   with it. Nothing records that it changed.
2. **Two auditors can hold different files for the same record.** Downloaded a
   week apart, across a deploy, the bytes differ. Neither can prove which is
   "the" record.
3. **The footer digest does not cover the PDF.** It carries
   `approval_step.content_hash`, which is a hash of the canonical *record
   serialisation*. It proves the underlying data is intact. It says nothing
   about the bytes an auditor filed.

For an ISO-13485 controlled record this is the wrong shape. The artefact a
person files should be fixed and provable.

Separately, Chromium cannot emit PDF/A in any mode — there is no Puppeteer
option for it. Archival conformance requires a post-processing step, which
this slice adds.

## 2. Scope

**In:** freeze-at-archive pipeline, PDF/A-2u conversion, byte-level digest,
object storage, data model + migration, backfill of existing archived records,
void interaction, reconciliation sweep, CI validation.

**Out:** the Archive UI (slice 24-ARCHIVE) and the Android download bridge
(slice 25-PDFSHELL). No change to `GET /records/{recordId}/pdf`'s contract —
it still returns `application/pdf`, so 24 can be built in parallel against it.

## 3. Design

### 3.1 Trigger

`verification.service.ts` already archives in one transaction
(`SUBMITTED -> ARCHIVED`, INV-13) and runs side effects in a `.then()` **after
commit** — that is where escalation-cancel and next-stage scheduling live. The
freeze enqueues there, in the same established seam.

It must not run inside the transaction. Chromium plus Ghostscript is seconds of
work; holding the archiving transaction open for it would be an availability
bug, not a slow path.

Enqueue failure must not fail a verify that already committed — consistent with
the existing best-effort side effects. But "best-effort" is not acceptable on
its own for an archival artefact, so §3.6 adds reconciliation.

### 3.2 Pipeline (on the worker)

```
record data ─► pdf-html-template ─► Chromium page.pdf()   (existing)
                                          │
                                          ▼
                        Ghostscript -dPDFA=2, sRGB output intent
                                          │
                                          ▼
                      sha256(bytes) ─► MinIO put ─► record_document row
```

Ghostscript is added to the API/worker runtime image (`apk add ghostscript`;
the image is Alpine and already carries `ttf-freefont`, so fonts are embeddable
— a PDF/A requirement). Input is a PDF this system generated moments earlier,
not user-supplied content, which materially limits the exposure of adding
Ghostscript; `-dSAFER` is on by default in current versions and is set
explicitly regardless.

**Conformance level is measured, never asserted.** `-dPDFA=2` produces
PDF/A-2**b**; level **u** additionally requires every glyph to carry a
`ToUnicode` mapping. Chromium normally emits those, so 2u is expected to be
achievable — but expected is not verified. veraPDF determines the level
actually reached, and only that measured value is ever written to
`record_document.conformance_level`. The target level is never written as if
it were the outcome. If 2u proves unreachable the artefact is recorded as 2b
and the owner decides whether to pursue it further — a file recorded as 2u
that only satisfies 2b would be worse than no label at all.

### 3.3 Data model

New table `record_document`. One **current** controlled copy per record, with
superseded copies retained rather than deleted (an archive does not overwrite).

| column | type | note |
|---|---|---|
| `id` | uuid v7 | |
| `job_id` | uuid | FK job |
| `revision` | int | 1, 2, … — increments when superseded |
| `storage_key` | text | MinIO object key |
| `sha256` | bytea | digest of the stored bytes |
| `byte_size` | int | |
| `conformance_level` | text | measured, e.g. `PDF/A-2u`, `PDF/A-2b`, `NONE` |
| `provenance` | enum | `FROZEN_AT_ARCHIVE` \| `BACKFILLED` \| `VOID_ANNOTATED` |
| `rendered_at` | timestamptz | |
| `superseded_at` | timestamptz null | null = current |

Partial unique index on `(job_id) WHERE superseded_at IS NULL` — at most one
current copy per record, enforced by the database rather than by convention.

No UPDATE path to the byte-bearing columns. Superseding writes a new row and
stamps `superseded_at` on the old one.

### 3.4 The void interaction

Slice 17-VOID renders a diagonal VOID watermark and a void notice into the PDF,
and a record can be voided **after** it is archived (ARCHIVED's one exit is
VOID). A frozen copy taken at archive time would therefore keep presenting a
voided record as clean — the exact failure this slice exists to prevent,
inverted.

On void: render again, freeze again as `provenance = VOID_ANNOTATED`,
`revision + 1`, and stamp `superseded_at` on the previous row. Downloads serve
the current row, so a voided record downloads as visibly void. The pre-void
copy is retained, which is what lets an auditor see what was filed before.

### 3.5 Serving

`PdfCoordinatorService` gains one branch: if a current `record_document` exists,
stream those exact bytes; otherwise fall back to the existing on-demand render.

The fallback is not dead code — it is the path for records that have a
signature but are not yet archived, which the owner explicitly wants
downloadable (§ owner decision). Those PDFs are deliberately *not* frozen: an
in-flight record is not a controlled copy, and its own `Status:` line
(`pdf-html-template.ts:296`) already distinguishes it.

Access control is unchanged. `assertAccessible` runs first, exactly as now, and
the storage read is server-side only — ADR-007's "streamed through `api`,
authorised on every fetch, never a presigned URL" continues to hold.

### 3.6 Reconciliation

A periodic sweep finds records that are ARCHIVED (or VOIDED) with no current
`record_document` and enqueues the freeze. This is what makes §3.1's
best-effort enqueue safe: a dropped enqueue, a worker restart mid-render or a
MinIO outage becomes a delay, not a permanently missing artefact. It runs on
the existing worker scheduler alongside the other cron work and logs what it
repaired.

### 3.7 Backfill

Existing archived records have no frozen copy. The backfill renders one from
the **current** template — which is, once, deliberately, the "history gets
rewritten" problem this slice otherwise prevents. That is unavoidable: the
bytes as they were at signing time were never stored and cannot be recovered.

It is therefore recorded honestly rather than hidden. Backfilled rows carry
`provenance = BACKFILLED` and their `rendered_at` is the backfill date, not the
archive date, so an auditor can always tell a frozen-at-archive copy from a
reconstruction. A reconstruction presented as an original would be the one
genuinely dishonest outcome available here.

Run as an explicit one-off command, not an automatic migration step: it needs
Chromium and Ghostscript per record and must be observable and resumable.

## 4. CI

Two distinct gates, deliberately different in strength:

- **Conversion ran — BLOCKING.** A test asserts the pipeline actually produced
  a PDF/A-converted artefact with a recorded digest. The owner chose warn-only
  conformance, and a warn-only check with nothing blocking behind it decays
  into a silent no-op — which is precisely how slice 22 shipped inert with
  every gate green.
- **Conformance level — WARN.** veraPDF validates and reports. Non-conformance
  is surfaced, not fatal, per the owner's "good practice, not mandated".

veraPDF is a Java tool and runs **in CI only**. It is not added to the runtime
image; production does not gain a JRE for a validation step.

## 5. Error handling

| condition | behaviour |
|---|---|
| Ghostscript missing/fails | freeze fails, logged, record left for the sweep; the on-demand path still serves a plain PDF, so downloads never break |
| MinIO unavailable | same — retried by the sweep |
| Enqueue fails post-commit | logged; sweep repairs |
| veraPDF reports non-conformance | stored anyway with the measured level recorded; warn |
| Record has no approval step | unchanged — 409 `pdf-not-yet-available` |

The governing rule: **a failure in this pipeline must never make a record
undownloadable.** Degrading to the current behaviour is always acceptable;
losing access to a signed record is not.

## 6. Testing

- Unit: digest computation, revision/supersede logic, provenance stamping,
  conformance-level recording, the serving branch.
- Integration (real deps): archive a record end-to-end → assert a
  `record_document` row exists, bytes in MinIO, digest matches a recomputed
  sha256; void it → assert revision 2, old row superseded, download shows void.
- The partial unique index actually enforced — attempt two current rows,
  expect a constraint violation. A DB constraint nobody tested is a comment.
- Determinism: the same stored record downloaded twice returns byte-identical
  content, including across a template edit. That is the regression test for
  the entire premise of this slice.
- Backfill: resumable, idempotent, marks provenance.
- Failure paths: Ghostscript absent, MinIO down — download still succeeds.

## 7. Risks

- **PDF/A-2u may not be reachable** from Chromium output. Handled by measuring
  rather than asserting (§3.2); worst case is a recorded 2b.
- **Ghostscript CVE surface.** Mitigated by `-dSAFER` and by the input being
  self-generated, but it is a new dependency in the production image and should
  be reviewed as one.
- **Backfill cost** on a large archive — resumable and out-of-band for that
  reason.
- **Storage growth** — one PDF per record plus one per void. Small relative to
  the attachment volume already in MinIO, but it is new unbounded-ish growth
  and worth stating.

## 8. Open

None blocking. The 2u-vs-2b outcome is deliberately deferred to measurement
rather than guessed at now.
