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
 * `PATCH /assets/{id}` is the highest-impact instance of the class, because
 * `asset.code` alone feeds TWO printed fields and a single edit rewrites every
 * archived record for that machine at once:
 *
 *   assetCode        <- asset.code          (pdf-record-assembly, `assetCode`)
 *   machineCode      <- asset.code          (same source, printed separately)
 *   assetDescription <- asset.description
 *
 * ##### WHY IT IS NARROW ON PURPOSE #####
 * A machine is long-lived and most of its row does NOT print: `manufacturer`,
 * `model`, `areaId`, `locationDetail`, `status` and `active` are absent from
 * the PDF assembly entirely, so editing them can never alter signed evidence
 * and must stay freely available — retiring or re-siting a machine is ordinary
 * work. Only the two printed fields are considered, and only when their value
 * actually changes, so a no-op re-send and a machine with no archived records
 * both stay editable. Someone fixing a typo on a new machine is never blocked.
 *
 * Unlike the document title there is no substitution step here: these values
 * are printed VERBATIM (`esc(input.assetCode)` and friends), so "would render
 * differently" is exactly "the value differs".
 */

/** The `asset` columns that reach the rendered record, and nothing else. */
export interface AssetPrintedFields {
  code: string;
  description: string | null;
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

const NOT_PRINTED = '(blank)';

function display(value: string | null): string {
  return value === null || value === '' ? NOT_PRINTED : value;
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
    // One edit, two printed fields — named as one so the refusal does not
    // read as if the engineer sent two things wrong.
    changed.push({
      pointer: '/code',
      subject: 'the machine code',
      before: display(current.code),
      after: display(proposed.code),
    });
  }
  if (proposed.description !== undefined && proposed.description !== current.description) {
    changed.push({
      pointer: '/description',
      subject: 'the machine description',
      before: display(current.description),
      after: display(proposed.description),
    });
  }

  return changed;
}
