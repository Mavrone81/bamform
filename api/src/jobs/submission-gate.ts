import type { OutstandingItem } from '@bamform/shared';

export interface MandatoryCheckItem {
  id: string;
  itemNo: number;
  instruction: string;
  mandatory: boolean;
}

/**
 * PR-045/UR-039 — the submission completeness gate. `recordedTemplateItemIds`
 * is the set of `template_item.id`s that already have an `item_result` row
 * for THIS job (any status — done/not_applicable/not_done all count as
 * "recorded"; PR-045 asks whether the technician addressed the item, not
 * what they concluded). Only ACTIVE items are ever passed in here (slice-4
 * `active` filtering happens before this function is called) — DP-3/PR-049.
 *
 * PR-API-13: returns the full list, not just a count, so a technician on a
 * phone can tap straight to what's missing.
 */
export function findOutstandingMandatoryItems(
  items: readonly MandatoryCheckItem[],
  recordedTemplateItemIds: ReadonlySet<string>,
): OutstandingItem[] {
  return items
    .filter((item) => item.mandatory && !recordedTemplateItemIds.has(item.id))
    .map((item) => ({
      templateItemId: item.id,
      itemNo: item.itemNo,
      instruction: item.instruction,
    }));
}
