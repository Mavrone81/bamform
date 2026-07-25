import { escapeHtml, renderRecordHtml, type PdfRecordInput } from './pdf-html-template';

function baseInput(overrides: Partial<PdfRecordInput> = {}): PdfRecordInput {
  return {
    recordId: 'rec-1',
    jobNumber: 'PM-0001',
    documentNumber: 'CE 95 010 00 01',
    documentTitle: 'Besi Die Attach Preventive Maintenance Record',
    revisionCode: 'R2',
    assetCode: 'AST-001',
    assetDescription: 'Die Attach Machine',
    frequency: 'M1',
    dueOn: '2026-07-01',
    status: 'ARCHIVED',
    standingContent: {
      specialTools: 'Torque wrench',
      partsRequired: [{ partNo: 'P-1', description: 'Filter', qty: '2', remarks: '' }],
      ppe: ['Gloves', 'Safety glasses'],
      safety: 'Lockout/tagout before servicing',
      procedure: null,
      remarks: 'All good',
    },
    checklist: [{ itemNo: 1, instruction: 'Check belts', status: 'DONE', remark: null }],
    measurements: [
      {
        description: 'Temperature',
        unit: 'C',
        specDisplay: '20-30',
        reading: '25',
        judgement: 'PASS',
        remark: null,
      },
    ],
    partsUsed: [{ partNo: 'P-2', description: 'Belt', quantity: '1', remarks: null }],
    attachments: [{ originalFilename: 'photo.jpg', contentType: 'image/jpeg' }],
    signatures: [
      {
        approvalStepId: 'step-1',
        stageOrdinal: 1,
        action: 'VERIFIED',
        actorName: 'Jane Doe',
        actorRoleCode: 'TEAM_LEADER',
        actedAt: '2026-07-02T10:00:00.000Z',
        drawnSignatureBase64: 'BASE64DATA',
      },
    ],
    footer: {
      recordId: 'rec-1',
      integrityDigestHex: 'deadbeef',
      renderedAt: '2026-07-03T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the five reserved HTML characters', () => {
    expect(escapeHtml(`<script>&"'</script>`)).toBe(
      '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;',
    );
  });
});

describe('renderRecordHtml (PR-116/117/118, UR-056/057)', () => {
  it('includes the header block: document title, document number, revision, job/asset', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Besi Die Attach Preventive Maintenance Record');
    expect(html).toContain('CE 95 010 00 01');
    expect(html).toContain('R2');
    expect(html).toContain('PM-0001');
    expect(html).toContain('AST-001');
  });

  it('includes the frequency banner', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toMatch(/Frequency:\s*M1/);
  });

  it('includes tools, parts-required, PPE and safety blocks', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Torque wrench');
    expect(html).toContain('Filter');
    expect(html).toContain('Gloves');
    expect(html).toContain('Lockout/tagout before servicing');
  });

  it('includes the numbered checklist with recorded status', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Check belts');
    expect(html).toContain('DONE');
  });

  it('includes the measurement table with specification and reading', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Temperature');
    expect(html).toContain('20-30');
    expect(html).toContain('25');
    expect(html).toContain('PASS');
  });

  it('includes the signature block with name, role and timestamp (UR-057)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Jane Doe');
    expect(html).toContain('TEAM_LEADER');
    expect(html).toContain('2026-07-02T10:00:00.000Z');
  });

  it('embeds the drawn signature as a base64 PNG data URL', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('data:image/png;base64,BASE64DATA');
  });

  it('renders "(no drawn signature captured...)" when a step has none (return/recall/void)', () => {
    const html = renderRecordHtml(
      baseInput({
        signatures: [
          {
            approvalStepId: 'step-2',
            stageOrdinal: 1,
            action: 'RETURNED',
            actorName: 'John Smith',
            actorRoleCode: 'ENGINEER',
            actedAt: '2026-07-02T09:00:00.000Z',
            drawnSignatureBase64: null,
            reason: 'Missing measurement',
          },
        ],
      }),
    );
    expect(html).toContain('no drawn signature captured');
    expect(html).toContain('Missing measurement');
    expect(html).not.toContain('data:image/png;base64,');
  });

  it('includes the Remarks footer (PR-116)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('All good');
  });

  it('the page footer carries the record id and integrity digest (PR-118)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('rec-1');
    expect(html).toContain('deadbeef');
  });

  it('a DIFFERENT integrity digest produces a DIFFERENT footer (tamper-detectable at a glance)', () => {
    const htmlA = renderRecordHtml(
      baseInput({ footer: { recordId: 'rec-1', integrityDigestHex: 'aaaa', renderedAt: 't' } }),
    );
    const htmlB = renderRecordHtml(
      baseInput({ footer: { recordId: 'rec-1', integrityDigestHex: 'bbbb', renderedAt: 't' } }),
    );
    expect(htmlA).not.toEqual(htmlB);
  });

  it('escapes malicious content in a remark field (SECURITY_ARCHITECTURE.md §8 — no markup injection)', () => {
    const html = renderRecordHtml(
      baseInput({
        checklist: [
          {
            itemNo: 1,
            instruction: 'Check belts',
            status: 'DONE',
            remark: '<img src=x onerror=alert(1)>',
          },
        ],
      }),
    );
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes malicious content in the document title and asset description', () => {
    const html = renderRecordHtml(
      baseInput({
        documentTitle: '<script>alert(1)</script>',
        assetDescription: '"><script>alert(2)</script>',
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(2)</script>');
  });

  it('handles an empty checklist/measurements/parts/attachments/signatures gracefully', () => {
    const html = renderRecordHtml(
      baseInput({
        checklist: [],
        measurements: [],
        partsUsed: [],
        attachments: [],
        signatures: [],
      }),
    );
    expect(html).toContain('No checklist items.');
    expect(html).toContain('No measurements.');
    expect(html).toContain('No parts used.');
    expect(html).toContain('No attachments.');
    expect(html).toContain('No approval actions recorded yet.');
  });
});
