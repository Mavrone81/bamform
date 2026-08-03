// scripts/template-load/src/masterlist/import.spec.ts
import {
  plannedDueDates,
  runImport,
  type ImportTemplateRef,
  type MachineImportResult,
} from './import';
import type { MasterlistRow, PlannedVisit } from './parse';
import type { Reconciliation } from './reconcile';

describe('plannedDueDates', () => {
  it('takes the FIRST planned week for each frequency', () => {
    const visits = [
      { workWeek: 5, frequency: 'M6' as const },
      { workWeek: 18, frequency: 'M3' as const },
      { workWeek: 30, frequency: 'Y' as const },
      { workWeek: 43, frequency: 'M3' as const },
    ];
    expect(plannedDueDates(visits, 2026)).toEqual({
      M6: '2026-01-29',
      M3: '2026-04-30',
      Y: '2026-07-23',
    });
  });

  it('uses the earliest of thirteen monthly visits', () => {
    const visits = [1, 5, 9].map((w) => ({ workWeek: w, frequency: 'M1' as const }));
    expect(plannedDueDates(visits, 2026)).toEqual({ M1: '2026-01-01' });
  });

  it('returns one entry per frequency, not per visit', () => {
    const visits = [
      { workWeek: 2, frequency: 'M3' as const },
      { workWeek: 15, frequency: 'M3' as const },
      { workWeek: 28, frequency: 'M3' as const },
      { workWeek: 41, frequency: 'M3' as const },
    ];
    expect(Object.keys(plannedDueDates(visits, 2026))).toEqual(['M3']);
  });

  it('is empty for an empty visit list', () => {
    expect(plannedDueDates([], 2026)).toEqual({});
  });
});

/**
 * Whole-branch review finding I4: `completion-cascade.service.ts` advances
 * `nextDueOn`/`lastCompletedOn` when a PM is completed and verified, but
 * never touches `adjustedReason` — so a re-run's ONLY human-adjustment
 * guard (`rule.adjustedReason && !rule.adjustedReason.startsWith(
 * PROVENANCE_PREFIX)`) does not fire, and the migration PUTs the original
 * date back over the advanced one. This runs the REAL `runImport` end to
 * end against a minimal mock `fetch` (same technique as
 * `cli-failure-banner.spec.ts`, kept self-contained here rather than
 * folded into that file's already-enumerated, count-asserting fixture set)
 * and proves the fix from BOTH directions: the PUT never happens, and the
 * log says why.
 */
describe('runImport — I4 review fix: a completed rule is never rewound on re-run', () => {
  const BASE = 'http://fake-bamform-i4.test';
  const templates: Record<string, ImportTemplateRef> = {
    ASSET_A: { documentNumber: 'DOC-A', title: 'Some Record ___' },
  };

  function row(label: string, code: string, visits: PlannedVisit[]): MasterlistRow {
    return { label, model: label, code, visits };
  }
  function reconciliation(
    overrides: Partial<Reconciliation> & { row: MasterlistRow },
  ): Reconciliation {
    return {
      assetTypeCode: 'ASSET_A',
      planned: ['M1'],
      formDefines: ['M1'],
      surplus: [],
      missing: [],
      ...overrides,
    };
  }
  const jsonResponse = (data: unknown): Response =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const page = <T>(data: T[]) => ({ data, page: { hasMore: false, nextCursor: null } });

  let putCalls: unknown[];
  let log: string[];

  async function mockFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input).replace(BASE, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === 'POST' && path === '/api/v1/auth/login')
      return jsonResponse({ accessToken: 't' });
    if (method === 'GET' && path === '/api/v1/asset-types') {
      return jsonResponse(page([{ id: 'at-1', code: 'ASSET_A' }]));
    }
    if (method === 'GET' && path === '/api/v1/templates') {
      return jsonResponse(
        page([{ id: 'tpl-1', documentNumber: 'DOC-A', title: 'Some Record ___' }]),
      );
    }
    if (method === 'GET' && path.startsWith('/api/v1/assets?assetTypeId='))
      return jsonResponse(page([]));
    if (method === 'POST' && path === '/api/v1/assets') {
      return jsonResponse({
        id: `asset-${body.code}`,
        code: body.code,
        assetTypeId: body.assetTypeId,
      });
    }
    const docsMatch = /^\/api\/v1\/assets\/([^/]+)\/documents$/.exec(path);
    if (docsMatch && method === 'GET') return jsonResponse({ data: [] });
    if (docsMatch && method === 'POST') {
      return jsonResponse({
        id: `doc-${docsMatch[1]}`,
        assetId: docsMatch[1],
        formTemplateId: body.formTemplateId,
      });
    }
    const scheduleMatch = /^\/api\/v1\/assets\/([^/]+)\/schedule$/.exec(path);
    if (scheduleMatch && method === 'GET') {
      const assetId = scheduleMatch[1];
      // The rule's adjustedReason still carries THIS migration's own
      // provenance prefix (so the pre-existing human-adjustment guard
      // would NOT fire) — the only signal a real completion happened since
      // is lastCompletedOn, exactly the scenario in the finding.
      return jsonResponse([
        {
          id: `rule-${assetId}`,
          assetDocumentId: `doc-${assetId}`,
          frequency: 'M1',
          nextDueOn: '2026-06-15',
          adjustedReason: 'Migrated from ML-S-MFT-00015 Rev 21 (WW1)',
          lastCompletedOn: '2026-06-01',
        },
      ]);
    }
    if (scheduleMatch && method === 'PUT') {
      putCalls.push({ path, body });
      return jsonResponse({});
    }
    throw new Error(`mockFetch: unhandled ${method} ${path}`);
  }

  beforeAll(async () => {
    putCalls = [];
    log = [];
    const reconciliations: Reconciliation[] = [
      reconciliation({
        row: row('Completed Machine', 'COMPLETED-01', [{ workWeek: 1, frequency: 'M1' }]),
      }),
    ];
    const originalFetch = global.fetch;
    // @ts-expect-error -- test double, narrower signature than lib.dom's fetch
    global.fetch = mockFetch;
    try {
      await runImport({
        baseUrl: BASE,
        author: { email: 'a@b.com', password: 'password12345' },
        reconciliations,
        templates,
        year: 2026,
        apply: true,
        log: (l) => log.push(l),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('never PUTs a new nextDueOn over a completed rule', () => {
    expect(putCalls).toHaveLength(0);
  });

  it('logs a distinguishable, per-frequency SKIP line naming lastCompletedOn', () => {
    expect(log).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^ {2}SKIP Completed Machine \(COMPLETED-01\) M1 — already completed \(lastCompletedOn 2026-06-01\)/,
        ),
      ]),
    );
  });

  it('is indented, like the human-adjustment SKIP, so it is not double-counted as a row outcome', () => {
    const skipLine = log.find((l) => l.includes('already completed'));
    expect(skipLine).toBeDefined();
    expect(/^(?:DRY|SKIP|ERROR|BLOCK|REUSE|NOTE)\s{2,}/.test(skipLine!)).toBe(false);
  });
});

/**
 * Owner decision 2026-08-03 (fix round 2): a surplus frequency means the
 * MACHINE ONLY is created — its PM document must NOT be attached, because
 * attaching it would let the scheduler's bootstrap sweep
 * (`schedule-rule-bootstrap.service.ts`, called from every `SchedulerService`
 * sweep) materialise a full schedule for it on the very next sweep,
 * including the surplus frequency the owner reserved for a planner. An
 * earlier version of this module attached the document and merely skipped
 * the schedule GET — that premise was false and has been retracted (see
 * `import.ts`'s file header). This runs the REAL `runImport` end to end,
 * both as a dry run and under `--apply` against a mock `fetch` that THROWS
 * if a surplus row ever reaches the document or schedule endpoints, so a
 * regression back to the old (wrong) behaviour fails loudly instead of
 * silently reappearing.
 */
describe('runImport — surplus decision 2026-08-03 (fix round 2): no document is attached', () => {
  const templates: Record<string, ImportTemplateRef> = {
    ASSET_A: { documentNumber: 'DOC-A', title: 'Some Record ___' },
  };

  function row(label: string, code: string, visits: PlannedVisit[]): MasterlistRow {
    return { label, model: label, code, visits };
  }
  function reconciliation(
    overrides: Partial<Reconciliation> & { row: MasterlistRow },
  ): Reconciliation {
    return {
      assetTypeCode: 'ASSET_A',
      planned: ['M1'],
      formDefines: ['M1', 'Y'],
      surplus: ['Y'],
      missing: [],
      ...overrides,
    };
  }
  const reconciliations: Reconciliation[] = [
    reconciliation({
      row: row('Surplus Machine', 'SURPLUS-01', [{ workWeek: 1, frequency: 'M1' }]),
    }),
  ];

  describe('dry run', () => {
    let log: string[];
    let result: MachineImportResult;

    beforeAll(async () => {
      log = [];
      const report = await runImport({
        baseUrl: 'http://unused',
        author: { email: 'x', password: 'y' },
        reconciliations,
        templates,
        year: 2026,
        apply: false,
        log: (l) => log.push(l),
      });
      result = report.machines[0];
    });

    it('reports the machine as left unplanned with NO document attached and no due dates', () => {
      expect(result.leftUnplanned).toBe(true);
      expect(result.documentAttached).toBe(false);
      expect(result.dueDates).toEqual({});
    });

    it('the log line says a document is NOT attached, and never mentions the documents endpoint', () => {
      const line = log.find((l) => l.includes('Surplus Machine'));
      expect(line).toBeDefined();
      expect(line).toMatch(/NO document is attached/);
      expect(line).not.toMatch(/\/documents/);
    });
  });

  describe('--apply', () => {
    const BASE = 'http://fake-bamform-surplus.test';
    const jsonResponse = (data: unknown): Response =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const page = <T>(data: T[]) => ({ data, page: { hasMore: false, nextCursor: null } });

    let log: string[];
    let result: MachineImportResult;

    async function mockFetch(input: string | URL, init?: RequestInit): Promise<Response> {
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = String(input).replace(BASE, '');
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (method === 'POST' && path === '/api/v1/auth/login')
        return jsonResponse({ accessToken: 't' });
      if (method === 'GET' && path === '/api/v1/asset-types') {
        return jsonResponse(page([{ id: 'at-1', code: 'ASSET_A' }]));
      }
      if (method === 'GET' && path === '/api/v1/templates') {
        return jsonResponse(
          page([{ id: 'tpl-1', documentNumber: 'DOC-A', title: 'Some Record ___' }]),
        );
      }
      if (method === 'GET' && path.startsWith('/api/v1/assets?assetTypeId='))
        return jsonResponse(page([]));
      if (method === 'POST' && path === '/api/v1/assets') {
        return jsonResponse({
          id: `asset-${body.code}`,
          code: body.code,
          assetTypeId: body.assetTypeId,
        });
      }
      // A surplus row must NEVER reach the document or schedule endpoints
      // (owner decision 2026-08-03, fix round 2) — fail LOUDLY if it does,
      // rather than let a regression back to the old behaviour pass silently.
      if (/\/documents(\?.*)?$/.test(path) || /\/schedule(\?.*)?$/.test(path)) {
        throw new Error(
          `REGRESSION: surplus row called ${method} ${path} — must not attach a document`,
        );
      }
      throw new Error(`mockFetch: unhandled ${method} ${path}`);
    }

    beforeAll(async () => {
      log = [];
      const originalFetch = global.fetch;
      // @ts-expect-error -- test double, narrower signature than lib.dom's fetch
      global.fetch = mockFetch;
      try {
        const report = await runImport({
          baseUrl: BASE,
          author: { email: 'a@b.com', password: 'password12345' },
          reconciliations,
          templates,
          year: 2026,
          apply: true,
          log: (l) => log.push(l),
        });
        result = report.machines[0];
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('creates the machine but reports no document attached and no schedule', () => {
      expect(result.assetId).toBe('asset-SURPLUS-01');
      expect(result.leftUnplanned).toBe(true);
      expect(result.documentAttached).toBe(false);
      expect(result.dueDates).toEqual({});
      expect(result.message).toMatch(/no document attached/);
    });

    it('logs a NOTE naming the document a planner must still attach', () => {
      expect(log).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^NOTE {4}Surplus Machine \(SURPLUS-01\).*NO document attached.*DOC-A/,
          ),
        ]),
      );
    });
  });
});
