import { Global, Module } from '@nestjs/common';
import { AuditChainDailyVerificationService } from './audit-chain-daily-verification.service';
import { AuditEventService } from './audit-event.service';
import { AuditEventsController } from './audit-events.controller';
import { ChainVerificationService } from './chain-verification.service';

/**
 * Global so every domain module (areas/asset-types/assets/templates, and
 * later jobs/approval) injects `AuditEventService` without importing this
 * module explicitly each time — mirrors `CryptoModule`'s `@Global()` choice.
 *
 * Slice 8 adds `ChainVerificationService` (the verify routine),
 * `AuditEventsController` (`GET /audit-events/chain-status`, AppModule's
 * HTTP surface), and `AuditChainDailyVerificationService` (the daily job
 * `worker.ts` calls). This module is imported by BOTH `AppModule` and
 * `WorkerModule` (the worker never serves HTTP —
 * `NestFactory.createApplicationContext` never wires a router, so
 * `AuditEventsController` is inert there, the same as `SchedulingModule`'s
 * `AssetScheduleController` — see `worker.module.ts`'s header), so declaring
 * all three here (rather than splitting the controller into a separate,
 * AppModule-only module) keeps every audit-chain concern in one place.
 */
@Global()
@Module({
  controllers: [AuditEventsController],
  providers: [AuditEventService, ChainVerificationService, AuditChainDailyVerificationService],
  exports: [AuditEventService, ChainVerificationService, AuditChainDailyVerificationService],
})
export class AuditModule {}
