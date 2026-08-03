// scripts/template-load/src/masterlist/import.ts
/**
 * Slice masterlist-migration — Task 4: the importer.
 *
 * Turns each `Reconciliation` (Task 3) into a real machine, document and
 * schedule through the SAME authenticated HTTP surface `loader.ts` drives
 * (`loader.ts:535-585` is the reuse precedent: create-or-reuse a machine,
 * attach a document idempotently by re-check, materialise the schedule with
 * a `GET`). The differences here: a real machine passes `code` (so the
 * server never issues a provisional `PROV-XXXXXXXX`), and this module PATCHes
 * — really `PUT`s, see the note below — the planned due dates afterwards.
 *
 * DRY RUN IS THE DEFAULT (`options.apply` must be explicitly `true`). Under
 * dry run this module makes ZERO network calls — not even GETs — and only
 * logs the calls it would make, computed from `options.reconciliations` plus
 * the caller-supplied template catalogue. That is what makes a dry run safe
 * to run against production before anything exists.
 *
 * Idempotency is by RE-CHECK (list, then compare), never by swallowing a 409
 * — a real conflict (e.g. a duplicate code created out-of-band) must still
 * surface as an error, exactly as `loader.ts`'s own comment insists.
 */
import { ApiClient, type Credentials } from '../client';
import { machineNumberFor, SKIPPED_LABELS, workWeekToDate } from './mapping';
import type { PlannedVisit } from './parse';
import type { Reconciliation } from './reconcile';

// ---- API response shapes (subset actually used) ----------------------------

interface AssetType {
  id: string;
  code: string;
}
interface Asset {
  id: string;
  code: string;
  assetTypeId: string;
}
interface AssetDocument {
  id: string;
  assetId: string;
  formTemplateId: string;
}
interface FormTemplate {
  id: string;
  documentNumber: string;
  title: string;
}
interface ScheduleRule {
  id: string;
  assetDocumentId: string;
  frequency: string;
  nextDueOn: string;
  adjustedReason: string | null;
}
interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

// ---- contract-trimmed comparison (mirrors loader.ts's `sameUnderContract`) -

const contractTrim = (value: string): string => value.trim();
const sameUnderContract = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a == null ? a : contractTrim(a)) === (b == null ? b : contractTrim(b));

async function listAll<T>(client: ApiClient, basePath: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const sep = basePath.includes('?') ? '&' : '?';
    const path: string = cursor
      ? `${basePath}${sep}cursor=${encodeURIComponent(cursor)}`
      : basePath;
    const page = await client.get<Page<T>>(path);
    out.push(...page.data);
    if (!page.page.hasMore || !page.page.nextCursor) return out;
    cursor = page.page.nextCursor;
  }
}

// ---- pure decision function (Task 4 Step 3, unit-tested) -------------------

function firstPlannedWeek(visits: readonly PlannedVisit[]): Record<string, number> {
  const first: Record<string, number> = {};
  for (const v of visits) {
    if (first[v.frequency] === undefined || v.workWeek < first[v.frequency]) {
      first[v.frequency] = v.workWeek;
    }
  }
  return first;
}

/**
 * One due date per frequency: the machine's FIRST planned week for it. The
 * interval carries it forward from there, which is what preserves the
 * masterlist's deliberate stagger without modelling the calendar.
 */
export function plannedDueDates(
  visits: readonly PlannedVisit[],
  year: number,
): Record<string, string> {
  const first = firstPlannedWeek(visits);
  return Object.fromEntries(
    Object.entries(first).map(([freq, week]) => [freq, workWeekToDate(week, year)]),
  );
}

const PROVENANCE_PREFIX = 'Migrated from ML-S-MFT-00015 Rev 21';

// ---- public surface ---------------------------------------------------------

export interface ImportTemplateRef {
  /** `FormTemplate.documentNumber`, e.g. `'CE 95 010 00 01'`. */
  documentNumber: string;
  /** `FormTemplate.title`, needed for `machineNumberFor` (Task 2b) — also
   *  what makes a DRY RUN able to show the computed machine number without
   *  ever calling the network. */
  title: string;
}

export interface ImportOptions {
  baseUrl: string;
  author: Credentials;
  /** Every row to process, already reconciled (Task 3). */
  reconciliations: readonly Reconciliation[];
  /**
   * `assetTypeCode` -> the family's PM document. Comes from the committed
   * template-load YAML (the same source `formFrequencies` was built from for
   * `reconcile()`) — this module never touches the filesystem itself, so the
   * caller (the CLI, Task 6) owns reading it.
   */
  templates: Record<string, ImportTemplateRef>;
  /** Plan year (owner decision: 2026). */
  year: number;
  /** Perform real writes. Default false: DRY RUN, zero network calls. */
  apply?: boolean;
  /**
   * Decide a machine's surplus conflict (Task 3 §6 — the form defines a
   * frequency the plan does not schedule). Applies to ALL of that machine's
   * surplus frequencies at once, matching Task 5's `promptConflict` shape.
   * Omit only when no row in this run has any `surplus` — a real decision is
   * REQUIRED, never defaulted (mirrors `parseConflictChoice`'s own refusal to
   * default silently: "would schedule or drop PM work nobody chose").
   */
  resolveSurplus?: (r: Reconciliation) => Promise<'plan' | 'form'> | 'plan' | 'form';
  /** When true, `resolveSurplus` is skipped and every conflict follows the
   *  plan — Task 5's `--follow-plan`, needed to keep a dry run non-interactive. */
  followPlan?: boolean;
  log?: (line: string) => void;
}

export interface SurplusResolution {
  frequency: string;
  choice: 'plan' | 'form';
  /** True once the frequency was actually deactivated. See `processMapped`'s
   *  surplus handling below — as of this task, always false: no HTTP endpoint
   *  deactivates a single schedule_rule frequency (see the task report). */
  deactivated: boolean;
}

export interface MachineImportResult {
  label: string;
  code: string;
  assetTypeCode: string | null;
  status: 'skipped' | 'unmapped' | 'hard-error' | 'imported';
  /** True when this row could not be fully completed without guessing or
   *  writing something the API cannot honestly represent. See `message`. */
  blocked: boolean;
  assetId?: string;
  documentAttached: boolean;
  /** frequency -> nextDueOn actually planned (or, under dry run, computed). */
  dueDates: Record<string, string>;
  surplus: SurplusResolution[];
  message?: string;
}

export interface ImportReport {
  dryRun: boolean;
  machines: MachineImportResult[];
  counts: {
    skipped: number;
    unmapped: number;
    hardError: number;
    imported: number;
    blocked: number;
  };
}

interface Ctx {
  client: ApiClient | null;
  dryRun: boolean;
  year: number;
  log: (line: string) => void;
  templates: Record<string, ImportTemplateRef>;
  resolveSurplus: (r: Reconciliation) => Promise<'plan' | 'form'> | 'plan' | 'form';
  // Populated once per run, live mode only.
  assetTypes: AssetType[];
  liveTemplates: FormTemplate[];
  assetsByType: Map<string, Asset[]>;
  allAssets: Asset[] | null;
}

export async function runImport(options: ImportOptions): Promise<ImportReport> {
  const log = options.log ?? (() => undefined);
  const dryRun = options.apply !== true;
  const resolveSurplus: Ctx['resolveSurplus'] =
    options.resolveSurplus ??
    (options.followPlan
      ? () => 'plan'
      : (r: Reconciliation) => {
          throw new Error(
            `${r.row.label} has a surplus conflict (${r.surplus.join(', ')}) but no ` +
              'resolveSurplus callback or followPlan flag was supplied — refusing to ' +
              'default silently (would schedule or drop PM work nobody chose).',
          );
        });

  log(
    dryRun
      ? 'DRY RUN (default) — logging every call that would be made; performing none.'
      : 'APPLY — writes are enabled.',
  );

  const ctx: Ctx = {
    client: null,
    dryRun,
    year: options.year,
    log,
    templates: options.templates,
    resolveSurplus,
    assetTypes: [],
    liveTemplates: [],
    assetsByType: new Map(),
    allAssets: null,
  };

  if (!dryRun) {
    const client = new ApiClient(options.baseUrl, options.author);
    await client.login();
    ctx.client = client;
    ctx.assetTypes = await listAll<AssetType>(client, '/api/v1/asset-types');
    ctx.liveTemplates = await listAll<FormTemplate>(client, '/api/v1/templates');
  }

  const machines: MachineImportResult[] = [];
  for (const r of options.reconciliations) {
    machines.push(await processRow(r, ctx));
  }

  const counts = { skipped: 0, unmapped: 0, hardError: 0, imported: 0, blocked: 0 };
  for (const m of machines) {
    if (m.status === 'skipped') counts.skipped += 1;
    else if (m.status === 'unmapped') counts.unmapped += 1;
    else if (m.status === 'hard-error') counts.hardError += 1;
    else counts.imported += 1;
    if (m.blocked) counts.blocked += 1;
  }
  return { dryRun, machines, counts };
}

// ---- per-row processing -----------------------------------------------------

async function processRow(r: Reconciliation, ctx: Ctx): Promise<MachineImportResult> {
  const { row } = r;

  // Step 1 — SKIPPED_LABELS is matched by LABEL, never by code: since the
  // parse fix, `DDA 03`'s code is `03`, so a code-based check would silently
  // stop skipping it and import a machine literally called `03`. Distinct
  // from the unmapped path below — this is a deliberate owner decision (the
  // machine is not on site), not a mapping gap awaiting one.
  if ((SKIPPED_LABELS as readonly string[]).includes(row.label)) {
    ctx.log(`SKIP    ${row.label} — SKIPPED_LABELS (owner: machine not on site). No writes.`);
    return {
      label: row.label,
      code: row.code,
      assetTypeCode: r.assetTypeCode,
      status: 'skipped',
      blocked: false,
      documentAttached: false,
      dueDates: {},
      surplus: [],
    };
  }

  // Step 2 — an unmapped model gets no document at all.
  if (r.assetTypeCode === null) {
    return processUnmapped(r, ctx);
  }

  // Step 3 — GATE ON assetTypeCode !== null before treating a non-empty
  // `missing` as a hard error. `reconcile()` sets `formDefines: []` for an
  // unmapped row, so `missing` fills with the WHOLE planned list for one —
  // that means "no form was ever mapped", not N hard divergences. We only
  // reach this line once assetTypeCode is known, so `missing` here is real.
  if (r.missing.length > 0) {
    const msg =
      `form ${ctx.templates[r.assetTypeCode]?.documentNumber ?? r.assetTypeCode} does not ` +
      `define ${r.missing.join(', ')}, but the plan schedules it — genuine plan/form ` +
      'divergence, not imported.';
    ctx.log(`ERROR   ${row.label} (${row.code}) — ${msg}`);
    return {
      label: row.label,
      code: row.code,
      assetTypeCode: r.assetTypeCode,
      status: 'hard-error',
      blocked: true,
      documentAttached: false,
      dueDates: {},
      surplus: [],
      message: msg,
    };
  }

  return processMapped(r, ctx);
}

/**
 * `assetTypeCode === null` (e.g. `MS-620 ST01`). `POST /api/v1/assets`
 * requires `assetTypeId` — there is no "no family yet" bucket — so this
 * importer can only ever REUSE an asset that already carries this code; it
 * must never invent an asset type to satisfy the schema, which is exactly
 * the kind of guess the brief forbids. If no such asset exists yet, the row
 * is recorded `blocked`, not silently created under a wrong family.
 */
async function processUnmapped(r: Reconciliation, ctx: Ctx): Promise<MachineImportResult> {
  const { row } = r;
  if (ctx.dryRun) {
    ctx.log(
      `DRY     ${row.label} (${row.code}) — unmapped model (no assetTypeCode). Would GET ` +
        `/api/v1/assets and reuse an existing asset with code=${row.code} if present; ` +
        'creation is impossible without an assetTypeId, and this importer never guesses one.',
    );
    return {
      label: row.label,
      code: row.code,
      assetTypeCode: null,
      status: 'unmapped',
      blocked: true,
      documentAttached: false,
      dueDates: {},
      surplus: [],
      message: 'unmapped model — dry run cannot confirm whether it already exists',
    };
  }

  const client = ctx.client!;
  if (ctx.allAssets === null) {
    ctx.allAssets = await listAll<Asset>(client, '/api/v1/assets');
    ctx.log(`  GET /assets (unfiltered, ${ctx.allAssets.length} total) — looking up ${row.code}`);
  }
  const found = ctx.allAssets.find((a) => sameUnderContract(a.code, row.code));
  if (found) {
    ctx.log(
      `REUSE   ${row.label} (${row.code}) — already exists as asset ${found.id} ` +
        `(assetTypeId ${found.assetTypeId}); left untouched.`,
    );
    return {
      label: row.label,
      code: row.code,
      assetTypeCode: null,
      status: 'imported',
      blocked: false,
      assetId: found.id,
      documentAttached: false,
      dueDates: {},
      surplus: [],
      message: 'reused an existing asset; unmapped model, so no document/schedule was touched',
    };
  }

  const msg =
    `unmapped model and no existing asset with code ${row.code} — cannot create without an ` +
    'assetTypeId, and this importer never guesses one. Needs an owner decision (assign a ' +
    'family, or confirm the machine is already registered under a different code) before ' +
    'this row can be migrated.';
  ctx.log(`BLOCK   ${row.label} (${row.code}) — ${msg}`);
  return {
    label: row.label,
    code: row.code,
    assetTypeCode: null,
    status: 'unmapped',
    blocked: true,
    documentAttached: false,
    dueDates: {},
    surplus: [],
    message: msg,
  };
}

async function processMapped(r: Reconciliation, ctx: Ctx): Promise<MachineImportResult> {
  const { row } = r;
  const assetTypeCode = r.assetTypeCode as string;
  const template = ctx.templates[assetTypeCode];
  if (!template) {
    const msg = `no template configured for asset type ${assetTypeCode} — cannot attach a document.`;
    ctx.log(`ERROR   ${row.label} (${row.code}) — ${msg}`);
    return {
      label: row.label,
      code: row.code,
      assetTypeCode,
      status: 'hard-error',
      blocked: true,
      documentAttached: false,
      dueDates: {},
      surplus: [],
      message: msg,
    };
  }

  const dueDates = plannedDueDates(row.visits, ctx.year);
  const firstWeek = firstPlannedWeek(row.visits);
  const anchorDate = Object.values(dueDates).sort()[0];
  const machineNumber = machineNumberFor(template.title, row.code);

  // Step 4 — resolve every surplus frequency BEFORE any network call, so a
  // dry run can show the decision without needing an asset to exist yet.
  const surplusChoice: 'plan' | 'form' | null =
    r.surplus.length > 0 ? await ctx.resolveSurplus(r) : null;
  const surplus: SurplusResolution[] = r.surplus.map((frequency) => ({
    frequency,
    choice: surplusChoice as 'plan' | 'form',
    deactivated: false,
  }));
  if (surplusChoice === 'plan') {
    for (const s of surplus) {
      // NEEDS_CONTEXT (see task report): `PUT /assets/{id}/schedule`
      // (`ScheduleAdjust`) only accepts `nextDueOn`/`adjustedReason` — there
      // is no `active` field. `PATCH /asset-documents/{id} {active:false}`
      // deactivates the WHOLE document (every frequency on it), which would
      // also disable this machine's genuinely PLANNED frequencies on the
      // same document. No verified HTTP call exists that deactivates ONE
      // schedule_rule frequency, so this is never performed — logged loudly
      // instead of guessed.
      ctx.log(
        `BLOCKED ${row.label} (${row.code}) — chose to DROP surplus ${s.frequency}, but no ` +
          'API call exists to deactivate a single schedule_rule frequency without also ' +
          'disabling this document’s planned frequencies. Left ACTIVE at its bootstrap ' +
          'default; needs an owner/API decision.',
      );
    }
  } else if (surplusChoice === 'form') {
    for (const s of surplus) {
      ctx.log(
        `NOTE    ${row.label} (${row.code}) — chose to FOLLOW THE FORM for ${s.frequency}: ` +
          'left at its bootstrap default (no masterlist due date exists for it to migrate).',
      );
    }
  }

  if (ctx.dryRun) {
    ctx.log(
      `DRY     ${row.label} (${row.code}) -> ${assetTypeCode} / ${template.documentNumber} — ` +
        `would GET/POST /api/v1/assets (code=${row.code}, scheduleAnchorDate=${anchorDate}), ` +
        `GET/POST /assets/{id}/documents (machineNumber=${machineNumber ?? 'null'}), ` +
        `GET /assets/{id}/schedule, then PUT it per frequency: ` +
        Object.entries(dueDates)
          .map(([f, d]) => `${f}=${d} (WW${firstWeek[f]})`)
          .join(', '),
    );
    return {
      label: row.label,
      code: row.code,
      assetTypeCode,
      status: 'imported',
      blocked: surplus.some((s) => s.choice === 'plan'),
      documentAttached: true,
      dueDates,
      surplus,
    };
  }

  const client = ctx.client!;

  // ---- Step 5: create-or-reuse the machine ---------------------------------
  const assetType = ctx.assetTypes.find((t) => sameUnderContract(t.code, assetTypeCode));
  if (!assetType) {
    const msg = `asset type ${assetTypeCode} does not exist in this environment.`;
    ctx.log(`ERROR   ${row.label} (${row.code}) — ${msg}`);
    return {
      label: row.label,
      code: row.code,
      assetTypeCode,
      status: 'hard-error',
      blocked: true,
      documentAttached: false,
      dueDates: {},
      surplus,
      message: msg,
    };
  }
  if (!ctx.assetsByType.has(assetType.id)) {
    const list = await listAll<Asset>(client, `/api/v1/assets?assetTypeId=${assetType.id}`);
    ctx.assetsByType.set(assetType.id, list);
    ctx.log(`  GET /assets?assetTypeId=${assetType.id} (${list.length} existing)`);
  }
  const assetsOfType = ctx.assetsByType.get(assetType.id)!;
  let asset = assetsOfType.find((a) => sameUnderContract(a.code, row.code));
  if (!asset) {
    asset = await client.post<Asset>('/api/v1/assets', {
      code: row.code,
      assetTypeId: assetType.id,
      description: row.model,
      scheduleAnchorDate: anchorDate,
    });
    assetsOfType.push(asset);
    ctx.log(`  POST /assets code=${row.code} -> ${asset.id}`);
  } else {
    ctx.log(`  REUSE asset ${asset.id} (code=${row.code})`);
  }

  // ---- Step 6: attach the document idempotently by re-check ---------------
  const liveTemplate = ctx.liveTemplates.find((t) =>
    sameUnderContract(t.documentNumber, template.documentNumber),
  );
  if (!liveTemplate) {
    const msg = `template ${template.documentNumber} is not loaded in this environment.`;
    ctx.log(`ERROR   ${row.label} (${row.code}) — ${msg}`);
    return {
      label: row.label,
      code: row.code,
      assetTypeCode,
      status: 'hard-error',
      blocked: true,
      assetId: asset.id,
      documentAttached: false,
      dueDates: {},
      surplus,
      message: msg,
    };
  }
  const tagged = await client.get<{ data: AssetDocument[] }>(
    `/api/v1/assets/${asset.id}/documents`,
  );
  let assetDocument = tagged.data.find((d) => d.formTemplateId === liveTemplate.id);
  if (!assetDocument) {
    assetDocument = await client.post<AssetDocument>(`/api/v1/assets/${asset.id}/documents`, {
      formTemplateId: liveTemplate.id,
      machineNumber,
    });
    ctx.log(`  POST /assets/${asset.id}/documents -> ${template.documentNumber}`);
  } else {
    ctx.log(`  REUSE document ${assetDocument.id} (${template.documentNumber})`);
  }

  // ---- Step 7: materialise the schedule rules ------------------------------
  const rules = await client.get<ScheduleRule[]>(`/api/v1/assets/${asset.id}/schedule`);
  ctx.log(`  GET /assets/${asset.id}/schedule (${rules.length} rules)`);

  // ---- Step 8: set each planned frequency's next due date -----------------
  for (const [frequency, nextDueOn] of Object.entries(dueDates)) {
    const rule = rules.find(
      (rl) => rl.assetDocumentId === assetDocument!.id && rl.frequency === frequency,
    );
    if (!rule) {
      ctx.log(
        `ERROR   ${row.label} (${row.code}) — no ${frequency} schedule_rule after bootstrap; ` +
          'the form may not define this frequency (should have been caught by `missing`).',
      );
      continue;
    }
    const wantedReason = `${PROVENANCE_PREFIX} (WW${firstWeek[frequency]})`;
    if (rule.adjustedReason && !rule.adjustedReason.startsWith(PROVENANCE_PREFIX)) {
      // A human adjusted this rule since the bootstrap default — never
      // overwrite a deliberate human decision (design doc §7 requirement).
      ctx.log(
        `SKIP    ${row.label} (${row.code}) ${frequency} — already manually adjusted ` +
          `("${rule.adjustedReason}"); migration does not override it.`,
      );
      continue;
    }
    if (rule.nextDueOn === nextDueOn && rule.adjustedReason === wantedReason) {
      ctx.log(`  ${row.code} ${frequency} already ${nextDueOn} — no write needed.`);
      continue;
    }
    // The brief calls this a PATCH; the real endpoint is `PUT
    // /api/v1/assets/{id}/schedule` (`asset-schedule.controller.ts`'s
    // `@Put()`, `ScheduleAdjust`). Used here, not `client.patch`.
    await client.put(`/api/v1/assets/${asset.id}/schedule`, {
      assetDocumentId: assetDocument.id,
      frequency,
      nextDueOn,
      adjustedReason: wantedReason,
    });
    ctx.log(`  PUT /assets/${asset.id}/schedule ${frequency} -> ${nextDueOn}`);
  }

  return {
    label: row.label,
    code: row.code,
    assetTypeCode,
    status: 'imported',
    blocked: surplus.some((s) => s.choice === 'plan'),
    assetId: asset.id,
    documentAttached: true,
    dueDates,
    surplus,
  };
}
