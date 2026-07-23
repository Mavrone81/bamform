import { Global, Module } from '@nestjs/common';
import { AreaScopeService } from './area-scope';

/**
 * Global home for cross-domain, dependency-free helpers every collection
 * module needs — currently `AreaScopeService` (PR-API-10). Mirrors
 * `AuditModule`'s `@Global()` choice so `assets`/later `jobs` modules don't
 * each redeclare the provider.
 */
@Global()
@Module({
  providers: [AreaScopeService],
  exports: [AreaScopeService],
})
export class CommonModule {}
