import { Module } from '@nestjs/common';
import { DelegationsController } from './delegations.controller';
import { DelegationsRepository } from './delegations.repository';
import { DelegationsService } from './delegations.service';

/**
 * PR-038/PR-076/UR-052. `AuditEventService` (global `AuditModule`) and
 * `FIELD_ENCRYPTION_SERVICE` (global `CryptoModule`, via `AuthModule`) are
 * not re-declared here, matching `jobs.module.ts`'s convention.
 * `DelegationsRepository` is exported — `QueueModule` reuses it for PR-076's
 * "effective queue = own + active delegators'" resolution rather than
 * duplicating the active-delegation query.
 */
@Module({
  controllers: [DelegationsController],
  providers: [DelegationsRepository, DelegationsService],
  exports: [DelegationsRepository],
})
export class DelegationsModule {}
