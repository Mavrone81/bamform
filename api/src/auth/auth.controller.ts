import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  loginRequestSchema,
  passwordChangeRequestSchema,
  stepUpRequestSchema,
  type LoginRequest,
  type PasswordChangeRequest,
  type StepUpRequest,
} from '@bamform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  applyRetryAfter,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  setRefreshCookie,
} from './auth.cookies';
import { AuthService } from './auth.service';
import { AllowPasswordChangeRequired } from './decorators/allow-password-change-required.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import type { AccessTokenClaims } from './jwt/access-token.types';
import { PasswordChangeService } from './password/password-change.service';
import type { RequestMeta } from './refresh/refresh-token.service';

function requestMeta(req: Request): RequestMeta {
  const userAgent = req.headers['user-agent'];
  const requestId = req.headers['x-request-id'];
  return {
    sourceIp: req.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
    requestId: Array.isArray(requestId) ? requestId[0] : requestId,
  };
}

function presentedRefreshToken(req: Request): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordChange: PasswordChangeService,
  ) {}

  /**
   * With `MFA_ENABLED=false` (the default, and the only value in committed
   * config) this returns `AuthResult` and sets the refresh cookie, exactly as
   * it always has. With the flag on AND the account holding an
   * `MFA_REQUIRED_ROLES` role it instead returns an `MfaChallenge` and sets
   * NO cookie — hence the conditional below rather than an unconditional
   * `setRefreshCookie` (brief §4.2).
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) dto: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const { result, refreshToken } = await this.authService.login(dto, requestMeta(req));
      if (refreshToken) {
        setRefreshCookie(res, refreshToken);
      }
      return result;
    } catch (error) {
      applyRetryAfter(res, error);
      throw error;
    }
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { result, refreshToken } = await this.authService.refresh(
      presentedRefreshToken(req),
      requestMeta(req),
    );
    setRefreshCookie(res, refreshToken);
    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowPasswordChangeRequired()
  async logout(
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logout({
      jti: user.jti,
      accessTokenExpiresAt: user.exp,
      presentedRefreshToken: presentedRefreshToken(req),
    });
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  async stepUp(
    @Body(new ZodValidationPipe(stepUpRequestSchema)) dto: StepUpRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      return await this.authService.stepUp(user.sub, dto.password, requestMeta(req));
    } catch (error) {
      applyRetryAfter(res, error);
      throw error;
    }
  }

  /**
   * Slice 13-MFA §7 — self-service password change, own account only.
   * `@AllowPasswordChangeRequired()` because this is the one endpoint a
   * forced-change user MUST be able to reach.
   */
  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowPasswordChangeRequired()
  async changePassword(
    @Body(new ZodValidationPipe(passwordChangeRequestSchema)) dto: PasswordChangeRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    try {
      await this.passwordChange.changeOwnPassword(user.sub, dto.currentPassword, dto.newPassword, {
        ...requestMeta(req),
        currentRefreshToken: presentedRefreshToken(req),
      });
    } catch (error) {
      applyRetryAfter(res, error);
      throw error;
    }
  }

  @Get('me')
  @AllowPasswordChangeRequired()
  me(@CurrentUser() user: AccessTokenClaims) {
    return this.authService.me(user.sub);
  }
}
