import { sortFrequencies, type Frequency } from '@bamform/shared';

/**
 * PR-053 — Frequency cascade. A job's item set is the union of all
 * frequencies whose interval divides the job's own frequency's interval:
 *
 *   1M -> {1M}; 3M -> {1M,3M}; 6M -> {1M,3M,6M}; Y -> {1M,3M,6M,Y}
 *
 * WORKFLOW_DIAGRAMS.md §3: "expressed as a general divisibility rule rather
 * than a hardcoded table, so a template introducing a new frequency does not
 * require code change" (U-CAS-07).
 */
export interface FrequencyCascadeItem {
  frequency: Frequency;
  intervalMonths: number;
}

/**
 * The cascade's entire rule, in one place: a candidate interval belongs to a
 * job of a given interval when it divides it evenly. Deliberately takes
 * plain numbers, not `Frequency` — this function has NO knowledge of which
 * frequency labels exist, which is exactly what makes U-CAS-07 true:
 * introducing a new frequency (e.g. a 24-month biennial inspection) needs no
 * change here, only a new interval value the caller supplies.
 */
export function intervalDivides(
  jobIntervalMonths: number,
  candidateIntervalMonths: number,
): boolean {
  return jobIntervalMonths % candidateIntervalMonths === 0;
}

/**
 * PR-054/OI-08: `template_revision.standing_content.cascade_override` — when
 * present for the job's own frequency, it is honoured verbatim and the
 * computed divisibility set is not consulted at all (U-CAS-06).
 */
export function resolveCascadeItems<T extends FrequencyCascadeItem>(
  jobIntervalMonths: number,
  items: readonly T[],
  override?: readonly Frequency[] | null,
): T[] {
  if (override && override.length > 0) {
    const allow = new Set(override);
    return items.filter((item) => allow.has(item.frequency));
  }
  return items.filter((item) => intervalDivides(jobIntervalMonths, item.intervalMonths));
}

/**
 * Distinct frequencies present in the resolved item set — this is what gets
 * frozen into `job.frequency_scope`. Canonically sorted ascending by
 * interval: PR-052's idempotency key `(asset_id, frequency_scope, due_on)`
 * relies on Postgres array equality, which compares POSITIONALLY, so two
 * runs computing the same set in different orders must not be treated as
 * distinct keys.
 *
 * Note this can differ from "every frequency dividing the job's interval"
 * when the template simply has no active items of a subsumed frequency
 * (U-CAS-05: a 3M job on a template with no 1M items scopes to {3M} only,
 * not {1M,3M} — there is nothing to schedule monthly for that asset).
 */
export function resolveCascadeFrequencyScope<T extends FrequencyCascadeItem>(
  jobIntervalMonths: number,
  items: readonly T[],
  override?: readonly Frequency[] | null,
): Frequency[] {
  const resolved = resolveCascadeItems(jobIntervalMonths, items, override);
  const distinct = [...new Set(resolved.map((item) => item.frequency))];
  return sortFrequencies(distinct);
}
