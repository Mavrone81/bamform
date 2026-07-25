import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { SyncBootstrapService } from './sync-bootstrap.service';
import { SyncOutboxService } from './sync-outbox.service';
import { SyncController } from './sync.controller';

/**
 * Slice 9 — sync API (bootstrap, outbox drain). Imports `JobsModule` (for
 * the exported `JobsRepository`/`JobAccessService`/`ResultsService`/
 * `PartsService`, slice 6) and `AuthModule` (for the exported `AuthService`,
 * slice 2) rather than redeclaring any of that machinery — see this slice's
 * report for the full reuse-point list. `AreaScopeService`/`IdempotencyService`/
 * `AuditEventService` come from the global `CommonModule`/`AuditModule`
 * (already imported by `AppModule`), same as `JobsModule` itself relies on.
 */
@Module({
  imports: [JobsModule, AuthModule],
  controllers: [SyncController],
  providers: [SyncBootstrapService, SyncOutboxService],
})
export class SyncModule {}
