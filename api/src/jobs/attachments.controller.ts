import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Get,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { AttachmentsService } from './attachments.service';
import { JOB_RECORD_ROLES } from './job-access';

/**
 * PR-034/PR-011/ADR-007. Split from `jobs.controller.ts` (same `jobs/`
 * module, focused file per BUILD_HANDOFF "Code Organization") because
 * upload/fetch have a materially different shape (multipart in, streamed
 * binary out) from the JSON job/result/part endpoints.
 *
 * A 20 MB multer memory cap is a coarse backstop against a memory-exhaustion
 * upload well above the real business limit — `AttachmentsService` enforces
 * the actual `ATTACHMENT_MAX_BYTES` (10 MB default, S-32) after the file is
 * in memory.
 */
const MULTER_MEMORY_CAP_BYTES = 20 * 1024 * 1024;

@Controller('jobs')
@UseGuards(RolesGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post(':jobId/attachments')
  @Roles(...JOB_RECORD_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MULTER_MEMORY_CAP_BYTES } }))
  upload(
    @Param('jobId') jobId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    const itemResultId = (req.body as { itemResultId?: string } | undefined)?.itemResultId;
    return this.attachments.upload(
      jobId,
      {
        buffer: file?.buffer ?? Buffer.alloc(0),
        originalFilename: file?.originalname,
        itemResultId,
      },
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  /**
   * S-19/I-INV-19 — streamed through the api, authorised on EVERY fetch, no
   * presigned URL (ADR-007). No `@Roles()` restriction: viewing follows the
   * same "own vs. all in scope" rule as viewing the job itself
   * (`JobAccessService`), not the narrower "who may record results" set.
   */
  @Get(':jobId/attachments/:attachmentId')
  async fetch(
    @Param('jobId') jobId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, contentType, byteSize, filename } = await this.attachments.fetch(
      jobId,
      attachmentId,
      { actorId: user.sub },
      user.roles,
    );
    res.set({
      'Content-Type': contentType,
      'Content-Length': String(byteSize),
      'Content-Disposition': `inline${filename ? `; filename="${encodeURIComponent(filename)}"` : ''}`,
    });
    return new StreamableFile(stream);
  }
}
