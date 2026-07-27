import { randomUUID } from 'node:crypto';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture, createUser } from './helpers/fixtures';

const CHECK_VIOLATION = '23514';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeAll();
});

async function insertApprovalStep(params: {
  jobId: string;
  actorId: string;
  action: string;
  reason?: string | null;
  stageOrdinal?: number;
  actedAt?: string; // SQL expression default now()
}) {
  return adminPool.query(
    `INSERT INTO "approval_step"
       ("job_id", "stage_ordinal", "action", "actor_id", "actor_role_code", "reason",
        "acted_at", "content_hash", "signature", "signing_key_id")
     VALUES ($1, $7, $2, $3, 'TEAM_LEADER', $4, COALESCE($8::timestamptz, now()), $5, $6, 'test-kid')`,
    [
      params.jobId,
      params.action,
      params.actorId,
      params.reason ?? null,
      Buffer.from('content-hash-placeholder'),
      Buffer.from('signature-placeholder'),
      params.stageOrdinal ?? 1,
      params.actedAt ?? null,
    ],
  );
}

describe('DBD §7 trigger-enforced invariants', () => {
  it('I-INV-05 rejects a submitter verifying their own record', async () => {
    const submitterId = await createUser('submitter');
    const { jobId } = await createJobFixture(`PM-${randomUUID()}`, 'submitted');

    await adminPool.query(
      'UPDATE "job" SET submitted_by = $1, submitted_at = now() WHERE id = $2',
      [submitterId, jobId],
    );

    await expect(
      insertApprovalStep({ jobId, actorId: submitterId, action: 'verified' }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // Sanity check: a different verifier is accepted.
    const verifierId = await createUser('verifier');
    await expect(
      insertApprovalStep({ jobId, actorId: verifierId, action: 'verified' }),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('SYS-8 (slice 15-SYSWIRE) rejects the SAME person verifying two stages of one record — distinct-verifier trigger backstop', async () => {
    const { jobId } = await createJobFixture(`PM-${randomUUID()}`, 'submitted');
    const submitterId = await createUser('submitter-distinct');
    await adminPool.query(
      'UPDATE "job" SET submitted_by = $1, submitted_at = now() WHERE id = $2',
      [submitterId, jobId],
    );
    const verifierId = await createUser('verifier-both-stages');

    await expect(
      insertApprovalStep({ jobId, actorId: verifierId, action: 'verified', stageOrdinal: 1 }),
    ).resolves.toMatchObject({ rowCount: 1 });

    // Same human, stage 2 — rejected by the trigger even on a direct SQL
    // insert that bypasses the service check.
    await expect(
      insertApprovalStep({ jobId, actorId: verifierId, action: 'verified', stageOrdinal: 2 }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // A different person is accepted.
    const otherId = await createUser('verifier-other');
    await expect(
      insertApprovalStep({ jobId, actorId: otherId, action: 'verified', stageOrdinal: 2 }),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('SYS-8 cycle boundary: a returned step resets the distinct-verifier window — the same person may verify again after rework', async () => {
    const { jobId } = await createJobFixture(`PM-${randomUUID()}`, 'submitted');
    const submitterId = await createUser('submitter-cycle');
    await adminPool.query(
      'UPDATE "job" SET submitted_by = $1, submitted_at = now() WHERE id = $2',
      [submitterId, jobId],
    );
    const verifierId = await createUser('verifier-cycle');
    const returnerId = await createUser('returner-cycle');

    await insertApprovalStep({
      jobId,
      actorId: verifierId,
      action: 'verified',
      stageOrdinal: 1,
      actedAt: '2026-07-27T01:00:00Z',
    });
    await insertApprovalStep({
      jobId,
      actorId: returnerId,
      action: 'returned',
      reason: 'rework required',
      stageOrdinal: 2,
      actedAt: '2026-07-27T02:00:00Z',
    });

    // New cycle — the pre-return signature is superseded; same verifier OK.
    await expect(
      insertApprovalStep({
        jobId,
        actorId: verifierId,
        action: 'verified',
        stageOrdinal: 1,
        actedAt: '2026-07-27T03:00:00Z',
      }),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('I-INV-07 rejects an UPDATE on an archived job', async () => {
    // archived_at is set at INSERT time, not via a follow-up UPDATE — a
    // second UPDATE on an already-archived row would itself be rejected by
    // the very trigger this test is exercising (INV-09).
    const { jobId } = await createJobFixture(`PM-${randomUUID()}`, 'archived', {
      archivedAt: new Date(),
    });

    await expect(
      adminPool.query('UPDATE "job" SET due_on = CURRENT_DATE + 1 WHERE id = $1', [jobId]),
    ).rejects.toThrow(/archived and immutable/i);
  });
});
