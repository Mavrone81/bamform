import {
  escapeHtml,
  itemInScope,
  renderRecordHtml,
  signatureBlockLabel,
  type PdfRecordInput,
} from './pdf-html-template';

function baseInput(overrides: Partial<PdfRecordInput> = {}): PdfRecordInput {
  return {
    recordId: 'rec-1',
    jobNumber: 'PM-0001',
    documentNumber: 'CE 95 010 00 01',
    documentTitle: 'Besi Die Attach Preventive Maintenance Record',
    revisionCode: 'R2',
    assetCode: 'AST-001',
    machineCode: 'AW02',
    assetDescription: 'Die Attach Machine',
    frequency: 'M1',
    frequencyScope: ['M3', 'M6'],
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
    checklist: [
      {
        itemNo: 1,
        frequency: 'M3',
        inScope: true,
        instruction: 'Check belts',
        status: 'DONE',
        remark: null,
      },
    ],
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
  it('includes the header block: document title, document number, revision, job/machine', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Besi Die Attach Preventive Maintenance Record');
    expect(html).toContain('CE 95 010 00 01');
    expect(html).toContain('R2');
    expect(html).toContain('PM-0001');
    expect(html).toContain('AW02');
  });

  it('prints the machine in the header grid', () => {
    const html = renderRecordHtml(baseInput({ machineCode: 'AW02' }));
    expect(html).toContain('<span>Machine</span><span>AW02</span>');
  });

  it('includes the frequency selection band, falling back to the scope when no banner was loaded', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('class="p-band"');
    expect(html).toContain('<span class="on">3M</span>');
    expect(html).toContain('<span class="on">6M</span>');
  });

  it('marks the selected frequency in the band and leaves the others unmarked', () => {
    const html = renderRecordHtml(
      baseInput({
        frequencyScope: ['M3', 'M6'],
        standingContent: { frequencyBanner: 'Three Monthly (3M) Six Monthly (6M) Yearly (Y)' },
      }),
    );
    expect(html).toContain('<span class="on">Six Monthly (6M)</span>');
    expect(html).toContain('<span class="off">Yearly (Y)</span>');
  });

  it('falls back to the scope itself when no banner was loaded', () => {
    const html = renderRecordHtml(
      baseInput({ frequencyScope: ['M3'], standingContent: { frequencyBanner: null } }),
    );
    expect(html).toContain('<span class="on">3M</span>');
  });

  it('escapes a banner containing markup', () => {
    const html = renderRecordHtml(
      baseInput({ standingContent: { frequencyBanner: '<script>x</script> (3M)' } }),
    );
    expect(html).not.toContain('<script>');
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

  /**
   * Slice 18-WORKFLOW review, finding X-3. The PDF is the CONTROLLED record
   * an auditor holds; a block captioned "Stage 0 — SUBMITTED" says nothing to
   * anyone in the plant. These pin the paper form's own wording.
   */
  describe('signatureBlockLabel — the controlled record reads like the paper form (X-3)', () => {
    it("the performer's stage-0 block is captioned 'Maintenance Performed By', never 'Stage 0'", () => {
      expect(signatureBlockLabel(0, 'SUBMITTED')).toBe('Maintenance Performed By');
      expect(signatureBlockLabel(0, 'SUBMITTED')).not.toMatch(/Stage 0/);
    });

    it('the two verification stages fall back to their paper-form captions when no label was snapshotted', () => {
      expect(signatureBlockLabel(1, 'VERIFIED')).toBe('Verified By (Workshop Team Leader)');
      expect(signatureBlockLabel(2, 'VERIFIED')).toBe('Verified By (Engineer)');
    });

    /**
     * Slice 26-TWOSTAGE review fix M1. This hard-coded map had DRIFTED from
     * the configured route: the live stage-2 label is
     * "Verified By (Supervisor / Engineer)" (and the paper form reads
     * "Verified By: (Workshop Supervisor/Engr)"), while this file printed
     * "Verified By (Engineer)" on the controlled record. The step now carries
     * the label snapshotted at signing time, and that snapshot wins.
     */
    it('M1: a snapshotted stage label WINS over the hard-coded map for a verification block', () => {
      expect(signatureBlockLabel(2, 'VERIFIED', 'Verified By (Supervisor / Engineer)')).toBe(
        'Verified By (Supervisor / Engineer)',
      );
      expect(signatureBlockLabel(1, 'VERIFIED', 'Verified By (Workshop Team Leader)')).toBe(
        'Verified By (Workshop Team Leader)',
      );
    });

    it('M1: a null/absent snapshot falls back to the map — historical rows still render', () => {
      expect(signatureBlockLabel(2, 'VERIFIED', null)).toBe('Verified By (Engineer)');
      expect(signatureBlockLabel(2, 'VERIFIED', undefined)).toBe('Verified By (Engineer)');
      expect(signatureBlockLabel(2, 'VERIFIED', '')).toBe('Verified By (Engineer)');
    });

    it('M1: the snapshot never overrides a non-verification caption — a return is still a return', () => {
      // Only the VERIFIED branch consults the snapshot: a returned/recalled/
      // voided block is captioned by WHAT IT IS, not by the stage it happened
      // at (this file's own doc comment), so a stray label must not turn a
      // rejection into something that reads like an approval.
      expect(signatureBlockLabel(1, 'RETURNED', 'Verified By (Workshop Team Leader)')).toBe(
        'Returned By (Stage 1)',
      );
      expect(signatureBlockLabel(0, 'SUBMITTED', 'Verified By (Workshop Team Leader)')).toBe(
        'Maintenance Performed By',
      );
    });

    it('return, recall and void are captioned by what they are', () => {
      expect(signatureBlockLabel(1, 'RETURNED')).toBe('Returned By (Stage 1)');
      expect(signatureBlockLabel(1, 'RECALLED')).toBe('Recalled By Submitter');
      expect(signatureBlockLabel(1, 'VOIDED')).toBe('Voided By');
    });

    it('an unrecognised action still prints a caption rather than nothing', () => {
      expect(signatureBlockLabel(3, 'FUTURE_ACTION')).toBe('Stage 3 — FUTURE_ACTION');
    });

    it('the rendered HTML uses the caption, not the raw stage ordinal', () => {
      const html = renderRecordHtml(
        baseInput({
          signatures: [
            {
              approvalStepId: 'step-0',
              stageOrdinal: 0,
              action: 'SUBMITTED',
              actorName: 'Pat Performer',
              actorRoleCode: 'MAINTAINER',
              actedAt: '2026-07-02T08:00:00.000Z',
              drawnSignatureBase64: 'BASE64DATA',
            },
          ],
        }),
      );
      expect(html).toContain('Maintenance Performed By');
      expect(html).not.toContain('Stage 0');
    });
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

  /**
   * Fix round 1 finding 1 — the header grid carries no status field, and
   * `pdf-coordinator.service.ts` documents that archival status is NOT the
   * access gate (a PDF can be pulled for a SUBMITTED-but-unverified job).
   * Without an explicit status, a SUBMITTED and an ARCHIVED record read
   * header-identical. Owner ruling: print status in the footer alongside
   * the other record metadata (integrity digest, record id) rather than
   * restoring it to the sheet's own header/body.
   */
  it('the page footer carries the record status (fix round 1, finding 1)', () => {
    const html = renderRecordHtml(baseInput({ status: 'SUBMITTED' }));
    expect(html).toMatch(/record-footer[\s\S]*Status:\s*SUBMITTED/);
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
            frequency: 'M3',
            inScope: true,
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

  // ------------------------------------------------------- slice 17-VOID

  it('U-VOID-04: a voided record renders the VOID watermark, banner and footer line — the PDF must tell the truth', () => {
    const html = renderRecordHtml(
      baseInput({
        status: 'VOIDED',
        voidNotice: {
          reason: 'Raised against the wrong machine',
          voidedAt: '2026-07-28T01:00:00.000Z',
          voidedByName: 'Ada Admin',
        },
      }),
    );
    expect(html).toContain('void-watermark');
    expect(html).toContain('RECORD VOID');
    expect(html).toContain('Raised against the wrong machine');
    expect(html).toContain('Ada Admin');
    expect(html).toContain('2026-07-28T01:00:00.000Z');
    // The footer carries the void line too (survives a single-page print of
    // the last page alone).
    expect(html).toMatch(/record-footer[\s\S]*RECORD VOID/);
  });

  it('U-VOID-05: a live record renders NO void marking (the stylesheet may define the class; no element uses it)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).not.toContain('class="void-watermark"');
    expect(html).not.toContain('class="void-banner"');
    expect(html).not.toContain('RECORD VOID');
  });

  it('U-VOID-06: the void reason is escaped — no markup injection through the annotation', () => {
    const html = renderRecordHtml(
      baseInput({
        status: 'VOIDED',
        voidNotice: {
          reason: '<script>alert(9)</script>',
          voidedAt: null,
          voidedByName: null,
        },
      }),
    );
    expect(html).not.toContain('<script>alert(9)</script>');
    expect(html).toContain('&lt;script&gt;alert(9)&lt;/script&gt;');
  });
});

describe('itemInScope', () => {
  it('is true when the row frequency is in the visit scope', () => {
    expect(itemInScope('M3', ['M3', 'M6'])).toBe(true);
    expect(itemInScope('M6', ['M3', 'M6'])).toBe(true);
  });

  it('is false for a yearly row on a six-monthly visit', () => {
    expect(itemInScope('Y', ['M3', 'M6'])).toBe(false);
  });

  it('is false against an empty scope rather than throwing', () => {
    expect(itemInScope('M3', [])).toBe(false);
  });
});
