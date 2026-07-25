import { findOutstandingMandatoryItems } from './submission-gate';

/**
 * PR-045/PR-API-13/UR-039 — `IN_PROGRESS -> SUBMITTED` completeness gate.
 * "Every `mandatory` item on the frozen revision has an `item_result`" —
 * this is the pure function that decides RED/GREEN before any HTTP/DB
 * plumbing exists; `SubmissionService`/the integration suite exercise it
 * against a real job in `test/integration/jobs-submission.spec.ts`.
 */
describe('findOutstandingMandatoryItems (PR-045)', () => {
  it('returns every mandatory item with no recorded result', () => {
    const items = [
      { id: 'item-1', itemNo: 1, instruction: 'Check A', mandatory: true },
      { id: 'item-2', itemNo: 2, instruction: 'Check B', mandatory: true },
      { id: 'item-3', itemNo: 3, instruction: 'Check C', mandatory: false },
    ];
    const recordedTemplateItemIds = new Set<string>();

    const outstanding = findOutstandingMandatoryItems(items, recordedTemplateItemIds);
    expect(outstanding).toEqual([
      { templateItemId: 'item-1', itemNo: 1, instruction: 'Check A' },
      { templateItemId: 'item-2', itemNo: 2, instruction: 'Check B' },
    ]);
  });

  it('a mandatory item with ANY recorded result (including NOT_DONE) counts as satisfied', () => {
    const items = [{ id: 'item-1', itemNo: 1, instruction: 'Check A', mandatory: true }];
    const outstanding = findOutstandingMandatoryItems(items, new Set(['item-1']));
    expect(outstanding).toEqual([]);
  });

  it('non-mandatory items are never outstanding, recorded or not', () => {
    const items = [{ id: 'item-1', itemNo: 1, instruction: 'Optional', mandatory: false }];
    expect(findOutstandingMandatoryItems(items, new Set())).toEqual([]);
  });

  it('empty checklist has nothing outstanding', () => {
    expect(findOutstandingMandatoryItems([], new Set())).toEqual([]);
  });

  it('every mandatory item recorded means nothing outstanding (the submit-succeeds case)', () => {
    const items = [
      { id: 'item-1', itemNo: 1, instruction: 'Check A', mandatory: true },
      { id: 'item-2', itemNo: 2, instruction: 'Check B', mandatory: true },
    ];
    expect(findOutstandingMandatoryItems(items, new Set(['item-1', 'item-2']))).toEqual([]);
  });
});
