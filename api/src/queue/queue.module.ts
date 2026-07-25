import { Module } from '@nestjs/common';
import { DelegationsModule } from '../delegations/delegations.module';
import { QueueController } from './queue.controller';
import { QueueRepository } from './queue.repository';
import { QueueService } from './queue.service';
import { VerifierEligibilityService } from './verifier-eligibility.service';

/**
 * PR-073/076/077/081. Imports `DelegationsModule` for
 * `DelegationsRepository#findActiveDelegatorsFor` (PR-076's queue-side
 * delegation resolution — the SAME active-delegation window semantics
 * `VerificationService`'s `onBehalfOf` check uses, see that repository's
 * doc comment). `VerifierEligibilityService`/`QueueRepository` are exported
 * so `JobsModule` (submission — UR-063 "verifier queue notification") and
 * `NotificationsModule` (escalation recipient fallback) can reuse the same
 * eligibility rule instead of re-deriving it.
 */
@Module({
  imports: [DelegationsModule],
  controllers: [QueueController],
  providers: [QueueRepository, QueueService, VerifierEligibilityService],
  exports: [QueueRepository, VerifierEligibilityService],
})
export class QueueModule {}
