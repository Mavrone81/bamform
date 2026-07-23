import { Global, Module } from '@nestjs/common';
import { AuditEventService } from './audit-event.service';

/**
 * Global so every domain module (areas/asset-types/assets/templates, and
 * later jobs/approval) injects `AuditEventService` without importing this
 * module explicitly each time — mirrors `CryptoModule`'s `@Global()` choice.
 */
@Global()
@Module({
  providers: [AuditEventService],
  exports: [AuditEventService],
})
export class AuditModule {}
