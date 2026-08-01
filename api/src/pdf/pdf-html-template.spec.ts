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

  /**
   * Task 5: the old separate "Parts Required" `<h2>` section is gone — the
   * sheet's own standing-content block prints what was actually USED
   * (`partsUsed`), not the planning list (`partsRequired`), matching the
   * physical form (see `renderStandingBlock`'s doc comment). `standingContent
   * .partsRequired`'s `Filter` row is therefore no longer expected on the
   * printed record; `partsUsed`'s `Belt` row is.
   */
  it('includes standing content: special tools, parts used, PPE and safety, in one labelled block', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Torque wrench');
    expect(html).toContain('Belt');
    expect(html).toContain('Gloves');
    expect(html).toContain('Lockout/tagout before servicing');
  });

  describe('renderStandingBlock / renderSignatures / page footer (Task 5)', () => {
    it('prints standing content as one labelled block, not separate headings', () => {
      const html = renderRecordHtml(
        baseInput({ standingContent: { ppe: ['Safety Shoes'], safety: 'Lock out.' } }),
      );
      expect(html).toContain('<dt>PPE</dt>');
      expect(html).not.toContain('<h2>PPE</h2>');
    });

    it('prints three signature cells with the captions signatureBlockLabel gives', () => {
      const html = renderRecordHtml(
        baseInput({
          signatures: [
            {
              approvalStepId: 's1',
              stageOrdinal: 0,
              action: 'SUBMITTED',
              actorName: 'R. Tan',
              actorRoleCode: 'MAINTAINER',
              actedAt: '2026-08-14',
            },
          ],
        }),
      );
      expect(html).toContain('Maintenance Performed By');
      expect(html).toContain('R. Tan');
    });

    it('prints the stored digest in the footer without recomputing it', () => {
      const html = renderRecordHtml(
        baseInput({
          footer: {
            recordId: 'r1',
            integrityDigestHex: 'deadbeef',
            renderedAt: '2026-08-14T00:00:00Z',
          },
        }),
      );
      expect(html).toContain('deadbeef');
    });
  });

  it('includes the numbered checklist with recorded status', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Check belts');
    expect(html).toContain('DONE');
  });

  describe("renderChecklist — the sheet's own columns (Task 4)", () => {
    it('prints No, Freq, Instruction, Status and Remark in that order', () => {
      const html = renderRecordHtml(baseInput({}));
      // A generic `<thead>` match is not scoped to a specific table — the
      // document renders more than one (checklist, measurements). Scope the
      // match to the checklist table specifically (`<table class="p">`,
      // first one in document order) rather than relying on ordering.
      const head = /<table class="p"><thead>(.*?)<\/thead>/s.exec(html)![1];
      expect(head.indexOf('No')).toBeLessThan(head.indexOf('Freq'));
      expect(head.indexOf('Freq')).toBeLessThan(head.indexOf('Maintenance Instruction'));
      expect(head.indexOf('Maintenance Instruction')).toBeLessThan(head.indexOf('Status'));
      expect(head.indexOf('Status')).toBeLessThan(head.indexOf('Remark'));
    });

    it("prints each row's frequency in the Freq column", () => {
      const html = renderRecordHtml(
        baseInput({
          frequencyScope: ['M3', 'M6'],
          checklist: [
            {
              itemNo: 1,
              frequency: 'M3',
              inScope: true,
              instruction: 'Clean',
              status: 'DONE',
              remark: null,
            },
            {
              itemNo: 9,
              frequency: 'M6',
              inScope: true,
              instruction: 'Fans',
              status: 'DONE',
              remark: null,
            },
          ],
        }),
      );
      expect(html).toContain('<td class="p-fq">M3</td>');
      expect(html).toContain('<td class="p-fq">M6</td>');
    });

    it('prints an out-of-scope row, numbered, with an em dash and a reason', () => {
      const html = renderRecordHtml(
        baseInput({
          frequencyScope: ['M3', 'M6'],
          checklist: [
            {
              itemNo: 13,
              frequency: 'Y',
              inScope: false,
              instruction: 'Calibrate',
              status: 'NOT_EVALUATED',
              remark: null,
            },
          ],
        }),
      );
      expect(html).toContain('>13<');
      expect(html).toContain('—');
      expect(html).toContain('Not in scope (6M)');
    });

    it('prints the status word, not a glyph, and flags NOT_DONE', () => {
      const html = renderRecordHtml(
        baseInput({
          checklist: [
            {
              itemNo: 12,
              frequency: 'M6',
              inScope: true,
              instruction: 'ESD',
              status: 'NOT_DONE',
              remark: 'WO-2291',
            },
          ],
        }),
      );
      expect(html).toContain('NOT DONE');
      expect(html).toContain('class="c fail-ink"');
    });

    /**
     * Owner ruling on the soft-removed-item sentinel: the assembly service
     * deliberately sets `frequency: ''` for a row whose template item was
     * removed from the revision (the correct fail-closed value for
     * `itemInScope`), but a bare blank Freq cell is visually
     * indistinguishable from a rendering defect if a viewer doesn't also
     * read the instruction column. The Freq column must print a visible
     * placeholder, not nothing.
     */
    it("prints a placeholder, not a blank cell, when a soft-removed item's frequency is empty", () => {
      const html = renderRecordHtml(
        baseInput({
          frequencyScope: ['M3', 'M6'],
          checklist: [
            {
              itemNo: 7,
              frequency: '',
              inScope: false,
              instruction: 'Replace filter (item removed from revision)',
              status: 'NOT_EVALUATED',
              remark: null,
            },
          ],
        }),
      );
      expect(html).toContain('<td class="p-fq">—</td>');
      expect(html).not.toContain('<td class="p-fq"></td>');
    });

    /**
     * Fix round 1, CRITICAL finding: `frequencyScope: []` is a deliberate,
     * documented production value for ad-hoc jobs
     * (`api/src/jobs/adhoc-job.service.ts` — "THE EMPTY SCOPE IS THE WHOLE
     * POINT"), not "nothing applies". Owner ruling: on an ad-hoc job every
     * checklist item is in scope, so its rows must print OPEN — no closed
     * cell, no "Not in scope" reason.
     */
    it('renders an ad-hoc job (empty scope) with checklist rows open, not closed', () => {
      const html = renderRecordHtml(
        baseInput({
          frequencyScope: [],
          checklist: [
            {
              itemNo: 1,
              frequency: 'M3',
              inScope: true,
              instruction: 'Check belts',
              status: 'DONE',
              remark: null,
            },
            {
              itemNo: 2,
              frequency: 'Y',
              inScope: true,
              instruction: 'Calibrate',
              status: 'DONE',
              remark: null,
            },
          ],
        }),
      );
      expect(html).not.toContain('Not in scope');
      expect(html).not.toContain('class="p-out"');
      expect(html).toContain('<td class="p-fq">M3</td>');
      expect(html).toContain('<td class="p-fq">Y</td>');
    });

    /**
     * Fix round 1: `scopeLabel([])` naively produced a bare `"M"` (matches
     * none of the sheet's real frequency labels — `3M`, `6M`, `Y`), which
     * reads as a rendering defect on a controlled record. The ruling makes
     * this path unreachable in practice (an ad-hoc job now puts every real
     * frequency in scope), but the orphaned-row sentinel can still land here
     * on an ad-hoc job — it fails closed regardless of scope — so the guard
     * must hold: a bare "Not in scope", never a malformed "(M)" reason.
     */
    it('prints a bare "Not in scope" reason, never a malformed "(M)", for the sentinel on an ad-hoc job', () => {
      const html = renderRecordHtml(
        baseInput({
          frequencyScope: [],
          checklist: [
            {
              itemNo: 4,
              frequency: '',
              inScope: false,
              instruction: 'Removed item',
              status: 'NOT_EVALUATED',
              remark: null,
            },
          ],
        }),
      );
      expect(html).toContain('Not in scope</td>');
      expect(html).not.toContain('Not in scope (');
      expect(html).not.toContain('(M)');
    });
  });

  it('includes the measurement table with specification and reading', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Temperature');
    expect(html).toContain('20-30');
    expect(html).toContain('25');
    expect(html).toContain('PASS');
  });

  describe("renderMeasurements — the sheet's own columns (Task 4b)", () => {
    it('heads the measurement result column "Result", not "Judgement"', () => {
      const html = renderRecordHtml(baseInput({}));
      expect(html).toContain('<th class="p-mk">Result</th>');
      expect(html).not.toContain('<th>Judgement</th>');
    });

    it('prints the specification verbatim and flags a FAIL', () => {
      const html = renderRecordHtml(
        baseInput({
          measurements: [
            {
              description: '91 steps calibration',
              unit: 'μm/encoder',
              specDisplay: '0.19 – 0.21 μm/encoder',
              reading: '0.218',
              judgement: 'FAIL',
              remark: null,
            },
          ],
        }),
      );
      expect(html).toContain('0.19 – 0.21 μm/encoder');
      expect(html).toContain('class="c fail-ink"');
    });

    it('prints an em dash for a measurement with no reading', () => {
      const html = renderRecordHtml(
        baseInput({
          measurements: [
            {
              description: 'Vacuum Check',
              unit: 'mmHg',
              specDisplay: '> -600 mmHg',
              reading: null,
              judgement: 'NOT_EVALUATED',
              remark: null,
            },
          ],
        }),
      );
      expect(html).toContain('<td class="c">—</td>');
    });
  });

  /**
   * UR-057 is Mandatory (`docs/URD.md:320`): "The rendered document shall
   * display, for each signature, the signatory's full name, role and the
   * date and time of signing." Owner ruling 2026-08-01 (Task 5 fix round 1)
   * restored `actorRoleCode` to the three-cell row after an earlier draft of
   * this task dropped it — the caption above the cell (e.g. "Verified By
   * (Workshop Team Leader)") names the STAGE, not the individual signatory's
   * own role code, so the two are not interchangeable.
   */
  it('includes the signature row with name, role and timestamp (UR-057, Mandatory)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('Jane Doe');
    expect(html).toContain('TEAM_LEADER');
    expect(html).toContain('2026-07-02T10:00:00.000Z');
    // All three in the same cell, name first, per the amended plan's markup.
    expect(html).toMatch(/Jane Doe · TEAM_LEADER · 2026-07-02T10:00:00\.000Z/);
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

  /**
   * Task 5: a step with no drawn signature (return/recall/void) prints the
   * sheet's own blank signature line (`.p-sigline`) in place of the drawn
   * `<img>` — the physical form's blank rule, not prose apologising for its
   * absence.
   *
   * Owner ruling 2026-08-01 (Task 5 fix round 1), Journey C / AC-06
   * (`docs/URD.md`): "the archive shows the full sequence with timestamps"
   * including "returned with reason" — a RETURNED step's `reason` MUST
   * still print. `renderSignatures` iterates every approval action, so this
   * RETURNED step gets its own cell and carries its reason there.
   */
  it('renders a blank signature line and the RETURNED reason when a step has no drawn signature', () => {
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
    expect(html).toContain('class="p-sigline"');
    expect(html).toContain('Returned By (Stage 1)');
    expect(html).toContain('John Smith');
    expect(html).toContain('ENGINEER');
    expect(html).toContain('Reason: Missing measurement');
    expect(html).not.toContain('data:image/png;base64,');
  });

  /**
   * UR-052 + URD Journey D (`docs/URD.md`): "every action shall be recorded
   * as performed by the delegate on behalf of the approver" — the archive
   * must read "verified by X, acting as delegate for Y", never print a
   * delegated signature identically to a personal one. Owner ruling
   * 2026-08-01 (Task 5 fix round 1) restored `onBehalfOfName` to the
   * signature cell. Pinned both directions: present when set, ABSENT when
   * not — a delegated signature must be distinguishable from a personal one
   * in both directions, not just printable when present.
   */
  it('prints "on behalf of" only for a delegated signature, never for a personal one', () => {
    const delegated = renderRecordHtml(
      baseInput({
        signatures: [
          {
            approvalStepId: 'step-3',
            stageOrdinal: 2,
            action: 'VERIFIED',
            actorName: 'Sam Supervisor',
            actorRoleCode: 'ENGINEER',
            actedAt: '2026-07-02T11:00:00.000Z',
            drawnSignatureBase64: 'BASE64DATA',
            onBehalfOfName: 'Terry Team Leader',
          },
        ],
      }),
    );
    expect(delegated).toContain('on behalf of Terry Team Leader');

    const personal = renderRecordHtml(baseInput()); // baseInput's signature has no onBehalfOfName
    expect(personal).not.toContain('on behalf of');
  });

  it('includes the Remarks footer (PR-116)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('All good');
  });

  /**
   * PR-118, this file's own header comment: "the page footer ALSO carries
   * the record id and integrity digest." Owner ruling 2026-08-01 (Task 5 fix
   * round 1) restored `<span>Record ${recordId}</span>` after an earlier
   * draft dropped it — `footer.recordId` IS `job.id`
   * (`pdf-record-assembly.service.ts:70/103`), and
   * `api/test/integration/records-pdf.spec.ts:531`/`:599` assert the job id
   * appears in the extracted PDF text; dropping it broke both. The footer
   * ALSO carries the document/machine/job identity line, which the sheet
   * itself has no field for but an auditor would still read a record by.
   */
  it('the page footer carries the record id, identity line and integrity digest (PR-118)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).toContain('CE 95 010 00 01');
    expect(html).toContain('PM-0001');
    expect(html).toMatch(/p-foot[\s\S]*Record rec-1/);
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
   *
   * Task 5 replaced the `.record-footer` div this ruling landed on with the
   * sheet's own `.p-foot` page footer — the selector below tracks that
   * rename, but the ruling itself (status must survive in the footer) is
   * unchanged and is NOT weakened here.
   */
  it('the page footer carries the record status (fix round 1, finding 1)', () => {
    const html = renderRecordHtml(baseInput({ status: 'SUBMITTED' }));
    expect(html).toMatch(/p-foot[\s\S]*Status:\s*SUBMITTED/);
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
    // Task 5: "no parts used" is now rendered inline in the standing-content
    // block's <dd> (`<span class="muted">None.</span>`), not as its own
    // sentence — the same fallback used for "no remarks".
    expect(html).toContain('<dt>Parts Used</dt><dd><span class="muted">None.</span></dd>');
    expect(html).toContain('No attachments.');
    expect(html).toContain('No approval actions recorded yet.');
  });

  // ------------------------------------------------------- slice 17-VOID

  /**
   * Owner ruling 2026-08-01 (Task 5 fix round 1, Important finding): an
   * earlier draft of this task dropped the footer's void line entirely.
   * `.void-banner` is NOT `position: fixed`, so the void REASON prints on
   * page 1 only; the `position: fixed` watermark that repeats on every page
   * carries just the word VOID, not why. A print/view of only the last page
   * of a multi-page voided record would say THAT it is void without saying
   * WHY — exactly what this footer line exists to prevent. Restored as
   * `<div class="p-foot-void">` after the `.p-foot` block, and the
   * assertion below is restored to match (not merely the `Status: VOIDED`
   * fallback a prior round of this fix used instead).
   */
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
    // the last page alone) — restored in `.p-foot-void`, printed after the
    // `.p-foot` metadata row.
    expect(html).toMatch(/p-foot-void[\s\S]*RECORD VOID/);
    // The footer's Status field still carries the same signal too.
    expect(html).toMatch(/p-foot[\s\S]*Status:\s*VOIDED/);
  });

  it('U-VOID-05: a live record renders NO void marking (the stylesheet may define the class; no element uses it)', () => {
    const html = renderRecordHtml(baseInput());
    expect(html).not.toContain('class="void-watermark"');
    expect(html).not.toContain('class="void-banner"');
    expect(html).not.toContain('class="p-foot-void"');
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

describe('print CSS — A4, margins, repeating headers (Task 6)', () => {
  it('declares A4 with margins and repeats table headers across pages', () => {
    const html = renderRecordHtml(baseInput({}));
    expect(html).toContain('@page { size: A4 portrait;');
    expect(html).toContain('thead { display: table-header-group; }');
    expect(html).toContain('tr { break-inside: avoid; }');
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

  /**
   * Owner ruling 2026-08-01 (Task 4 fix round 1). This assertion is
   * DELIBERATELY INVERTED from the one Task 2 committed
   * (`expect(itemInScope('M3', [])).toBe(false)`). An empty scope is not
   * "nothing applies" — it is `adhoc-job.service.ts`'s deliberate scheduling
   * device ("THE EMPTY SCOPE IS THE WHOLE POINT") so an ad-hoc job advances
   * no schedule rule; it says nothing about which checklist items apply. On
   * an ad-hoc job every item is in scope. This is a corrected requirement,
   * not a weakened test.
   */
  it('treats an empty scope as ad-hoc: every real frequency applies', () => {
    expect(itemInScope('M3', [])).toBe(true);
    expect(itemInScope('M6', [])).toBe(true);
    expect(itemInScope('Y', [])).toBe(true);
  });

  // The orphaned-row sentinel is a DIFFERENT thing from an empty scope and
  // still fails closed — including on an ad-hoc job, where an unresolvable
  // row must never print as work that was expected.
  it('is false for the empty-frequency sentinel, even on an ad-hoc job', () => {
    expect(itemInScope('', [])).toBe(false);
    expect(itemInScope('', ['M3', 'M6'])).toBe(false);
  });
});
