import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { QueueService } from './queue.service';

/**
 * PR-073/076/081/UR-049. No `@Roles()` — any authenticated user may call
 * this; a non-verifier (e.g. MAINTAINER, who holds none of a stage's
 * required roles) simply gets an empty queue, which is correct behaviour,
 * not a permission gap (slice-11a-brief.md: "an empty queue for a
 * non-verifier is fine").
 */
@Controller('queue')
@UseGuards(RolesGuard)
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  getQueue(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.queue.getQueue(user.sub, { limit, cursor });
  }
}
