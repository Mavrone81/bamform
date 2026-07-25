import { Injectable, Logger } from '@nestjs/common';
import { AuditActionT } from '@prisma/client';
import { AuditEventService } from './audit-event.service';
import {
  type ChainVerificationResult,
  ChainVerificationService,
} from './chain-verification.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PR-099 — the daily scheduled chain-verification job. `worker.ts` calls
 * `run()` once per matching `AUDIT_CHAIN_VERIFY_CRON` minute (gated by
 * `SCHEDULER_ENABLED`, same flag slice 5's job-generation sweep uses — see
 * slice-8-brief.md: "Gate it behind the scheduler-enabled flag like slice 5").
 *
 * On a detected break: records a `chain_break_detected` `audit_event` (an
 * additive `AuditActionT` enum value — see `api/prisma/migrations/
 * .../migration.sql`) documenting the break, AND logs at `error` level with
 * an unmistakable "CRITICAL" marker — PR-SEC-25 / SECURITY_ARCHITECTURE.md's
 * alerting table sets "Audit chain break | any | Critical", the highest
 * severity signal in the system, above outage. No email/notification here —
 * that hook is slice 11 (`docs/BUILD_HANDOFF.md` §3); this is the "clearly-
 * marked critical log line + a persisted flag" the brief accepts as
 * sufficient until slice 11 wires real alerting on top of it.
 *
 * Idempotent: if the LATEST `chain_break_detected` event already reports the
 * same `firstBreakSequence`, this run does not write a second, identical
 * event — repeat runs while the same break is unresolved log the critical
 * line every time (so monitoring never goes quiet) but do not spam the
 * audit log with duplicate rows for a break that has already been recorded.
 * A NEW/different `firstBreakSequence` (or a chain that recovers and later
 * breaks again elsewhere) is always recorded.
 */
@Injectable()
export class AuditChainDailyVerificationService {
  private readonly logger = new Logger(AuditChainDailyVerificationService.name);

  constructor(
    private readonly chainVerification: ChainVerificationService,
    private readonly auditEvents: AuditEventService,
    private readonly prisma: PrismaService,
  ) {}

  async run(): Promise<ChainVerificationResult> {
    const result = await this.chainVerification.verify();

    if (result.intact) {
      this.logger.log(`audit chain verification OK — eventCount=${result.eventCount}`);
      return result;
    }

    this.logger.error(
      `CRITICAL: audit hash chain break detected at sequence ${String(result.firstBreakSequence)} ` +
        '(PR-SEC-25: audit chain break is the highest-severity signal in the system, above ' +
        'outage — see docs/SECURITY_ARCHITECTURE.md §12.3 playbook P2).',
    );

    const alreadyReported = await this.isAlreadyReported(result.firstBreakSequence);
    if (alreadyReported) {
      this.logger.warn(
        `break at sequence ${String(result.firstBreakSequence)} was already recorded by a ` +
          'previous run — not writing a duplicate audit_event (idempotent).',
      );
      return result;
    }

    await this.prisma.$transaction(async (tx) => {
      await this.auditEvents.record(tx, {
        actorId: null,
        action: AuditActionT.chain_break_detected,
        entityType: 'audit_event',
        entityId: null,
        after: {
          firstBreakSequence:
            result.firstBreakSequence === null ? null : Number(result.firstBreakSequence),
          eventCount: result.eventCount,
          checkedAt: result.checkedAt.toISOString(),
        },
      });
    });

    return result;
  }

  private async isAlreadyReported(firstBreakSequence: bigint | null): Promise<boolean> {
    if (firstBreakSequence === null) {
      return false;
    }
    const latest = await this.prisma.auditEvent.findFirst({
      where: { action: AuditActionT.chain_break_detected },
      orderBy: { sequence: 'desc' },
    });
    if (!latest || typeof latest.after !== 'object' || latest.after === null) {
      return false;
    }
    const reportedSequence = (latest.after as { firstBreakSequence?: unknown }).firstBreakSequence;
    return reportedSequence === Number(firstBreakSequence);
  }
}
