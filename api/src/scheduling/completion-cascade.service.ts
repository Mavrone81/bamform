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
 *
 * Slice 27-ASSETDOC — scoped by `assetDocumentId`, NEVER by `assetId`. Until
 * slice 27 a machine carried one document and the two were interchangeable.
 * They are not any more: TE7 carries a monthly pH-meter check AND its monthly
 * preventive maintenance, and an asset-scoped update advanced BOTH rules from
 * one completion. The pH check would then simply stop coming due — no error,
 * no overdue flag, nothing to notice until an audit. See
 * `test/integration/cross-document-schedule.spec.ts`.
 */
@Injectable()
export class CompletionCascadeService {
  constructor(private readonly audit: AuditEventService) {}

  async apply(
    tx: Prisma.TransactionClient,
    params: {
      jobId: string;
      /** The document the completed job satisfies — the ONLY schedule it advances. */
      assetDocumentId: string;
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
        where: { assetDocumentId: params.assetDocumentId, frequency: update.frequency },
        data: { lastCompletedOn: update.lastCompletedOn, nextDueOn: update.nextDueOn },
      });
      if (row.count > 0) {
        await this.audit.record(tx, {
          actorId: params.actorId,
          action: AuditActionT.update,
          entityType: 'schedule_rule',
          // The DOCUMENT, not the machine: with several documents per machine an
          // asset-keyed audit row no longer says which schedule moved.
          entityId: params.assetDocumentId,
          after: {
            assetDocumentId: params.assetDocumentId,
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
