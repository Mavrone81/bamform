import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  loginRequestSchema,
  stepUpRequestSchema,
  type LoginRequest,
  type StepUpRequest,
} from '@bamform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import type { AccessTokenClaims } from './jwt/access-token.types';
import { RateLimitedException } from './problems';
import type { IssuedRefreshToken, RequestMeta } from './refresh/refresh-token.service';

const REFRESH_COOKIE_NAME = 'bf_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function requestMeta(req: Request): RequestMeta {
  const userAgent = req.headers['user-agent'];
  const requestId = req.headers['x-request-id'];
  return {
    sourceIp: req.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
    requestId: Array.isArray(requestId) ? requestId[0] : requestId,
  };
}

/** SEC §10.3: `bf_refresh` — `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` (PR-085). */
function setRefreshCookie(res: Response, issued: IssuedRefreshToken): void {
  res.cookie(REFRESH_COOKIE_NAME, issued.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires: issued.expiresAt,
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
      setRefreshCookie(res, refreshToken);
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
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    const { result, refreshToken } = await this.authService.refresh(presented, requestMeta(req));
    setRefreshCookie(res, refreshToken);
    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    await this.authService.logout({
      jti: user.jti,
      accessTokenExpiresAt: user.exp,
      presentedRefreshToken: presented,
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

  @Get('me')
  async me(@CurrentUser() user: AccessTokenClaims) {
    return this.authService.me(user.sub);
  }
}

function applyRetryAfter(res: Response, error: unknown): void {
  if (error instanceof RateLimitedException) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
}
