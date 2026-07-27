import { computeContentHash } from '../crypto/content-hash';
import { canonicalSerialiseToString } from '../crypto/canonical-serialiser';
import { buildCanonicalJobRecord, type CanonicalJobRecordInput } from './canonical-job-record';

function baseInput(): CanonicalJobRecordInput {
  return {
    job: {
      id: 'job-1',
      jobNumber: 'PM-2026-000001',
      assetId: 'asset-1',
      templateRevisionId: 'rev-1',
      frequency: 'M3',
      status: 'SUBMITTED',
    },
    templateRevision: {
      id: 'rev-1',
      formTemplateId: 'tmpl-1',
      revisionCode: 'A',
      sequenceOrdinal: 1,
    },
    submitter: { userId: 'user-1', submittedAt: new Date('2026-07-24T02:00:00.000Z') },
    itemResults: [
      { id: 'item-1', templateItemId: 'ti-1', status: 'DONE', remark: null },
      { id: 'item-2', templateItemId: 'ti-2', status: 'NOT_DONE', remark: 'jammed' },
    ],
    measurementResults: [
      {
        id: 'meas-1',
        templateMeasurementId: 'tm-1',
        readingNumeric: '24.750000',
        readingText: null,
        judgement: 'PASS',
      },
    ],
    partsUsed: [{ id: 'part-1', partNo: 'GRS-100', description: 'Grease', quantity: '2.000' }],
    attachments: [
      { id: 'att-1', sha256Hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85' },
    ],
    approvalSteps: [
      {
        id: 'step-1',
        stageOrdinal: 1,
        action: 'VERIFIED',
        actorId: 'verifier-1',
        onBehalfOfId: null,
        reason: null,
        actedAt: new Date('2026-07-24T03:00:00.000Z'),
      },
    ],
  };
}

describe('buildCanonicalJobRecord (PR-093/ADR-010, slice-3 HARD GATE resolution)', () => {
  it('serialises deterministically and hashes reproducibly', () => {
    const a = computeContentHash(buildCanonicalJobRecord(baseInput()));
    const b = computeContentHash(buildCanonicalJobRecord(baseInput()));
    expect(a.equals(b)).toBe(true);
  });

  it('is independent of input array order — every array is sorted by id internally', () => {
    const input = baseInput();
    input.itemResults.reverse();
    const shuffled = computeContentHash(buildCanonicalJobRecord(input));
    const original = computeContentHash(buildCanonicalJobRecord(baseInput()));
    expect(shuffled.equals(original)).toBe(true);
  });

  it('a changed measurement reading changes the hash', () => {
    const input = baseInput();
    input.measurementResults[0].readingNumeric = '24.750001';
    const changed = computeContentHash(buildCanonicalJobRecord(input));
    const original = computeContentHash(buildCanonicalJobRecord(baseInput()));
    expect(changed.equals(original)).toBe(false);
  });

  it('a high-precision (>15 significant digit) NUMERIC(18,6) reading serialises losslessly, not via a JS number', () => {
    const input = baseInput();
    input.measurementResults[0].readingNumeric = '123456789012.123456';
    const serialised = canonicalSerialiseToString(buildCanonicalJobRecord(input));
    expect(serialised).toContain('"reading":123456789012.123456');
  });

  it('trailing-zero decimal variants of the same reading hash identically (U-SIG-04 extended to CanonicalDecimal)', () => {
    const a = baseInput();
    a.measurementResults[0].readingNumeric = '24.750000';
    const b = baseInput();
    b.measurementResults[0].readingNumeric = '24.75';
    expect(
      computeContentHash(buildCanonicalJobRecord(a)).equals(
        computeContentHash(buildCanonicalJobRecord(b)),
      ),
    ).toBe(true);
  });

  it('a text reading (readingNumeric null) falls back to readingText, never coerced to a number', () => {
    const input = baseInput();
    input.measurementResults[0].readingNumeric = null;
    input.measurementResults[0].readingText = 'OK';
    const serialised = canonicalSerialiseToString(buildCanonicalJobRecord(input));
    expect(serialised).toContain('"reading":"OK"');
  });

  it('the approval step being signed is INCLUDED (binds the signature to itself)', () => {
    const serialised = canonicalSerialiseToString(buildCanonicalJobRecord(baseInput()));
    expect(serialised).toContain('"id":"step-1"');
    expect(serialised).toContain('"actorId":"verifier-1"');
  });

  it('a changed approval step (e.g. different actor) changes the hash — the signature is content-bound to itself too', () => {
    const input = baseInput();
    input.approvalSteps[0].actorId = 'someone-else';
    const changed = computeContentHash(buildCanonicalJobRecord(input));
    const original = computeContentHash(buildCanonicalJobRecord(baseInput()));
    expect(changed.equals(original)).toBe(false);
  });

  it('quantity (part_used, NUMERIC(12,3)) also uses CanonicalDecimal, not a JS number', () => {
    const input = baseInput();
    input.partsUsed[0].quantity = '2.5';
    const serialised = canonicalSerialiseToString(buildCanonicalJobRecord(input));
    expect(serialised).toContain('"quantity":2.5');
  });

  // ------------------------------------------------- slice 17-VOID lockdown

  it('U-VOID-03: the canonical serialisation contains NO void annotation fields — the exact key sets are pinned', () => {
    // Slice 17's non-negotiable: void is an ANNOTATION, never a mutation.
    // `void_reason`/`voided_by`/`voided_at` must NEVER enter the signed
    // canonical content, or voiding an archived record would break every
    // stored signature. This pins the canonical shape's exact key sets so a
    // future edit that adds a void field (or anything else) to the signed
    // content fails HERE, loudly, instead of silently invalidating the
    // archive (the same failure class U-SIG-01's golden hash guards).
    const canonical = buildCanonicalJobRecord(baseInput()) as Record<string, unknown>;
    expect(Object.keys(canonical).sort()).toEqual([
      'approvalSteps',
      'attachments',
      'itemResults',
      'job',
      'measurementResults',
      'partsUsed',
      'submitter',
      'templateRevision',
    ]);
    expect(Object.keys(canonical.job as Record<string, unknown>).sort()).toEqual([
      'assetId',
      'frequency',
      'id',
      'jobNumber',
      'status',
      'templateRevisionId',
    ]);
    const serialised = canonicalSerialiseToString(buildCanonicalJobRecord(baseInput()));
    expect(serialised.toLowerCase()).not.toContain('void');
  });
});
