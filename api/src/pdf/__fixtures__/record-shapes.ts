/**
 * Task 7 — golden-fixture form shapes for `pdf-html-template.golden.spec.ts`.
 *
 * Adapted from the task-7 brief's literal fixture, which predates six tasks
 * of rulings on `PdfRecordInput` (Tasks 2–6). The brief's shape turned out to
 * match the CURRENT interface field-for-field once checked against
 * `pdf-html-template.ts` — no field needed to be dropped. The only changes
 * from the brief are:
 *
 *  - `standingContent.ppe`/`safety`/`remarks` are read from the base fixture
 *    as written; nothing added there.
 *  - Every `checklist`/`measurements`/`partsUsed` entry is typed against the
 *    CURRENT `PdfChecklistItemInput`/`PdfMeasurementInput`/`PdfPartUsedInput`
 *    shapes (all of which the brief's literal already matched), rather than
 *    copied without checking.
 *  - `'long-18-item'`'s checklist previously left `frequencyScope` at the
 *    base's `['M3', 'M6']`, which would put the M1 and Y rows the brief's
 *    generator produces OUT of scope (see `itemInScope`) — contradicting the
 *    "all DONE" shape the brief's own test list implies. This fixture sets
 *    `frequencyScope: ['M1', 'M3', 'M6', 'Y']` for that shape explicitly
 *    (the brief already did this — kept, called out here because it is
 *    load-bearing for `itemInScope`, not decorative).
 *
 * See `task-7-report.md` for the full field-by-field comparison against the
 * live `PdfRecordInput` interface.
 */
import type { PdfRecordInput } from '../pdf-html-template';

const base: PdfRecordInput = {
  recordId: 'rec-1',
  jobNumber: 'PM-4471',
  documentNumber: 'CE 95 020 00 01',
  documentTitle: 'ASM Wire Bond Preventive Maintenance Record',
  revisionCode: 'C',
  assetCode: 'AW02',
  assetDescription: 'Bevora Semiconductor · Assembly',
  machineCode: 'AW02',
  frequency: 'M6',
  frequencyScope: ['M3', 'M6'],
  dueOn: '2026-08-14',
  status: 'ARCHIVED',
  standingContent: {
    frequencyBanner: 'Three Monthly (3M) Six Monthly (6M) Yearly (Y)',
    ppe: ['Safety Shoes', 'Ear Plugs (If required)'],
    safety: 'Please switch off the main power and put the lock out/ tag on the power disconnect.',
    remarks: 'For Y maintenance, 3M and 6M must be performed at the same time.',
  },
  checklist: [
    {
      itemNo: 1,
      frequency: 'M3',
      inScope: true,
      instruction: 'Inspection and check safety interlock / emergency stop is functional',
      status: 'DONE',
      remark: null,
    },
    {
      itemNo: 13,
      frequency: 'Y',
      inScope: false,
      instruction: 'Calibrate Workholder, BH Setup, Heater Block Setup, Bond Force',
      status: 'NOT_EVALUATED',
      remark: null,
    },
  ],
  measurements: [
    {
      description: 'Heater Block Flatness Check',
      unit: 'um',
      specDisplay: 'Hmin ≤ 20 um',
      reading: '17.4',
      judgement: 'PASS',
      remark: null,
    },
    {
      description: '91 steps calibration',
      unit: 'μm/encoder',
      specDisplay: '0.19 – 0.21 μm/encoder',
      reading: '0.218',
      judgement: 'FAIL',
      remark: 'Above upper limit',
    },
  ],
  partsUsed: [
    { partNo: 'ASM-4471-FLT', description: 'Air filter element', quantity: '2', remarks: null },
  ],
  attachments: [],
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
  footer: {
    recordId: 'rec-1',
    integrityDigestHex: 'deadbeefcafe',
    renderedAt: '2026-08-14T02:00:00Z',
  },
};

export function recordShape(name: string): PdfRecordInput {
  if (name === 'monthly-only') {
    return {
      ...base,
      documentNumber: 'CE 95 012 00 02',
      frequency: 'M1',
      frequencyScope: ['M1'],
      standingContent: {
        ...base.standingContent,
        frequencyBanner: 'Monthly (1M) Three Monthly (3M) Six Monthly (6M) Yearly (Y)',
      },
      checklist: [
        {
          itemNo: 1,
          frequency: 'M1',
          inScope: true,
          instruction: 'Monthly check',
          status: 'DONE',
          remark: null,
        },
      ],
    };
  }
  if (name === 'long-18-item') {
    return {
      ...base,
      documentNumber: 'CE 95 043 00 01',
      frequencyScope: ['M1', 'M3', 'M6', 'Y'],
      checklist: Array.from({ length: 18 }, (_, i) => ({
        itemNo: i + 1,
        frequency: i < 10 ? 'M1' : i < 14 ? 'M3' : i < 17 ? 'M6' : 'Y',
        inScope: true,
        instruction: `Maintenance instruction number ${i + 1} for the long-form pagination case`,
        status: 'DONE',
        remark: null,
      })),
    };
  }
  if (name === 'voided') {
    // Status flips to VOIDED alongside the notice — a live PdfRecordAssemblyService
    // read never produces a voidNotice without also mapping the job's own status
    // (`JOB_STATUS_FROM_DB[job.status]`) to VOIDED; the brief's literal fixture left
    // `status: 'ARCHIVED'` unchanged here, which no real assembled record does.
    return {
      ...base,
      status: 'VOIDED',
      voidNotice: { reason: 'Wrong machine', voidedAt: '2026-08-15', voidedByName: 'S. Kumar' },
    };
  }
  return base;
}
