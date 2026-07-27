import { Injectable } from '@nestjs/common';
import { AuditActionT, JobStatusT, type Prisma } from '@prisma/client';
import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { addCalendarMonthsClamped } from './completion-cascade';

/**
 * Slice 17-VOID — the reverse of `CompletionCascadeService`: when an ARCHIVED
 * job is voided (owner decision 2026-07-27: "a voided job never satisfies its
 * schedule period"), every schedule_rule the job's frozen `frequency_scope`
 * subsumed is recomputed AS IF THAT COMPLETION NEVER HAPPENED:
 *
 * - `last_completed_on`/`next_due_on` re-derive from the most recent
 *   STILL-VALID (non-voided, archived) job whose own frozen scope covers the
 *   frequency — same rolling ADR-009 arithmetic as the forward cascade
 *   (`addCalendarMonthsClamped(verified_at, interval)`).
 * - If no valid completion remains, `last_completed_on` clears and
 *   `next_due_on` reverts to the VOIDED JOB'S OWN original `due_on` — the
 *   schedule is back to exactly the period the voided job was meant to
 *   satisfy, and the next scheduler tick generates the replacement (the
 *   period key excludes voided rows since 20260728000010).
 *
 * MUST be called with the SAME transaction client that annotates the void
 * (mirrors `CompletionCascadeService#apply`'s contract) — a void that commits
 * without its recompute would leave the schedule crediting a PM the plant has
 * just declared never happened. Audited per rule, in-txn, mirroring the
 * forward cascade's audit shape (`cause: 'post_archive_void_recompute'`).
 *
 * Already-generated successor jobs are deliberately LEFT ALONE (slice-17
 * brief §2): the recompute affects future generation only; generation stays
 * idempotent per (asset, scope, due_on), so an existing successor for a
 * given period simply satisfies that period's generation. See the slice
 * report's "successor jobs" argument.
 */
@Injectable()
export class VoidScheduleRecomputeService {
  constructor(private readonly audit: AuditEventService) {}

  async apply(
    tx: Prisma.TransactionClient,
    params: {
      /** The job being voided — already flipped to `voided` in this same transaction. */
      jobId: string;
      assetId: string;
      frequencyScope: readonly Frequency[];
      /** The voided job's own original due date — the fallback `next_due_on`. */
      voidedJobDueOn: Date;
      actorId: string | null;
    },
  ): Promise<void> {
    for (const frequency of params.frequencyScope) {
      const intervalMonths = FREQUENCY_INTERVAL_MONTHS[frequency];

      // The most recent still-valid completion covering this frequency:
      // status filter alone excludes the voided job (its row is already
      // `voided` inside this transaction); the id exclusion is belt-and-
      // braces against reordering of the guarded update.
      const prior = await tx.job.findFirst({
        where: {
          assetId: params.assetId,
          id: { not: params.jobId },
          status: JobStatusT.archived,
          frequencyScope: { has: frequency },
          verifiedAt: { not: null },
        },
        orderBy: { verifiedAt: 'desc' },
        select: { id: true, verifiedAt: true },
      });

      const lastCompletedOn = prior?.verifiedAt ?? null;
      const nextDueOn = prior
        ? addCalendarMonthsClamped(prior.verifiedAt!, intervalMonths)
        : params.voidedJobDueOn;

      const row = await tx.scheduleRule.updateMany({
        where: { assetId: params.assetId, frequency },
        data: { lastCompletedOn, nextDueOn },
      });
      if (row.count > 0) {
        await this.audit.record(tx, {
          actorId: params.actorId,
          action: AuditActionT.update,
          entityType: 'schedule_rule',
          entityId: params.assetId,
          after: {
            assetId: params.assetId,
            frequency,
            lastCompletedOn,
            nextDueOn,
            causedByJobId: params.jobId,
            cause: 'post_archive_void_recompute',
            derivedFromJobId: prior?.id ?? null,
          },
        });
      }
    }
  }
}
