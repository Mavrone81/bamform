import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  mfaEnrolConfirmRequestSchema,
  mfaEnrolRequestSchema,
  mfaRecoveryRequestSchema,
  mfaVerifyRequestSchema,
  type MfaEnrolConfirmRequest,
  type MfaEnrolRequest,
  type MfaRecoveryRequest,
  type MfaVerifyRequest,
} from '@bamform/shared';
import { requestMeta } from '../../common/request-meta';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { applyRetryAfter, setRefreshCookie } from '../auth.cookies';
import { MfaChallengeAuth } from '../decorators/mfa-challenge-auth.decorator';
import type { RequestWithPrincipals } from '../guards/jwt-auth.guard';
import type { AccessTokenClaims } from '../jwt/access-token.types';
import { MfaService, type MfaActor } from './mfa.service';

/**
 * Slice 13-MFA — `POST /auth/mfa/{enrol,enrol/confirm,verify,recovery}`.
 *
 * None of these routes is `@Public()`. `@MfaChallengeAuth()` tells the global
 * `JwtAuthGuard` to accept the short-lived MFA challenge token (body field
 * `challengeToken`) on this route in place of, or in addition to, an access
 * token — the token is still signed, audience-pinned, expiry-checked and
 * denylist-checked, so deny-by-default (PR-SEC-05) and C-07's route-coverage
 * check both continue to hold.
 *
 * `/verify` and `/recovery` are `challenge-only`: they exist to FINISH a
 * login, so an access-token holder has no business calling them.
 * `/enrol` and `/enrol/confirm` are `challenge-or-access`, because they serve
 * both the user who must enrol before they can finish logging in (brief §4.4)
 * and the user who signs in normally today and wants to enrol ahead of the
 * `MFA_ENABLED` flip (brief §2).
 */
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Post('enrol')
  @HttpCode(HttpStatus.OK)
  @MfaChallengeAuth('challenge-or-access')
  async enrol(
    @Body(new ZodValidationPipe(mfaEnrolRequestSchema)) _dto: MfaEnrolRequest,
    @Req() req: RequestWithPrincipals,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Rate-limited and lockout-checked since the fix pass (M-4), so it can
    // now answer 429 and owes the same `Retry-After` its siblings send.
    try {
      return await this.mfa.enrol(actorFrom(req));
    } catch (error) {
      applyRetryAfter(res, error);
      throw error;
    }
  }

  @Post('enrol/confirm')
  @HttpCode(HttpStatus.OK)
  @MfaChallengeAuth('challenge-or-access')
  async confirm(
    @Body(new ZodValidationPipe(mfaEnrolConfirmRequestSchema)) dto: MfaEnrolConfirmRequest,
    @Req() req: RequestWithPrincipals,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const { response, refreshToken } = await this.mfa.confirmEnrolment(
        actorFrom(req),
        dto.totpCode,
        requestMeta(req),
      );
      if (refreshToken) {
        setRefreshCookie(res, refreshToken);
      }
      return response;
    } catch (error) {
      applyRetryAfter(res, error);
      throw error;
    }
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @MfaChallengeAuth('challenge-only')
  async verify(
    @Body(new ZodValidationPipe(mfaVerifyRequestSchema)) dto: MfaVerifyRequest,
    @Req() req: RequestWithPrincipals,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const { result, refreshToken } = await this.mfa.verify(
        actorFrom(req),
        dto.totpCode,
        requestMeta(req),
      );
      setRefreshCookie(res, refreshToken);
      return result;
    } catch (error) {
      applyRetryAfter(res, error);
      throw error;
    }
  }

  @Post('recovery')
  @HttpCode(HttpStatus.OK)
  @MfaChallengeAuth('challenge-only')
  async recovery(
    @Body(new ZodValidationPipe(mfaRecoveryRequestSchema)) dto: MfaRecoveryRequest,
    @Req() req: RequestWithPrincipals,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const { result, refreshToken } = await this.mfa.redeemRecoveryCode(
        actorFrom(req),
        dto.recoveryCode,
        requestMeta(req),
      );
      setRefreshCookie(res, refreshToken);
      return result;
    } catch (error) {
      applyRetryAfter(res, error);
      throw error;
    }
  }
}

/**
 * The subject always comes from the VERIFIED principal the guard attached —
 * never from the request body. A challenge token's `sub` and an access
 * token's `sub` are equally trustworthy here; nothing else is.
 */
function actorFrom(req: RequestWithPrincipals): MfaActor {
  if (req.mfaChallenge) {
    return {
      userId: req.mfaChallenge.userId,
      challenge: { jti: req.mfaChallenge.jti, exp: req.mfaChallenge.exp },
    };
  }
  const claims = req.user as AccessTokenClaims;
  return { userId: claims.sub };
}
