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
}) {
  return adminPool.query(
    `INSERT INTO "approval_step"
       ("job_id", "stage_ordinal", "action", "actor_id", "actor_role_code", "reason",
        "acted_at", "content_hash", "signature", "signing_key_id")
     VALUES ($1, 1, $2, $3, 'TEAM_LEADER', $4, now(), $5, $6, 'test-kid')`,
    [
      params.jobId,
      params.action,
      params.actorId,
      params.reason ?? null,
      Buffer.from('content-hash-placeholder'),
      Buffer.from('signature-placeholder'),
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
