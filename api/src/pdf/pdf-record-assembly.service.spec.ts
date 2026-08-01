import type { JobFullRow } from '../jobs/job-include';
import { PdfRecordAssemblyService } from './pdf-record-assembly.service';

/**
 * Fix round 1, Task 2 review finding — `buildChecklist`'s soft-removed-item
 * fallback was untested production behaviour. `buildChecklist` is a private,
 * synchronous, Prisma-free mapping (it only reads off the `JobFullRow`
 * already passed in), so it's exercised directly here via bracket access
 * with a minimal `JobFullRow`-shaped fixture, rather than standing up a full
 * Prisma-backed `assemble()` integration test — the constructor's `prisma`/
 * `fieldEncryption` collaborators are never touched by this method.
 */
type BuildChecklistResult = Array<{
  itemNo: number;
  frequency: string;
  inScope: boolean;
  instruction: string;
  status: string;
  remark: string | null;
}>;

function buildChecklist(job: unknown): BuildChecklistResult {
  const service = new PdfRecordAssemblyService(
    undefined as never,
    undefined as never,
  ) as unknown as { buildChecklist: (job: JobFullRow) => BuildChecklistResult };
  return service.buildChecklist(job as JobFullRow);
}

describe('PdfRecordAssemblyService#buildChecklist', () => {
  it('fails CLOSED for an item result whose template item was soft-removed (active: false, so absent from the frozen-revision include) — never silently in scope', () => {
    const job = {
      frequency: 'M6',
      frequencyScope: ['M3', 'M6'], // the job's own frequency IS in its own scope
      templateRevision: { items: [] }, // the referenced item is gone
      itemResults: [{ templateItemId: 'ghost-item', status: 'done', remark: null }],
    };

    const checklist = buildChecklist(job);

    expect(checklist).toHaveLength(1);
    expect(checklist[0].frequency).toBe('');
    expect(checklist[0].inScope).toBe(false);
    expect(checklist[0].instruction).toBe('(item no longer on the revision)');
    expect(checklist[0].itemNo).toBe(0);
  });

  it('a present item resolves scope normally (regression guard for the fallback change)', () => {
    const job = {
      frequency: 'M6',
      frequencyScope: ['M3', 'M6'],
      templateRevision: {
        items: [{ id: 'item-1', itemNo: 1, frequency: 'M3', instruction: 'Check belts' }],
      },
      itemResults: [{ templateItemId: 'item-1', status: 'done', remark: null }],
    };

    const checklist = buildChecklist(job);

    expect(checklist[0].frequency).toBe('M3');
    expect(checklist[0].inScope).toBe(true);
    expect(checklist[0].instruction).toBe('Check belts');
  });

  /**
   * Task 7, extra requirement 1 — the only test in this codebase that
   * exercises the REAL wiring from `job.frequencyScope` through
   * `itemInScope` to an assembled row's `inScope`. Every other coverage of
   * "an ad-hoc job's rows print open" (`pdf-html-template.spec.ts`) feeds
   * `renderRecordHtml` a fixture with `inScope: true` HARDCODED — it proves
   * only that rendering respects a precomputed flag, not that the flag is
   * computed correctly. `buildChecklist` calls the real, un-mocked
   * `itemInScope` (imported from `pdf-html-template.ts`, not stubbed here),
   * so this is the one place a regression to `itemInScope`'s old, buggy
   * "empty scope means nothing applies" form would actually fail a test.
   */
  it('an ad-hoc job (empty frequencyScope) resolves a real template item as in scope — the real itemInScope wiring, not a hardcoded flag', () => {
    const job = {
      frequency: 'ADHOC',
      frequencyScope: [], // adhoc-job.service.ts: "THE EMPTY SCOPE IS THE WHOLE POINT"
      templateRevision: {
        items: [{ id: 'item-1', itemNo: 1, frequency: 'Y', instruction: 'Calibrate' }],
      },
      itemResults: [{ templateItemId: 'item-1', status: 'done', remark: null }],
    };

    const checklist = buildChecklist(job);

    expect(checklist[0].frequency).toBe('Y');
    expect(checklist[0].inScope).toBe(true);
  });
});
