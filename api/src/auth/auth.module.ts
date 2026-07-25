import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CryptoModule } from '../crypto/crypto.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SecurityAuditService } from './audit/security-audit.service';
import { BlindIndexModule } from './blind-index.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwksController } from './jwks.controller';
import { JwtKeysModule } from './jwt/jwt-keys.module';
import { PasswordService } from './password/password.service';
import { RateLimiterService } from './redis/rate-limiter.service';
import { TokenDenylistService } from './redis/token-denylist.service';
import { RefreshTokenService } from './refresh/refresh-token.service';

/**
 * PR-SEC-05 deny-by-default: `JwtAuthGuard` is registered globally
 * (`APP_GUARD`) here, so importing `AuthModule` into `AppModule` is what
 * makes every route require authentication unless `@Public()`.
 */
@Module({
  imports: [JwtKeysModule, BlindIndexModule, CryptoModule],
  controllers: [AuthController, JwksController],
  providers: [
    AuthService,
    PasswordService,
    RefreshTokenService,
    SecurityAuditService,
    RateLimiterService,
    TokenDenylistService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  // `AuthService` exported (slice 9) so `sync.module.ts`'s
  // `SyncBootstrapService` can reuse `AuthService#me` (`buildCurrentUser`,
  // `current-user.builder.ts`) verbatim for the bootstrap `user` field
  // (`{id, fullName, roles}` per API_SPECIFICATION.md §11.1 — `CurrentUser`
  // in openapi.yaml carries more optional fields, all genuinely useful
  // offline: areaScope, activeDelegations, stepUpValidUntil) instead of
  // re-querying/re-decrypting `app_user` a second way.
  exports: [PasswordService, AuthService],
})
export class AuthModule {}
