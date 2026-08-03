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
 * SURPLUS (Task 3 §6 — the form defines a frequency the plan does not
 * schedule) means the MACHINE ONLY is created. An earlier draft of this
 * module attached the document as normal and relied on skipping
 * `GET /assets/{id}/schedule` to keep the schedule blank — a whole-branch
 * review found that premise FALSE (attaching the document is enough on its
 * own; the GET was never load-bearing), and the owner then ruled 2026-08-03:
 * "create the machine only; do not attach the PM document."
 * `SchedulerService`'s sweep (`scheduler.service.ts:44`)
 * calls `ScheduleRuleBootstrapService.ensureForAllActiveAssets()` at the
 * start of EVERY sweep (hourly; `SCHEDULER_ENABLED` defaults true), and that
 * bootstrap (`schedule-rule-bootstrap.service.ts:58-66`) iterates every
 * `active` document on every `active` asset and creates one `schedule_rule`
 * row per template frequency — the surplus one included — dated
 * `asset.scheduleAnchorDate`. So attaching the document, even without this
 * module ever calling the schedule GET itself, would still get a FULL
 * schedule materialised by the next sweep, dated in the past, immediately
 * raising jobs. The only way to leave a machine genuinely unplanned is to
 * leave it WITHOUT a document at all: with no active `asset_document` on it,
 * the bootstrap sweep has nothing to iterate for this asset, so no
 * `schedule_rule` rows are ever created. So for a machine with any
 * `surplus`, this module creates the machine and STOPS — no document POST,
 * no schedule GET, no schedule PUT. It shows up in the planner as unplanned;
 * a human (a planner) attaches the correct document and sets the dates from
 * there. No API change, no invented write, no conflict prompt (dropped from
 * this slice — see the plan's "Decisions since this plan was drafted").
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
 *
 * MACHINE NUMBER is never computed or sent here. Eight of the twelve PM
 * forms carry a blank in their title (`ED____`, `KW___`, etc.) that an
 * earlier version of this module filled in on the caller's behalf
 * (`mapping.ts`'s now-deleted `machineNumberFor`). Owner ruling: that blank
 * is filled BY HAND by the technician when they complete the paper record —
 * confirmed by a signed specimen (`April 2026/ED01.pdf` shows `01`
 * handwritten into `ED____`) — not decided by this migration. `POST
 * /assets/{id}/documents` is called below with no `machineNumber` field at
 * all; the API defaults an omitted `machineNumber` to `null` exactly as it
 * would for an explicit `null` (`asset-documents.service.ts`'s `dto.
 * machineNumber ?? null`), so omitting it is a deliberate, not merely
 * convenient, choice — it says nothing was computed, rather than asserting
 * a value of nothing. See `evidence.ts` and `docs/DEPLOYMENT_RUNBOOK.md`
 * §3.6 for what this means for a printed record today.
 */
import { ApiClient, type Credentials } from '../client';
import { SKIPPED_LABELS, workWeekToDate } from './mapping';
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
  /**
   * Whole-branch review finding I4: `GET /assets/{id}/schedule` already
   * returns this (`asset-schedule.service.ts`'s `toDto`), but it was never
   * declared here, so a re-run had no way to see it. `completion-cascade.
   * service.ts` sets this and advances `nextDueOn` when a PM is completed
   * and verified — WITHOUT touching `adjustedReason` — so a rule can carry
   * this migration's own `PROVENANCE_PREFIX` in `adjustedReason` (the
   * human-adjustment guard below doesn't fire) while `lastCompletedOn` is
   * the only signal that real maintenance has since happened against it.
   */
  lastCompletedOn: string | null;
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
  log?: (line: string) => void;
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
  /** False exactly when `leftUnplanned` (surplus decision, owner ruling
   *  2026-08-03 following a whole-branch review): no document is attached
   *  for a surplus row, precisely because attaching one would let the
   *  scheduler's bootstrap sweep materialise a full schedule for it on the
   *  next sweep — see the file header. True otherwise. */
  documentAttached: boolean;
  /** True when the machine was deliberately left with NO document and
   *  therefore no schedule (`surplus` non-empty) — see the file header for
   *  why a document, not just the schedule GET, has to be withheld. Not
   *  `blocked`: this is the intended owner-decided outcome, not a gap. */
  leftUnplanned: boolean;
  /** frequency -> nextDueOn actually planned (or, under dry run, computed).
   *  Empty when `leftUnplanned`. */
  dueDates: Record<string, string>;
  /** frequency -> the FIRST planned WORK WEEK (the masterlist's own unit —
   *  see `mapping.ts`'s `workWeekToDate`) that produced the matching entry
   *  in `dueDates`. Added for Task 6's evidence file: the paper masterlist
   *  is written in work weeks, not ISO dates, so carrying this through lets
   *  the owner cross-check a row directly instead of converting every date
   *  by hand. Same keys as `dueDates`; empty when `leftUnplanned`. */
  dueWeeks: Record<string, number>;
  /** Frequencies the form defines beyond the plan (Task 3's `surplus`) —
   *  informational; non-empty exactly when `leftUnplanned`. */
  surplus: string[];
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
    leftUnplanned: number;
  };
}

interface Ctx {
  client: ApiClient | null;
  dryRun: boolean;
  year: number;
  log: (line: string) => void;
  templates: Record<string, ImportTemplateRef>;
  // Populated once per run, live mode only.
  assetTypes: AssetType[];
  liveTemplates: FormTemplate[];
  assetsByType: Map<string, Asset[]>;
  allAssets: Asset[] | null;
}

export async function runImport(options: ImportOptions): Promise<ImportReport> {
  const log = options.log ?? (() => undefined);
  const dryRun = options.apply !== true;

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

  const counts = {
    skipped: 0,
    unmapped: 0,
    hardError: 0,
    imported: 0,
    blocked: 0,
    leftUnplanned: 0,
  };
  for (const m of machines) {
    if (m.status === 'skipped') counts.skipped += 1;
    else if (m.status === 'unmapped') counts.unmapped += 1;
    else if (m.status === 'hard-error') counts.hardError += 1;
    else counts.imported += 1;
    if (m.blocked) counts.blocked += 1;
    if (m.leftUnplanned) counts.leftUnplanned += 1;
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
      leftUnplanned: false,
      dueDates: {},
      dueWeeks: {},
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
      leftUnplanned: false,
      dueDates: {},
      dueWeeks: {},
      surplus: [],
      message: msg,
    };
  }

  return processMapped(r, ctx);
}

/**
 * `assetTypeCode === null`. `POST /api/v1/assets` requires `assetTypeId` —
 * there is no "no family yet" bucket — so this importer can only ever REUSE
 * an asset that already carries this code; it must never invent an asset
 * type to satisfy the schema, which is exactly the kind of guess the brief
 * forbids. If no such asset exists yet, the row is recorded `blocked`, not
 * silently created under a wrong family.
 *
 * As of fix round 1 (owner decision 2026-08-03), `MS-620 ST01` — this
 * path's only real-fixture example — is no longer unmapped (`mapping.ts` now
 * maps it to `MB_E_TEST`), so this function is unreachable for the current
 * 77-row fixture. Left in place as the correct defensive behaviour for any
 * future genuinely-unmapped row.
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
      leftUnplanned: false,
      dueDates: {},
      dueWeeks: {},
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
      leftUnplanned: false,
      dueDates: {},
      dueWeeks: {},
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
    leftUnplanned: false,
    dueDates: {},
    dueWeeks: {},
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
      leftUnplanned: false,
      dueDates: {},
      dueWeeks: {},
      surplus: [],
      message: msg,
    };
  }

  const dueDates = plannedDueDates(row.visits, ctx.year);
  const firstWeek = firstPlannedWeek(row.visits);
  const anchorDate = Object.values(dueDates).sort()[0];

  // Owner decision 2026-08-03, following a whole-branch review: a surplus
  // frequency means the MACHINE ONLY is created for a planner — not
  // resolved at migration time. No conflict prompt, no callback. The
  // document is deliberately NOT attached (see the file header for why the
  // earlier "attach it, just skip the schedule GET" approach was wrong), so
  // no schedule_rule rows can ever materialise for this machine until a
  // planner attaches one.
  const leaveUnplanned = r.surplus.length > 0;

  if (ctx.dryRun) {
    if (leaveUnplanned) {
      ctx.log(
        `DRY     ${row.label} (${row.code}) -> ${assetTypeCode} / ${template.documentNumber} — ` +
          `would GET/POST /api/v1/assets (code=${row.code}, scheduleAnchorDate=${anchorDate}), ` +
          `then STOP — surplus (${r.surplus.join(', ')}) means NO document is attached (a ` +
          `planner will need to attach ${template.documentNumber}) and no /assets/{id}/schedule ` +
          'GET/PUT is made; left unplanned for a planner.',
      );
    } else {
      ctx.log(
        `DRY     ${row.label} (${row.code}) -> ${assetTypeCode} / ${template.documentNumber} — ` +
          `would GET/POST /api/v1/assets (code=${row.code}, scheduleAnchorDate=${anchorDate}), ` +
          'GET/POST /assets/{id}/documents (no machineNumber — the technician fills that in ' +
          'by hand on the printed record), GET /assets/{id}/schedule, then PUT it per frequency: ' +
          Object.entries(dueDates)
            .map(([f, d]) => `${f}=${d} (WW${firstWeek[f]})`)
            .join(', '),
      );
    }
    return {
      label: row.label,
      code: row.code,
      assetTypeCode,
      status: 'imported',
      blocked: false,
      documentAttached: !leaveUnplanned,
      leftUnplanned: leaveUnplanned,
      dueDates: leaveUnplanned ? {} : dueDates,
      dueWeeks: leaveUnplanned ? {} : firstWeek,
      surplus: leaveUnplanned ? [...r.surplus] : [],
      message: leaveUnplanned
        ? `machine created only, no document attached (surplus: ${r.surplus.join(', ')}); a ` +
          `planner must attach ${template.documentNumber} and set the dates`
        : undefined,
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
      leftUnplanned: false,
      dueDates: {},
      dueWeeks: {},
      surplus: [],
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
    // Logged BEFORE the await, not after (review fix round 2, IMPORTANT):
    // if the process dies while this call is in flight, the CLI's mid-run
    // failure handler must be able to see that a write was ATTEMPTED even
    // though it never got the chance to log completion — a network failure
    // mid-write is exactly the case the operator most needs to be warned
    // about, not the case most likely to be silently miscounted as "safe".
    ctx.log(`  WRITE POST /assets code=${row.code} — attempting`);
    asset = await client.post<Asset>('/api/v1/assets', {
      code: row.code,
      assetTypeId: assetType.id,
      description: row.model,
      scheduleAnchorDate: anchorDate,
    });
    assetsOfType.push(asset);
    ctx.log(`  WRITE POST /assets code=${row.code} -> ${asset.id} — done`);
  } else {
    ctx.log(`  REUSE asset ${asset.id} (code=${row.code})`);
  }

  // ---- Verify the template exists in this environment ---------------------
  // Moved ahead of the surplus early return below (review finding M1): a
  // surplus row is carried by exactly one machine for two templates in this
  // masterlist (`CE 95 043 00 01`, `CE 95 012 00 01`), so if either template
  // is missing here, skipping this check for a surplus row would report
  // `hardError 0` and the evidence file would cheerfully tell a planner to
  // attach a document that does not exist. Checked for EVERY row now, surplus
  // or not, before either return below.
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
      leftUnplanned: false,
      dueDates: {},
      dueWeeks: {},
      surplus: [],
      message: msg,
    };
  }

  // ---- Surplus: create the machine only; no document is attached ----------
  // Owner decision 2026-08-03, following a whole-branch review: attaching
  // the document here would let the scheduler's bootstrap sweep
  // (`schedule-rule-bootstrap.service.ts`, called from every
  // `SchedulerService` sweep) materialise a FULL schedule for this machine
  // — the surplus frequency the owner reserved for a planner included —
  // within the hour, dated in the past. The only way to leave a machine
  // genuinely unplanned is to leave it with NO active document at all, so
  // this module stops HERE: no document POST, no schedule GET, no schedule
  // PUT. See the file header for the full reasoning (this replaces an
  // earlier, incorrect version of this comment that claimed skipping the
  // schedule GET alone was sufficient).
  if (leaveUnplanned) {
    ctx.log(
      `NOTE    ${row.label} (${row.code}) — surplus (${r.surplus.join(', ')}): machine created, ` +
        `NO document attached (a planner must attach ${template.documentNumber} and set the ` +
        'dates) — no schedule_rule rows exist for it. A planner decides.',
    );
    return {
      label: row.label,
      code: row.code,
      assetTypeCode,
      status: 'imported',
      blocked: false,
      assetId: asset.id,
      documentAttached: false,
      leftUnplanned: true,
      dueDates: {},
      dueWeeks: {},
      surplus: [...r.surplus],
      message:
        `machine created only, no document attached (surplus: ${r.surplus.join(', ')}); a ` +
        `planner must attach ${template.documentNumber} and set the dates`,
    };
  }

  // ---- Step 6: attach the document idempotently by re-check ---------------
  const tagged = await client.get<{ data: AssetDocument[] }>(
    `/api/v1/assets/${asset.id}/documents`,
  );
  let assetDocument = tagged.data.find((d) => d.formTemplateId === liveTemplate.id);
  if (!assetDocument) {
    ctx.log(`  WRITE POST /assets/${asset.id}/documents (${template.documentNumber}) — attempting`);
    assetDocument = await client.post<AssetDocument>(`/api/v1/assets/${asset.id}/documents`, {
      formTemplateId: liveTemplate.id,
    });
    ctx.log(`  WRITE POST /assets/${asset.id}/documents -> ${template.documentNumber} — done`);
  } else {
    ctx.log(`  REUSE document ${assetDocument.id} (${template.documentNumber})`);
  }

  // ---- Step 7: materialise the schedule rules ------------------------------
  // Only reached for a non-surplus row — a surplus row already returned
  // above, before the document was even attached (see that block's comment
  // for why). This GET is NOT a pure read (review fix round 2, IMPORTANT
  // part 2): it lazily materialises the bootstrap `schedule_rule` rows on
  // the server (`schedule-rule-bootstrap.service`) as a side effect of being
  // called — exactly the effect the surplus branch above exists to avoid by
  // withholding the document entirely. Tagged WRITE/attempting/done like the
  // POST/PUT calls so a mid-run failure handler counts it as state-changing,
  // not as a safe no-op read.
  ctx.log(`  WRITE GET /assets/${asset.id}/schedule (materialises bootstrap rules) — attempting`);
  const rules = await client.get<ScheduleRule[]>(`/api/v1/assets/${asset.id}/schedule`);
  ctx.log(`  WRITE GET /assets/${asset.id}/schedule (${rules.length} rules) — done`);

  // ---- Step 8: set each planned frequency's next due date -----------------
  for (const [frequency, nextDueOn] of Object.entries(dueDates)) {
    const rule = rules.find(
      (rl) => rl.assetDocumentId === assetDocument!.id && rl.frequency === frequency,
    );
    if (!rule) {
      // INDENTED deliberately (review fix round 2, MINOR): this fires PER
      // FREQUENCY inside a loop, up to 4 times for one machine, so it is
      // NOT a row-final-outcome line like the unindented ERROR/SKIP/BLOCK
      // lines elsewhere in this module — a mid-run failure handler counting
      // unindented lines as "rows processed" must not mistake several of
      // these for several machines.
      ctx.log(
        `  ERROR ${row.label} (${row.code}) — no ${frequency} schedule_rule after bootstrap; ` +
          'the form may not define this frequency (should have been caught by `missing`).',
      );
      continue;
    }
    const wantedReason = `${PROVENANCE_PREFIX} (WW${firstWeek[frequency]})`;
    if (rule.lastCompletedOn) {
      // Whole-branch review finding I4: a completed-and-verified PM advances
      // `nextDueOn`/`lastCompletedOn` (`completion-cascade.service.ts`) but
      // never touches `adjustedReason` — so on a re-run, `adjustedReason`
      // can still carry THIS migration's own `PROVENANCE_PREFIX`, and the
      // human-adjustment guard just below would not fire. Left unguarded,
      // a re-run PUTs the original migration date back over the advanced
      // one, and the next scheduler sweep raises a duplicate overdue job
      // for maintenance that was just signed off. Treat ANY non-null
      // `lastCompletedOn` exactly like a human adjustment: never overwrite,
      // regardless of what `adjustedReason` says. INDENTED for the same
      // per-frequency reason as the ERROR/SKIP cases here.
      ctx.log(
        `  SKIP ${row.label} (${row.code}) ${frequency} — already completed ` +
          `(lastCompletedOn ${rule.lastCompletedOn}); migration does not rewind a signed-off PM.`,
      );
      continue;
    }
    if (rule.adjustedReason && !rule.adjustedReason.startsWith(PROVENANCE_PREFIX)) {
      // A human adjusted this rule since the bootstrap default — never
      // overwrite a deliberate human decision (design doc §7 requirement).
      // INDENTED for the same per-frequency reason as the ERROR case above.
      ctx.log(
        `  SKIP ${row.label} (${row.code}) ${frequency} — already manually adjusted ` +
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
    // `@Put()`, `ScheduleAdjust`). Used here, not `client.patch`. Logged
    // before/after like the other writes above (review fix round 2).
    ctx.log(`  WRITE PUT /assets/${asset.id}/schedule ${frequency} -> ${nextDueOn} — attempting`);
    await client.put(`/api/v1/assets/${asset.id}/schedule`, {
      assetDocumentId: assetDocument.id,
      frequency,
      nextDueOn,
      adjustedReason: wantedReason,
    });
    ctx.log(`  WRITE PUT /assets/${asset.id}/schedule ${frequency} -> ${nextDueOn} — done`);
  }

  return {
    label: row.label,
    code: row.code,
    assetTypeCode,
    status: 'imported',
    blocked: false,
    assetId: asset.id,
    documentAttached: true,
    leftUnplanned: false,
    dueDates,
    dueWeeks: firstWeek,
    surplus: [],
  };
}
