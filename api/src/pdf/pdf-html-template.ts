/**
 * PR-116/117/118, UR-056/057 — the HTML template rendered to PDF via
 * headless Chromium (`pdf-render.service.ts`). Deliberately a pure,
 * Prisma/Puppeteer-independent function of a plain input shape (mirrors
 * `canonical-job-record.ts`'s own "stay directly unit-testable" convention)
 * so layout/escaping can be asserted without a real browser or database.
 *
 * PR-116's required blocks: header (title/document number/revision/page),
 * frequency banner, tools/parts/PPE/safety blocks, the numbered checklist,
 * the measurement table, the signature block (UR-057: name/role/timestamp
 * per signature), and the Remarks footer. PR-118: the page footer ALSO
 * carries the record id and integrity digest.
 *
 * SECURITY_ARCHITECTURE.md §8 ("PDF rendering... template variables
 * escaped — a remark field must not be able to inject markup into a
 * rendered record"): every piece of user-authored text is passed through
 * `escapeHtml` before interpolation; only the drawn-signature `<img>` `src`
 * is trusted, and only because it is base64 bytes decrypted server-side
 * (`pdf-render.service.ts`), never a caller-supplied string.
 */

export interface PdfSignatureInput {
  approvalStepId: string;
  stageOrdinal: number;
  action: string;
  actorName: string;
  actorRoleCode: string;
  actedAt: string;
  onBehalfOfName?: string | null;
  reason?: string | null;
  /** Decrypted base64 PNG (no data-URL prefix) — `null` for actions that never capture one (return/recall/void). */
  drawnSignatureBase64?: string | null;
  /**
   * Slice 26-TWOSTAGE M1 — `approval_step.stage_label`: the configured stage
   * caption as it read when this signature was taken. `null`/absent for
   * actions that are not a verification signature, and for rows written
   * before the column existed.
   */
  stageLabel?: string | null;
}

export interface PdfChecklistItemInput {
  itemNo: number;
  /** `'M1' | 'M3' | 'M6' | 'Y'` — printed in the sheet's Freq column (column B of the workbook). */
  frequency: string;
  /**
   * False when the row's frequency is outside this visit's scope — a Y item on
   * a 6M visit. Such rows still PRINT, still numbered: the sheet stays whole
   * and only the cell is closed.
   */
  inScope: boolean;
  instruction: string;
  status: string;
  remark: string | null;
}

export interface PdfMeasurementInput {
  description: string;
  unit: string | null;
  specDisplay: string;
  reading: string | null;
  judgement: string;
  remark: string | null;
}

export interface PdfPartUsedInput {
  partNo: string | null;
  description: string;
  quantity: string;
  remarks: string | null;
}

export interface PdfAttachmentInput {
  originalFilename: string | null;
  contentType: string;
}

export interface PdfStandingContentInput {
  specialTools?: string | null;
  partsRequired?: Array<{ partNo?: string; description?: string; qty?: string; remarks?: string }>;
  ppe?: string[];
  safety?: string | null;
  procedure?: string | null;
  remarks?: string | null;
  /** The form's printed banner, verbatim. Absent for forms loaded before Task 1. */
  frequencyBanner?: string | null;
}

/**
 * Slice 17-VOID — the void ANNOTATION, rendered as a diagonal watermark, a
 * banner and a footer line. `null` for a live record. The record content
 * below it is the untouched double-signed record (the annotation never
 * modifies it); the PDF must therefore SAY the record is void while still
 * showing the intact content — truth in both directions.
 */
export interface PdfVoidNoticeInput {
  reason: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
}

export interface PdfRecordInput {
  recordId: string;
  jobNumber: string;
  documentNumber: string;
  documentTitle: string;
  revisionCode: string;
  assetCode: string;
  /** The machine this record covers. One record is one machine — printed in the header. */
  machineCode: string;
  assetDescription: string | null;
  frequency: string;
  /** Every frequency in scope for this visit, e.g. `['M3','M6']` for a 6M. */
  frequencyScope: string[];
  dueOn: string;
  status: string;
  standingContent: PdfStandingContentInput;
  checklist: PdfChecklistItemInput[];
  measurements: PdfMeasurementInput[];
  partsUsed: PdfPartUsedInput[];
  attachments: PdfAttachmentInput[];
  signatures: PdfSignatureInput[];
  /** Slice 17-VOID — present only for a VOIDED record. */
  voidNotice?: PdfVoidNoticeInput | null;
  footer: {
    recordId: string;
    /** `approval_step.content_hash`, hex-encoded — PR-118 (see `job-include.ts#latestApprovalStep`). */
    integrityDigestHex: string;
    renderedAt: string;
  };
}

/**
 * Whether a checklist row applies to this visit. A Y row on a 6M visit is out
 * of scope: it still PRINTS, still numbered, but its cell is closed.
 * `job.frequency_scope` already carries the cascade — a Y visit arrives as
 * `['M3','M6','Y']` — so for a scheduled job plain membership is the rule.
 *
 * Two special cases, and they are NOT the same thing:
 *
 *  - An EMPTY `scope` is an AD-HOC job. `frequency_scope` is deliberately
 *    empty there so the job advances no schedule rule (see
 *    `adhoc-job.service.ts`: "THE EMPTY SCOPE IS THE WHOLE POINT"). That is a
 *    scheduling device, not a statement about which checklist items apply —
 *    reading it as "nothing applies" printed every row of an ad-hoc record
 *    closed. Owner ruling 2026-08-01: on an ad-hoc job every item is in scope.
 *
 *  - An EMPTY `frequency` is the orphaned-row sentinel, set when a row's
 *    template item was soft-removed from the revision. It fails closed
 *    ALWAYS, including on an ad-hoc job — an unresolvable row must never
 *    print as work that was expected.
 */
export function itemInScope(frequency: string, scope: readonly string[]): boolean {
  if (frequency === '') return false;
  if (scope.length === 0) return true;
  return scope.includes(frequency);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function esc(value: string | null | undefined): string {
  return value ? escapeHtml(value) : '';
}

/**
 * The sheet's frequency band. The banner is printed VERBATIM and split on its
 * "(3M)"-style tokens so each option can be marked or greyed; a token is
 * "on" when its code is in this visit's scope.
 *
 * Falls back to rendering the scope codes alone when no banner was loaded —
 * forms loaded before the banner was persisted must still print a band.
 */
function renderFrequencyBand(banner: string | null | undefined, scope: string[]): string {
  const codeOf = (token: string): string | null => {
    const m = /\(([0-9]+M|Y)\)/i.exec(token);
    if (!m) return null;
    const raw = m[1].toUpperCase();
    return raw === 'Y' ? 'Y' : `M${raw.replace('M', '')}`;
  };

  if (!banner) {
    const spans = scope
      .map((f) => `<span class="on">${esc(f === 'Y' ? 'Y' : f.replace('M', '') + 'M')}</span>`)
      .join(' &nbsp; ');
    return `<div class="p-band">${spans}</div>`;
  }

  // Split before each "Monthly (3M)"-style group: the code marks the end of one.
  const tokens = banner.split(/(?<=\))\s+/).filter((t) => t.trim() !== '');
  const spans = tokens
    .map((token) => {
      const code = codeOf(token);
      const on = code !== null && scope.includes(code);
      return `<span class="${on ? 'on' : 'off'}">${esc(token.trim())}</span>`;
    })
    .join(' &nbsp; ');
  return `<div class="p-band">${spans}</div>`;
}

function renderPartsRequired(parts: PdfStandingContentInput['partsRequired']): string {
  if (!parts || parts.length === 0) return '<p class="muted">None specified.</p>';
  const rows = parts
    .map(
      (p) =>
        `<tr><td>${esc(p.partNo)}</td><td>${esc(p.description)}</td><td>${esc(p.qty)}</td><td>${esc(p.remarks)}</td></tr>`,
    )
    .join('');
  return `<table class="parts-required"><thead><tr><th>Part No.</th><th>Description</th><th>Qty</th><th>Remarks</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** `NOT_APPLICABLE` prints as `N/A`, `NOT_DONE` as `NOT DONE` — the sheet's own words. */
function statusWord(status: string): string {
  if (status === 'NOT_APPLICABLE') return 'N/A';
  if (status === 'NOT_DONE') return 'NOT DONE';
  return status;
}

/**
 * The coarsest frequency in scope, for the "Not in scope (6M)" reason.
 *
 * An empty scope returns `''` and the caller must omit the parenthesised
 * reason entirely. It should be unreachable — an ad-hoc job (empty scope)
 * puts every real-frequency row in scope via `itemInScope`, so no row prints
 * a reason — but the naive form returned a bare `"M"`, which matches none of
 * the sheet's labels and reads as a rendering defect on a controlled record.
 * Guarded rather than trusted.
 */
function scopeLabel(scope: string[]): string {
  if (scope.length === 0) return '';
  const order = ['M1', 'M3', 'M6', 'Y'];
  const widest = [...scope].sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? '';
  return widest === 'Y' ? 'Y' : widest.replace('M', '') + 'M';
}

/** "Not in scope (6M)" — or bare "Not in scope" when `scopeLabel` has nothing to say. */
function notInScopeReason(scope: string[]): string {
  const label = scopeLabel(scope);
  return label === '' ? 'Not in scope' : `Not in scope (${esc(label)})`;
}

/**
 * Assembly service ruling: a checklist row whose template item was
 * soft-removed from the revision arrives with `frequency === ''` — the
 * correct fail-closed sentinel for `itemInScope` (it can never be a scope
 * member). But a bare blank cell is visually indistinguishable from a
 * rendering defect if a viewer doesn't also read the instruction column, so
 * the Freq column prints a visible placeholder instead of nothing.
 */
function freqCell(frequency: string): string {
  return frequency === '' ? '—' : esc(frequency);
}

function renderChecklist(items: PdfChecklistItemInput[], scope: string[]): string {
  if (items.length === 0) return '<p class="muted">No checklist items.</p>';
  const rows = items
    .map((item) => {
      if (!item.inScope) {
        return `<tr class="p-out"><td class="p-no">${item.itemNo}</td><td class="p-fq">${freqCell(item.frequency)}</td><td>${esc(item.instruction)}</td><td class="c">—</td><td>${notInScopeReason(scope)}</td></tr>`;
      }
      const cls = item.status === 'NOT_DONE' ? 'c fail-ink' : 'c';
      return `<tr><td class="p-no">${item.itemNo}</td><td class="p-fq">${freqCell(item.frequency)}</td><td>${esc(item.instruction)}</td><td class="${cls}">${esc(statusWord(item.status))}</td><td>${esc(item.remark)}</td></tr>`;
    })
    .join('');
  return `<table class="p"><thead><tr><th class="p-no">No</th><th class="p-fq">Freq</th><th class="l">Maintenance Instruction</th><th class="p-st">Status</th><th class="l">Remark</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMeasurements(rows: PdfMeasurementInput[]): string {
  if (rows.length === 0) return '<p class="muted">No measurements.</p>';
  const body = rows
    .map((m) => {
      const reading =
        m.reading === null || m.reading === ''
          ? '—'
          : `${esc(m.reading)}${m.unit ? ` ${esc(m.unit)}` : ''}`;
      const cls = m.judgement === 'FAIL' ? 'c fail-ink' : 'c';
      return `<tr><td>${esc(m.description)}</td><td class="p-sp">${esc(m.specDisplay)}</td><td class="c">${reading}</td><td class="${cls}">${esc(m.judgement)}</td><td>${esc(m.remark)}</td></tr>`;
    })
    .join('');
  return `<div class="p-sect">Measurement Records</div>
  <table class="p"><thead><tr><th class="l">Description</th><th class="p-sp">Specification</th><th class="p-mk">Reading</th><th class="p-mk">Result</th><th class="l">Remark</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderParts(parts: PdfPartUsedInput[]): string {
  if (parts.length === 0) return '<p class="muted">No parts used.</p>';
  const body = parts
    .map(
      (p) =>
        `<tr><td>${esc(p.partNo)}</td><td>${esc(p.description)}</td><td>${esc(p.quantity)}</td><td>${esc(p.remarks)}</td></tr>`,
    )
    .join('');
  return `<table class="parts-used"><thead><tr><th>Part No.</th><th>Description</th><th>Qty</th><th>Remarks</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderAttachments(attachments: PdfAttachmentInput[]): string {
  if (attachments.length === 0) return '<p class="muted">No attachments.</p>';
  const items = attachments
    .map((a) => `<li>${esc(a.originalFilename ?? '(unnamed)')} — ${esc(a.contentType)}</li>`)
    .join('');
  return `<ul class="attachments">${items}</ul>`;
}

/** Slice 17-VOID — "RECORD VOID: <reason> (voided <at> by <name>)", shared by the banner and the footer line. */
function voidLine(notice: PdfVoidNoticeInput): string {
  const parts: string[] = [];
  if (notice.voidedAt) parts.push(`voided ${esc(notice.voidedAt)}`);
  if (notice.voidedByName) parts.push(`by ${esc(notice.voidedByName)}`);
  const suffix = parts.length > 0 ? ` (${parts.join(' ')})` : '';
  return `RECORD VOID: ${esc(notice.reason ?? '(no reason recorded)')}${suffix}`;
}

function renderVoidNotice(notice: PdfVoidNoticeInput | null | undefined): string {
  if (!notice) return '';
  // `position: fixed` repeats on every printed page in Chromium's print
  // pipeline — the watermark marks ALL pages, not just the first.
  return `
  <div class="void-watermark" aria-hidden="true">VOID</div>
  <div class="void-banner">${voidLine(notice)}</div>`;
}

/**
 * The heading printed above each signature block on the CONTROLLED RECORD.
 *
 * Slice 18-WORKFLOW review, finding X-3: the template rendered a bare
 * `Stage ${stageOrdinal} — ${action}`, so the performer's new stage-0
 * signature printed as "Stage 0 — SUBMITTED" on the archived PDF — the
 * artefact an ISO-13485 auditor actually holds. The screen had already been
 * given the paper form's own wording ("Maintenance Performed By",
 * `RecordReview.tsx`'s `STAGE_LABELS`); that reasoning applies with MORE
 * force to the printed record than to the screen.
 *
 * Keyed on the ACTION first, then the stage, because the two say different
 * things: `SUBMITTED` is always the performer regardless of ordinal, while a
 * `RETURNED`/`RECALLED`/`VOIDED` block carries a stage ordinal that is a
 * verification stage. Anything unrecognised falls back to the old shape
 * rather than printing nothing — a controlled record must never lose a
 * caption because an enum grew.
 */
export function signatureBlockLabel(
  stageOrdinal: number,
  action: string,
  stageLabel?: string | null,
): string {
  switch (action) {
    case 'SUBMITTED':
      return 'Maintenance Performed By';
    case 'VERIFIED':
      // Slice 26-TWOSTAGE M1: the label snapshotted onto the step at signing
      // time WINS. The map below had drifted from the configured route (it
      // printed "Verified By (Engineer)" where the route, and the paper form,
      // say "Supervisor / Engineer"), and it is kept only as the fallback for
      // steps carrying no snapshot — a controlled record must never lose a
      // caption. Only this branch consults the snapshot: the other actions
      // are captioned by WHAT THEY ARE, so a stray label must not make a
      // rejection read like an approval.
      if (stageLabel) return stageLabel;
      return stageOrdinal === 1
        ? 'Verified By (Workshop Team Leader)'
        : stageOrdinal === 2
          ? 'Verified By (Engineer)'
          : `Verified By (Stage ${stageOrdinal})`;
    case 'RETURNED':
      return `Returned By (Stage ${stageOrdinal})`;
    case 'RECALLED':
      return 'Recalled By Submitter';
    case 'VOIDED':
      return 'Voided By';
    default:
      return `Stage ${stageOrdinal} — ${action}`;
  }
}

function renderSignatures(signatures: PdfSignatureInput[]): string {
  if (signatures.length === 0) {
    return '<p class="muted">No approval actions recorded yet.</p>';
  }
  const blocks = signatures
    .map((s) => {
      const drawn = s.drawnSignatureBase64
        ? `<img class="drawn-signature" alt="signature" src="data:image/png;base64,${s.drawnSignatureBase64}" />`
        : '<p class="muted">(no drawn signature captured for this action)</p>';
      const onBehalf = s.onBehalfOfName
        ? `<div class="on-behalf-of">on behalf of ${esc(s.onBehalfOfName)}</div>`
        : '';
      const reason = s.reason ? `<div class="reason">Reason: ${esc(s.reason)}</div>` : '';
      return `
        <div class="signature-block">
          <div class="signature-stage">${esc(signatureBlockLabel(s.stageOrdinal, s.action, s.stageLabel))}</div>
          ${drawn}
          <div class="signature-name">${esc(s.actorName)}</div>
          <div class="signature-role">${esc(s.actorRoleCode)}</div>
          <div class="signature-timestamp">${esc(s.actedAt)}</div>
          ${onBehalf}
          ${reason}
        </div>`;
    })
    .join('');
  return `<div class="signatures">${blocks}</div>`;
}

export function renderRecordHtml(input: PdfRecordInput): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(input.documentNumber)} — ${esc(input.jobNumber)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; }
  h1 { font-size: 16px; margin-bottom: 2px; }
  h2 { font-size: 13px; margin-top: 18px; margin-bottom: 4px; border-bottom: 1px solid #999; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
  .p-head { display: grid; grid-template-columns: 1fr 13rem; border: 1px solid #1a1a1a; }
  .p-head-l { padding: 5px 7px; border-right: 1px solid #1a1a1a; }
  .p-title { font-size: 13px; font-weight: 700; line-height: 1.15; margin-top: 2px; }
  .p-head-r { display: grid; grid-template-columns: auto 1fr; }
  .p-head-r span { padding: 2px 6px; border-bottom: 1px solid #c4c4c4; }
  .p-head-r span:nth-child(odd) { color: #555; border-right: 1px solid #c4c4c4; }
  .p-band { border: 1px solid #1a1a1a; border-top: none; text-align: center;
            padding: 4px; background: #ececec; font-weight: 700; }
  .p-band .off { color: #999; font-weight: 400; }
  .p-band .on { text-decoration: underline; text-underline-offset: 2px; }
  table.p { width: 100%; border-collapse: collapse; }
  table.p th, table.p td { border: 1px solid #8a8a8a; padding: 3px 5px; text-align: left; vertical-align: middle; }
  table.p thead th { background: #ececec; font-size: 9px; text-align: center; font-weight: 700; }
  table.p thead th.l { text-align: left; }
  table.p td.c { text-align: center; }
  .p-no { width: 24px; text-align: center; }
  .p-fq { width: 32px; text-align: center; }
  .p-st { width: 58px; text-align: center; }
  .p-sp { width: 110px; }
  .p-mk { width: 44px; text-align: center; }
  .p-out { color: #777; }
  .fail-ink { color: #a8261c; font-weight: 700; }
  .muted { color: #777; font-style: italic; }
  .signature-block { display: inline-block; width: 45%; margin: 6px 2%; border: 1px solid #ccc; padding: 6px; vertical-align: top; }
  .drawn-signature { max-width: 180px; max-height: 80px; display: block; border-bottom: 1px solid #333; }
  .record-footer { margin-top: 24px; border-top: 1px solid #999; padding-top: 4px; font-size: 9px; color: #444; }
  .void-watermark { position: fixed; top: 40%; left: 8%; font-size: 130px; font-weight: bold; color: rgba(176, 0, 32, 0.14); transform: rotate(-30deg); letter-spacing: 24px; pointer-events: none; z-index: 1000; }
  .void-banner { border: 2px solid #b00020; color: #b00020; font-weight: bold; padding: 6px 8px; margin: 8px 0; }
</style>
</head>
<body>
  ${renderVoidNotice(input.voidNotice)}
  <div class="p-head">
    <div class="p-head-l">
      <div class="p-title">${esc(input.documentTitle)}</div>
    </div>
    <div class="p-head-r">
      <span>Document No.</span><span>${esc(input.documentNumber)}</span>
      <span>Revision</span><span>${esc(input.revisionCode)}</span>
      <span>Machine</span><span>${esc(input.machineCode)}</span>
      <span>Job No.</span><span>${esc(input.jobNumber)}</span>
      <span>Date</span><span>${esc(input.dueOn)}</span>
    </div>
  </div>
  ${renderFrequencyBand(input.standingContent.frequencyBanner, input.frequencyScope)}

  <h2>Special Tools</h2>
  <p>${esc(input.standingContent.specialTools) || '<span class="muted">None specified.</span>'}</p>

  <h2>Parts Required</h2>
  ${renderPartsRequired(input.standingContent.partsRequired)}

  <h2>PPE</h2>
  <p>${input.standingContent.ppe && input.standingContent.ppe.length > 0 ? input.standingContent.ppe.map(esc).join(', ') : '<span class="muted">None specified.</span>'}</p>

  <h2>Safety</h2>
  <p>${esc(input.standingContent.safety) || '<span class="muted">None specified.</span>'}</p>

  ${renderChecklist(input.checklist, input.frequencyScope)}

  ${renderMeasurements(input.measurements)}

  <h2>Parts Used</h2>
  ${renderParts(input.partsUsed)}

  <h2>Attachments</h2>
  ${renderAttachments(input.attachments)}

  <h2>Signatures</h2>
  ${renderSignatures(input.signatures)}

  <h2>Remarks</h2>
  <p>${esc(input.standingContent.remarks) || '<span class="muted">None.</span>'}</p>

  <div class="record-footer">
    Record ${esc(input.footer.recordId)} — Status: ${esc(input.status)} — Integrity digest (SHA-256): ${esc(input.footer.integrityDigestHex)} — Rendered ${esc(input.footer.renderedAt)}${input.voidNotice ? ` — ${voidLine(input.voidNotice)}` : ''}
  </div>
</body>
</html>`;
}
