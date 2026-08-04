import { Module } from '@nestjs/common';
import { AssignableUserService } from './assignable-user.service';

/**
 * Slice 32-PLANNERJOB — a module of ONE service, for a structural reason.
 *
 * Assignability is needed by BOTH `JobsModule` (assign/reassign an
 * occurrence, and the ad-hoc raise) and `SchedulingModule` (set a schedule's
 * standing assignee, and honour it at generation time). `JobsModule` already
 * imports `SchedulingModule` (slice 15-SYSWIRE, for `CompletionCascadeService`),
 * so `SchedulingModule` cannot import `JobsModule` back without a cycle — and
 * declaring the provider in both would give the two graphs two instances of a
 * rule that must be one.
 *
 * It depends on nothing but the global modules (`PrismaModule`, `CommonModule`
 * for `AreaScopeService`, `CryptoModule` for `FIELD_ENCRYPTION_SERVICE`), all
 * three of which `WorkerModule` also imports — so the scheduler sweep resolves
 * it exactly as the API does.
 */
@Module({
  providers: [AssignableUserService],
  exports: [AssignableUserService],
})
export class AssignableUserModule {}
