import { resolveTemplateTitle } from '@bamform/shared';

/**
 * Which ARCHIVED records would print a different title if
 * `asset_document.machine_number` changed.
 *
 * ##### WHY THIS EXISTS #####
 * The record PDF is re-rendered LIVE from current data on every request
 * (`pdf-render.service.ts` -> `pdf-record-assembly.service.ts`); nothing is
 * frozen at archive. The document title is resolved at RENDER by substituting
 * a machine number into the template title's fillable run
 * (`resolveTemplateTitle`). So an edit to `asset_document.machine_number`
 * silently rewrites the title printed on records that were signed and
 * archived long ago — and `GET /records/{id}/integrity` cannot see it,
 * because neither the machine number nor the resolved title is part of the
 * canonical signed record (`canonical-job-record.ts`).
 *
 * ##### WHY IT IS NARROW ON PURPOSE #####
 * A machine's document is long-lived. Freezing `machine_number` forever the
 * moment ONE record archives would block the ordinary, legitimate correction
 * of a typo, so the test is not "does any archived record exist" but "would
 * any archived record actually PRINT DIFFERENTLY". Three cases fall out of
 * that and are all deliberately ALLOWED:
 *
 *  - The template title carries no fillable run (`EP01`, `PM01` — the number
 *    is printed into the document already). `resolveTemplateTitle` has
 *    nothing to substitute into, so both the old and the new value render the
 *    identical title. Compared, not special-cased: the comparison below IS the
 *    render path, so it cannot drift from it.
 *  - The record captured its OWN machine number, which takes precedence over
 *    the document's (see `ownMachineNumber`). The document's value is not what
 *    that record prints from at all.
 *  - A no-op write (`machineNumber` re-sent unchanged) resolves to the same
 *    title on both sides.
 *
 * Toggling `active` is not routed here at all — retiring a document stops
 * future job generation and changes nothing any record prints.
 */
export interface ArchivedRecordTitle {
  /** The record's human-facing identifier, for naming it in the refusal. */
  jobNumber: string;
  /**
   * The template title this record prints, blank and all — from the record's
   * OWN frozen revision (`job.templateRevision.formTemplate.title`), never
   * from the asset_document's template, so a record bound to an older
   * revision is judged on what IT prints.
   */
  templateTitle: string;
  /**
   * The record's own captured machine number, or `null` if it has none and
   * therefore prints from `asset_document.machine_number`.
   *
   * On `main` today no such per-record column exists, so this is always
   * `null` and every archived record is judged against the document's value —
   * which is correct, because the document's value is the only source
   * `pdf-record-assembly.service.ts` reads. Slice 31-TITLEBLANK adds
   * `job.title_machine_number`, which takes PRECEDENCE over the document's
   * value; a record that captured its own is then genuinely unaffected by
   * this edit and must not block it. Keeping the precedence in the CALLER's
   * mapping (rather than assuming a schema) is what lets this rule stay
   * correct on both sides of that change.
   */
  ownMachineNumber: string | null;
}

/**
 * The archived records that would print a different title if
 * `currentMachineNumber` became `proposedMachineNumber`. Empty means the
 * change alters nothing already signed and must be allowed.
 */
export function recordsBlockingMachineNumberChange(
  records: readonly ArchivedRecordTitle[],
  currentMachineNumber: string | null,
  proposedMachineNumber: string | null,
): ArchivedRecordTitle[] {
  return records.filter((record) => {
    // Prints from its own captured value — the document's value is not a
    // source for this record, so changing it is invisible to it.
    if (record.ownMachineNumber !== null) {
      return false;
    }
    // The comparison is the RENDER function itself, applied to the record's
    // own title. Anything `resolveTemplateTitle` treats as a no-op (no
    // fillable run, an unchanged value) is therefore a no-op here too,
    // without this module having to restate the substitution rules.
    return (
      resolveTemplateTitle(record.templateTitle, currentMachineNumber) !==
      resolveTemplateTitle(record.templateTitle, proposedMachineNumber)
    );
  });
}
