import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { CryptoModule } from '../crypto/crypto.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SecurityAuditService } from './audit/security-audit.service';
import { BlindIndexModule } from './blind-index.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordChangeRequiredGuard } from './guards/password-change-required.guard';
import { JwksController } from './jwks.controller';
import { JwtKeysModule, JWT_KEYS_SERVICE } from './jwt/jwt-keys.module';
import type { JwtKeysService } from './jwt/jwt-keys.service';
import { AccountLockoutService } from './lockout/account-lockout.service';
import { MfaController } from './mfa/mfa.controller';
import { MfaConfig } from './mfa/mfa.config';
import { MfaService } from './mfa/mfa.service';
import {
  MfaChallengeTokenService,
  MFA_CHALLENGE_TTL_SECONDS,
} from './mfa/mfa-challenge-token.service';
import { MFA_CHALLENGE_TOKEN_SERVICE } from './mfa/mfa.tokens';
import { PasswordChangeService } from './password/password-change.service';
import { PasswordPolicyConfig } from './password/password-policy.config';
import { PasswordService } from './password/password.service';
import { RateLimiterService } from './redis/rate-limiter.service';
import { TokenDenylistService } from './redis/token-denylist.service';
import { RefreshTokenService } from './refresh/refresh-token.service';
import { SessionIssuerService } from './session/session-issuer.service';

/**
 * PR-SEC-05 deny-by-default: `JwtAuthGuard` is registered globally
 * (`APP_GUARD`) here, so importing `AuthModule` into `AppModule` is what
 * makes every route require authentication unless `@Public()`.
 *
 * Slice 13-MFA registers a SECOND global guard after it,
 * `PasswordChangeRequiredGuard`. Nest applies `APP_GUARD` providers in the
 * order they are declared here, so it always runs with `request.user`
 * already populated by `JwtAuthGuard` — that order matters and must not be
 * shuffled.
 */
@Module({
  imports: [JwtKeysModule, BlindIndexModule, CryptoModule],
  controllers: [AuthController, MfaController, JwksController],
  providers: [
    AuthService,
    PasswordService,
    PasswordChangeService,
    PasswordPolicyConfig,
    RefreshTokenService,
    SecurityAuditService,
    RateLimiterService,
    TokenDenylistService,
    AccountLockoutService,
    SessionIssuerService,
    MfaConfig,
    MfaService,
    {
      // Signed with the SAME Ed25519 key as the access token (one key, one
      // JWKS, PR-087) and separated from it by audience + `typ` alone — see
      // `mfa-challenge-token.service.ts`. `MFA_CHALLENGE_TTL_SECONDS` is
      // 5 minutes (brief §4.2).
      provide: MFA_CHALLENGE_TOKEN_SERVICE,
      inject: [JWT_KEYS_SERVICE, ConfigService],
      useFactory: (jwtKeys: JwtKeysService, config: ConfigService): MfaChallengeTokenService =>
        new MfaChallengeTokenService(
          jwtKeys.signingKey,
          (kid) => jwtKeys.resolveVerificationKey(kid),
          config.get<string>('JWT_ISSUER') ?? 'https://form.bevorasg.com',
          Number(config.get('MFA_CHALLENGE_TTL_SECONDS') ?? MFA_CHALLENGE_TTL_SECONDS),
        ),
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PasswordChangeRequiredGuard },
  ],
  // `AuthService` exported (slice 9) so `sync.module.ts`'s
  // `SyncBootstrapService` can reuse `AuthService#me` (`buildCurrentUser`,
  // `current-user.builder.ts`) verbatim for the bootstrap `user` field
  // (`{id, fullName, roles}` per API_SPECIFICATION.md §11.1 — `CurrentUser`
  // in openapi.yaml carries more optional fields, all genuinely useful
  // offline: areaScope, activeDelegations, stepUpValidUntil) instead of
  // re-querying/re-decrypting `app_user` a second way.
  //
  // `MfaService` exported (slice 13-MFA) so `UsersController` can expose the
  // ADMIN reset (`POST /users/{userId}/mfa-reset`) without duplicating the
  // reset logic or the audit write.
  exports: [PasswordService, AuthService, MfaService, PasswordPolicyConfig],
})
export class AuthModule {}
