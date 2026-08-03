import { Injectable } from '@nestjs/common';
import { AuditActionT } from '@prisma/client';
import type { Job, TitleMachineNumberInput } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { idempotencyKeyRequiredProblem } from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertJobWritable } from './job-status-guard';
import { JOB_FULL_INCLUDE } from './job-include';
import { JobsService } from './jobs.service';
import { toJob } from './mappers';

/**
 * Slice 31-TITLEBLANK — `PUT /jobs/{jobId}/title-machine-number`.
 *
 * The blank in a form's TITLE (`ED____`, `AVS 35-____`, CE 95 050 00 01's
 * bare `______` — 8 of the 12 real templates carry one) is filled by the
 * TECHNICIAN, per record, exactly as it is on paper. Until this slice the
 * only value that could fill it was `asset_document.machine_number`, set once
 * by an admin at tag time; the owner has ruled that wrong, and the migration
 * that used to set it has stopped, so nothing filled the blank at all.
 *
 * Shaped as a sibling of the capture routes it is used alongside:
 *   - `assertJobWritable` (ASSIGNED/IN_PROGRESS only; ARCHIVED gets the more
 *     specific `/errors/record-immutable`), so an archived record can never
 *     have the title it was signed under rewritten. `prevent_archived_job_
 *     update()` is the database backstop for the same rule,
 *   - `Idempotency-Key` REQUIRED (PR-API-16) — this route is reachable from
 *     the offline outbox (`outbox-dispatch.ts`), and row-idempotency alone
 *     would still let a bare retry write a duplicate no-op `audit_event`,
 *   - the value + `audit_event` written in ONE transaction (non-negotiable #3).
 *
 * UNVERSIONED, deliberately — it follows `parts.service.ts#upsertPart`, NOT
 * `results.service.ts`. It neither checks `If-Match` nor bumps the job's
 * `draftVersion`, and the client sends `versioned: false` to match
 * (`sync-engine.ts#appendJobMutation` documents that contract).
 *
 * The reason is measured, not stylistic. `appendJobMutation`'s predicted
 * version is a read-modify-write across two awaits; two mutations appended in
 * the SAME tick both read the same predicted version and the second 409s
 * against the first — a conflict the technician did nothing to cause and
 * cannot understand. The title box flushes its debounce on blur, and blurring
 * it is almost always caused by TAPPING SOMETHING ELSE on the same screen (a
 * checklist button), so those two appends land in one tick every time. It was
 * reproducible on the first interaction of the offline journey (O-23a) before
 * this route was unversioned. Last-write-wins on a single scalar the one
 * assigned technician types on one device is the correct trade, and it is the
 * same one slice 30 made for parts.
 *
 * For the same reason there is no ASSIGNED -> IN_PROGRESS transition here
 * (that too is a `job` write, and parts do not do it either). Submit requires
 * IN_PROGRESS, which recording any result already produces.
 *
 * NOT validated here for presence: an empty blank is legitimate all the way
 * through drafting and a whole offline shift. The requirement bites once, at
 * SUBMIT (`submission.service.ts`), and only for a title that actually
 * carries a fillable run.
 */
@Injectable()
export class TitleMachineNumberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async recordTitleMachineNumber(
    jobId: string,
    dto: TitleMachineNumberInput,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    if (!idempotencyKey) {
      throw idempotencyKeyRequiredProblem();
    }
    const fingerprint = this.idempotency.fingerprint({ jobId, ...dto });
    const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
    if (replay) {
      return replay.body as Job;
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertJobWritable(job.status);

    const before = job.titleMachineNumber;
    const after = dto.titleMachineNumber;

    return this.prisma.$transaction(async (tx) => {
      // `titleMachineNumber` and nothing else — see the class doc: no status
      // transition, no `draftVersion` bump. Writing either would make this an
      // ordinary versioned mutation and reintroduce the self-inflicted
      // conflict the unversioned shape exists to avoid.
      const row = await tx.job.update({
        where: { id: jobId },
        data: { titleMachineNumber: after },
        include: JOB_FULL_INCLUDE,
      });

      // The value is technician free text that ends up in the title of a
      // controlled record, so the change is auditable in both directions —
      // `before` is the only evidence a previously-entered number was
      // replaced (mirrors `parts.service.ts#upsertPart`'s soft-remove
      // pre-image). It is machine identification, not personal data.
      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: before == null ? AuditActionT.create : AuditActionT.update,
        entityType: 'job',
        entityId: jobId,
        before: before == null ? null : { titleMachineNumber: before },
        after: { titleMachineNumber: after },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      const dtoOut = toJob(row);
      await this.idempotency.recordWithin(
        tx,
        {
          key: idempotencyKey,
          userId: actor.actorId,
          endpoint: 'PUT /jobs/{jobId}/title-machine-number',
          fingerprint,
        },
        { status: 200, body: dtoOut },
      );

      return dtoOut;
    });
  }
}
