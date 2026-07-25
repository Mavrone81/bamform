import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard';
import { IntegrityService } from './integrity.service';

/**
 * PR-095/AC-11 — `GET /records/{recordId}/integrity`. `recordId` is the
 * `job.id` (this system has no separate `record` table — an archived `job`
 * IS the record, matching `api/openapi.yaml`'s `/records/{recordId}/...`
 * paths, which never introduce a distinct identifier). No `@Roles()` beyond
 * authentication (`JwtAuthGuard`, global) — every permitted role in
 * API_SPECIFICATION.md §4.1's "View archive" row may check integrity,
 * including `AUDITOR` (read-only by construction — this is a `GET`).
 */
@Controller('records')
@UseGuards(RolesGuard)
export class RecordsController {
  constructor(private readonly integrity: IntegrityService) {}

  @Get(':recordId/integrity')
  checkIntegrity(@Param('recordId') recordId: string) {
    return this.integrity.checkIntegrity(recordId);
  }
}
