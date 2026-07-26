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
import {
  MFA_CHALLENGE_AUTH_KEY,
  type MfaChallengeAuthMode,
} from '../decorators/mfa-challenge-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AccessTokenService } from '../jwt/access-token.service';
import { MFA_CHALLENGE_TOKEN_SERVICE } from '../mfa/mfa.tokens';
import type { MfaChallengeTokenService } from '../mfa/mfa-challenge-token.service';
import { TokenDenylistService } from '../redis/token-denylist.service';

function unauthenticatedProblem(): UnauthorizedException {
  return new UnauthorizedException({
    type: '/errors/unauthenticated',
    title: 'Unauthenticated',
    status: 401,
    detail: 'No or invalid access token.',
  });
}

/** Set by this guard when a route is entered on an MFA challenge token rather than an access token. */
export interface MfaChallengePrincipal {
  userId: string;
  jti: string;
  /** Epoch seconds — used to size the denylist TTL when the challenge is redeemed. */
  exp: number;
}

export interface RequestWithPrincipals extends Request {
  user?: unknown;
  mfaChallenge?: MfaChallengePrincipal;
}

/**
 * Global guard (registered as `APP_GUARD` in `AuthModule`): every route is
 * authenticated unless annotated `@Public()` (PR-SEC-05 deny-by-default;
 * BUILD_HANDOFF deliverable "every route authenticated unless explicitly
 * allowlisted"). Also enforces PR-088's `jti` denylist so a logged-out
 * access token is refused for the remainder of its natural lifetime, even
 * though it would otherwise still verify.
 *
 * Slice 13-MFA adds ONE further branch, for routes annotated
 * `@MfaChallengeAuth(...)`: those accept the short-lived MFA challenge token
 * (`mfa/mfa-challenge-token.service.ts`) carried in the request body's
 * `challengeToken`. This is emphatically not a hole in deny-by-default —
 * such a route still requires a signed, unexpired, correctly-audienced,
 * non-denylisted token, and `isPublic` stays false so
 * `route-coverage.spec.ts` (C-07) keeps checking it. The two token kinds can
 * never be substituted for one another: each verifier pins its own audience
 * (S-35).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenService,
    @Inject(MFA_CHALLENGE_TOKEN_SERVICE)
    private readonly mfaChallengeTokens: MfaChallengeTokenService,
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

    const request = context.switchToHttp().getRequest<RequestWithPrincipals>();

    const challengeMode = this.reflector.getAllAndOverride<MfaChallengeAuthMode>(
      MFA_CHALLENGE_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (challengeMode) {
      return this.authoriseWithChallenge(request, challengeMode);
    }

    return this.authoriseWithAccessToken(request);
  }

  private async authoriseWithAccessToken(request: RequestWithPrincipals): Promise<boolean> {
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

  /**
   * `challenge-only` routes complete a login and accept nothing else.
   * `challenge-or-access` routes prefer the challenge token when one is
   * presented (the caller is mid-login) and otherwise fall back to the
   * ordinary access-token path.
   *
   * The body is already parsed here — Express's JSON body parser is
   * middleware and runs before the router, hence before guards. It has NOT
   * been through `ZodValidationPipe` yet (pipes run after guards), so the
   * value is treated as untrusted and type-checked before use.
   */
  private async authoriseWithChallenge(
    request: RequestWithPrincipals,
    mode: MfaChallengeAuthMode,
  ): Promise<boolean> {
    const presented = (request.body as { challengeToken?: unknown } | undefined)?.challengeToken;

    if (typeof presented !== 'string' || presented.length === 0) {
      if (mode === 'challenge-or-access') {
        return this.authoriseWithAccessToken(request);
      }
      throw unauthenticatedProblem();
    }

    const claims = await this.mfaChallengeTokens.verify(presented);

    // Single use: a redeemed challenge's `jti` is denylisted by MfaService
    // for the remainder of its 5-minute life, so a captured challenge token
    // cannot be replayed after the login it belongs to has completed
    // (brief §4, "Expired/replayed challenge token -> 401").
    if (await this.denylist.isDenylisted(claims.jti)) {
      throw unauthenticatedProblem();
    }

    request.mfaChallenge = { userId: claims.sub, jti: claims.jti, exp: claims.exp };
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
