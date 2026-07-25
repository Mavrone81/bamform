import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActionT } from '@prisma/client';
import type { Attachment } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import {
  attachmentRejectedProblem,
  idempotencyKeyRequiredProblem,
  notFoundProblem,
} from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { toBytes } from '../common/prisma-bytes';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../storage/minio.service';
import { JobAccessService } from './job-access';
import { assertJobWritable } from './job-status-guard';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { sniffImageContentType } from './magic-byte';
import { toAttachment } from './mappers';

export interface UploadAttachmentInput {
  buffer: Buffer;
  originalFilename?: string;
  itemResultId?: string;
}

/**
 * PR-034/PR-011/PR-012/ADR-007 — attachments streamed THROUGH the api to
 * MinIO (never presigned), magic-byte content-validated (S-30), size- and
 * per-job-capped (S-32, `ATTACHMENT_MAX_BYTES`/`ATTACHMENT_MAX_PER_JOB`),
 * fetch authorised on EVERY access (S-19/I-INV-19) — see `attachments
 * .controller.ts` for the two HTTP endpoints this backs.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly maxBytes: number;
  private readonly maxPerJob: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly jobsRepo: JobsRepository,
    private readonly access: JobAccessService,
    private readonly minio: MinioService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
    config: ConfigService,
  ) {
    this.maxBytes = Number(config.get('ATTACHMENT_MAX_BYTES') ?? 10_485_760);
    this.maxPerJob = Number(config.get('ATTACHMENT_MAX_PER_JOB') ?? 30);
  }

  async upload(
    jobId: string,
    input: UploadAttachmentInput,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Attachment> {
    if (!idempotencyKey) {
      throw idempotencyKeyRequiredProblem();
    }

    if (input.buffer.length === 0) {
      throw attachmentRejectedProblem('The uploaded file is empty.');
    }
    // S-32: size cap enforced server-side, never trusting a client-declared size.
    if (input.buffer.length > this.maxBytes) {
      throw attachmentRejectedProblem(
        `Attachment exceeds the ${this.maxBytes}-byte limit (ATTACHMENT_MAX_BYTES).`,
      );
    }

    // S-30: magic-byte content sniff — the declared/inferred MIME type and
    // filename extension are NEVER trusted for this decision.
    const sniffedContentType = sniffImageContentType(input.buffer);
    if (!sniffedContentType) {
      throw attachmentRejectedProblem(
        'File content is not a recognised image/jpeg, image/png or image/webp (magic-byte check failed).',
      );
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertJobWritable(job.status);

    if (input.itemResultId && !job.itemResults.some((r) => r.id === input.itemResultId)) {
      throw notFoundProblem('Item result', input.itemResultId);
    }

    const existingCount = await this.prisma.attachment.count({ where: { jobId } });
    if (existingCount >= this.maxPerJob) {
      throw attachmentRejectedProblem(
        `This job already has the maximum of ${this.maxPerJob} attachments (ATTACHMENT_MAX_PER_JOB).`,
      );
    }

    const sha256 = createHash('sha256').update(input.buffer).digest();
    const fingerprint = this.idempotency.fingerprint({
      jobId,
      itemResultId: input.itemResultId ?? null,
      sha256: sha256.toString('hex'),
      byteSize: input.buffer.length,
    });
    const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
    if (replay) {
      return replay.body as Attachment;
    }

    const attachmentId = randomUUID();
    const objectKey = buildObjectKey(jobId, attachmentId);

    // MinIO write happens OUTSIDE the Postgres transaction (two different
    // systems, ADR-007) — sequenced first, so a DB row is never created
    // pointing at an object that was never actually stored. If the DB insert
    // below fails after this succeeds, the object is orphaned in MinIO
    // (logged), never data loss the other way around.
    await this.minio.putObject(objectKey, input.buffer, sniffedContentType);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.attachment.create({
          data: {
            id: attachmentId,
            jobId,
            itemResultId: input.itemResultId ?? null,
            objectKey,
            originalFilename: input.originalFilename ?? null,
            contentType: sniffedContentType,
            byteSize: input.buffer.length,
            sha256: toBytes(sha256),
            uploadedBy: actor.actorId,
            uploadedAt: new Date(),
            uploadState: 'received',
          },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'attachment',
          entityId: row.id,
          after: { contentType: row.contentType, byteSize: Number(row.byteSize) },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        const dtoOut = toAttachment(row);
        await this.idempotency.recordWithin(
          tx,
          {
            key: idempotencyKey,
            userId: actor.actorId,
            endpoint: 'POST /jobs/{jobId}/attachments',
            fingerprint,
          },
          { status: 201, body: dtoOut },
        );

        return dtoOut;
      });
    } catch (error) {
      this.logger.warn(
        `attachment DB insert failed after MinIO write succeeded — orphaned object ${objectKey}: ${String(error)}`,
      );
      throw error;
    }
  }

  /**
   * S-19/I-INV-19 — authorisation evaluated on EVERY fetch, never a
   * presigned URL (ADR-007/PR-011). The job-access check runs BEFORE MinIO
   * is ever touched, so an unauthorised caller never causes the object to be
   * read off disk, let alone served.
   */
  async fetch(
    jobId: string,
    attachmentId: string,
    actor: ActorMeta,
    roles: string[],
  ): Promise<{ stream: Readable; contentType: string; byteSize: number; filename: string | null }> {
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.jobId !== jobId) {
      throw notFoundProblem('Attachment', attachmentId);
    }

    const job = await this.jobsRepo.findByIdForAccess(jobId);
    if (!job) {
      throw notFoundProblem('Job', jobId);
    }
    await this.access.assertAccessible(
      { userId: actor.actorId, roles },
      { assignedTo: job.assignedTo, areaId: job.asset.areaId },
    );

    const stream = await this.minio.getObjectStream(attachment.objectKey);
    return {
      stream,
      contentType: attachment.contentType,
      byteSize: Number(attachment.byteSize),
      filename: attachment.originalFilename,
    };
  }
}

/** DBD §6.19: `records/{yyyy}/{job_id}/{attachment_id}`. */
function buildObjectKey(jobId: string, attachmentId: string): string {
  const year = new Date().getUTCFullYear();
  return `records/${year}/${jobId}/${attachmentId}`;
}
