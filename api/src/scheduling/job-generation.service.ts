import { Injectable, Logger } from '@nestjs/common';
import {
  AuditActionT,
  JobStatusT,
  Prisma,
  type Asset,
  type AssetDocument,
  type AssetType,
  type ScheduleRule,
} from '@prisma/client';
import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { AssignableUserService } from '../jobs/assignable-user.service';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveCascadeFrequencyScope, resolveCascadeItems } from './frequency-cascade';
import { nextJobNumber } from './job-number';

export interface GenerateDueJobsResult {
  /** schedule_rule rows whose asset/lead-time made them candidates this run. */
  evaluated: number;
  /** New `job` rows inserted this run. */
  generated: number;
  /** Candidates that already had a matching job (PR-052 idempotency — I-INV-14). */
  alreadyExists: number;
  /** Candidates skipped because the template has no active items in scope, or no current revision. */
  skippedNoItems: number;
  /** Slice 32-PLANNERJOB — jobs generated ASSIGNED, from the rule's standing assignee. */
  assignedFromDefault: number;
  /**
   * Slice 32-PLANNERJOB — jobs generated UNASSIGNED because the rule named a
   * standing assignee who is no longer eligible (left, role revoked, area
   * scope narrowed). The job IS still created; this counter is what makes the
   * silence impossible. See `resolveDefaultAssignee`.
   */
  defaultAssigneeUnavailable: number;
}

/**
 * Slice 27-ASSETDOC: a rule reaches its machine THROUGH its document. The
 * template comes from the document; the approval route and lead time still come
 * from the machine's asset type (both are family-wide properties — the approval
 * chain is a property of the machine family, not of the document).
 */
type RuleWithDocument = ScheduleRule & {
  assetDocument: AssetDocument & { asset: Asset & { assetType: AssetType } };
};

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** `Date`-only (no time-of-day) comparison — `due_on`/`next_due_on` are DATE columns. */
function dateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * PR-ENV: the lead time used for a machine whose asset type sets none. The
 * deployment overrides it with `DEFAULT_LEAD_TIME_DAYS`.
 */
export const DEFAULT_LEAD_TIME_DAYS = 30;

/**
 * `DEFAULT_LEAD_TIME_DAYS` as an actual number of days.
 *
 * The old inline `Number(config.get(...) ?? 30)` turned a typo'd env value
 * into `NaN`, and `nextDueOn > today + NaN` is FALSE for every rule — which
 * would have made the scheduler generate the entire plant's remaining
 * schedule on one sweep rather than fail loudly. A non-finite or non-positive
 * value falls back to the documented default instead.
 */
export function resolveDefaultLeadTimeDays(raw: unknown): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LEAD_TIME_DAYS;
}

/**
 * THE GENERATION BOUNDARY, in one place — the earliest date on which a sweep
 * will raise the job for `nextDueOn`.
 *
 * `generateDueJobs` skips a rule while `nextDueOn > today + leadTimeDays`,
 * i.e. it generates once `today >= nextDueOn - leadTimeDays`. Both are whole
 * UTC calendar days (`next_due_on` and `due_on` are DATE columns), so the two
 * forms are the same inequality rearranged — and it is stated ONCE here
 * because `GET /schedule` has to tell a planner the same boundary the sweep
 * applies, and a second hand-written copy of it would eventually disagree.
 */
export function jobGenerationOpensOn(nextDueOn: Date, leadTimeDays: number): Date {
  return addDays(dateOnly(nextDueOn), -leadTimeDays);
}

/**
 * PR-050/PR-052 — evaluates every active `schedule_rule` due within its
 * asset type's lead time and generates the `job` rows PR-053's cascade
 * says are missing. Idempotent: a repeated call (whether because the
 * scheduler tick simply runs twice, or a worker crashed after insert but
 * before its surrounding bookkeeping committed) creates no duplicate
 * (I-INV-14) — enforced by the database (`job`'s
 * `(asset_document_id, frequency_scope, due_on)` partial unique index, not merely an
 * application-level check-then-insert, which would leave a TOCTOU race
 * inside a single process's own run).
 *
 * Concurrency ACROSS worker instances is `SchedulerLockService`'s job
 * (PR-051, I-INV-15) — this service assumes it is never invoked twice
 * concurrently for the same tick.
 */
@Injectable()
export class JobGenerationService {
  private readonly logger = new Logger(JobGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
    private readonly assignableUsers: AssignableUserService,
    private readonly notificationQueue: NotificationQueueService,
  ) {}

  async generateDueJobs(today: Date, defaultLeadTimeDays: number): Promise<GenerateDueJobsResult> {
    const rules = (await this.prisma.scheduleRule.findMany({
      // U-SCH-05 extended by slice 27: a DEACTIVATED document generates no
      // further jobs, exactly as a deactivated asset does not. Deactivation
      // (never deletion, INV-16) is how an admin retires a document while its
      // history stays resolvable.
      where: { active: true, assetDocument: { active: true } },
      include: { assetDocument: { include: { asset: { include: { assetType: true } } } } },
    })) as RuleWithDocument[];

    const result: GenerateDueJobsResult = {
      evaluated: 0,
      generated: 0,
      alreadyExists: 0,
      skippedNoItems: 0,
      assignedFromDefault: 0,
      defaultAssigneeUnavailable: 0,
    };

    for (const rule of rules) {
      const asset = rule.assetDocument.asset;
      // U-SCH-05: a deactivated asset generates no further jobs.
      if (!asset.active || asset.status !== 'active') {
        continue;
      }

      const leadTimeDays = asset.assetType.leadTimeDays ?? defaultLeadTimeDays;
      // Stated through the shared boundary rather than inline, so `GET
      // /schedule`'s `jobGenerationOpensOn` and this candidate test are
      // provably the same condition (see the function's own note).
      if (dateOnly(today) < jobGenerationOpensOn(rule.nextDueOn, leadTimeDays)) {
        continue; // not due within the lead-time window yet
      }

      result.evaluated += 1;
      const outcome = await this.generateForRule(rule, asset, result);
      if (outcome === 'generated') result.generated += 1;
      else if (outcome === 'exists') result.alreadyExists += 1;
      else result.skippedNoItems += 1;
    }

    return result;
  }

  /**
   * Slice 32-PLANNERJOB — WHO the generated job goes to, and what happens when
   * that person is no longer eligible.
   *
   * THE DECISION, stated once so it cannot be re-litigated in a diff: an
   * ineligible standing assignee produces an UNASSIGNED JOB, NOT A REFUSAL.
   *
   * Refusing to generate was the other candidate and it is wrong. The job IS
   * the controlled maintenance record — the artefact the ISO audit asks for —
   * and a plant that silently stops raising PM records because a technician
   * left the company has an audit finding, not a staffing problem. The
   * schedule would also stall: `next_due_on` only advances on completion, so
   * a refused generation leaves the rule overdue for ever with nothing to
   * complete.
   *
   * But it must never be QUIET, which was the real hazard: a job that arrives
   * unassigned is invisible to every MAINTAINER (`job-access.ts` shows them
   * only their own), so "the work stopped being assigned" would look exactly
   * like "there was no work". So one lapse leaves three traces:
   *   * the sweep's own `defaultAssigneeUnavailable` counter, logged by
   *     `SchedulerService` on every run;
   *   * an ERROR log naming the rule, the job and the user that failed;
   *   * the job's `create` AUDIT EVENT, which carries
   *     `defaultAssigneeUnavailable: true` and the id — permanent, in the
   *     hash chain, and the only one of the three that survives log rotation.
   * And the planner grid says it BEFORE the sweep does: `GET /schedule`
   * reports `defaultAssignee.eligible = false` on the row.
   */
  private async resolveDefaultAssignee(
    rule: RuleWithDocument,
    asset: Asset,
    result: GenerateDueJobsResult,
  ): Promise<{ assigneeId: string | null; unavailableId: string | null }> {
    // The overwhelmingly common path, and every pre-slice-32 row: no standing
    // assignee, so the job is born SCHEDULED and unassigned exactly as before.
    if (!rule.defaultAssigneeId) {
      return { assigneeId: null, unavailableId: null };
    }
    const eligible = await this.assignableUsers.isAssignable(rule.defaultAssigneeId, asset.areaId);
    if (eligible) {
      result.assignedFromDefault += 1;
      return { assigneeId: rule.defaultAssigneeId, unavailableId: null };
    }
    result.defaultAssigneeUnavailable += 1;
    this.logger.error(
      `schedule_rule ${rule.id} names default assignee ${rule.defaultAssigneeId}, who is no longer ` +
        `assignable for asset ${asset.id} (inactive, no result-recording role, or out of area scope) — ` +
        'generating this job UNASSIGNED. Set a new default assignee on the plan.',
    );
    return { assigneeId: null, unavailableId: rule.defaultAssigneeId };
  }

  private async generateForRule(
    rule: RuleWithDocument,
    asset: Asset & { assetType: AssetType },
    result: GenerateDueJobsResult,
  ): Promise<'generated' | 'exists' | 'skipped'> {
    // Slice 27: the form comes from the DOCUMENT. Two documents on one machine
    // therefore raise jobs against two DIFFERENT template revisions — which is
    // the whole point, and was impossible while the template was reached
    // through `asset.assetType.formTemplateId`.
    const revision = await this.prisma.templateRevision.findFirst({
      where: { formTemplateId: rule.assetDocument.formTemplateId, status: 'current' },
    });
    if (!revision) {
      return 'skipped';
    }

    const activeItems = await this.prisma.templateItem.findMany({
      where: { templateRevisionId: revision.id, active: true },
      select: { frequency: true },
    });
    const candidates = activeItems.map((item) => ({
      frequency: item.frequency as unknown as Frequency,
      intervalMonths: FREQUENCY_INTERVAL_MONTHS[item.frequency as unknown as Frequency],
    }));

    const standingContent = revision.standingContent as {
      cascadeOverride?: Record<string, string[]>;
    } | null;
    const override = standingContent?.cascadeOverride?.[rule.frequency] as Frequency[] | undefined;

    const resolvedItems = resolveCascadeItems(rule.intervalMonths, candidates, override);
    if (resolvedItems.length === 0) {
      return 'skipped';
    }
    const frequencyScope = resolveCascadeFrequencyScope(rule.intervalMonths, candidates, override);

    // Slice 32-PLANNERJOB — resolved BEFORE the transaction: it is a read
    // against `app_user`/`user_role`/`user_area_scope` and holding the job
    // insert's transaction open across it would widen the window on the very
    // table the idempotency index protects.
    const { assigneeId, unavailableId } = await this.resolveDefaultAssignee(rule, asset, result);
    const now = new Date();

    try {
      const createdJob = await this.prisma.$transaction(async (tx) => {
        const jobNumber = await nextJobNumber(tx, rule.nextDueOn.getUTCFullYear());
        const job = await tx.job.create({
          data: {
            jobNumber,
            assetId: asset.id,
            assetDocumentId: rule.assetDocument.id,
            templateRevisionId: revision.id,
            // Unchanged, deliberately: the approval chain is a property of the
            // machine family, not of the document. Only the FORM moved.
            approvalRouteId: asset.assetType.approvalRouteId,
            frequency: rule.frequency,
            frequencyScope,
            dueOn: rule.nextDueOn,
            generatedAt: now,
            // Slice 32-PLANNERJOB. A rule with an eligible standing assignee
            // generates a job that is ALREADY ASSIGNED — which is the whole
            // point: `job-access.ts` shows a MAINTAINER only their own jobs,
            // so an unassigned job is invisible to the person who should do
            // it. The status follows the same PRD §5.1 edge a manual
            // assignment takes (SCHEDULED -> ASSIGNED); with no assignee it
            // stays SCHEDULED, exactly as every job before this slice.
            assignedTo: assigneeId,
            assignedAt: assigneeId ? now : null,
            status: assigneeId ? JobStatusT.assigned : JobStatusT.scheduled,
          },
        });

        await this.audit.record(tx, {
          actorId: null,
          action: AuditActionT.create,
          entityType: 'job',
          entityId: job.id,
          after: {
            jobNumber: job.jobNumber,
            assetId: asset.id,
            assetDocumentId: rule.assetDocument.id,
            frequency: rule.frequency,
            frequencyScope,
            dueOn: job.dueOn,
            status: job.status,
            assignedTo: assigneeId,
            // THE PERMANENT TRACE. Present only when a standing assignee was
            // named and rejected — the audit chain is the one record of this
            // that outlives log rotation, and without it a job that quietly
            // arrived unassigned would be indistinguishable from a rule that
            // never had a default at all. Ids only: `full_name` is encrypted
            // and `audit_event` is append-only with 7-year retention
            // (PR-SEC-02).
            ...(unavailableId
              ? { defaultAssigneeUnavailable: true, defaultAssigneeId: unavailableId }
              : {}),
          },
        });
        return job;
      });

      // UR-061 — the assignee has to LEARN they have work, exactly as a manual
      // assignment tells them (`AssignmentService`). Best-effort and
      // post-commit, by the same rule: a notification failure must never
      // un-generate a job that is already the controlled record.
      if (assigneeId) {
        try {
          await this.notificationQueue.enqueueNotification({
            recipientId: assigneeId,
            templateCode: 'JOB_ASSIGNED',
            entityType: 'job',
            entityId: createdJob.id,
            payload: { jobNumber: createdJob.jobNumber, assetCode: asset.code },
          });
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `generated-job assignment notification enqueue failed for job ${createdJob.id}: ${err.message}`,
          );
        }
      }
      return 'generated';
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // I-INV-14: (asset_document_id, frequency_scope, due_on) already has a
        // job — idempotent no-op. Keyed by DOCUMENT since slice 27: under the
        // old asset-keyed index a second document due the same day at the same
        // frequency landed here and was silently never raised.
        this.logger.debug(
          `job already generated for document=${rule.assetDocument.id} scope=${frequencyScope.join(',')} due=${rule.nextDueOn.toISOString()}`,
        );
        return 'exists';
      }
      throw error;
    }
  }
}
