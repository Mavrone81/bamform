import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ACCESS_TOKEN_SERVICE } from '../auth.tokens';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AccessTokenService } from '../jwt/access-token.service';
import { TokenDenylistService } from '../redis/token-denylist.service';

function unauthenticatedProblem(): UnauthorizedException {
  return new UnauthorizedException({
    type: '/errors/unauthenticated',
    title: 'Unauthenticated',
    status: 401,
    detail: 'No or invalid access token.',
  });
}

/**
 * Global guard (registered as `APP_GUARD` in `AuthModule`): every route is
 * authenticated unless annotated `@Public()` (PR-SEC-05 deny-by-default;
 * BUILD_HANDOFF deliverable "every route authenticated unless explicitly
 * allowlisted"). Also enforces PR-088's `jti` denylist so a logged-out
 * access token is refused for the remainder of its natural lifetime, even
 * though it would otherwise still verify.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenService,
    private readonly denylist: TokenDenylistService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const token = extractBearerToken(request);
    if (!token) {
      throw unauthenticatedProblem();
    }

    const claims = await this.accessTokens.verify(token);

    if (await this.denylist.isDenylisted(claims.jti)) {
      throw unauthenticatedProblem();
    }

    request.user = claims;
    return true;
  }
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice('Bearer '.length).trim() || undefined;
}
