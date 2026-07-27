import { Controller, Get, Param, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { PdfCoordinatorService } from '../pdf/pdf-coordinator.service';
import { RecordsService } from '../records/records.service';
import { IntegrityService } from './integrity.service';

/**
 * PR-095/AC-11 — `GET /records/{recordId}/integrity`. `recordId` is the
 * `job.id` (this system has no separate `record` table — an archived `job`
 * IS the record, matching `api/openapi.yaml`'s `/records/{recordId}/...`
 * paths, which never introduce a distinct identifier). No `@Roles()` beyond
 * authentication (`JwtAuthGuard`, global) — every permitted role in
 * API_SPECIFICATION.md §4.1's "View archive" row may check integrity,
 * including `AUDITOR` (read-only by construction — this is a `GET`).
 *
 * Slice 12 adds the rest of the archive read surface: `GET /records`
 * (search, UR-058), `GET /records/{recordId}` (retrieve) and `GET
 * /records/{recordId}/pdf` (PR-116..118). Same "no extra `@Roles()`" stance
 * — `RecordsService`/`PdfCoordinatorService` enforce the "own vs. all in
 * scope" rule internally (mirrors `JobAccessService`), same as `/integrity`
 * already did.
 */
@Controller('records')
@UseGuards(RolesGuard)
export class RecordsController {
  constructor(
    private readonly integrity: IntegrityService,
    private readonly records: RecordsService,
    private readonly pdf: PdfCoordinatorService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('assetId') assetId?: string,
    @Query('assetTypeId') assetTypeId?: string,
    @Query('documentNumber') documentNumber?: string,
    @Query('frequency') frequency?: 'M1' | 'M3' | 'M6' | 'Y',
    @Query('archivedFrom') archivedFrom?: string,
    @Query('archivedTo') archivedTo?: string,
    @Query('technician') technician?: string,
    @Query('approver') approver?: string,
  ) {
    return this.records.list(user.sub, user.roles, {
      limit,
      cursor,
      assetId,
      assetTypeId,
      documentNumber,
      frequency,
      archivedFrom,
      archivedTo,
      technician,
      approver,
    });
  }

  @Get(':recordId')
  getById(@Param('recordId') recordId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.records.getById(user.sub, user.roles, recordId);
  }

  @Get(':recordId/integrity')
  checkIntegrity(@Param('recordId') recordId: string, @CurrentUser() user: AccessTokenClaims) {
    // SYS-9 (slice 15-SYSWIRE): the caller is now passed through so
    // IntegrityService applies the same object-level scope/role gate its
    // sibling record reads always had — previously any authenticated user
    // could probe any UUID (IDOR).
    return this.integrity.checkIntegrity(recordId, { userId: user.sub, roles: user.roles });
  }

  /** PR-116/117/118 — rendered on the worker, streamed back through `api` (never blocking `api` on Chromium — see `pdf-coordinator.service.ts`). */
  @Get(':recordId/pdf')
  async getPdf(
    @Param('recordId') recordId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const pdf = await this.pdf.getRecordPdf(recordId, { userId: user.sub, roles: user.roles });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      'Content-Disposition': `inline; filename="record-${recordId}.pdf"`,
    });
    return new StreamableFile(pdf);
  }
}
