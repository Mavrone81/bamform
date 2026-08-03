/**
 * Slice 13-TL — the template loader (BAMFORM-TLP-001 §6, steps 5/9).
 *
 * Loads the committed intermediate YAML (PR-TLP-08/09 — staging and
 * production load from the IDENTICAL files; this module never reads .xlsx)
 * into a running BamForm instance through the REAL authenticated API:
 *
 *   author (ENGINEER + DOC_CONTROLLER):  POST /templates,
 *     POST /templates/{id}/revisions, PATCH /revisions/{id},
 *     PUT /revisions/{id}/items|measurements, POST /revisions/{id}/submit,
 *     POST /asset-types, POST /assets, GET /assets/{id}/schedule
 *   approver (DOC_CONTROLLER, a DIFFERENT person — INV-03):
 *     POST /auth/step-up + POST /revisions/{id}/approve
 *
 * Revision plan per document (TLP §4.1 "Revision History sheet →
 * template_revision rows"): every HISTORICAL revision becomes a metadata
 * row (empty content — the paper archive holds it, PR-TLP-01) approved in
 * printed order so `sequence_ordinal` is contiguous (INV-02, defect B-02's
 * disposition); the FINAL revision carries the extracted content and ends
 * CURRENT. Doc 4 is CURRENT at revision C — the B-04 correction that created
 * a revision D was withdrawn 2026-08-03.
 *
 * Idempotent: a template whose CURRENT revision already matches the YAML is
 * left completely untouched ('unchanged'); a mismatch produces ONE new
 * corrective revision through the same authoring flow ('updated', PR-TLP-12
 * pre-go-live correction path); a partial previous load is resumed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient, ApiError, type Credentials } from './client';
import type { ParsedDocument } from './model';
import { parseYaml } from './yaml-io';

// ---- API response shapes (subset actually used) ---------------------------

interface FormTemplate {
  id: string;
  documentNumber: string;
  title: string;
  currentRevisionId?: string | null;
}
interface TemplateItemOut {
  itemNo: number;
  frequency: string;
  instruction: string;
  mandatory: boolean;
  stableKey: string;
  displayOrder: number;
}
interface TemplateMeasurementOut {
  section: string | null;
  description: string;
  unit: string | null;
  specType: string;
  lowerLimit: number | null;
  upperLimit: number | null;
  nominal: number | null;
  tolerance: number | null;
  specDisplay: string;
  stableKey: string;
  displayOrder: number;
}
interface TemplateRevision {
  id: string;
  revisionCode: string;
  sequenceOrdinal: number;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'CURRENT' | 'SUPERSEDED' | 'REJECTED';
  standingContent?: Record<string, unknown>;
  items?: TemplateItemOut[];
  measurements?: TemplateMeasurementOut[];
}
interface AssetType {
  id: string;
  code: string;
}
/** Slice 27-ASSETDOC — the tag that routes a machine to a form. */
interface AssetDocument {
  id: string;
  assetId: string;
  formTemplateId: string;
}
interface Asset {
  id: string;
  code: string;
  assetTypeId: string;
  description: string | null;
  codeProvisional: boolean;
}
interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

export interface LoadOptions {
  baseUrl: string;
  author: Credentials;
  approver: Credentials;
  yamlDir: string;
  /** Create provisional SAMPLE machines + materialise their schedule rules. */
  createSampleMachines: boolean;
  /** Anchor date for sample-machine schedules (YYYY-MM-DD). Default: today (UTC). */
  scheduleAnchorDate?: string;
  log?: (line: string) => void;
}

export interface DocumentLoadResult {
  documentNumber: string;
  action: 'created' | 'updated' | 'unchanged' | 'resumed';
  templateId: string;
  currentRevisionId: string;
  assetTypeId: string;
  sampleMachines: { id: string; code: string }[];
}

export interface LoadSummary {
  documents: DocumentLoadResult[];
  created: number;
  updated: number;
  unchanged: number;
  resumed: number;
}

/**
 * Normalise a string the way the API's zod contract does before storing it.
 *
 * Fix-pass (review finding T-1). Several request fields are declared
 * `z.string().trim()` in `shared/src/template.ts` / `shared/src/asset-type.ts`
 * — `revisionCode`, `documentNumber`, `title`, `instruction`, `description`,
 * `specDisplay`, `stableKey`, asset-type `code`/`name` — so what the server
 * STORES can differ from what the YAML HOLDS whenever a value carries edge
 * whitespace. Every resume/idempotency check below compares a local YAML
 * value against a server-stored one, so all of them must compare through
 * this function or they compare unequal forever.
 *
 * The bug this fixes: doc 5's revision code is `'B '` (trailing space,
 * verbatim from the source by design — I-TL-13 asserts it). An interruption
 * inside doc 5's revision plan left a stored `'B'` that never again matched
 * the planned `'B '`, so every re-run refused with "this template was not
 * produced by this loader", wedging doc 5 and every document after it and
 * falsifying the runbook's "re-run the same command" recovery.
 *
 * NOTE this is a comparison-time normalisation only. The YAML and the AC-01
 * evidence keep the verbatim `'B '` (PR-TLP-04); the trimmed form is simply
 * what the contract stores, and V-3/V-13 reviewers should expect that.
 */
const contractTrim = (value: string): string => value.trim();

/** Contract-trimmed string equality (see `contractTrim`). */
const sameUnderContract = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a == null ? a : contractTrim(a)) === (b == null ? b : contractTrim(b));

const SAMPLE_MACHINE_MARKER = 'SAMPLE machine (slice 13-TL)';
/** ASM gets two samples to demonstrate one-template-many-assets (UR-018, TLP §5.1). */
const SAMPLE_MACHINE_COUNT: Record<string, number> = { ASM_WIRE_BOND: 2 };

export async function runLoad(options: LoadOptions): Promise<LoadSummary> {
  const log = options.log ?? (() => undefined);
  const docs = readYamlDir(options.yamlDir);
  log(`Loaded ${docs.length} intermediate YAML documents from ${options.yamlDir}`);

  // ONE login per session (RATE_LIMIT_LOGIN_PER_MIN is 10 by default — a
  // login per document would trip it). Token expiry mid-run is handled by
  // the client's single re-login retry; step-up freshness is handled
  // on-demand at each approval (see approveWithStepUp).
  const author = new ApiClient(options.baseUrl, options.author);
  const approver = new ApiClient(options.baseUrl, options.approver);
  await author.login();
  await approver.login();

  const summary: LoadSummary = { documents: [], created: 0, updated: 0, unchanged: 0, resumed: 0 };
  for (const doc of docs) {
    const result = await loadDocument(doc, author, approver, options, log);
    summary.documents.push(result);
    summary[result.action] += 1;
    log(
      `${doc.documentNumber}: ${result.action} (template ${result.templateId}, ` +
        `current revision ${result.currentRevisionId})`,
    );
  }
  return summary;
}

function readYamlDir(dir: string): ParsedDocument[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  if (files.length === 0) throw new Error(`no .yaml files in ${dir}`);
  return files.map((f) => parseYaml(readFileSync(join(dir, f), 'utf8')));
}

// ---------------------------------------------------------------------------
// Per-document load
// ---------------------------------------------------------------------------

async function loadDocument(
  doc: ParsedDocument,
  author: ApiClient,
  approver: ApiClient,
  options: LoadOptions,
  log: (line: string) => void,
): Promise<DocumentLoadResult> {
  // ---- 1. Template shell -------------------------------------------------
  const templates = await listAll<FormTemplate>(author, '/api/v1/templates');
  let template = templates.find((t) => sameUnderContract(t.documentNumber, doc.documentNumber));
  let action: DocumentLoadResult['action'];
  if (!template) {
    template = await author.post<FormTemplate>('/api/v1/templates', {
      documentNumber: doc.documentNumber,
      title: doc.title,
    });
    action = 'created';
    log(`  POST /templates -> ${template.id}`);
  } else {
    action = 'resumed';
  }

  // ---- 2. Revision plan ---------------------------------------------------
  const planned = buildRevisionPlan(doc);
  const existing = await author.get<TemplateRevision[]>(
    `/api/v1/templates/${template.id}/revisions`,
  );
  // API returns newest-first; work oldest-first.
  const existingAsc = [...existing].sort((a, b) => a.sequenceOrdinal - b.sequenceOrdinal);

  const finalPlanned = planned[planned.length - 1];
  const existingCurrent = existingAsc.find((r) => r.status === 'CURRENT');
  if (
    existingCurrent &&
    sameUnderContract(existingCurrent.revisionCode, finalPlanned.revisionCode) &&
    (await contentMatches(author, existingCurrent.id, doc))
  ) {
    // Fully loaded already — clean no-op (zero writes).
    return finishDocument(doc, template, existingCurrent.id, 'unchanged', author, options, log);
  }

  if (
    existingCurrent &&
    sameUnderContract(existingCurrent.revisionCode, finalPlanned.revisionCode)
  ) {
    // Loaded before, but the YAML changed (pre-go-live correction,
    // PR-TLP-12): ONE corrective revision through the normal flow.
    log(`  content drift vs CURRENT ${existingCurrent.revisionCode} — corrective revision`);
    const revision = await author.post<TemplateRevision>(
      `/api/v1/templates/${template.id}/revisions`,
      {
        revisionCode: finalPlanned.revisionCode,
        changeDescription:
          `Reload from corrected intermediate YAML (PR-TLP-12 pre-go-live correction). ` +
          finalPlanned.changeDescription,
      },
    );
    await putContent(author, revision.id, doc);
    await author.post(`/api/v1/revisions/${revision.id}/submit`);
    await approveWithStepUp(approver, revision.id);
    return finishDocument(doc, template, revision.id, 'updated', author, options, log);
  }

  // Fresh or partial load: walk the plan, resuming wherever it stopped.
  let currentRevisionId = existingCurrent?.id ?? '';
  for (const [index, plan] of planned.entries()) {
    const isFinal = index === planned.length - 1;
    let revision = existingAsc[index];
    if (revision && !sameUnderContract(revision.revisionCode, plan.revisionCode)) {
      throw new Error(
        `${doc.documentNumber}: existing revision at ordinal ${revision.sequenceOrdinal} has ` +
          `code '${revision.revisionCode}' where the plan expects '${plan.revisionCode}' ` +
          `(compared as '${contractTrim(revision.revisionCode)}' vs ` +
          `'${contractTrim(plan.revisionCode)}' — the API stores these trimmed) — ` +
          'this template was not produced by this loader; refusing to touch it (PR-TLP-05 spirit).',
      );
    }
    if (revision && (revision.status === 'CURRENT' || revision.status === 'SUPERSEDED')) {
      currentRevisionId = revision.status === 'CURRENT' ? revision.id : currentRevisionId;
      continue; // already in place
    }
    if (!revision) {
      revision = await author.post<TemplateRevision>(`/api/v1/templates/${template.id}/revisions`, {
        revisionCode: plan.revisionCode,
        changeDescription: plan.changeDescription,
      });
      log(`  revision ${plan.revisionCode}: created (ordinal ${revision.sequenceOrdinal})`);
    } else {
      log(`  revision ${plan.revisionCode}: resuming from status ${revision.status}`);
    }
    if (revision.status === 'REJECTED') {
      throw new Error(
        `${doc.documentNumber}: revision ${plan.revisionCode} is REJECTED — resolve manually.`,
      );
    }
    if (revision.status === 'DRAFT' || !revision.status) {
      if (isFinal) {
        await putContent(author, revision.id, doc);
      } else {
        // Historical metadata row: no content (the paper archive holds it);
        // clone-forward from the previous empty revision is already empty.
        // Guard against a resumed load where content leaked in: wipe.
        await author.put(`/api/v1/revisions/${revision.id}/items`, []);
        await author.put(`/api/v1/revisions/${revision.id}/measurements`, []);
      }
      await author.post(`/api/v1/revisions/${revision.id}/submit`);
    }
    await approveWithStepUp(approver, revision.id);
    currentRevisionId = revision.id;
  }

  return finishDocument(doc, template, currentRevisionId, action, author, options, log);
}

/**
 * Approve, stepping up ONLY when the guard demands it. Login itself stamps
 * `last_authenticated_at`, so within STEP_UP_WINDOW_SECONDS (900 s default)
 * of login no step-up call is needed at all — and POST /auth/step-up is
 * rate-limited (RATE_LIMIT_STEP_UP_PER_MIN, 10/min default), so calling it
 * before every approval would 429 a full 34-revision load.
 */
async function approveWithStepUp(approver: ApiClient, revisionId: string): Promise<void> {
  try {
    await approver.post(`/api/v1/revisions/${revisionId}/approve`);
  } catch (error) {
    const stepUpRequired =
      error instanceof ApiError &&
      error.status === 403 &&
      typeof error.body === 'object' &&
      error.body !== null &&
      (error.body as { type?: string }).type === '/errors/step-up-required';
    if (!stepUpRequired) throw error;
    await approver.stepUp();
    await approver.post(`/api/v1/revisions/${revisionId}/approve`);
  }
}

interface PlannedRevision {
  revisionCode: string;
  changeDescription: string;
}

export function buildRevisionPlan(doc: ParsedDocument): PlannedRevision[] {
  const plan: PlannedRevision[] = [];
  const historyLine = (i: number): string => {
    const h = doc.revisionHistory[i];
    return `${h.date} — ${h.details} | Revised by: ${h.revisedBy} | Approved by: ${h.approvedBy}`;
  };

  const finalIsBeyondHistory =
    doc.revisionHistory.length === 0 ||
    doc.loadRevision.trim() !== doc.revisionHistory[doc.revisionHistory.length - 1].code.trim();
  const metaCount = finalIsBeyondHistory
    ? doc.revisionHistory.length
    : doc.revisionHistory.length - 1;

  for (let i = 0; i < metaCount; i++) {
    plan.push({
      revisionCode: doc.revisionHistory[i].code,
      changeDescription:
        `Historical revision loaded for document-control continuity (BAMFORM-TLP-001 §4.1). ` +
        `Content not digitised — the paper archive holds it (PR-TLP-01). ${historyLine(i)}`,
    });
  }

  const notes = doc.notes.length ? ` | Load notes: ${doc.notes.join(' || ')}` : '';
  if (finalIsBeyondHistory) {
    // A synthetic revision beyond the printed history — e.g. a future
    // client-decided correction with its own `loadRevisionOverride` in
    // DOC_CONFIG. No current document uses this path: doc 4's B-04
    // correction (which once loaded here as a synthetic client revision D)
    // was WITHDRAWN 2026-08-03 — the owner ruled the signed records
    // authoritative (every signed ASM Wire Bond specimen, and cell J66 of
    // the workbook itself, prints "95 - 28 g") — so CE 95 020 00 01 now
    // takes the `else` branch below and ends CURRENT at its printed
    // revision C, same as every other document.
    plan.push({
      revisionCode: doc.loadRevision,
      changeDescription:
        `Loaded from ${doc.sourceFile} (sha256 ${doc.sourceSha256}) per BAMFORM-TLP-001; ` +
        `printed revision ${doc.printedRevision}.${notes}`,
    });
  } else {
    const last = doc.revisionHistory.length - 1;
    plan.push({
      revisionCode: doc.revisionHistory[last].code,
      changeDescription:
        `${historyLine(last)} | Loaded from ${doc.sourceFile} (sha256 ${doc.sourceSha256}) ` +
        `per BAMFORM-TLP-001.${notes}`,
    });
  }
  return plan;
}

function itemsPayload(doc: ParsedDocument): unknown[] {
  return doc.items.map((i) => ({
    itemNo: i.itemNo,
    frequency: i.frequency,
    instruction: i.instruction,
    mandatory: true,
    stableKey: i.stableKey,
    displayOrder: i.displayOrder,
  }));
}

function measurementsPayload(doc: ParsedDocument): unknown[] {
  return doc.measurements.map((m) => ({
    section: m.section,
    description: m.description,
    unit: m.unit,
    specType: m.specType,
    lowerLimit: m.lowerLimit,
    upperLimit: m.upperLimit,
    nominal: m.nominal,
    tolerance: m.tolerance,
    specDisplay: m.specDisplay,
    stableKey: m.stableKey,
    displayOrder: m.displayOrder,
  }));
}

function standingContentPayload(doc: ParsedDocument): Record<string, unknown> {
  const sc = doc.standingContent;
  return {
    specialTools: sc.specialTools,
    partsRequired: sc.partsRequired,
    ppe: sc.ppe,
    safety: sc.safety,
    procedure: sc.procedure,
    remarks: sc.remarks,
    frequencyBanner: doc.frequencyBanner,
    // No cascadeOverride: OI-08 stands unresolved, so the uniform cascade
    // applies to every document (TLP §5.2 disposition).
  };
}

async function putContent(author: ApiClient, revisionId: string, doc: ParsedDocument) {
  await author.patch(`/api/v1/revisions/${revisionId}`, {
    standingContent: standingContentPayload(doc),
  });
  await author.put(`/api/v1/revisions/${revisionId}/items`, itemsPayload(doc));
  await author.put(`/api/v1/revisions/${revisionId}/measurements`, measurementsPayload(doc));
}

/** Deep-compare the CURRENT revision's content against the YAML (read-only). */
async function contentMatches(
  author: ApiClient,
  revisionId: string,
  doc: ParsedDocument,
): Promise<boolean> {
  const revision = await author.get<TemplateRevision>(`/api/v1/revisions/${revisionId}`);
  // Every contract-trimmed field (`instruction`, `stableKey`, `description`,
  // `specDisplay`) is normalised on BOTH sides — see `contractTrim`. Without
  // this, a YAML value with edge whitespace would report drift on every run
  // and author an endless chain of corrective revisions (the same defect
  // class as T-1, with a noisier failure mode). `section`/`unit` are NOT
  // trimmed by the contract, so they compare as stored.
  const itemShape = (i: {
    itemNo: number;
    frequency: string;
    instruction: string;
    mandatory: boolean;
    stableKey: string;
  }) => ({
    itemNo: i.itemNo,
    frequency: i.frequency,
    instruction: contractTrim(i.instruction),
    mandatory: i.mandatory,
    stableKey: contractTrim(i.stableKey),
  });
  const measurementShape = (m: {
    section: string | null;
    description: string;
    unit: string | null;
    specType: string;
    lowerLimit: number | null;
    upperLimit: number | null;
    nominal: number | null;
    tolerance: number | null;
    specDisplay: string;
    stableKey: string;
  }) => ({
    section: m.section,
    description: contractTrim(m.description),
    unit: m.unit,
    specType: m.specType,
    lowerLimit: m.lowerLimit,
    upperLimit: m.upperLimit,
    nominal: m.nominal,
    tolerance: m.tolerance,
    specDisplay: contractTrim(m.specDisplay),
    stableKey: contractTrim(m.stableKey),
  });

  const wantItems = doc.items.map((i) => itemShape({ ...i, mandatory: true }));
  const gotItems = (revision.items ?? []).map(itemShape);
  const wantMeasurements = doc.measurements.map(measurementShape);
  const gotMeasurements = (revision.measurements ?? []).map(measurementShape);
  const sc = (revision.standingContent ?? {}) as Record<string, unknown>;
  const wantSc = standingContentPayload(doc);
  const scMatches = Object.entries(wantSc).every(
    ([key, value]) => JSON.stringify(sc[key] ?? null) === JSON.stringify(value ?? null),
  );
  return (
    scMatches &&
    JSON.stringify(wantItems) === JSON.stringify(gotItems) &&
    JSON.stringify(wantMeasurements) === JSON.stringify(gotMeasurements)
  );
}

// ---------------------------------------------------------------------------
// Asset type + sample machines + schedules
// ---------------------------------------------------------------------------

async function finishDocument(
  doc: ParsedDocument,
  template: FormTemplate,
  currentRevisionId: string,
  action: DocumentLoadResult['action'],
  author: ApiClient,
  options: LoadOptions,
  log: (line: string) => void,
): Promise<DocumentLoadResult> {
  // Machine family (approval route + lead time).
  //
  // Slice 27-ASSETDOC: this is NO LONGER 1:1 with the template. `asset_type`
  // used to carry `form_template_id UNIQUE`, so the loader had to mint an
  // asset type per document purely to have somewhere to hang the template —
  // which is why production ended up with 12 asset types for 12 documents and
  // 1 real machine. An asset type is now only the machine-family grouping, and
  // the document is tagged to each MACHINE below. The
  // "governs a different template" guard is gone with the column it checked.
  const assetTypes = await listAll<AssetType>(author, '/api/v1/asset-types');
  // `assetTypeCreateSchema.code` is contract-trimmed too (T-1's class).
  let assetType = assetTypes.find((t) => sameUnderContract(t.code, doc.assetTypeCode));
  if (!assetType) {
    const routes = await author.get<{ id: string; code: string }[]>('/api/v1/approval-routes');
    if (routes.length === 0) throw new Error('no approval routes seeded (PR-DBD-09 violated?)');
    const route = routes.find((r) => r.code === 'TWO_STAGE_TL_THEN_ENG') ?? routes[0];
    assetType = await author.post<AssetType>('/api/v1/asset-types', {
      code: doc.assetTypeCode,
      name: doc.assetTypeName,
      description: `Loaded by BAMFORM-TLP-001 tooling for ${doc.documentNumber}.`,
      approvalRouteId: route.id,
    });
    log(`  POST /asset-types ${doc.assetTypeCode} -> ${assetType.id}`);
  }

  // Sample machines (decision 2026-07-27: clearly-sample set, left
  // provisional/RED; B-09 — NEVER a bulk auto-seed of real machines).
  const sampleMachines: { id: string; code: string }[] = [];
  if (options.createSampleMachines) {
    const existing = await listAll<Asset>(
      author,
      `/api/v1/assets?assetTypeId=${assetType.id}&limit=100`,
    );
    const samples = existing.filter(
      (a) => a.codeProvisional && (a.description ?? '').includes(SAMPLE_MACHINE_MARKER),
    );
    const want = SAMPLE_MACHINE_COUNT[doc.assetTypeCode] ?? 1;
    sampleMachines.push(...samples.map((a) => ({ id: a.id, code: a.code })));
    for (let i = samples.length; i < want; i++) {
      const anchor = options.scheduleAnchorDate ?? new Date().toISOString().slice(0, 10);
      const created = await author.post<Asset>('/api/v1/assets', {
        // No `code` — the server issues a provisional PROV-XXXXXXXX code and
        // codeProvisional=true (RED in the admin UI), impossible to mistake
        // for a real plant code (machine-code.ts, B-09).
        assetTypeId: assetType.id,
        description:
          `${SAMPLE_MACHINE_MARKER} for ${doc.documentNumber} — NOT a real asset; ` +
          'replace via the admin UI when the client supplies the real machine list (B-09/DP-03).',
        scheduleAnchorDate: anchor,
      });
      sampleMachines.push({ id: created.id, code: created.code });
      log(`  POST /assets (sample) -> ${created.code}`);
    }
    // Slice 27-ASSETDOC — tag the document to each sample machine. This is
    // what the schedule bootstrap now reads (it iterates asset_document rows,
    // not assets), so it MUST happen before the schedule GET below.
    // Idempotent by re-check rather than by swallowing the 409, so a real
    // conflict still surfaces.
    for (const machine of sampleMachines) {
      const tagged = await author.get<{ data: AssetDocument[] }>(
        `/api/v1/assets/${machine.id}/documents`,
      );
      if (!tagged.data.some((d) => d.formTemplateId === template.id)) {
        await author.post<AssetDocument>(`/api/v1/assets/${machine.id}/documents`, {
          formTemplateId: template.id,
        });
        log(`  POST /assets/${machine.code}/documents -> ${doc.documentNumber}`);
      }
    }
    // Materialise schedule rules for every sample machine — the lazy
    // bootstrap runs on first read (schedule-rule-bootstrap.service.ts).
    for (const machine of sampleMachines) {
      await author.get(`/api/v1/assets/${machine.id}/schedule`);
    }
  }

  return {
    documentNumber: doc.documentNumber,
    action,
    templateId: template.id,
    currentRevisionId,
    assetTypeId: assetType.id,
    sampleMachines,
  };
}

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
