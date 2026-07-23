import type { CanonicalValue } from './canonical-serialiser';

/**
 * U-SIG-01's fixture. Representative of what PR-093 says the canonical serialisation
 * must cover: job identity, asset identity, template revision identity, every item
 * result, every measurement result, every part used, every attachment hash, the
 * submitter identity and timestamp, and all prior approval steps.
 *
 * This exact shape/values are frozen the moment the golden hash in
 * `content-hash.spec.ts` is committed — changing so much as one field here changes
 * the hash. Do not "tidy up" this fixture later.
 */
export function buildGoldenRecordFixture(): CanonicalValue {
  return {
    job: {
      id: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c4d',
      jobNumber: 'CE95-010-2026-000123',
      assetId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c4e',
      templateRevisionId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c4f',
      frequency: '3M',
      status: 'verified',
    },
    submitter: {
      userId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c50',
      fullName: 'Jane Tan',
      submittedAt: new Date('2026-03-15T02:00:00.000Z'),
    },
    itemResults: [
      {
        itemId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c51',
        stableKey: 'CHK-01',
        status: 'pass',
        remark: null,
      },
      {
        itemId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c52',
        stableKey: 'CHK-02',
        status: 'pass',
        remark: 'Cleaned and re-greased',
      },
    ],
    measurementResults: [
      {
        measurementId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c53',
        stableKey: 'MEAS-01',
        reading: 1.5,
        withinSpec: true,
      },
      {
        measurementId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c54',
        stableKey: 'MEAS-02',
        reading: 24.75,
        withinSpec: true,
      },
    ],
    partsUsed: [
      { partId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c55', partNumber: 'GRS-100', quantity: 2 },
    ],
    attachments: [
      {
        id: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c56',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85',
      },
    ],
    approvalSteps: [
      {
        stageOrdinal: 1,
        actorId: '0190f6d2-3b3a-7c9a-9c1a-2f6e1a2b3c57',
        decision: 'verified',
        signedAt: new Date('2026-03-15T03:30:00.000Z'),
      },
    ],
  };
}
