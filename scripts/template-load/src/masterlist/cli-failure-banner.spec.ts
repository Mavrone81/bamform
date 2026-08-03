// scripts/template-load/src/masterlist/cli-failure-banner.spec.ts
/**
 * Slice masterlist-migration — Task 6 review fix round 3, MINOR.
 *
 * `countRowOutcomes`/`classifyWriteState` (`cli.ts`) drive the mid-run
 * failure banner an operator reads when deciding whether it is safe to
 * re-run a half-finished PRODUCTION migration. This exact logic was wrong
 * in each of the previous two review rounds — first a false alarm (every
 * log line miscounted as a "row"), then a false all-clear (a write
 * in-flight when the process died was indistinguishable from no write at
 * all) — so it must not go on resting on hand-tracing.
 *
 * Per the review ruling, this does NOT assert against invented log-line
 * strings: a test written that way would keep passing even if `import.ts`
 * changed its wording and broke the regexes that classify it. Instead this
 * runs the REAL `runImport` (Task 4) end-to-end — once as a dry run (which
 * needs no network and covers SKIP/ERROR/DRY), once under `--apply`
 * against an in-process mock `fetch` (covers REUSE/BLOCK/NOTE, the four
 * WRITE attempt/done pairs, and the two indented per-frequency diagnostic
 * lines) — and classifies the REAL log output it produced.
 */
import { countRowOutcomes, classifyWriteState } from './cli';
import { runImport, type ImportTemplateRef } from './import';
import type { MasterlistRow, PlannedVisit } from './parse';
import type { Reconciliation } from './reconcile';

function row(label: string, code: string, visits: PlannedVisit[] = []): MasterlistRow {
  return { label, model: label, code, visits };
}

function reconciliation(
  overrides: Partial<Reconciliation> & { row: MasterlistRow },
): Reconciliation {
  return {
    assetTypeCode: null,
    planned: [],
    formDefines: [],
    surplus: [],
    missing: [],
    ...overrides,
  };
}

const templates: Record<string, ImportTemplateRef> = {
  ASSET_A: { documentNumber: 'DOC-A' },
};

// ---- Batch 1: DRY RUN — zero network calls, covers SKIP / ERROR(missing) /
// DRY(normal) / DRY(surplus) / DRY(unmapped), plus the run-header line. ------

const dryReconciliations: Reconciliation[] = [
  // Matches SKIPPED_LABELS by LABEL — see import.ts's processRow Step 1.
  reconciliation({ row: row('DDA 03', '03') }),
  // planned schedules M1 but the form doesn't define it -> hard-error ERROR line.
  reconciliation({
    row: row('Hard Error Machine', 'HE01', [{ workWeek: 1, frequency: 'M1' }]),
    assetTypeCode: 'ASSET_A',
    planned: ['M1'],
    formDefines: [],
    missing: ['M1'],
  }),
  // ordinary mapped row -> DRY (non-surplus variant).
  reconciliation({
    row: row('Normal Dry Machine', 'ND01', [{ workWeek: 1, frequency: 'M1' }]),
    assetTypeCode: 'ASSET_A',
    planned: ['M1'],
    formDefines: ['M1'],
  }),
  // mapped row with a surplus frequency -> DRY (leaveUnplanned/STOP variant).
  reconciliation({
    row: row('Surplus Dry Machine', 'SD01', [{ workWeek: 1, frequency: 'M1' }]),
    assetTypeCode: 'ASSET_A',
    planned: ['M1'],
    formDefines: ['M1', 'Y'],
    surplus: ['Y'],
  }),
  // unmapped model -> DRY (processUnmapped's dry-run stub).
  reconciliation({ row: row('Unmapped Dry Machine', 'UD01', [{ workWeek: 1, frequency: 'M1' }]) }),
];

// ---- Batch 2: --apply against a mock fetch — covers REUSE / BLOCK / NOTE, ---
// the four WRITE attempt/done pairs, and the two indented per-frequency lines.

const APPLY_BASE = 'http://fake-bamform.test';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const page = <T>(data: T[]) => ({ data, page: { hasMore: false, nextCursor: null } });

async function mockFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = String(input).replace(APPLY_BASE, '');
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  if (method === 'POST' && path === '/api/v1/auth/login') {
    return jsonResponse({ accessToken: 'test-token' });
  }
  if (method === 'GET' && path === '/api/v1/asset-types') {
    return jsonResponse(page([{ id: 'at-1', code: 'ASSET_A' }]));
  }
  if (method === 'GET' && path === '/api/v1/templates') {
    return jsonResponse(page([{ id: 'tpl-1', documentNumber: 'DOC-A', title: 'Some Record ___' }]));
  }
  // Unfiltered listing — used once by processUnmapped for BOTH unmapped rows.
  if (method === 'GET' && path === '/api/v1/assets') {
    return jsonResponse(page([{ id: 'existing-1', code: 'UNMAPPED-REUSE', assetTypeId: 'at-x' }]));
  }
  if (method === 'GET' && path.startsWith('/api/v1/assets?assetTypeId=')) {
    return jsonResponse(page([]));
  }
  if (method === 'POST' && path === '/api/v1/assets') {
    return jsonResponse({
      id: `asset-${body.code}`,
      code: body.code,
      assetTypeId: body.assetTypeId,
    });
  }
  const docsMatch = /^\/api\/v1\/assets\/([^/]+)\/documents$/.exec(path);
  if (docsMatch && method === 'GET') {
    return jsonResponse({ data: [] });
  }
  if (docsMatch && method === 'POST') {
    const assetId = docsMatch[1];
    return jsonResponse({ id: `doc-${assetId}`, assetId, formTemplateId: body.formTemplateId });
  }
  const scheduleMatch = /^\/api\/v1\/assets\/([^/]+)\/schedule$/.exec(path);
  if (scheduleMatch && method === 'GET') {
    const assetId = scheduleMatch[1];
    // MISSING-RULE-01: bootstrap produced no M1 rule -> the indented ERROR line.
    if (assetId === 'asset-MISSING-RULE-01') return jsonResponse([]);
    // ADJUSTED-01: an M1 rule exists but a human already adjusted it -> the
    // indented SKIP line (adjustedReason does NOT carry the migration prefix).
    if (assetId === 'asset-ADJUSTED-01') {
      return jsonResponse([
        {
          id: 'rule-adj',
          assetDocumentId: `doc-${assetId}`,
          frequency: 'M1',
          nextDueOn: '2020-01-01',
          adjustedReason: 'Operator manually reset per work order 123',
        },
      ]);
    }
    // NORMAL-01: an M1 rule exists but with the WRONG date -> triggers the PUT.
    return jsonResponse([
      {
        id: `rule-${assetId}`,
        assetDocumentId: `doc-${assetId}`,
        frequency: 'M1',
        nextDueOn: '2020-01-01',
        adjustedReason: null,
      },
    ]);
  }
  if (scheduleMatch && method === 'PUT') {
    return jsonResponse({});
  }
  throw new Error(`mockFetch: unhandled ${method} ${path}`);
}

const applyReconciliations: Reconciliation[] = [
  reconciliation({ row: row('Unmapped Reuse Machine', 'UNMAPPED-REUSE') }),
  reconciliation({ row: row('Unmapped Block Machine', 'UNMAPPED-BLOCK') }),
  reconciliation({
    row: row('Surplus Apply Machine', 'SURPLUS-01', [{ workWeek: 1, frequency: 'M1' }]),
    assetTypeCode: 'ASSET_A',
    planned: ['M1'],
    formDefines: ['M1', 'Y'],
    surplus: ['Y'],
  }),
  reconciliation({
    row: row('Normal Apply Machine', 'NORMAL-01', [{ workWeek: 1, frequency: 'M1' }]),
    assetTypeCode: 'ASSET_A',
    planned: ['M1'],
    formDefines: ['M1'],
  }),
  reconciliation({
    row: row('Missing Rule Machine', 'MISSING-RULE-01', [{ workWeek: 1, frequency: 'M1' }]),
    assetTypeCode: 'ASSET_A',
    planned: ['M1'],
    formDefines: ['M1'],
  }),
  reconciliation({
    row: row('Adjusted Machine', 'ADJUSTED-01', [{ workWeek: 1, frequency: 'M1' }]),
    assetTypeCode: 'ASSET_A',
    planned: ['M1'],
    formDefines: ['M1'],
  }),
];

describe('mid-run failure banner classification (real import.ts log output)', () => {
  let dryLog: string[];
  let applyLog: string[];

  beforeAll(async () => {
    dryLog = [];
    await runImport({
      baseUrl: 'http://unused',
      author: { email: 'x', password: 'y' },
      reconciliations: dryReconciliations,
      templates,
      year: 2026,
      apply: false,
      log: (l) => dryLog.push(l),
    });

    applyLog = [];
    const originalFetch = global.fetch;
    // @ts-expect-error -- test double, narrower signature than lib.dom's fetch
    global.fetch = mockFetch;
    try {
      await runImport({
        baseUrl: APPLY_BASE,
        author: { email: 'a@b.com', password: 'password12345' },
        reconciliations: applyReconciliations,
        templates,
        year: 2026,
        apply: true,
        log: (l) => applyLog.push(l),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Sanity check that the fixtures above actually exercised every code path
  // this suite depends on — if one of these fails, the property assertions
  // below are testing an empty/wrong corpus, not the real thing.
  it('sanity: the two batches produced the real log lines this suite classifies', () => {
    expect(dryLog).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DRY RUN (default) — logging every call'),
        expect.stringMatching(/^SKIP {4}DDA 03 — SKIPPED_LABELS/),
        expect.stringMatching(/^ERROR {3}Hard Error Machine \(HE01\) —/),
        expect.stringMatching(/^DRY {5}Normal Dry Machine \(ND01\) ->/),
        expect.stringMatching(/^DRY {5}Surplus Dry Machine \(SD01\) ->.*STOP — surplus/),
        expect.stringMatching(/^DRY {5}Unmapped Dry Machine \(UD01\) — unmapped model/),
      ]),
    );
    expect(applyLog).toEqual(
      expect.arrayContaining([
        expect.stringContaining('APPLY — writes are enabled.'),
        expect.stringMatching(/^REUSE {3}Unmapped Reuse Machine \(UNMAPPED-REUSE\) —/),
        expect.stringMatching(/^BLOCK {3}Unmapped Block Machine \(UNMAPPED-BLOCK\) —/),
        expect.stringMatching(/^NOTE {4}Surplus Apply Machine \(SURPLUS-01\) — surplus/),
        expect.stringMatching(/^ {2}WRITE POST \/assets code=NORMAL-01 — attempting$/),
        expect.stringMatching(/^ {2}WRITE POST \/assets code=NORMAL-01 -> asset-NORMAL-01 — done$/),
        expect.stringMatching(
          /^ {2}WRITE PUT \/assets\/asset-NORMAL-01\/schedule M1 -> .* — attempting$/,
        ),
        expect.stringMatching(
          /^ {2}WRITE PUT \/assets\/asset-NORMAL-01\/schedule M1 -> .* — done$/,
        ),
        expect.stringMatching(
          /^ {2}ERROR Missing Rule Machine \(MISSING-RULE-01\) — no M1 schedule_rule/,
        ),
        expect.stringMatching(
          /^ {2}SKIP Adjusted Machine \(ADJUSTED-01\) M1 — already manually adjusted/,
        ),
      ]),
    );
  });

  describe('countRowOutcomes', () => {
    it('is 0 for an empty buffer', () => {
      expect(countRowOutcomes([])).toBe(0);
    });

    it('does NOT count the run-mode header line as a row outcome (the exact round-2 bug)', () => {
      expect(
        countRowOutcomes([
          'DRY RUN (default) — logging every call that would be made; performing none.',
        ]),
      ).toBe(0);
      expect(countRowOutcomes(['APPLY — writes are enabled.'])).toBe(0);
    });

    it('counts every real row-outcome prefix — SKIP, ERROR, DRY, REUSE, BLOCK, NOTE', () => {
      // 5 dry-run rows -> 5 unindented outcome lines (SKIP, ERROR, DRY x3),
      // the header does not count.
      expect(countRowOutcomes(dryLog)).toBe(5);
      // Of the 6 apply rows: REUSE, BLOCK and NOTE each log one unindented
      // outcome line; the 3 fully-mapped, schedule-writing rows (NORMAL-01,
      // MISSING-RULE-01, ADJUSTED-01) do NOT — an ordinary/erroring
      // --apply schedule write logs no single unindented summary line,
      // which is exactly why this is documented as a LOWER bound.
      expect(countRowOutcomes(applyLog)).toBe(3);
    });

    it('does NOT count the two indented per-frequency diagnostic lines', () => {
      const onlyIndentedDiagnostics = applyLog.filter(
        (l) => /^\s+ERROR /.test(l) || /^\s+SKIP /.test(l),
      );
      // Confirms the fixture actually produced both indented lines...
      expect(onlyIndentedDiagnostics).toHaveLength(2);
      // ...and that counting the WHOLE apply log includes them without
      // inflating the outcome count (already asserted above at 3, not 5).
      for (const line of onlyIndentedDiagnostics) {
        expect(countRowOutcomes([line])).toBe(0);
      }
    });
  });

  describe('classifyWriteState', () => {
    it('classifies an empty buffer as "nothing-attempted"', () => {
      expect(classifyWriteState([])).toEqual({ kind: 'nothing-attempted' });
    });

    it('classifies a buffer with only the mode header as "nothing-attempted"', () => {
      expect(
        classifyWriteState([
          'DRY RUN (default) — logging every call that would be made; performing none.',
        ]),
      ).toEqual({ kind: 'nothing-attempted' });
      expect(classifyWriteState(['APPLY — writes are enabled.'])).toEqual({
        kind: 'nothing-attempted',
      });
    });

    it('the dry-run batch (zero network calls) never attempts a write', () => {
      expect(classifyWriteState(dryLog)).toEqual({ kind: 'nothing-attempted' });
    });

    it('an attempt with no matching "done" classifies as "outcome-unknown" (real line, truncated mid-run)', () => {
      const attemptLine = applyLog.find((l) =>
        /^\s+WRITE POST \/assets code=NORMAL-01 — attempting$/.test(l),
      );
      expect(attemptLine).toBeDefined();
      // Simulates the process dying between the "attempting" and "done"
      // lines: only the attempt line survived in the buffer.
      expect(classifyWriteState([attemptLine!])).toEqual({
        kind: 'outcome-unknown',
        attempted: 1,
        confirmed: 0,
      });
    });

    it('equal attempts and dones, count > 0, classifies as "all-confirmed"', () => {
      const attemptLine = applyLog.find((l) =>
        /^\s+WRITE POST \/assets code=NORMAL-01 — attempting$/.test(l),
      );
      const doneLine = applyLog.find((l) =>
        /^\s+WRITE POST \/assets code=NORMAL-01 -> .* — done$/.test(l),
      );
      expect(attemptLine).toBeDefined();
      expect(doneLine).toBeDefined();
      expect(classifyWriteState([attemptLine!, doneLine!])).toEqual({
        kind: 'all-confirmed',
        confirmed: 1,
      });
    });

    it('the full apply batch (every write completed) classifies as "all-confirmed"', () => {
      const state = classifyWriteState(applyLog);
      expect(state.kind).toBe('all-confirmed');
      if (state.kind === 'all-confirmed') {
        expect(state.confirmed).toBeGreaterThan(0);
      }
    });

    it('a real REUSE/BLOCK/NOTE row-outcome line is never mistaken for a write', () => {
      const nonWriteOutcomes = applyLog.filter((l) => /^(?:REUSE|BLOCK|NOTE)\s{2,}/.test(l));
      expect(nonWriteOutcomes.length).toBeGreaterThan(0);
      expect(classifyWriteState(nonWriteOutcomes)).toEqual({ kind: 'nothing-attempted' });
    });
  });
});
