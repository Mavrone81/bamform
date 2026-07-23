import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function makeContext(user: { roles: string[] } | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard (PR-090 seam)', () => {
  it('allows the request through when the handler declares no required roles', () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(makeContext({ roles: ['MAINTAINER'] }))).toBe(true);
  });

  it('allows when the user holds one of the required roles', () => {
    const reflector = {
      getAllAndOverride: () => ['ADMIN', 'DOC_CONTROLLER'],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(makeContext({ roles: ['MAINTAINER', 'ADMIN'] }))).toBe(true);
  });

  it('rejects with 403 /errors/forbidden when the user holds none of the required roles', () => {
    const reflector = { getAllAndOverride: () => ['ADMIN'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() => guard.canActivate(makeContext({ roles: ['MAINTAINER'] }))).toThrow(
      ForbiddenException,
    );
    try {
      guard.canActivate(makeContext({ roles: ['MAINTAINER'] }));
      fail('expected ForbiddenException');
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        type: '/errors/forbidden',
        status: 403,
      });
    }
  });

  it('rejects an unauthenticated request (no user) when roles are required', () => {
    const reflector = { getAllAndOverride: () => ['ADMIN'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);

    expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException);
  });
});
