/**
 * Which fields of `asset` an ARCHIVED record actually PRINTS.
 *
 * ##### WHY THIS EXISTS #####
 * Same defect class as `archived-title-dependency.ts`: a record's PDF is
 * re-rendered live from current data on every request
 * (`pdf-render.service.ts` -> `pdf-record-assembly.service.ts`), so editing a
 * machine's long-lived row rewrites what records signed months ago print.
 * `GET /records/{id}/integrity` cannot see it — the canonical signed record
 * binds `job.assetId` (the identity) but none of the asset's descriptive
 * columns (`canonical-job-record.ts`).
 *
 * ##### EXACTLY ONE COLUMN QUALIFIES — MEASURED, NOT ASSUMED #####
 * `asset.code`, and nothing else. It reaches TWO rendered artefacts, which is
 * what makes this the highest-impact instance of the class — one edit rewrites
 * every archived record for the machine at once:
 *
 *   - the PDF header and footer, via `PdfRecordInput.machineCode`
 *     (`pdf-html-template.ts` `esc(input.machineCode)`, twice)
 *   - the `assetCode` column of a bulk export's `manifest.csv`
 *     (`records-export-worker.service.ts`)
 *
 * `asset.description` is deliberately ABSENT. `pdf-record-assembly.service.ts`
 * assembles it into `PdfRecordInput.assetDescription`, but the template never
 * emits it — `pdf-html-template.spec.ts` records the same finding ("
 * `assetDescription` is not rendered anywhere in this template"), and it is not
 * in the export manifest either. Guarding it would 409 an engineer fixing a
 * typo in a description with a message claiming archived records would print
 * differently, which is simply false. `PdfRecordInput.assetCode` is likewise
 * assembled and never emitted; `code` earns its guard through `machineCode` and
 * the CSV, not through that field.
 *
 * ##### WHY IT IS NARROW ON PURPOSE #####
 * A machine is long-lived and almost none of its row prints: `description`,
 * `manufacturer`, `model`, `areaId`, `locationDetail`, `status` and `active`
 * are all unrendered, so editing them can never alter signed evidence and must
 * stay freely available — describing, re-siting or retiring a machine is
 * ordinary work. Only a real change to a printed value is considered, so a
 * no-op re-send and a machine with no archived records both stay editable.
 * Someone fixing a typo on a new machine is never blocked.
 *
 * Unlike the document title there is no substitution step here: the value is
 * printed VERBATIM, so "would render differently" is exactly "the value
 * differs".
 *
 * If a future change starts rendering another `asset` column, add it BOTH here
 * and to this comment's measured list — the guard is only as honest as this
 * inventory.
 */

/** The `asset` columns that reach a rendered artefact, and nothing else. */
export interface AssetPrintedFields {
  code: string;
}

/** A printed field whose value would change, named as it reads on the record. */
export interface ChangedPrintedField {
  /** JSON pointer of the request field that would cause it. */
  pointer: string;
  /** How it reads in a refusal sentence — "the machine code". */
  subject: string;
  before: string;
  after: string;
}

/**
 * The printed fields that would change if `current` became `proposed`. Empty
 * means the edit alters nothing any record prints and must be allowed — even
 * when the machine has archived records.
 *
 * `proposed` carries only the fields the caller actually sent; an absent field
 * is untouched and can never be a change.
 */
export function changedPrintedAssetFields(
  current: AssetPrintedFields,
  proposed: Partial<AssetPrintedFields>,
): ChangedPrintedField[] {
  const changed: ChangedPrintedField[] = [];

  if (proposed.code !== undefined && proposed.code !== current.code) {
    // One edit, two rendered artefacts (PDF header/footer and the export
    // manifest) — named as one so the refusal does not read as if the engineer
    // sent two things wrong.
    changed.push({
      pointer: '/code',
      subject: 'the machine code',
      before: current.code,
      after: proposed.code,
    });
  }

  return changed;
}
