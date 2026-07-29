/**
 * The machine-number blank in a controlled document's title.
 *
 * Slice 27-ASSETDOC. The admin fills exactly one thing when tagging a document
 * to a machine (owner, 2026-07-29: "Only the form number is filled by admin");
 * everything else on the form is maintainer capture.
 *
 * Measured against the 12 real templates: 8 carry a run of underscores
 * (ED____, KW___, EW_____, MB_____, DP_____, AVS 35-____, IMOS 0__, and
 * CE 95 050 00 01's bare ______), 2 have the number printed already (EP01,
 * PM01), and 2 have no machine designation at all. A single underscore is
 * punctuation, not a blank — hence the {2,}.
 */
const FILLABLE_RUN = /_{2,}/;

/**
 * Whether the admin should be offered a form-number field at all.
 *
 * DERIVED from the title, never stored. This is what keeps the feature honest
 * without a validation error: an admin is never shown a box that does nothing,
 * so they can never believe they have labelled a form when they have not. A
 * flag that returned true for everything would hide the EP01/PM01 case rather
 * than serve it.
 */
export function titleHasFillableRun(title: string): boolean {
  return FILLABLE_RUN.test(title);
}

/**
 * Substitution happens at RENDER, never at tag time, so a template revision
 * that changes the title stays correct. Slice 23-PDFA freezes the rendered
 * result at archive, so an archived record keeps the title it was signed under.
 *
 * A missing `machineNumber` is never an error: it leaves the blank intact,
 * exactly as the paper form reads before someone writes on it. A number
 * supplied for a title with no run is likewise accepted, and simply has
 * nothing to substitute into.
 */
export function resolveTemplateTitle(
  title: string,
  machineNumber: string | null | undefined,
): string {
  if (!machineNumber) {
    return title;
  }
  // The replacement is LITERAL. `String.prototype.replace` interprets `$&`,
  // `$'` and `$1` in a replacement STRING, and a machine number is
  // admin-supplied free text — a bare `.replace(run, machineNumber)` would
  // splice the matched underscores back into the title for an input like
  // "A$&B". The function form of the second argument takes no such patterns.
  return title.replace(FILLABLE_RUN, () => machineNumber);
}
