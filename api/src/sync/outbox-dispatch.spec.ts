import { matchOutboxRoute } from './outbox-dispatch';

const JOB_ID = '0192e7a1-1111-7000-8000-000000000001';
const ITEM_ID = '0192e7a1-2222-7000-8000-000000000002';
const MEASUREMENT_ID = '0192e7a1-3333-7000-8000-000000000003';

describe('matchOutboxRoute — outbox mutation-path allowlist (PR-API-24..27)', () => {
  it('matches PUT /jobs/{jobId}/items/{templateItemId}', () => {
    expect(matchOutboxRoute('PUT', `/jobs/${JOB_ID}/items/${ITEM_ID}`)).toEqual({
      kind: 'item',
      jobId: JOB_ID,
      templateItemId: ITEM_ID,
    });
  });

  it('matches PUT /jobs/{jobId}/measurements/{templateMeasurementId}', () => {
    expect(matchOutboxRoute('PUT', `/jobs/${JOB_ID}/measurements/${MEASUREMENT_ID}`)).toEqual({
      kind: 'measurement',
      jobId: JOB_ID,
      templateMeasurementId: MEASUREMENT_ID,
    });
  });

  it('matches POST /jobs/{jobId}/parts', () => {
    expect(matchOutboxRoute('POST', `/jobs/${JOB_ID}/parts`)).toEqual({
      kind: 'part',
      jobId: JOB_ID,
    });
  });

  it('PR-API-26: rejects /jobs/{jobId}/submit — submit is never routed through the outbox', () => {
    expect(matchOutboxRoute('POST', `/jobs/${JOB_ID}/submit`)).toBeNull();
  });

  it('PR-API-27: rejects /jobs/{jobId}/attachments — attachments are a separate channel', () => {
    expect(matchOutboxRoute('POST', `/jobs/${JOB_ID}/attachments`)).toBeNull();
  });

  it('rejects an otherwise-allowed path with the WRONG method', () => {
    expect(matchOutboxRoute('POST', `/jobs/${JOB_ID}/items/${ITEM_ID}`)).toBeNull();
    expect(matchOutboxRoute('PUT', `/jobs/${JOB_ID}/parts`)).toBeNull();
  });

  it('rejects DELETE on anything (non-negotiable #7: no DELETE on record tables)', () => {
    expect(matchOutboxRoute('DELETE', `/jobs/${JOB_ID}/items/${ITEM_ID}`)).toBeNull();
    expect(matchOutboxRoute('DELETE', `/jobs/${JOB_ID}/parts`)).toBeNull();
  });

  it('rejects a path with an extra trailing segment (not exactly the allowed shape)', () => {
    expect(matchOutboxRoute('PUT', `/jobs/${JOB_ID}/items/${ITEM_ID}/extra`)).toBeNull();
  });

  it('rejects a completely unrelated path', () => {
    expect(matchOutboxRoute('GET', '/jobs')).toBeNull();
    expect(matchOutboxRoute('GET', '/audit-events')).toBeNull();
  });
});
