import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobStatusT, NotificationChannelT, NotificationStateT, type Prisma } from '@prisma/client';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { PrismaService } from '../prisma/prisma.service';
import { VerifierEligibilityService } from '../queue/verifier-eligibility.service';
import { buildNotificationContent } from './notification-content';
import { NOTIFICATION_TRANSPORT } from './notification.tokens';
import type { EscalationJobPayload, NotificationJobPayload } from './notification-payloads';
import type { NotificationTransport } from './transports/notification-transport';

/**
 * WORKER-side dispatch (PR-150/151: the worker sends, `api` never does —
 * this class is only ever constructed inside `WorkerModule`'s graph, see
 * `notifications.module.ts`). Every dispatch attempt is recorded on
 * `notification` (DBD §6.22) REGARDLESS of `NOTIFICATION_ENABLED` — the row
 * is how a test (or an operator) can assert a dispatch DECISION was made
 * without a real SMTP relay (slice-11a-brief.md item 3).
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
    @Inject(NOTIFICATION_TRANSPORT) private readonly transport: NotificationTransport,
    private readonly eligibility: VerifierEligibilityService,
  ) {}

  async dispatch(payload: NotificationJobPayload): Promise<void> {
    const recipient = await this.prisma.appUser.findUnique({
      where: { id: payload.recipientId },
      select: { id: true, emailCt: true, dekVersion: true },
    });

    const notification = await this.prisma.notification.create({
      data: {
        recipientId: payload.recipientId,
        channel: NotificationChannelT.email,
        templateCode: payload.templateCode,
        entityType: payload.entityType,
        entityId: payload.entityId,
        payload: payload.payload as Prisma.InputJsonValue,
        state: NotificationStateT.queued,
        queuedAt: new Date(),
      },
    });

    if (!recipient) {
      // Never logs `payload.recipientId`'s email (it doesn't have one to log) — only the id, which is not personal data on its own.
      this.logger.warn(
        `notification ${notification.id}: recipient ${payload.recipientId} not found`,
      );
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          state: NotificationStateT.failed,
          failedReason: 'recipient not found',
          attempts: { increment: 1 },
        },
      });
      return;
    }

    // PR-106 — decrypt via the established field-decryption path. Never logged.
    const email = decodeIdentityField(
      recipient.emailCt,
      recipient.dekVersion,
      { column: 'email_ct', rowId: recipient.id },
      this.fieldEncryption,
    );
    const content = buildNotificationContent(payload.templateCode, payload.payload);

    try {
      await this.transport.send({ to: email, subject: content.subject, text: content.text });
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { state: NotificationStateT.sent, sentAt: new Date(), attempts: { increment: 1 } },
      });
      // Logs the transport KIND and template — never the recipient address.
      this.logger.log(
        `notification ${notification.id} dispatched via ${this.transport.kind} transport (template=${payload.templateCode})`,
      );
    } catch (error) {
      const err = error as Error;
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          state: NotificationStateT.failed,
          failedReason: err.message,
          attempts: { increment: 1 },
        },
      });
      this.logger.error(`notification ${notification.id} dispatch failed: ${err.message}`);
    }
  }

  /**
   * PR-077 — a delayed job matured. Defensively re-checks the job is STILL
   * at the escalated stage (it may have been verified/returned/voided in a
   * race with cancellation, or `cancelEscalation` may have failed to reach
   * Redis) before sending — an escalation notification for a decision that
   * was already made is a false alarm UR-050 does not intend.
   */
  async dispatchEscalation(payload: EscalationJobPayload): Promise<void> {
    const job = await this.prisma.job.findUnique({
      where: { id: payload.jobId },
      include: { asset: true },
    });
    if (
      !job ||
      job.status !== JobStatusT.submitted ||
      job.currentStageOrdinal !== payload.stageOrdinal
    ) {
      this.logger.log(
        `escalation for job ${payload.jobId} stage ${payload.stageOrdinal} skipped — no longer at that stage (already actioned)`,
      );
      return;
    }

    const recipientIds = payload.recipientRoleCode
      ? await this.eligibility.findUsersWithRoleInScope(payload.recipientRoleCode, job.asset.areaId)
      : await this.eligibility.findEligibleVerifierIds({
          approvalRouteId: job.approvalRouteId,
          currentStageOrdinal: job.currentStageOrdinal,
          areaId: job.asset.areaId,
        });

    if (recipientIds.length === 0) {
      this.logger.warn(
        `escalation for job ${payload.jobId} stage ${payload.stageOrdinal} matured but no recipient could be resolved`,
      );
      return;
    }

    for (const recipientId of recipientIds) {
      await this.dispatch({
        recipientId,
        templateCode: 'VERIFICATION_ESCALATED',
        entityType: 'job',
        entityId: payload.jobId,
        payload: { jobNumber: job.jobNumber, stageOrdinal: payload.stageOrdinal },
      });
    }
  }
}
