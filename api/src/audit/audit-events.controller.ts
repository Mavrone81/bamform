import { Controller, Get, UseGuards } from '@nestjs/common';
import type { AuditChainStatus } from '@bamform/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ChainVerificationService } from './chain-verification.service';

/**
 * `GET /audit-events/chain-status` — SECURITY_ARCHITECTURE.md §4.2 P2 ("Identify
 * the first break sequence from `GET /audit-events/chain-status`"),
 * PR-097/PR-099. AUDITOR + ADMIN only, per API_SPECIFICATION.md §4.1's
 * `/audit-events` row ("AUDITOR/DOC_CONTROLLER/ADMIN only" for the
 * collection; this narrower chain-status view is AUDITOR/ADMIN — the
 * primary compliance/security-review roles for a P2 S1 incident, DOC_CONTROLLER
 * is the template-authoring role and has no stake in this signal). Read-only
 * by construction (a `GET`) — no separate check that AUDITOR "cannot write"
 * is needed here, unlike the mutating endpoints S-24 covers.
 *
 * Runs the verification on demand (recompute), matching
 * `IntegrityService.checkIntegrity` (`GET /records/{id}/integrity`,
 * slice 7) rather than returning a cached daily result — see
 * `chain-verification.service.ts`'s header for why.
 */
@Controller('audit-events')
@UseGuards(RolesGuard)
export class AuditEventsController {
  constructor(private readonly chainVerification: ChainVerificationService) {}

  @Get('chain-status')
  @Roles('AUDITOR', 'ADMIN')
  async chainStatus(): Promise<AuditChainStatus> {
    const result = await this.chainVerification.verify();
    return {
      intact: result.intact,
      checkedAt: result.checkedAt.toISOString(),
      eventCount: result.eventCount,
      firstBreakSequence:
        result.firstBreakSequence === null ? null : Number(result.firstBreakSequence),
    };
  }
}
