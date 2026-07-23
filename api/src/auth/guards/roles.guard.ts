import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AccessTokenClaims } from '../jwt/access-token.types';

/**
 * PR-090 seam: not attached to any slice-2 endpoint (none of `/auth/*` needs
 * a specific role — see `decorators/roles.decorator.ts`). Later slices apply
 * it with `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('ADMIN', ...)`.
 * Must run after `JwtAuthGuard` (needs `request.user` already populated).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AccessTokenClaims }>();
    const userRoles = request.user?.roles ?? [];
    const permitted = requiredRoles.some((role) => userRoles.includes(role));

    if (!permitted) {
      throw new ForbiddenException({
        type: '/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'Authenticated but not permitted to perform this action.',
      });
    }
    return true;
  }
}
