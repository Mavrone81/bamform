import { Global, Module } from '@nestjs/common';
import { AreaScopeService } from './area-scope';
import { IdempotencyService } from './idempotency.service';

/**
 * Global home for cross-domain, dependency-free helpers every collection
 * module needs — `AreaScopeService` (PR-API-10) and, since slice 6,
 * `IdempotencyService` (PR-API-16). Mirrors `AuditModule`'s `@Global()`
 * choice so `assets`/`jobs` modules don't each redeclare the provider.
 */
@Global()
@Module({
  providers: [AreaScopeService, IdempotencyService],
  exports: [AreaScopeService, IdempotencyService],
})
export class CommonModule {}
