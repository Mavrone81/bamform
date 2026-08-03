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

/** Same bracket-access technique and the same reasoning: `documentTitle` is a
 * private, synchronous, Prisma-free mapping over the `JobFullRow` it is
 * handed. Slice 31-TITLEBLANK. */
function documentTitle(job: unknown): string {
  const service = new PdfRecordAssemblyService(
    undefined as never,
    undefined as never,
  ) as unknown as { documentTitle: (job: JobFullRow) => string };
  return service.documentTitle(job as JobFullRow);
}

/** A `JobFullRow`-shaped fixture carrying only what `documentTitle` reads. */
function titleFixture(input: {
  title: string;
  titleMachineNumber?: string | null;
  machineNumber?: string | null;
}) {
  return {
    titleMachineNumber: input.titleMachineNumber ?? null,
    assetDocument: { machineNumber: input.machineNumber ?? null },
    templateRevision: { formTemplate: { title: input.title } },
  };
}

const FILLABLE = 'BESi Die Attach Preventive Maintenance Record ED____';

describe('PdfRecordAssemblyService#documentTitle (slice 31-TITLEBLANK)', () => {
  it("prefers the TECHNICIAN's per-record entry over the admin-set machineNumber", () => {
    expect(
      documentTitle(
        titleFixture({ title: FILLABLE, titleMachineNumber: '01', machineNumber: '99' }),
      ),
    ).toBe('BESi Die Attach Preventive Maintenance Record ED01');
  });

  it('falls back to the admin-set asset_document.machineNumber when the record has no entry — every record signed before this field existed prints exactly as before', () => {
    expect(documentTitle(titleFixture({ title: FILLABLE, machineNumber: '99' }))).toBe(
      'BESi Die Attach Preventive Maintenance Record ED99',
    );
  });

  it('leaves the blank INTACT when neither is set — the paper form reads that way before anyone writes on it', () => {
    expect(documentTitle(titleFixture({ title: FILLABLE }))).toBe(FILLABLE);
  });

  it('substitutes nothing into a title with no blank, whatever is captured (EP01/PM01 shapes)', () => {
    const printed = 'Epoxy Dispenser EP01 Preventive Maintenance Record';
    expect(documentTitle(titleFixture({ title: printed, titleMachineNumber: '07' }))).toBe(printed);
  });

  it('treats technician free text LITERALLY — a `$&` in the value never splices the matched underscores back in', () => {
    // The exact defect `resolveTemplateTitle`'s function-form replacement
    // exists to prevent, now reachable from a technician's keyboard rather
    // than only an admin's.
    expect(documentTitle(titleFixture({ title: 'Record KW___', titleMachineNumber: 'A$&B' }))).toBe(
      'Record KWA$&B',
    );
  });

  it('passes markup through UNESCAPED — escaping is pdf-html-template.ts’s job, and this proves it is not double-handled here', () => {
    // `esc(input.documentTitle)` in `pdf-html-template.ts` is the single
    // escaping point (see that file's own injection tests). Escaping here as
    // well would double-encode every `&` in a legitimate title.
    expect(
      documentTitle(
        titleFixture({ title: 'Record KW___', titleMachineNumber: '<script>x</script>' }),
      ),
    ).toBe('Record KW<script>x</script>');
  });
});

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

/**
 * INV-09 — the signatory name printed on a record comes from the SNAPSHOT
 * taken at signing (`approval_step.actor_name_ct`), not from a live
 * `app_user` join, so `PATCH /users/{id}` can no longer rewrite who an
 * archived record says signed it.
 *
 * `buildSignatures` is exercised through its private handle for the same
 * reason `buildChecklist` is above: the decision under test is a pure
 * preference between two already-fetched values. `prisma.appUser.findMany`
 * (the fallback path) and `fieldEncryption` are stubbed so the test states
 * exactly which source won.
 */
type Signature = { actorName: string; onBehalfOfName: string | null };

function buildSignatures(
  job: unknown,
  opts: { liveNames?: Record<string, string>; snapshots?: Record<string, string> } = {},
): Promise<Signature[]> {
  const liveNames = opts.liveNames ?? {};
  const snapshots = opts.snapshots ?? {};

  const prisma = {
    appUser: {
      findMany: async () =>
        Object.keys(liveNames).map((id) => ({ id, fullNameCt: Buffer.from(id), dekVersion: 1 })),
    },
  };
  const fieldEncryption = {
    // Stands in for BOTH decrypt paths. The AAD column tells them apart:
    // `full_name_ct` is the live `app_user` read, anything else is a step
    // snapshot. A key absent from `snapshots` throws, standing in for "no
    // snapshot readable" so the fallback is genuinely exercised.
    decrypt: (stored: Uint8Array, _v: number, ctx: { column: string; rowId: string }) => {
      if (ctx.column === 'full_name_ct') {
        const name = liveNames[Buffer.from(stored).toString()];
        if (name === undefined) throw new Error('no live name');
        return name;
      }
      const name = snapshots[`${ctx.rowId}:${ctx.column}`];
      if (name === undefined) throw new Error('no snapshot');
      return name;
    },
  };

  const service = new PdfRecordAssemblyService(
    prisma as never,
    fieldEncryption as never,
  ) as unknown as { buildSignatures: (job: JobFullRow) => Promise<Signature[]> };
  return service.buildSignatures(job as JobFullRow);
}

const STEP = {
  id: 'step-1',
  stageOrdinal: 1,
  stageLabel: 'Verified By',
  action: 'verified',
  actorId: 'user-1',
  onBehalfOfId: null,
  actorRoleCode: 'ENGINEER',
  actedAt: new Date('2026-01-01T00:00:00Z'),
  reason: null,
  drawnSignatureCt: null,
  drawnSignatureDekVersion: null,
  actorNameCt: null,
  onBehalfOfNameCt: null,
  signatoryNameDekVersion: null,
};

describe('PdfRecordAssemblyService#buildSignatures — signatory name (INV-09)', () => {
  it('prints the SNAPSHOT, not the current app_user name', async () => {
    // The whole point: the user has since been renamed to "Bob Jones", and the
    // archived record must still say who actually signed it.
    const job = {
      approvalSteps: [
        {
          ...STEP,
          actorNameCt: Buffer.from('ct'),
          signatoryNameDekVersion: 1,
        },
      ],
    };

    const [signature] = await buildSignatures(job, {
      liveNames: { 'user-1': 'Bob Jones' },
      snapshots: { 'step-1:actor_name_ct': 'Alice Smith' },
    });

    expect(signature.actorName).toBe('Alice Smith');
  });

  it('falls back to the live name for a step signed before the snapshot existed', async () => {
    // Not dead code: every approval_step written before the column existed has
    // a NULL snapshot and must keep rendering exactly as it did before.
    const job = { approvalSteps: [{ ...STEP }] };

    const [signature] = await buildSignatures(job, { liveNames: { 'user-1': 'Alice Smith' } });

    expect(signature.actorName).toBe('Alice Smith');
  });

  it('falls back to the live name when the snapshot cannot be decrypted', async () => {
    // A snapshot that will not decrypt must never make an archived record
    // unprintable — an auditor still has to be able to produce it.
    const job = {
      approvalSteps: [{ ...STEP, actorNameCt: Buffer.from('ct'), signatoryNameDekVersion: 1 }],
    };

    const [signature] = await buildSignatures(job, {
      liveNames: { 'user-1': 'Alice Smith' },
      snapshots: {}, // decrypt throws
    });

    expect(signature.actorName).toBe('Alice Smith');
  });

  it('falls back to the raw actor id when neither a snapshot nor a live name resolves', async () => {
    const job = { approvalSteps: [{ ...STEP }] };
    const [signature] = await buildSignatures(job, {});
    expect(signature.actorName).toBe('user-1');
  });

  it('prefers the snapshot for the on-behalf-of signatory too', async () => {
    const job = {
      approvalSteps: [
        {
          ...STEP,
          onBehalfOfId: 'user-2',
          actorNameCt: Buffer.from('ct'),
          onBehalfOfNameCt: Buffer.from('ct2'),
          signatoryNameDekVersion: 1,
        },
      ],
    };

    const [signature] = await buildSignatures(job, {
      liveNames: { 'user-1': 'Renamed A', 'user-2': 'Renamed B' },
      snapshots: {
        'step-1:actor_name_ct': 'Alice Smith',
        'step-1:on_behalf_of_name_ct': 'Carol White',
      },
    });

    expect(signature.actorName).toBe('Alice Smith');
    expect(signature.onBehalfOfName).toBe('Carol White');
  });
});
