import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SecurityAuditService } from './audit/security-audit.service';
import { BlindIndexModule } from './blind-index.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwksController } from './jwks.controller';
import { JwtKeysModule } from './jwt/jwt-keys.module';
import { PasswordService } from './password/password.service';
import { LoginRateLimiterService } from './redis/login-rate-limiter.service';
import { TokenDenylistService } from './redis/token-denylist.service';
import { RefreshTokenService } from './refresh/refresh-token.service';

/**
 * PR-SEC-05 deny-by-default: `JwtAuthGuard` is registered globally
 * (`APP_GUARD`) here, so importing `AuthModule` into `AppModule` is what
 * makes every route require authentication unless `@Public()`.
 */
@Module({
  imports: [JwtKeysModule, BlindIndexModule],
  controllers: [AuthController, JwksController],
  providers: [
    AuthService,
    PasswordService,
    RefreshTokenService,
    SecurityAuditService,
    LoginRateLimiterService,
    TokenDenylistService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [PasswordService],
})
export class AuthModule {}
