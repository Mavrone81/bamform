import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from '../decorators/allow-password-change-required.decorator';
import type { AccessTokenClaims } from '../jwt/access-token.types';
import type { RequestWithPrincipals } from './jwt-auth.guard';

export function passwordChangeRequiredProblem(): ForbiddenException {
  return new ForbiddenException({
    type: '/errors/password-change-required',
    title: 'Password change required',
    status: 403,
    detail:
      'Your password was set by an administrator and must be changed before you can use the system.',
  });
}

/**
 * Slice 13-MFA §7 — closes the slice-13a gap where an ADMIN chooses a user's
 * password and then knows that user's credential indefinitely, which is
 * unacceptable for signature attribution under ISO 13485.
 *
 * Registered as a SECOND global `APP_GUARD` immediately after `JwtAuthGuard`
 * (Nest runs `APP_GUARD` providers in registration order), so it only ever
 * sees requests that already carry a verified principal.
 *
 * DENY-BY-DEFAULT, deliberately: a forced-change user is blocked from every
 * route unless the handler carries `@AllowPasswordChangeRequired()`. A new
 * endpoint added in a future slice is therefore closed automatically. The
 * three allowlisted handlers are exactly the ones the brief names —
 * `GET /auth/me`, `POST /auth/password`, `POST /auth/logout`.
 *
 * The flag is read from the DATABASE on each request rather than carried as
 * an access-token claim. That costs one primary-key lookup per request, and
 * buys correctness: a claim would go stale for up to the 15-minute token TTL
 * after the password is changed, leaving the user locked out of their own
 * session immediately after fixing the very thing that blocked them. On a
 * single-site system with a handful of concurrent users that trade is
 * clearly the right way round; if it ever isn't, the fix is a short-TTL
 * cache here, not a claim.
 */
@Injectable()
export class PasswordChangeRequiredGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipals>();
    const claims = request.user as AccessTokenClaims | undefined;

    // No access-token principal: either a `@Public()` route, or one of the
    // `@MfaChallengeAuth()` routes, which run BEFORE any access token exists
    // and therefore before this gate can meaningfully apply. A user whose
    // password must change still has to pass through `/auth/password`
    // afterwards — the gate applies from their first access-token request on.
    if (!claims?.sub) {
      return true;
    }

    const user = await this.prisma.appUser.findUnique({
      where: { id: claims.sub },
      select: { mustChangePassword: true },
    });

    if (user?.mustChangePassword) {
      throw passwordChangeRequiredProblem();
    }
    return true;
  }
}
