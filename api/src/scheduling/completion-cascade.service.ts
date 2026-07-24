import { Injectable } from '@nestjs/common';
import { AuditActionT, type Prisma } from '@prisma/client';
import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { computeCompletionCascade } from './completion-cascade';

/**
 * PR-055/PR-056 — the seam slice 7's verify transaction calls. Deliberately
 * NOT wired to any endpoint or trigger in this slice (the brief: "the actual
 * call from the verify transaction lands in slice 7"); this only exists so
 * that when slice 7 implements `POST /jobs/{id}/verify`, updating every
 * schedule_rule subsumed by the completed job's `frequency_scope` is a
 * one-line call into already-tested logic, not new code written under
 * pressure inside the approval slice.
 *
 * Must be called with the SAME transaction client the verify endpoint uses
 * to flip the job to VERIFIED/ARCHIVED (PR-098's "audit write shares the
 * transaction" discipline — same reasoning as `AuditEventService`).
 */
@Injectable()
export class CompletionCascadeService {
  constructor(private readonly audit: AuditEventService) {}

  async apply(
    tx: Prisma.TransactionClient,
    params: {
      jobId: string;
      assetId: string;
      frequencyScope: readonly Frequency[];
      verifiedOn: Date;
      actorId: string | null;
    },
  ): Promise<void> {
    const scoped = params.frequencyScope.map((frequency) => ({
      frequency,
      intervalMonths: FREQUENCY_INTERVAL_MONTHS[frequency],
    }));
    const updates = computeCompletionCascade(params.verifiedOn, scoped);

    for (const update of updates) {
      const row = await tx.scheduleRule.updateMany({
        where: { assetId: params.assetId, frequency: update.frequency },
        data: { lastCompletedOn: update.lastCompletedOn, nextDueOn: update.nextDueOn },
      });
      if (row.count > 0) {
        await this.audit.record(tx, {
          actorId: params.actorId,
          action: AuditActionT.update,
          entityType: 'schedule_rule',
          entityId: params.assetId,
          after: {
            assetId: params.assetId,
            frequency: update.frequency,
            lastCompletedOn: update.lastCompletedOn,
            nextDueOn: update.nextDueOn,
            causedByJobId: params.jobId,
          },
        });
      }
    }
  }
}
