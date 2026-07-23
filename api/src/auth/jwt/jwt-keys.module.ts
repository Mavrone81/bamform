import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretFileLoader } from '../../secret-loading/secret-loader';
import { ACCESS_TOKEN_SERVICE } from '../auth.tokens';
import { AccessTokenService } from './access-token.service';
import { JwtKeysService } from './jwt-keys.service';

export const JWT_KEYS_SERVICE = Symbol('JWT_KEYS_SERVICE');

/**
 * Wires the production `JwtKeysService`/`AccessTokenService` from the
 * file-mounted `JWT_SIGNING_KEY` (non-negotiable #9) — production reads
 * `/run/secrets/jwt_signing_key`, local dev/test falls back to the
 * git-ignored `secrets/jwt_signing_key.pem`
 * (`scripts/dev/generate-dev-secrets.sh`).
 */
@Global()
@Module({
  providers: [
    {
      provide: JWT_KEYS_SERVICE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtKeysService => {
        const pem = new SecretFileLoader().load('jwt_signing_key', 'jwt_signing_key.pem');
        const kid = config.get<string>('JWT_KID_CURRENT') ?? 'bf-2026-07';
        return new JwtKeysService(pem, kid);
      },
    },
    {
      provide: ACCESS_TOKEN_SERVICE,
      inject: [JWT_KEYS_SERVICE, ConfigService],
      useFactory: (jwtKeys: JwtKeysService, config: ConfigService): AccessTokenService => {
        const issuer = config.get<string>('JWT_ISSUER') ?? 'https://form.bevorasg.com';
        const audience = config.get<string>('JWT_AUDIENCE') ?? 'bamform-api';
        const ttlSeconds = Number(config.get('ACCESS_TOKEN_TTL_SECONDS') ?? 900);
        return new AccessTokenService(
          jwtKeys.signingKey,
          (kid) => jwtKeys.resolveVerificationKey(kid),
          issuer,
          audience,
          ttlSeconds,
        );
      },
    },
  ],
  exports: [JWT_KEYS_SERVICE, ACCESS_TOKEN_SERVICE],
})
export class JwtKeysModule {}
