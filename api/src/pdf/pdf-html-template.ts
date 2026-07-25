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
}

export interface PdfChecklistItemInput {
  itemNo: number;
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
}

export interface PdfRecordInput {
  recordId: string;
  jobNumber: string;
  documentNumber: string;
  documentTitle: string;
  revisionCode: string;
  assetCode: string;
  assetDescription: string | null;
  frequency: string;
  dueOn: string;
  status: string;
  standingContent: PdfStandingContentInput;
  checklist: PdfChecklistItemInput[];
  measurements: PdfMeasurementInput[];
  partsUsed: PdfPartUsedInput[];
  attachments: PdfAttachmentInput[];
  signatures: PdfSignatureInput[];
  footer: {
    recordId: string;
    /** `approval_step.content_hash`, hex-encoded — PR-118 (see `job-include.ts#latestApprovalStep`). */
    integrityDigestHex: string;
    renderedAt: string;
  };
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

function renderChecklist(items: PdfChecklistItemInput[]): string {
  if (items.length === 0) return '<p class="muted">No checklist items.</p>';
  const rows = items
    .map(
      (item) =>
        `<tr><td>${item.itemNo}</td><td>${esc(item.instruction)}</td><td class="status-${esc(item.status)}">${esc(item.status)}</td><td>${esc(item.remark)}</td></tr>`,
    )
    .join('');
  return `<table class="checklist"><thead><tr><th>#</th><th>Instruction</th><th>Status</th><th>Remark</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMeasurements(rows: PdfMeasurementInput[]): string {
  if (rows.length === 0) return '<p class="muted">No measurements.</p>';
  const body = rows
    .map(
      (m) =>
        `<tr><td>${esc(m.description)}</td><td>${esc(m.specDisplay)}</td><td>${esc(m.reading)}${esc(m.unit ? ` ${m.unit}` : '')}</td><td class="judgement-${esc(m.judgement)}">${esc(m.judgement)}</td><td>${esc(m.remark)}</td></tr>`,
    )
    .join('');
  return `<table class="measurements"><thead><tr><th>Description</th><th>Specification</th><th>Reading</th><th>Judgement</th><th>Remark</th></tr></thead><tbody>${body}</tbody></table>`;
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
          <div class="signature-stage">Stage ${s.stageOrdinal} — ${esc(s.action)}</div>
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
  .header-block { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 6px; }
  .frequency-banner { background: #eee; padding: 4px 8px; font-weight: bold; margin: 8px 0; }
  .muted { color: #777; font-style: italic; }
  .judgement-FAIL { color: #b00020; font-weight: bold; }
  .status-NOT_DONE { color: #b00020; font-weight: bold; }
  .signature-block { display: inline-block; width: 45%; margin: 6px 2%; border: 1px solid #ccc; padding: 6px; vertical-align: top; }
  .drawn-signature { max-width: 180px; max-height: 80px; display: block; border-bottom: 1px solid #333; }
  .record-footer { margin-top: 24px; border-top: 1px solid #999; padding-top: 4px; font-size: 9px; color: #444; }
</style>
</head>
<body>
  <div class="header-block">
    <div>
      <h1>${esc(input.documentTitle)}</h1>
      <div>Document No.: ${esc(input.documentNumber)} &nbsp; Revision: ${esc(input.revisionCode)}</div>
      <div>Job No.: ${esc(input.jobNumber)} &nbsp; Asset: ${esc(input.assetCode)}${esc(input.assetDescription ? ` — ${input.assetDescription}` : '')}</div>
    </div>
    <div>
      <div>Due: ${esc(input.dueOn)}</div>
      <div>Status: ${esc(input.status)}</div>
    </div>
  </div>

  <div class="frequency-banner">Frequency: ${esc(input.frequency)}</div>

  <h2>Special Tools</h2>
  <p>${esc(input.standingContent.specialTools) || '<span class="muted">None specified.</span>'}</p>

  <h2>Parts Required</h2>
  ${renderPartsRequired(input.standingContent.partsRequired)}

  <h2>PPE</h2>
  <p>${input.standingContent.ppe && input.standingContent.ppe.length > 0 ? input.standingContent.ppe.map(esc).join(', ') : '<span class="muted">None specified.</span>'}</p>

  <h2>Safety</h2>
  <p>${esc(input.standingContent.safety) || '<span class="muted">None specified.</span>'}</p>

  <h2>Checklist</h2>
  ${renderChecklist(input.checklist)}

  <h2>Measurements</h2>
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
    Record ${esc(input.footer.recordId)} — Integrity digest (SHA-256): ${esc(input.footer.integrityDigestHex)} — Rendered ${esc(input.footer.renderedAt)}
  </div>
</body>
</html>`;
}
