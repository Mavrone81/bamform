# Design — The QA-format printed record, and the capture screen that fills it

Date: 2026-08-01
Status: agreed with the owner in session; ready for an implementation plan
Related: BAMFORM-TLP-001 (template load), PR-116 (record blocks), PR-118 (footer digest)

## 1. Problem

The downloaded PDF is the QA artefact. An auditor holds it, compares it against
the controlled Excel form, and its format cannot vary. It does not currently
match that form.

`api/src/pdf/pdf-html-template.ts` renders a generic stacked report: an `<h2>`
per section and a checklist table with columns `# | Instruction | Status |
Remark`. The controlled sheet has `No | Freq | Instruction` plus a status
region, inside a boxed header grid, under a frequency selection band, above a
three-cell signature row. The PDF has no `Freq` column, no machine identity in
the header, no frequency band, and prints `Frequency: 6M` as a grey bar where
the sheet has a selection.

Separately, the capture screen (`web/src/screens/RecordCapture.tsx`) is a card
list that shares no structure with either. Technicians fill one shape and QA
reads another.

## 2. Decisions (owner, 2026-08-01)

| Question | Decision |
|---|---|
| What is the QA specimen? | The Excel printed to PDF. The target is a **page**, not a report. |
| Print granularity | **One form at a time** — a record covers one machine. |
| Machine columns on the printout | **One `Status` column**; the machine is named once in the header. |
| Revision-history block on the printout | **Dropped.** The header already names the revision the record was filled against. |
| Frequency banner | A **selection**. The schedule proposes; the technician may override; the override is recorded on the signed record. |
| Devices | **Tablet and phone**, both. |

The second and third decisions are what make the sixth achievable. The four
printed machine columns exist because one paper sheet covered AW01–AW04; one
form at a time collapses them to a single column, and a single column is narrow
enough for a phone. Had the grid stayed at four columns, phone support would
have forced the screen to depart from the sheet.

## 3. Current state (verified in code, 2026-08-01)

- **The signature does not cover the PDF.** `pdf-record-assembly.service.ts:40`
  — the footer digest is `latestApprovalStep(job).contentHash`, the exact row
  `integrity.service.ts#checkIntegrity` treats as the stored value, "never
  recomputed here, never a new digest". The canonical record
  (`api/src/jobs/canonical-job-record.ts`) is a Prisma-independent data shape.
  **Changing the PDF layout therefore cannot invalidate a signed record**, and
  archived records re-render in the new format carrying their original digest.
  This is the single most important property of this work.
- **One record already is one machine.** Jobs are generated per
  `asset_document`, so the four-machine sheet already produces four jobs. The
  decision confirms existing behaviour rather than changing it.
- **The data all exists.** Item results (`status ∈ DONE | NOT_APPLICABLE |
  NOT_DONE` + `remark`), measurement results (reading + server-derived
  `PASS/FAIL/NOT_EVALUATED` against the spec range), `PartUsed`, attachments and
  approval steps are all modelled, signed and already rendered in the current
  PDF. This work is presentation.
- **Frequency cascade exists and is unused at the edge.**
  `resolveCascadeFrequencyScope(jobIntervalMonths, items, override)`
  (`api/src/scheduling/frequency-cascade.ts:63`) already expands a Y visit to
  `{M3, M6, Y}` — the sheet's "For Y maintenance, 3M and 6M must be performed at
  the same time" rule. Its `override` parameter has **no caller**.
- **Monthly is already built.** `M1` is in `FrequencyT`, in
  `FREQUENCY_INTERVAL_MONTHS` (`M1: 1`), and `RaiseJob.tsx:20` offers
  `Monthly (1M)`. **7 of the 12 forms carry monthly items — 38 in total**, up to
  10 on `CE-95-043-00-01`. No enum or model work is needed for monthly.
- **Signature captions come from `signatureBlockLabel()`**
  (`pdf-html-template.ts:220`): `Maintenance Performed By`,
  `Verified By (Workshop Team Leader)`, `Verified By (Engineer)`, with a
  stage-label snapshot taking precedence (slice 26-TWOSTAGE M1).
- **Per-item frequency is printed on the sheet.** `parse.ts:401` reads it from
  column B of every checklist row. The `Freq` column is faithful, not invented.

## 4. The printed record

One machine, one page, A4 portrait. Blocks in this order:

1. **Header grid**, boxed. Left: organisation eyebrow, document title. Right, as
   label/value rows: Document No., Revision, **Machine**, Job No., Date.
2. **Frequency band**, full width, centred. Every frequency the form's banner
   offers, with the selected one marked. The options come from that form's own
   banner — four variants exist across the twelve, some with `1M`, one with no
   `Y`.
3. **Checklist table**: `No | Freq | Instruction | Status | Remark`.
   - `No` is the printed number, not a positional index.
   - Status prints the word (`DONE` / `N/A` / `NOT DONE`), not a glyph.
   - `NOT DONE` prints in the stamp colour.
   - Out-of-scope rows (a Y item on a 6M visit) **still print, still numbered**,
     with `—` and `Not in scope (6M)` in the remark. The sheet stays whole.
4. **Measurement records**: `Description | Specification | Reading | Result |
   Remark`. Specification prints the template's `spec_display` verbatim
   (`Hmin ≤ 20 um`, `0.19 – 0.21 μm/encoder`). `FAIL` in the stamp colour.
5. **Standing content**, label/value: Special Tools, Parts Used, PPE, Safety,
   Remarks.
6. **Signature row**, three cells, captions from `signatureBlockLabel()`, each
   with a rule and `name · date` beneath.
7. **Page footer**: document number, revision, machine, job number; the
   integrity digest; `Page N of M`.

Not included: the revision-history block (dropped), and the current template's
`Attachments` heading is folded into standing content as a count with the images
following the signature row.

## 5. The capture screen

The same columns, the same order, the same wording. One component, one
breakpoint.

- **Tablet and above** — the table exactly as printed: `No | Freq |
  Instruction | Status`. Status is a three-way segmented control
  (`DONE / N/A / NOT`).
- **Below the breakpoint** — each row becomes a card carrying the same fields as
  labelled lines: `No 12 · 6M`, the instruction, then the same segmented
  control. Nothing is renamed or dropped; the columns are stacked.
- **Frequency band** sits above the table on both, as a live selector.
- **Out-of-scope rows** render in both, greyed and not fillable — matching the
  printout rather than hiding them.

Aids, all of which live inside an existing cell and move no column:

| Aid | Behaviour |
|---|---|
| Tolerance check | The spec is already beside the field. The cell stamps on blur when the reading falls outside it, rather than waiting for a verifier. |
| Prior reading | Last visit's value for the same measurement, shown on tap. Calibration drift is the thing paper genuinely cannot do. |
| Required remark | `NOT DONE` and out-of-tolerance cannot be submitted bare — enforced at entry, same rule as today. |
| Attachment marker | Indicator in the cell corner; images print after the signature row. |

## 6. Build design — two slices

**Slice A — the QA-format PDF.** The larger job and the one QA depends on.
Rewrite `pdf-html-template.ts` to the §4 layout. Print CSS with real A4 margins
and repeating table headers across page breaks. Golden-file tests per form
shape: single-machine, multi-machine, a form with `1M` items, and the 18-item
`CE-95-043-00-01` to prove pagination. An integrity test proving a record
archived before the change re-renders with an unchanged digest.

**Slice B — the capture screen.** Re-cut `RecordCapture.tsx` (currently 1216
lines) to the §5 layout. The file is already large enough that the table/card
row belongs in its own component with its own tests. Existing offline, conflict
and draft-version behaviour is untouched.

**Slice C — the frequency override.** Smallest, and it can land either side.
Persist the technician's chosen frequency on the job, pass it as
`resolveCascadeFrequencyScope`'s `override`, include it in the canonical record
so the change is signed, and surface it in the frequency band. Needs an audit
event, since it changes which items were in scope for a controlled record.

Order: A, then B, then C. A is what QA is waiting for; C touches the signed
record and should not be rushed alongside a layout change.

## 7. Out of scope

- The scheduler. It is upstream of all of this and gets its own design pass
  (owner's instruction, 2026-08-01).
- Multi-machine records. One form at a time is now the model; nothing here
  attempts a combined four-machine record.
- Any change to the canonical record's existing fields, the approval workflow,
  or the offline outbox.
- Adding monthly. It already exists end to end.

## 8. Risks

1. **No QA-approved specimen PDF has been supplied.** §4 is reconstructed from
   the extracted workbook (content, cell references) plus the current PDF's
   block list. If a signed specimen exists, it should be diffed against slice
   A's golden files before the slice is called done. This is the largest
   uncertainty in the design.
2. **Pagination on long forms.** `CE-95-043-00-01` has 18 items and 10 of them
   monthly; with measurements and standing content it may not hold one page.
   Dropping the revision-history block buys roughly a third of a page, which is
   why it was dropped. Golden-file tests must cover it explicitly.
3. **Print fidelity is Chromium's.** The PDF is rendered by Puppeteer against
   the distro Chromium (`api/Dockerfile`). Table borders and page-break
   behaviour must be verified in that engine, not in a developer's browser.
4. **`spec_display` is free text from the workbook.** Strings like
   `Hmin ≤ 20 um` and `>-600 mmHg` print verbatim. They are not parsed for the
   printed page, so a malformed one degrades to visible nonsense rather than a
   wrong judgement — the judgement is derived server-side from the numeric
   limits, independently.
