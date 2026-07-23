import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenClaims } from '../jwt/access-token.types';

function stepUpRequiredProblem(): ForbiddenException {
  return new ForbiddenException({
    type: '/errors/step-up-required',
    title: 'Step-up authentication required',
    status: 403,
    detail: 'Re-authenticate (password) before performing this signing action.',
  });
}

/**
 * PR-091/PR-API-07: verification and template approval require the actor to
 * have authenticated within the preceding `STEP_UP_WINDOW_SECONDS`, or to
 * have re-entered their password via `POST /auth/step-up`. Not attached to
 * any slice-2 endpoint (no signing endpoints exist yet — `/jobs/{id}/verify`
 * and `/revisions/{id}/approve` are slices 5/7); this guard is the seam
 * those slices attach via `@UseGuards(JwtAuthGuard, StepUpGuard)`.
 *
 * Must run after `JwtAuthGuard` (needs `request.user.sub`). Re-queries
 * `app_user.last_authenticated_at` fresh from the database rather than
 * trusting a JWT claim — PR-086 forbids adding claims beyond the fixed
 * seven, and step-up state can change mid-session (a user can step up
 * without getting a new access token).
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get windowSeconds(): number {
    return Number(this.config.get('STEP_UP_WINDOW_SECONDS') ?? 900);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user: AccessTokenClaims }>();
    const user = await this.prisma.appUser.findUniqueOrThrow({ where: { id: request.user.sub } });

    if (!user.lastAuthenticatedAt) {
      throw stepUpRequiredProblem();
    }

    const ageSeconds = (Date.now() - user.lastAuthenticatedAt.getTime()) / 1000;
    if (ageSeconds > this.windowSeconds) {
      throw stepUpRequiredProblem();
    }

    return true;
  }
}
