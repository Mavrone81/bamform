import type { Prisma } from '@prisma/client';

/**
 * `PM-{year}-{6-digit sequence}` (DBD §6.15). Extracted from
 * `JobGenerationService`'s private helper in slice 18-WORKFLOW so ad-hoc
 * creation (`jobs/adhoc-job.service.ts`, UR-028) draws from the SAME
 * numbering scheme rather than inventing a second one — one sequence, one
 * `job_number` unique index, one thing for a plant to read.
 *
 * Must be called INSIDE the transaction that inserts the job: it reads the
 * current maximum and returns its successor, so anything less than "read and
 * insert in one transaction" is a TOCTOU race. Even inside a transaction two
 * CONCURRENT writers can both read the same maximum (READ COMMITTED gives no
 * gap lock), which surfaces as a `job_number` unique violation (P2002) — the
 * scheduler is single-flight (`SchedulerLockService`, PR-051/I-INV-15) so it
 * cannot race itself, but a planner raising ad-hoc work CAN race a scheduler
 * tick. Callers on that path retry; see `AdhocJobService`.
 */
export async function nextJobNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
  const prefix = `PM-${year}-`;
  const last = await tx.job.findFirst({
    where: { jobNumber: { startsWith: prefix } },
    orderBy: { jobNumber: 'desc' },
    select: { jobNumber: true },
  });
  const lastSeq = last ? Number(last.jobNumber.slice(prefix.length)) : 0;
  return `${prefix}${String(lastSeq + 1).padStart(6, '0')}`;
}
